/**
 * Embedded Verdaccio npm registry server for workspace package resolution.
 *
 * This server eliminates the need for workspace:* protocol translation by
 * providing a local npm registry that serves workspace packages natively.
 * All Arborist calls install from this local registry.
 *
 * Benefits:
 * - Native npm semantics (no workspace:* translation needed)
 * - Shared package cache across all panel builds
 * - Proper transitive dependency resolution
 * - Offline support for cached packages
 * - Lazy building: packages are built on-demand when first requested
 *
 * Architecture:
 * - Runs Verdaccio in-process using runServer() programmatic API
 * - Injects lazy-build middleware to intercept workspace package requests
 * - Packages are built and published just-in-time during npm install
 */

import * as path from "path";
import * as fs from "fs";
import * as crypto from "crypto";
import * as http from "http";
import { promisify } from "util";
import { app } from "electron";
import { spawn, exec } from "child_process";
import { runServer, ConfigBuilder } from "verdaccio";

const execAsync = promisify(exec);
import { findAndBindPort, PORT_RANGES } from "./portUtils.js";

import type { GitWatcher } from "./workspace/gitWatcher.js";
import { EsmTransformer, ESM_SAFE_PACKAGES } from "./lazyBuild/esmTransformer.js";
import { createDevLogger } from "./devLog.js";

const log = createDevLogger("Verdaccio");

/**
 * Configuration options for the Verdaccio server.
 */
export interface VerdaccioServerConfig {
  /** Port to listen on. If unavailable, will find an open port. */
  port?: number;
  /** Path for cached npm packages. Defaults to userData/verdaccio-storage. */
  storagePath?: string;
  /** Root of the workspace containing packages/ directory. */
  workspaceRoot?: string;
  /** Maximum restart attempts after unexpected exit. Defaults to 3. */
  maxRestartAttempts?: number;
  /** Delay between restart attempts in ms. Defaults to 1000. */
  restartDelayMs?: number;
}

/**
 * Result of publishing workspace packages.
 */
export interface PublishResult {
  /** True if all packages published successfully (or were skipped) */
  success: boolean;
  /** Packages that were newly published */
  published: string[];
  /** Packages that failed to publish */
  failed: { name: string; error: string }[];
  /** Packages already published (version conflict) */
  skipped: string[];
}

// Singleton instance
let verdaccioServerInstance: VerdaccioServer | null = null;

/**
 * Get the Verdaccio server singleton.
 * Must be initialized with createVerdaccioServer() first.
 */
export function getVerdaccioServer(): VerdaccioServer {
  if (!verdaccioServerInstance) {
    throw new Error("VerdaccioServer not initialized. Call createVerdaccioServer() first.");
  }
  return verdaccioServerInstance;
}

/**
 * Check if Verdaccio server is initialized.
 */
export function isVerdaccioServerInitialized(): boolean {
  return verdaccioServerInstance !== null;
}

/**
 * Create and initialize the Verdaccio server singleton.
 */
export function createVerdaccioServer(config?: VerdaccioServerConfig): VerdaccioServer {
  if (verdaccioServerInstance) {
    console.warn("[VerdaccioServer] Server already created, returning existing instance");
    return verdaccioServerInstance;
  }
  verdaccioServerInstance = new VerdaccioServer(config);
  return verdaccioServerInstance;
}

/**
 * Result of checking workspace changes.
 */
export interface WorkspaceChangesResult {
  /** Packages whose content hash differs from published Verdaccio version */
  changed: string[];
  /** Packages whose content hash matches published Verdaccio version */
  unchanged: string[];
  /** Whether this is a fresh start (no packages in Verdaccio yet) */
  freshStart: boolean;
}

/**
 * Extract package name from a Verdaccio request URL.
 * Handles URL-encoded scoped packages (e.g., /@scope%2Fname or /@scope/name).
 */
function extractPackageName(url: string): string | null {
  // Remove query string
  const urlPath = url.split("?")[0];
  if (!urlPath) return null;

  // Handle URL-encoded scoped packages
  const decoded = decodeURIComponent(urlPath);

  // Match package name patterns:
  // - /@scope/name (scoped)
  // - /name (unscoped)
  // Stop at /- for tarballs, dist-tags, etc.
  const match = decoded.match(/^\/(@[^/]+\/[^/]+|[^/@][^/]*)(?:\/|$|-)/);
  if (!match || !match[1]) return null;

  return match[1];
}

/**
 * Check if a package name is a workspace package that should be lazily built.
 */
function isWorkspacePackage(pkgName: string): boolean {
  return (
    pkgName.startsWith("@natstack/") ||
    pkgName.startsWith("@workspace/") ||
    pkgName.startsWith("@workspace-panels/") ||
    pkgName.startsWith("@workspace-workers/") ||
    pkgName.startsWith("@workspace-agents/")
  );
}

/**
 * Build queue for managing on-demand package builds with promise coalescing.
 */
class BuildQueue {
  private locks = new Map<string, Promise<void>>();
  private buildStack = new Set<string>(); // Cycle detection
  private building = new Set<string>(); // Packages currently being built

  constructor(
    private readonly publishPackage: (pkgPath: string, pkgName: string) => Promise<"published" | "skipped">,
    private readonly resolvePackagePath: (pkgName: string, userWorkspacePath?: string) => string | null,
    private readonly checkPackageInStorage: (pkgName: string) => boolean,
    private readonly userWorkspacePath?: string
  ) {}

  /**
   * Check if a package is currently being built.
   * Used to avoid deadlocks where npm publish's GET request would wait for itself.
   */
  isBuilding(pkgName: string): boolean {
    return this.building.has(pkgName);
  }

  /**
   * Ensure a package is built and published.
   * Uses promise coalescing so concurrent requests share the same build.
   */
  async ensureBuilt(pkgName: string): Promise<void> {
    // Check if already exists in storage
    if (this.checkPackageInStorage(pkgName)) {
      return;
    }

    // If already building, DON'T wait - just return immediately.
    // This prevents deadlocks where npm publish makes GET requests during publish.
    // Those GET requests should go through to Verdaccio (which will 404) rather than waiting.
    const existing = this.locks.get(pkgName);
    if (existing) {
      return; // Don't wait - let the request go to Verdaccio
    }

    const promise = this.doBuild(pkgName)
      .finally(() => this.locks.delete(pkgName));

    this.locks.set(pkgName, promise);
    return promise;
  }

  private async doBuild(pkgName: string): Promise<void> {
    // Cycle detection
    if (this.buildStack.has(pkgName)) {
      throw new Error(`Circular dependency detected: ${pkgName}`);
    }

    this.buildStack.add(pkgName);
    this.building.add(pkgName);
    try {
      const pkgPath = this.resolvePackagePath(pkgName, this.userWorkspacePath);
      if (!pkgPath) {
        throw new Error(`Cannot resolve path for package: ${pkgName}`);
      }

      // Check if package.json exists
      const pkgJsonPath = path.join(pkgPath, "package.json");
      if (!fs.existsSync(pkgJsonPath)) {
        throw new Error(`Package not found: ${pkgName} (expected at ${pkgPath})`);
      }

      log.verbose(`[LazyBuild] Building ${pkgName} on-demand...`);
      await this.publishPackage(pkgPath, pkgName);
      log.verbose(`[LazyBuild] Built ${pkgName}`);
    } finally {
      this.buildStack.delete(pkgName);
      this.building.delete(pkgName);
    }
  }
}

export class VerdaccioServer {
  private httpServer: http.Server | null = null;
  private verdaccioInternalServer: http.Server | null = null;
  private configuredPort: number;
  private actualPort: number | null = null;
  private storagePath: string;
  private workspaceRoot: string;
  private isStarting = false;
  private startPromise: Promise<number> | null = null;
  /** Maximum restart attempts after unexpected exit */
  private maxRestartAttempts: number;
  /** Delay between restart attempts in ms */
  private restartDelayMs: number;
  /** Current restart attempt count (reset on successful start) */
  private restartAttempts = 0;
  /** Cached Verdaccio versions with TTL */
  private verdaccioVersionsCache: { versions: Record<string, string>; timestamp: number } | null = null;
  /** TTL for Verdaccio versions cache (30 seconds) */
  private readonly VERDACCIO_VERSIONS_TTL_MS = 30_000;
  /** Build queue for lazy building */
  private buildQueue: BuildQueue | null = null;
  /** User workspace path for lazy builds (set via setUserWorkspacePath) */
  private userWorkspacePath: string | undefined;
  /** ESM transformer for on-demand ESM bundling */
  private esmTransformer: EsmTransformer | null = null;
  /** Cache for discovered packages by directory path */
  private packageDiscoveryCache = new Map<string, Array<{ path: string; name: string }>>();
  /** Tracks which directories have already been logged (persists across cache invalidations) */
  private discoveryLoggedDirs = new Set<string>();
  /** HTTP agent for connection pooling to internal Verdaccio */
  private proxyAgent: http.Agent | null = null;

  constructor(config?: VerdaccioServerConfig) {
    this.configuredPort = config?.port ?? PORT_RANGES.verdaccio.start;
    this.storagePath = config?.storagePath ?? path.join(app.getPath("userData"), "verdaccio-storage");
    this.workspaceRoot = config?.workspaceRoot ?? process.cwd();
    this.maxRestartAttempts = config?.maxRestartAttempts ?? 3;
    this.restartDelayMs = config?.restartDelayMs ?? 1000;
  }

  /**
   * Set the user workspace path for lazy building of @workspace/* packages.
   * Call this when a workspace is opened/changed.
   */
  setUserWorkspacePath(workspacePath: string | undefined): void {
    this.userWorkspacePath = workspacePath;
    // Clear package discovery cache since workspace changed
    this.invalidatePackageDiscoveryCache();
    // Recreate build queue with new workspace path
    this.buildQueue = new BuildQueue(
      this.publishPackage.bind(this),
      this.resolvePackagePath.bind(this),
      this.checkPackageInStorage.bind(this),
      workspacePath
    );
  }

  /**
   * Start the Verdaccio server.
   * Returns the port the server is listening on.
   */
  async start(): Promise<number> {
    // Prevent concurrent starts
    if (this.startPromise) {
      return this.startPromise;
    }

    if (this.actualPort !== null) {
      log.verbose(` Already running on port ${this.actualPort}`);
      return this.actualPort;
    }

    this.isStarting = true;
    this.startPromise = this.doStart();

    try {
      const port = await this.startPromise;
      return port;
    } finally {
      this.isStarting = false;
      this.startPromise = null;
    }
  }

  private async doStart(): Promise<number> {
    // Stop any existing servers before starting new ones
    // This prevents EADDRINUSE errors on restart
    if (this.httpServer || this.verdaccioInternalServer) {
      console.log("[VerdaccioServer] Stopping existing servers before restart...");
      await this.stop();
    }

    // Ensure storage directory exists
    const packagesStoragePath = path.join(this.storagePath, "packages");
    if (!fs.existsSync(packagesStoragePath)) {
      fs.mkdirSync(packagesStoragePath, { recursive: true });
    }

    // Ensure htpasswd directory exists
    const configDir = path.join(this.storagePath, "config");
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true });
    }

    // Create empty htpasswd file if it doesn't exist
    const htpasswdPath = path.join(configDir, "htpasswd");
    if (!fs.existsSync(htpasswdPath)) {
      fs.writeFileSync(htpasswdPath, "", "utf-8");
    }

    // Find available port
    const { port, server: tempServer } = await findAndBindPort(
      this.configuredPort,
      PORT_RANGES.verdaccio.end
    );

    if (port !== this.configuredPort) {
      log.verbose(` Configured port ${this.configuredPort} unavailable, using ${port}`);
    }

    // Close temp server before starting Verdaccio
    await new Promise<void>((resolve) => tempServer.close(() => resolve()));

    // Build Verdaccio configuration programmatically
    // Use 'json' format to avoid pino's prettify transport (which doesn't work in bundled apps)
    const config = new ConfigBuilder({
      storage: packagesStoragePath,
      self_path: "./",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      web: { enable: false } as any,
      auth: {
        htpasswd: {
          file: htpasswdPath,
          max_users: -1,
        },
      },
      // Use JSON format logging to avoid @verdaccio/logger-prettify transport
      // which doesn't work in bundled Electron apps (pino can't resolve the module)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      log: { type: "stdout", format: "json", level: "warn" } as any,
    })
      .addUplink("npmjs", {
        url: "https://registry.npmjs.org/",
        cache: true,
      })
      // Workspace packages are served locally (no uplink proxy)
      .addPackageAccess("@natstack/*", {
        access: "$all",
        publish: "$all",
      })
      .addPackageAccess("@workspace-panels/*", {
        access: "$all",
        publish: "$all",
      })
      .addPackageAccess("@workspace-workers/*", {
        access: "$all",
        publish: "$all",
      })
      .addPackageAccess("@workspace-agents/*", {
        access: "$all",
        publish: "$all",
      })
      .addPackageAccess("@workspace/*", {
        access: "$all",
        publish: "$all",
      })
      // All other packages proxy to npmjs
      .addPackageAccess("**", {
        access: "$all",
        proxy: "npmjs",
      })
      .getConfig();

    // Run Verdaccio in-process
    // Set NODE_ENV=production to avoid Verdaccio's logger trying to load @verdaccio/logger-prettify
    // (the pino transport doesn't work in bundled Electron apps)
    const originalNodeEnv = process.env["NODE_ENV"];
    process.env["NODE_ENV"] = "production";

    console.log("[VerdaccioServer] Starting Verdaccio in-process...");

    // runServer returns an HTTP server factory/app that we need to call .listen() on
    const internalPort = port + 1;
    let verdaccioServer: http.Server;
    try {
      log.verbose(` Calling runServer...`);
      const serverFactory = await runServer(config);
      log.verbose(` runServer completed, calling listen(${internalPort})...`);

      // The serverFactory is an Express-like app with a listen method
      // Wait for the server to actually be listening before proceeding
      verdaccioServer = await new Promise<http.Server>((resolve, reject) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const server = (serverFactory as any).listen(internalPort, "127.0.0.1", () => {
          log.verbose(` Internal server listening on 127.0.0.1:${internalPort}`);
          resolve(server as http.Server);
        });
        server.on("error", (err: Error) => {
          console.error(`[VerdaccioServer] Internal server error:`, err);
          reject(err);
        });
      });
    } finally {
      // Restore original NODE_ENV
      if (originalNodeEnv !== undefined) {
        process.env["NODE_ENV"] = originalNodeEnv;
      } else {
        delete process.env["NODE_ENV"];
      }
    }

    this.verdaccioInternalServer = verdaccioServer;

    // Initialize build queue
    this.buildQueue = new BuildQueue(
      this.publishPackage.bind(this),
      this.resolvePackagePath.bind(this),
      this.checkPackageInStorage.bind(this),
      this.userWorkspacePath
    );

    // Initialize ESM transformer with internal Verdaccio URL for fetching packages
    this.esmTransformer = new EsmTransformer({
      cacheDir: path.join(this.storagePath, "esm-cache"),
      verdaccioUrl: `http://127.0.0.1:${internalPort}`,
    });

    // Create HTTP agent for connection pooling to internal Verdaccio
    this.proxyAgent = new http.Agent({
      keepAlive: true,
      keepAliveMsecs: 30000,
      maxSockets: 50,  // Allow many concurrent connections
      maxFreeSockets: 10,
    });

    // Create our proxy server that handles lazy-build and ESM routes
    this.httpServer = this.createProxyServer(internalPort);

    // Start the proxy server on the external port
    this.httpServer.listen(port);

    // Wait for both servers to be ready
    await this.waitForServerReady(internalPort); // Wait for internal Verdaccio
    await this.waitForServerReady(port); // Wait for proxy

    this.actualPort = port;
    this.restartAttempts = 0;
    log.verbose(` Started on http://localhost:${port}`);
    log.verbose(` Storage: ${this.storagePath}`);

    // Pre-warm ESM cache in background (non-blocking)
    this.preWarmEsmCache().catch(err => {
      console.warn("[ESM] Pre-warming failed:", err instanceof Error ? err.message : err);
    });

    return port;
  }

  /**
   * Pre-warm ESM cache by transforming known safe packages at startup.
   * Runs in background so it doesn't block server startup.
   */
  private async preWarmEsmCache(): Promise<void> {
    if (!this.esmTransformer) {
      return;
    }

    const packagesToWarm = Array.from(ESM_SAFE_PACKAGES);
    log.verbose(`[ESM] Pre-warming ${packagesToWarm.length} packages...`);

    for (const pkg of packagesToWarm) {
      try {
        await this.esmTransformer.getEsmBundle(pkg, "latest");
      } catch (error) {
        console.warn(`[ESM] Failed to pre-warm ${pkg}:`, error instanceof Error ? error.message : error);
      }
    }
    log.verbose(`[ESM] Pre-warming complete`);
  }

  /**
   * Create a proxy server that handles lazy-build and ESM routes,
   * then proxies to the internal Verdaccio server.
   */
  private createProxyServer(verdaccioPort: number): http.Server {
    // Don't capture buildQueue in a closure - always use this.buildQueue
    // so that setUserWorkspacePath() updates are visible
    const checkStorage = this.checkPackageInStorage.bind(this);

    return http.createServer(async (req, res) => {
      const url = req.url ?? "/";
      const requestId = Math.random().toString(36).slice(2, 8);

      // Handle ESM routes: /-/esm/*
      if (url.startsWith("/-/esm/") && this.esmTransformer) {
        await this.handleEsmRequest(req, res, this.esmTransformer);
        return;
      }

      // Handle lazy-build for workspace packages
      // Only trigger lazy builds for GET requests (package metadata/tarball fetches)
      // PUT requests are npm publish - don't intercept those or we get infinite loops
      const pkgName = extractPackageName(url);
      if (req.method === "GET" && pkgName && isWorkspacePackage(pkgName) && this.buildQueue) {
        const inStorage = checkStorage(pkgName);
        if (!inStorage) {
          try {
            // Use this.buildQueue to get the current build queue (may be updated by setUserWorkspacePath)
            await this.buildQueue.ensureBuilt(pkgName);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            console.error(`[LazyBuild] Failed to build ${pkgName}:`, message);
            res.statusCode = 404;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({
              error: "not_found",
              reason: `Build failed: ${message}`,
            }));
            return;
          }
        }
      }

      // Proxy to Verdaccio
      this.proxyToVerdaccio(req, res, verdaccioPort);
    });
  }

  /**
   * Handle ESM transform requests.
   */
  private async handleEsmRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    esmTransformer: EsmTransformer
  ): Promise<void> {
    // Add CORS headers for cross-origin script loading from natstack-panel://
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    // Handle CORS preflight
    if (req.method === "OPTIONS") {
      res.statusCode = 204;
      res.end();
      return;
    }

    const url = req.url ?? "";
    const urlPath = url.replace("/-/esm/", "");
    const decoded = decodeURIComponent(urlPath.split("?")[0] ?? urlPath);

    let pkgName: string;
    let version: string = "latest";
    let subpath: string | undefined;

    // Handle scoped packages: @scope/pkg, @scope/pkg@version, @scope/pkg/subpath, @scope/pkg@version/subpath
    if (decoded.startsWith("@")) {
      // Match @scope/pkg with optional @version and optional /subpath
      const match = decoded.match(/^(@[^/@]+\/[^/@]+)(?:@([^/]+))?(\/.*)?$/);
      if (!match || !match[1]) {
        res.statusCode = 400;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: "Invalid package name" }));
        return;
      }
      pkgName = match[1];
      version = match[2] ?? "latest";
      subpath = match[3]?.slice(1); // Remove leading /
    } else {
      // Handle unscoped packages: pkg, pkg@version, pkg/subpath, pkg@version/subpath
      // First check for version (@) then subpath (/)
      const atIndex = decoded.indexOf("@");
      const slashIndex = decoded.indexOf("/");

      if (atIndex > 0 && (slashIndex === -1 || atIndex < slashIndex)) {
        // Has version: pkg@version or pkg@version/subpath
        pkgName = decoded.substring(0, atIndex);
        const afterAt = decoded.substring(atIndex + 1);
        const versionSlashIndex = afterAt.indexOf("/");
        if (versionSlashIndex > 0) {
          version = afterAt.substring(0, versionSlashIndex);
          subpath = afterAt.substring(versionSlashIndex + 1);
        } else {
          version = afterAt;
        }
      } else if (slashIndex > 0) {
        // No version but has subpath: pkg/subpath
        pkgName = decoded.substring(0, slashIndex);
        subpath = decoded.substring(slashIndex + 1);
      } else {
        // Just package name
        pkgName = decoded;
      }
    }

    // Check if package is in the ESM-safe allowlist
    if (!esmTransformer.isEsmSafe(pkgName)) {
      res.statusCode = 400;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({
        error: "not_esm_safe",
        reason: `Package "${pkgName}" is not in the ESM-safe allowlist. ` +
          `Known safe packages: ${Array.from(ESM_SAFE_PACKAGES).join(", ")}`,
      }));
      return;
    }

    try {
      const requestDesc = subpath ? `${pkgName}@${version}/${subpath}` : `${pkgName}@${version}`;
      log.verbose(`[ESM] Request: ${requestDesc}`);
      const bundle = await esmTransformer.getEsmBundle(pkgName, version, subpath);

      res.setHeader("Content-Type", "application/javascript; charset=utf-8");
      res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
      res.end(bundle);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[ESM] Transform failed for ${pkgName}@${version}:`, message);
      res.statusCode = 500;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({
        error: "transform_failed",
        reason: message,
      }));
    }
  }

  /**
   * Proxy a request to the internal Verdaccio server.
   * GET requests are retried on transient errors (ECONNRESET, socket hang up).
   */
  private proxyToVerdaccio(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    verdaccioPort: number,
    retryCount = 0
  ): void {
    const MAX_RETRIES = 3;
    const RETRY_DELAY_MS = 100;

    const options: http.RequestOptions = {
      hostname: "127.0.0.1", // Use IPv4 explicitly to avoid IPv6 issues
      port: verdaccioPort,
      path: req.url,
      method: req.method,
      headers: req.headers,
      timeout: 60000, // 60 second timeout
      agent: this.proxyAgent ?? undefined, // Use connection pooling
    };

    const proxyReq = http.request(options, (proxyRes) => {
      res.writeHead(proxyRes.statusCode ?? 200, proxyRes.headers);
      proxyRes.pipe(res);
    });

    proxyReq.on("error", (error: NodeJS.ErrnoException) => {
      // Retry GET requests on transient connection errors
      const isTransient = error.code === "ECONNRESET" || error.code === "ECONNREFUSED" || error.message?.includes("socket hang up");
      const canRetry = req.method === "GET" && isTransient && retryCount < MAX_RETRIES;

      if (canRetry) {
        setTimeout(() => {
          this.proxyToVerdaccio(req, res, verdaccioPort, retryCount + 1);
        }, RETRY_DELAY_MS * (retryCount + 1));
        return;
      }

      // Only log as error if we've exhausted retries or it's not a GET request
      if (retryCount > 0 || req.method !== "GET") {
        console.error(`[Verdaccio] Proxy error for ${req.method} ${req.url} (attempt ${retryCount + 1}):`, error.message);
      }
      if (!res.headersSent) {
        res.statusCode = 502;
        res.end("Bad Gateway");
      }
    });

    proxyReq.on("timeout", () => {
      console.error(`[Verdaccio] Proxy timeout for ${req.method} ${req.url}`);
      proxyReq.destroy();
      if (!res.headersSent) {
        res.statusCode = 504;
        res.end("Gateway Timeout");
      }
    });

    req.pipe(proxyReq);
  }

  /**
   * Check if a package exists in Verdaccio's storage directory.
   */
  private checkPackageInStorage(pkgName: string): boolean {
    // Handle scoped packages: @scope/name → @scope/name or @scope%2fname
    const storageBase = path.join(this.storagePath, "packages");
    const directPath = path.join(storageBase, pkgName);
    if (fs.existsSync(directPath)) {
      return true;
    }
    if (pkgName.startsWith("@")) {
      const encodedPath = path.join(storageBase, pkgName.replace("/", "%2F"));
      return fs.existsSync(encodedPath);
    }
    return false;
  }

  /**
   * Wait for Verdaccio to respond to HTTP requests.
   */
  private async waitForServerReady(port: number, timeoutMs: number = 30000): Promise<void> {
    const startTime = Date.now();
    const pollInterval = 100;

    while (Date.now() - startTime < timeoutMs) {
      // Check if server died
      if (this.httpServer === null) {
        throw new Error("Verdaccio server failed to start");
      }

      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 500);

        const response = await fetch(`http://localhost:${port}/-/ping`, {
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        if (response.ok) {
          return; // Server is ready
        }
      } catch {
        // Server not ready yet, continue polling
      }

      await new Promise(resolve => setTimeout(resolve, pollInterval));
    }

    throw new Error(`Verdaccio did not respond within ${timeoutMs}ms`);
  }

  /**
   * Check if Verdaccio is healthy and responding.
   */
  async healthCheck(): Promise<boolean> {
    if (!this.actualPort || !this.httpServer) {
      return false;
    }

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 1000);

      const response = await fetch(`http://localhost:${this.actualPort}/-/ping`, {
        signal: controller.signal,
      });

      clearTimeout(timeoutId);
      return response.ok;
    } catch {
      return false;
    }
  }

  /** Concurrency limit for parallel publishing */
  private readonly PUBLISH_CONCURRENCY = 4;

  /**
   * Discover all packages in a directory, supporting scoped packages.
   * Scoped packages live in directories starting with @ (e.g., @scope/mylib).
   * Skips packages marked as private (they shouldn't be published).
   */
  private discoverPackagesInDir(packagesDir: string): Array<{ path: string; name: string }> {
    // Check cache first
    const cached = this.packageDiscoveryCache.get(packagesDir);
    if (cached) {
      return cached;
    }

    const packages: Array<{ path: string; name: string }> = [];

    if (!fs.existsSync(packagesDir)) {
      this.packageDiscoveryCache.set(packagesDir, packages);
      return packages;
    }

    const entries = fs.readdirSync(packagesDir, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && !entry.name.startsWith("."));

    for (const entry of entries) {
      const entryPath = path.join(packagesDir, entry.name);

      if (entry.name.startsWith("@")) {
        // Scoped package directory - recurse one level to find actual packages
        const scopedEntries = fs.readdirSync(entryPath, { withFileTypes: true })
          .filter(e => e.isDirectory() && !e.name.startsWith("."));

        for (const scopedEntry of scopedEntries) {
          const scopedPkgPath = path.join(entryPath, scopedEntry.name);
          const pkgJsonPath = path.join(scopedPkgPath, "package.json");

          if (fs.existsSync(pkgJsonPath)) {
            try {
              const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, "utf-8")) as { name: string; private?: boolean };
              // Skip private packages - they shouldn't be published
              if (!pkgJson.private) {
                packages.push({ path: scopedPkgPath, name: pkgJson.name });
              }
            } catch {
              // Skip malformed package.json
            }
          }
        }
      } else {
        // Regular unscoped package
        const pkgJsonPath = path.join(entryPath, "package.json");

        if (fs.existsSync(pkgJsonPath)) {
          try {
            const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, "utf-8")) as { name: string; private?: boolean };
            // Skip private packages - they shouldn't be published
            if (!pkgJson.private) {
              packages.push({ path: entryPath, name: pkgJson.name });
            }
          } catch {
            // Skip malformed package.json
          }
        }
      }
    }

    // Cache the result
    this.packageDiscoveryCache.set(packagesDir, packages);

    // Log only on first discovery (persists across cache invalidations)
    if (packages.length > 0 && !this.discoveryLoggedDirs.has(packagesDir)) {
      this.discoveryLoggedDirs.add(packagesDir);
      log.verbose(` Discovered ${packages.length} packages in ${path.basename(packagesDir)}/: ${packages.map(p => p.name).join(", ")}`);
    }

    return packages;
  }

  /**
   * Clean up orphaned .npmrc files from package directories.
   * These can be left behind if the process crashes during npm publish.
   */
  private cleanupOrphanedNpmrc(packagesDir: string): void {
    const packages = this.discoverPackagesInDir(packagesDir);
    for (const pkg of packages) {
      const npmrcPath = path.join(pkg.path, ".npmrc");
      if (fs.existsSync(npmrcPath)) {
        try {
          fs.rmSync(npmrcPath);
          log.verbose(` Cleaned up orphaned .npmrc in ${pkg.name}`);
        } catch {
          // Ignore cleanup errors
        }
      }
    }
  }

  /**
   * Publish all workspace packages to the local registry.
   * Uses parallel publishing with concurrency limit for faster startup.
   */
  async publishWorkspacePackages(): Promise<PublishResult> {
    const result: PublishResult = {
      success: true,
      published: [],
      failed: [],
      skipped: [],
    };

    const packagesDir = path.join(this.workspaceRoot, "packages");

    if (!fs.existsSync(packagesDir)) {
      console.log("[VerdaccioServer] No packages directory found, skipping publish");
      return result;
    }

    // Clean up any orphaned .npmrc files from previous crashes
    this.cleanupOrphanedNpmrc(packagesDir);

    // Collect all packages to publish (supports scoped packages)
    const packagesToPublish = this.discoverPackagesInDir(packagesDir);

    log.verbose(` Publishing ${packagesToPublish.length} workspace packages (concurrency: ${this.PUBLISH_CONCURRENCY})...`);

    // Publish in parallel batches
    for (let i = 0; i < packagesToPublish.length; i += this.PUBLISH_CONCURRENCY) {
      const batch = packagesToPublish.slice(i, i + this.PUBLISH_CONCURRENCY);

      const batchResults = await Promise.allSettled(
        batch.map(async (pkg) => {
          const publishResult = await this.publishPackage(pkg.path, pkg.name);
          return { name: pkg.name, result: publishResult };
        })
      );

      for (const batchResult of batchResults) {
        if (batchResult.status === "fulfilled") {
          const { name, result: publishResult } = batchResult.value;
          if (publishResult === "published") {
            result.published.push(name);
          } else if (publishResult === "skipped") {
            result.skipped.push(name);
          }
        } else {
          // Extract package name from the error if possible
          const errorMsg = batchResult.reason instanceof Error
            ? batchResult.reason.message
            : String(batchResult.reason);
          const pkgName = batch[batchResults.indexOf(batchResult)]?.name ?? "unknown";
          console.error(`[VerdaccioServer] Failed to publish ${pkgName}:`, errorMsg);
          result.failed.push({ name: pkgName, error: errorMsg });
          result.success = false;
        }
      }
    }

    const summary = [
      result.published.length > 0 ? `${result.published.length} published` : null,
      result.skipped.length > 0 ? `${result.skipped.length} skipped` : null,
      result.failed.length > 0 ? `${result.failed.length} failed` : null,
    ].filter(Boolean).join(", ");

    log.verbose(` Workspace packages: ${summary || "none"}`);
    return result;
  }

  /**
   * Calculate a content hash for a package based on its publishable files.
   */
  private calculatePackageHash(pkgPath: string): string {
    const hash = crypto.createHash("sha256");
    const pkgJsonPath = path.join(pkgPath, "package.json");

    // Parse package.json to find which files will be published
    const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, "utf-8")) as {
      files?: string[];
      main?: string;
      types?: string;
      exports?: Record<string, unknown>;
    };

    // Hash the package.json itself (excluding version which we'll modify)
    const pkgJsonForHash = { ...pkgJson } as Record<string, unknown>;
    delete pkgJsonForHash["version"];
    hash.update(JSON.stringify(pkgJsonForHash, null, 2));

    // Hash the dist folder if it exists (most packages use this)
    const distPath = path.join(pkgPath, "dist");
    if (fs.existsSync(distPath)) {
      this.hashDirectory(distPath, hash);
    }

    // Hash src folder for source-based packages
    const srcPath = path.join(pkgPath, "src");
    if (fs.existsSync(srcPath)) {
      this.hashDirectory(srcPath, hash);
    }

    // For workspace packages that export TypeScript directly (no dist/src),
    // hash all .ts/.tsx/.js/.jsx files in the package root and subdirectories
    if (!fs.existsSync(distPath) && !fs.existsSync(srcPath)) {
      this.hashSourceFiles(pkgPath, hash);
    }

    return hash.digest("hex").slice(0, 12);
  }

  /**
   * Hash all source files (.ts, .tsx, .js, .jsx) in a directory recursively.
   * Used for workspace packages that don't have a dist/ or src/ folder.
   */
  private hashSourceFiles(dirPath: string, hash: crypto.Hash): void {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      // Skip node_modules, .git, and other common non-source directories
      if (entry.name === "node_modules" || entry.name.startsWith(".")) {
        continue;
      }

      const fullPath = path.join(dirPath, entry.name);

      if (entry.isDirectory()) {
        this.hashSourceFiles(fullPath, hash);
      } else if (entry.isFile()) {
        // Only hash source files
        const ext = path.extname(entry.name).toLowerCase();
        if ([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].includes(ext)) {
          hash.update(entry.name);
          hash.update(fs.readFileSync(fullPath));
        }
      }
    }
  }

  /**
   * Recursively hash all files in a directory.
   */
  private hashDirectory(dirPath: string, hash: crypto.Hash): void {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        this.hashDirectory(fullPath, hash);
      } else if (entry.isFile()) {
        hash.update(entry.name);
        hash.update(fs.readFileSync(fullPath));
      }
    }
  }

  // ===========================================================================
  // Git-Based Package Versioning
  // ===========================================================================

  /** Default branch names to check (in order of preference) */
  private static readonly DEFAULT_BRANCHES = ["main", "master"];

  /**
   * Get the default branch name for a repo.
   * Checks for main first, then master. Returns null if neither exists.
   */
  private async getDefaultBranch(repoPath: string): Promise<string | null> {
    try {
      // Check which default branch exists
      for (const branch of VerdaccioServer.DEFAULT_BRANCHES) {
        const { stdout } = await execAsync(
          `git rev-parse --verify refs/heads/${branch}`,
          { cwd: repoPath }
        ).catch(() => ({ stdout: "" }));
        if (stdout.trim()) {
          return branch;
        }
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Get the current git branch name, sanitized for npm tags.
   * Returns null for detached HEAD or errors (skip tagging in these cases).
   */
  private async getCurrentBranch(repoPath: string): Promise<string | null> {
    try {
      const { stdout } = await execAsync(
        "git rev-parse --abbrev-ref HEAD",
        { cwd: repoPath }
      );
      const branch = stdout.trim();

      // Don't tag detached HEAD or error states
      if (branch === "HEAD" || !branch) {
        return null;
      }

      // Sanitize for npm tags: replace / with -- (feature/foo → feature--foo)
      return branch.replace(/\//g, "--");
    } catch {
      return null;
    }
  }

  /**
   * Check if the current branch is the default branch (main/master).
   */
  private async isOnDefaultBranch(repoPath: string): Promise<boolean> {
    const current = await this.getCurrentBranch(repoPath);
    if (!current) return false;
    return VerdaccioServer.DEFAULT_BRANCHES.includes(current);
  }

  /**
   * Get the short commit hash for the most recent commit affecting this package.
   * Returns null if no commits or not a git repo.
   */
  private async getPackageCommitHash(pkgPath: string): Promise<string | null> {
    try {
      const { stdout } = await execAsync(
        "git log -1 --format=%h -- .",
        { cwd: pkgPath }
      );
      const hash = stdout.trim();
      return hash || null;
    } catch {
      return null;
    }
  }

  /**
   * Compute git-based version for a package.
   * Format: {baseVersion}-git.{shortHash}
   * Falls back to content hash if not in a git repo or no commits.
   */
  private async getPackageGitVersion(pkgPath: string): Promise<string> {
    const hash = await this.getPackageCommitHash(pkgPath);

    if (!hash) {
      // Fall back to content hash for non-git packages
      const contentHash = this.calculatePackageHash(pkgPath);
      const pkgJson = JSON.parse(fs.readFileSync(path.join(pkgPath, "package.json"), "utf-8")) as { version: string };
      const baseVersion = (pkgJson.version || "0.0.0").split("-")[0];
      return `${baseVersion}-${contentHash}`;
    }

    const pkgJsonPath = path.join(pkgPath, "package.json");
    const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, "utf-8")) as { version: string };
    const baseVersion = (pkgJson.version || "0.0.0").split("-")[0];

    return `${baseVersion}-git.${hash}`;
  }

  /**
   * Check if a specific version of a package exists in Verdaccio.
   */
  private async checkVersionExists(pkgName: string, version: string): Promise<boolean> {
    const registryUrl = this.getBaseUrl();
    const encodedName = pkgName.replace("/", "%2f");

    try {
      const response = await fetch(`${registryUrl}/${encodedName}/${version}`, {
        signal: AbortSignal.timeout(5000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  /**
   * Get the latest version of a package from Verdaccio (the "latest" tagged version).
   * Returns null if package doesn't exist or on error.
   */
  async getPackageVersion(pkgName: string): Promise<string | null> {
    const registryUrl = this.getBaseUrl();
    const encodedName = pkgName.replace("/", "%2f");

    try {
      const response = await fetch(`${registryUrl}/${encodedName}`, {
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) return null;

      const data = await response.json() as { "dist-tags"?: { latest?: string } };
      return data["dist-tags"]?.latest ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Update the "latest" dist-tag to point to a specific version.
   * Used when a version exists but isn't tagged as latest.
   */
  private async updateLatestTag(pkgName: string, version: string): Promise<void> {
    return this.updateDistTag(pkgName, version, "latest");
  }

  /**
   * Set a dist-tag to point to a specific version.
   * Creates temp .npmrc for auth, same as publishPackage().
   */
  private async updateDistTag(pkgName: string, version: string, tag: string): Promise<void> {
    const registryUrl = this.getBaseUrl();
    const registryHost = new URL(registryUrl).host;
    const npmrcContent = `//${registryHost}/:_authToken="natstack-local-publish"\n`;

    // Write temp .npmrc in workspace root
    const tempNpmrc = path.join(this.workspaceRoot, ".npmrc.dist-tag-temp");
    fs.writeFileSync(tempNpmrc, npmrcContent);

    try {
      await new Promise<void>((resolve) => {
        const proc = spawn(
          "npm",
          ["dist-tag", "add", `${pkgName}@${version}`, tag, "--registry", registryUrl, "--userconfig", tempNpmrc],
          { cwd: this.workspaceRoot, stdio: ["ignore", "pipe", "pipe"] }
        );

        let stderr = "";
        proc.stderr?.on("data", (data) => { stderr += data.toString(); });

        proc.on("close", (code) => {
          if (code === 0) {
            log.verbose(` Tagged ${pkgName}@${version} as "${tag}"`);
            resolve();
          } else {
            console.warn(`[VerdaccioServer] Failed to set tag "${tag}" for ${pkgName}: ${stderr}`);
            resolve();  // Don't fail on tag errors
          }
        });

        proc.on("error", () => resolve());
      });
    } finally {
      fs.rmSync(tempNpmrc, { force: true });
    }
  }

  /**
   * Get the actual versions served by Verdaccio for all workspace packages.
   * Used to include in deps hash to detect when Verdaccio state changes.
   * Results are cached for 30 seconds to avoid repeated HTTP queries during rapid builds.
   */
  async getVerdaccioVersions(): Promise<Record<string, string>> {
    // Return cached if fresh
    if (this.verdaccioVersionsCache &&
        Date.now() - this.verdaccioVersionsCache.timestamp < this.VERDACCIO_VERSIONS_TTL_MS) {
      return this.verdaccioVersionsCache.versions;
    }

    const versions: Record<string, string> = {};
    const packagesDir = path.join(this.workspaceRoot, "packages");

    if (!fs.existsSync(packagesDir)) {
      return versions;
    }

    // Discover all packages (supports scoped packages)
    const packages = this.discoverPackagesInDir(packagesDir);

    // Query versions in parallel
    const queries = packages.map(async (pkg) => {
      try {
        const version = await this.getPackageVersion(pkg.name);
        return version ? { name: pkg.name, version } : null;
      } catch {
        return null;
      }
    });

    const results = await Promise.all(queries);
    for (const result of results) {
      if (result) {
        versions[result.name] = result.version;
      }
    }

    // Cache the results
    this.verdaccioVersionsCache = { versions, timestamp: Date.now() };
    return versions;
  }

  /**
   * Get the actual versions served by Verdaccio for user workspace packages.
   * Includes @workspace/*, @workspace-panels/*, and @workspace-workers/* packages.
   * Used to include in deps hash to detect when user workspace packages change.
   */
  async getUserWorkspaceVersions(userWorkspacePath: string): Promise<Record<string, string>> {
    const versions: Record<string, string> = {};

    // Collect packages from all user workspace directories
    const allPackages: Array<{ path: string; name: string }> = [];

    const packagesDir = path.join(userWorkspacePath, "packages");
    if (fs.existsSync(packagesDir)) {
      allPackages.push(...this.discoverPackagesInDir(packagesDir));
    }

    const panelsDir = path.join(userWorkspacePath, "panels");
    if (fs.existsSync(panelsDir)) {
      allPackages.push(...this.discoverPackagesInDir(panelsDir));
    }

    const workersDir = path.join(userWorkspacePath, "workers");
    if (fs.existsSync(workersDir)) {
      allPackages.push(...this.discoverPackagesInDir(workersDir));
    }

    const agentsDir = path.join(userWorkspacePath, "agents");
    if (fs.existsSync(agentsDir)) {
      allPackages.push(...this.discoverPackagesInDir(agentsDir));
    }

    if (allPackages.length === 0) {
      return versions;
    }

    // Query versions in parallel
    const queries = allPackages.map(async (pkg) => {
      try {
        const version = await this.getPackageVersion(pkg.name);
        return version ? { name: pkg.name, version } : null;
      } catch {
        return null;
      }
    });

    const results = await Promise.all(queries);
    for (const result of results) {
      if (result) {
        versions[result.name] = result.version;
      }
    }

    return versions;
  }

  /**
   * Invalidate the Verdaccio versions cache.
   * Call after publishing packages to ensure fresh data.
   */
  invalidateVerdaccioVersionsCache(): void {
    this.verdaccioVersionsCache = null;
  }

  /**
   * Invalidate the package discovery cache.
   * Call when packages are added/removed from the workspace.
   */
  invalidatePackageDiscoveryCache(directory?: string): void {
    if (directory) {
      this.packageDiscoveryCache.delete(directory);
    } else {
      this.packageDiscoveryCache.clear();
    }
  }

  // ===========================================================================
  // Lazy/On-Demand Publishing
  // ===========================================================================

  /** Locks to prevent concurrent publishes of the same package */
  private publishLocks = new Map<string, Promise<"published" | "skipped">>();

  /**
   * Resolve a package name to its filesystem path.
   * Returns null if the package scope is not recognized.
   *
   * @param pkgName - Package name (e.g., "@natstack/utils", "@workspace/mylib")
   * @param userWorkspacePath - Path to user's workspace (required for @workspace* packages)
   */
  resolvePackagePath(pkgName: string, userWorkspacePath?: string): string | null {
    if (pkgName.startsWith("@natstack/")) {
      const name = pkgName.replace("@natstack/", "");
      return path.join(this.workspaceRoot, "packages", name);
    }

    // Use instance userWorkspacePath if not provided as argument
    const workspacePath = userWorkspacePath ?? this.userWorkspacePath;
    if (!workspacePath) {
      return null;
    }

    if (pkgName.startsWith("@workspace-panels/")) {
      const name = pkgName.replace("@workspace-panels/", "");
      return path.join(workspacePath, "panels", name);
    }

    if (pkgName.startsWith("@workspace-workers/")) {
      const name = pkgName.replace("@workspace-workers/", "");
      return path.join(workspacePath, "workers", name);
    }

    if (pkgName.startsWith("@workspace-agents/")) {
      const name = pkgName.replace("@workspace-agents/", "");
      return path.join(workspacePath, "agents", name);
    }

    if (pkgName.startsWith("@workspace/")) {
      const name = pkgName.replace("@workspace/", "");
      return path.join(workspacePath, "packages", name);
    }

    return null;
  }

  /**
   * Ensure a single package is published to Verdaccio.
   * Uses locking to prevent concurrent publishes of the same package.
   *
   * @param pkgName - Package name (e.g., "@natstack/utils")
   * @param userWorkspacePath - Path to user's workspace (for @workspace* packages)
   * @returns "published" if newly published, "skipped" if already up-to-date, "not-found" if package doesn't exist
   */
  async ensurePackagePublished(
    pkgName: string,
    userWorkspacePath?: string
  ): Promise<"published" | "skipped" | "not-found"> {
    // Check if already publishing this package
    const existingLock = this.publishLocks.get(pkgName);
    if (existingLock) {
      return existingLock;
    }

    // Resolve package path
    const pkgPath = this.resolvePackagePath(pkgName, userWorkspacePath);
    if (!pkgPath) {
      return "not-found";
    }

    // Check if package exists on filesystem
    const pkgJsonPath = path.join(pkgPath, "package.json");
    if (!fs.existsSync(pkgJsonPath)) {
      return "not-found";
    }

    // Check if package is private (shouldn't be published)
    try {
      const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, "utf-8")) as { private?: boolean };
      if (pkgJson.private) {
        return "skipped";
      }
    } catch {
      console.warn(`[Verdaccio] Failed to parse package.json for ${pkgName}`);
      return "not-found";
    }

    // Create a lock for this package
    const publishPromise = this.publishPackage(pkgPath, pkgName)
      .finally(() => {
        this.publishLocks.delete(pkgName);
      });

    this.publishLocks.set(pkgName, publishPromise);
    return publishPromise;
  }

  /**
   * Publish a single package to the local registry.
   * Uses git-based versioning with branch support.
   * @returns "published" if newly published, "skipped" if content unchanged
   */
  private async publishPackage(pkgPath: string, pkgName: string): Promise<"published" | "skipped"> {
    const registryUrl = this.getBaseUrl();
    const pkgJsonPath = path.join(pkgPath, "package.json");
    const npmrcPath = path.join(pkgPath, ".npmrc");

    // Use git-based version instead of content hash
    const gitVersion = await this.getPackageGitVersion(pkgPath);

    // Get current branch for tagging (null = skip branch tag)
    const branch = await this.getCurrentBranch(pkgPath);

    // Only update "latest" tag when on default branch (main/master)
    const isDefault = await this.isOnDefaultBranch(pkgPath);

    // Check if this exact version already exists
    const exists = await this.checkVersionExists(pkgName, gitVersion);
    if (exists) {
      const latestVersion = await this.getPackageVersion(pkgName);
      if (latestVersion === gitVersion && !branch) {
        // Version is latest and no branch tag to set
        log.verbose(` ${pkgName}@${gitVersion} unchanged (skipping)`);
        return "skipped";
      }

      // Update tags as needed
      if (isDefault) {
        await this.updateLatestTag(pkgName, gitVersion);
      }
      if (branch) {
        await this.updateDistTag(pkgName, gitVersion, branch);
      }
      return "published";
    }

    // Parse original package.json
    const originalContent = fs.readFileSync(pkgJsonPath, "utf-8");

    // Publish with --tag based on whether we're on default branch
    // If on default branch: npm publish --tag latest
    // If on feature branch: npm publish --tag {branch} (don't touch latest)
    const publishTag = isDefault ? "latest" : (branch || "latest");

    // Rewrite workspace:* deps to * and set git-based version
    const modifiedPkgJson = JSON.parse(originalContent) as Record<string, unknown>;
    modifiedPkgJson["version"] = gitVersion;

    // Rewrite workspace:* dependencies
    for (const depKey of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
      const deps = modifiedPkgJson[depKey] as Record<string, string> | undefined;
      if (deps && typeof deps === "object") {
        for (const [name, version] of Object.entries(deps)) {
          if (typeof version === "string" && version.startsWith("workspace:")) {
            deps[name] = "*";
          }
        }
      }
    }

    // Save existing .npmrc if present (before we modify anything)
    const existingNpmrc = fs.existsSync(npmrcPath) ? fs.readFileSync(npmrcPath, "utf-8") : null;

    // Prepare .npmrc content
    const registryHost = new URL(registryUrl).host;
    const npmrcContent = `//${registryHost}/:_authToken="natstack-local-publish"\nregistry=${registryUrl}\n`;

    log.verbose(` Publishing ${pkgName}@${gitVersion} to ${registryUrl} (tag: ${publishTag})`);

    // All file modifications inside try block to ensure cleanup
    try {
      fs.writeFileSync(pkgJsonPath, JSON.stringify(modifiedPkgJson, null, 2));
      fs.writeFileSync(npmrcPath, npmrcContent);
      const PUBLISH_TIMEOUT_MS = 60000; // 60 second timeout for npm publish

      const result = await new Promise<"published" | "skipped">((resolve, reject) => {
        const proc = spawn(
          "npm",
          ["publish", "--registry", registryUrl, "--access", "public", "--tag", publishTag],
          {
            cwd: pkgPath,
            stdio: ["ignore", "pipe", "pipe"],
          }
        );

        let stdout = "";
        let stderr = "";
        let timedOut = false;

        // Timeout to prevent hanging forever
        const timeout = setTimeout(() => {
          timedOut = true;
          console.error(`[VerdaccioServer] npm publish timeout for ${pkgName} after ${PUBLISH_TIMEOUT_MS}ms`);
          console.error(`[VerdaccioServer] stdout so far: ${stdout}`);
          console.error(`[VerdaccioServer] stderr so far: ${stderr}`);
          proc.kill("SIGTERM");
          // Give it a moment to terminate gracefully, then force kill
          setTimeout(() => {
            if (!proc.killed) {
              proc.kill("SIGKILL");
            }
          }, 5000);
        }, PUBLISH_TIMEOUT_MS);

        proc.stdout?.on("data", (data) => {
          stdout += data.toString();
        });

        proc.stderr?.on("data", (data) => {
          stderr += data.toString();
        });

        proc.on("close", (code) => {
          clearTimeout(timeout);
          if (timedOut) {
            reject(new Error(`npm publish timed out for ${pkgName}`));
          } else if (code === 0) {
            log.verbose(` Published: ${pkgName}@${gitVersion}`);
            resolve("published");
          } else if (stderr.includes("E409") || stderr.includes("this package is already present")) {
            // E409 Conflict means another publish beat us to it - treat as success
            log.verbose(` ${pkgName}@${gitVersion} already published (race condition)`);
            resolve("skipped");
          } else {
            // Log errors for debugging
            if (stderr.trim()) {
              log.verbose(` ${pkgName} stderr: ${stderr.trim()}`);
            }
            reject(new Error(`npm publish failed for ${pkgName} (exit code ${code}): ${stderr || stdout}`));
          }
        });

        proc.on("error", (err) => {
          clearTimeout(timeout);
          reject(err);
        });
      });

      // After successful publish, also set branch tag (if different from publish tag)
      if (result === "published" && branch && branch !== publishTag) {
        await this.updateDistTag(pkgName, gitVersion, branch);
      }

      return result;
    } finally {
      // Always restore original package.json
      fs.writeFileSync(pkgJsonPath, originalContent);

      // Restore or remove .npmrc
      if (existingNpmrc !== null) {
        fs.writeFileSync(npmrcPath, existingNpmrc);
      } else {
        fs.rmSync(npmrcPath, { force: true });
      }
    }
  }

  /**
   * Stop the Verdaccio server.
   */
  async stop(): Promise<void> {
    console.log("[VerdaccioServer] Stopping servers...");
    const proxyServer = this.httpServer;
    const verdaccioServer = this.verdaccioInternalServer;

    this.httpServer = null;
    this.verdaccioInternalServer = null;
    this.actualPort = null;

    // Helper to close a server with timeout and force destroy
    const closeServer = (server: http.Server, name: string): Promise<void> => {
      return new Promise((resolve) => {
        // First, stop accepting new connections
        server.close(() => {
          log.verbose(` ${name} closed gracefully`);
          resolve();
        });

        // Force close after timeout
        const timeout = setTimeout(() => {
          log.verbose(` ${name} force closing after timeout`);
          // closeAllConnections is available in Node 18.2+
          const serverWithCloseAll = server as http.Server & { closeAllConnections?: () => void };
          if (typeof serverWithCloseAll.closeAllConnections === "function") {
            serverWithCloseAll.closeAllConnections();
          }
          resolve();
        }, 2000);

        // Clear timeout if server closes gracefully
        server.once("close", () => clearTimeout(timeout));
      });
    };

    // Stop both servers
    const closePromises: Promise<void>[] = [];

    if (proxyServer) {
      closePromises.push(closeServer(proxyServer, "proxy server"));
    }

    if (verdaccioServer) {
      closePromises.push(closeServer(verdaccioServer, "internal Verdaccio"));
    }

    if (closePromises.length > 0) {
      await Promise.all(closePromises);
      console.log("[VerdaccioServer] Stopped");
    }

    // Destroy the HTTP agent to close pooled connections
    if (this.proxyAgent) {
      this.proxyAgent.destroy();
      this.proxyAgent = null;
    }
  }

  /**
   * Get the server port. Returns actual port if running, otherwise configured port.
   */
  getPort(): number {
    return this.actualPort ?? this.configuredPort;
  }

  /**
   * Get the base URL for the registry.
   */
  getBaseUrl(): string {
    return `http://localhost:${this.getPort()}`;
  }

  /**
   * Check if the server is running.
   */
  isRunning(): boolean {
    return this.actualPort !== null && this.httpServer !== null;
  }

  /**
   * Check if the server exited unexpectedly.
   * With in-process Verdaccio, this is always false (no subprocess to crash).
   * @deprecated Not needed with in-process Verdaccio
   */
  hasUnexpectedExit(): boolean {
    return false;
  }

  /**
   * Get the error from an unexpected exit, if any.
   * @deprecated Not needed with in-process Verdaccio
   */
  getExitError(): Error | null {
    return null;
  }

  /**
   * Attempt to restart the server after an unexpected exit.
   * Returns the new port if successful, or throws if restart fails.
   */
  async restart(): Promise<number> {
    if (this.isRunning() && this.actualPort !== null) {
      console.log("[VerdaccioServer] Server is already running, no restart needed");
      return this.actualPort;
    }

    if (this.restartAttempts >= this.maxRestartAttempts) {
      throw new Error(
        `[VerdaccioServer] Max restart attempts (${this.maxRestartAttempts}) exceeded.`
      );
    }

    this.restartAttempts++;
    console.log(
      `[VerdaccioServer] Restart attempt ${this.restartAttempts}/${this.maxRestartAttempts}...`
    );

    // Wait before restart attempt
    if (this.restartAttempts > 1) {
      await new Promise(resolve => setTimeout(resolve, this.restartDelayMs));
    }

    return this.start();
  }

  /**
   * Ensure the server is running and healthy.
   * If the server crashed, attempts to restart it automatically.
   * Returns true if server is running (or was successfully restarted).
   * Returns false if server cannot be started/restarted.
   *
   * Use this before operations that require Verdaccio (e.g., panel builds).
   */
  async ensureRunning(): Promise<boolean> {
    // Already running and healthy
    if (this.isRunning()) {
      const healthy = await this.healthCheck();
      if (healthy) {
        return true;
      }
      // Server exists but not responding - something is wrong
      console.warn("[VerdaccioServer] Health check failed, attempting restart");
    }

    // Not running - try to restart
    try {
      await this.restart();
      return true;
    } catch (error) {
      console.error("[VerdaccioServer] Failed to restart:", error);
      return false;
    }
  }

  /**
   * Reset the restart attempt counter.
   * Call this if you want to allow fresh restart attempts after previous failures.
   */
  resetRestartAttempts(): void {
    this.restartAttempts = 0;
  }

  /**
   * Get the workspace root path.
   */
  getWorkspaceRoot(): string {
    return this.workspaceRoot;
  }

  // ===========================================================================
  // GitWatcher Integration
  // ===========================================================================

  /** Debounce delay for commit-triggered republishing (ms) */
  private readonly COMMIT_DEBOUNCE_MS = 500;
  /** Pending debounced publishes keyed by repo path */
  private pendingPublishes: Map<string, NodeJS.Timeout> = new Map();
  /** Packages currently being published (to prevent concurrent publishes) */
  private publishingInProgress: Set<string> = new Set();

  /**
   * Check if a relative path is under a publishable directory (packages, panels, or workers).
   */
  private isInPublishableDir(repoPath: string): boolean {
    return (
      repoPath.startsWith("packages/") || repoPath.startsWith("packages\\") ||
      repoPath.startsWith("panels/") || repoPath.startsWith("panels\\") ||
      repoPath.startsWith("workers/") || repoPath.startsWith("workers\\")
    );
  }

  /**
   * Subscribe to GitWatcher events for automatic republishing.
   * When a package repo gets a new commit, republish it to Verdaccio.
   *
   * @param watcher - The GitWatcher instance to subscribe to
   * @param userWorkspacePath - Absolute path to the user's workspace root.
   *   GitWatcher emits paths relative to this directory, which may be different
   *   from this.workspaceRoot (which is used for built-in @natstack/* packages).
   */
  subscribeToGitWatcher(watcher: GitWatcher, userWorkspacePath: string): void {
    // Convert workspace-relative repo path to absolute path
    const toAbsolutePath = (repoPath: string) => path.join(userWorkspacePath, repoPath);

    // Update user workspace path for lazy building
    this.setUserWorkspacePath(userWorkspacePath);

    watcher.on("repoAdded", async (repoPath) => {
      if (!this.isInPublishableDir(repoPath)) return;
      if (!this.isRunning()) return;

      // Invalidate package discovery cache for the parent directory
      const parentDir = path.dirname(toAbsolutePath(repoPath));
      this.invalidatePackageDiscoveryCache(parentDir);

      try {
        const absolutePath = toAbsolutePath(repoPath);
        const pkgJsonPath = path.join(absolutePath, "package.json");
        if (!fs.existsSync(pkgJsonPath)) return;

        const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, "utf-8")) as { name: string; private?: boolean };
        // Skip private packages
        if (pkgJson.private) return;
        await this.publishPackage(absolutePath, pkgJson.name);
        log.verbose(` Published new workspace package: ${pkgJson.name}`);
        this.invalidateVerdaccioVersionsCache();
      } catch (err) {
        console.error("[Verdaccio] Failed to publish new package:", err);
      }
    });

    watcher.on("commitAdded", (repoPath) => {
      if (!this.isInPublishableDir(repoPath)) return;
      if (!this.isRunning()) return;

      // Debounce: cancel any pending publish for this repo and reschedule
      const existingTimeout = this.pendingPublishes.get(repoPath);
      if (existingTimeout) {
        clearTimeout(existingTimeout);
      }

      const timeout = setTimeout(async () => {
        this.pendingPublishes.delete(repoPath);

        // Skip if a publish is already in progress for this repo
        if (this.publishingInProgress.has(repoPath)) {
          log.verbose(` Skipping publish for ${repoPath} - already in progress`);
          return;
        }

        try {
          this.publishingInProgress.add(repoPath);

          const absolutePath = toAbsolutePath(repoPath);
          const pkgJsonPath = path.join(absolutePath, "package.json");
          if (!fs.existsSync(pkgJsonPath)) return;

          const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, "utf-8")) as { name: string; private?: boolean };
          // Skip private packages
          if (pkgJson.private) return;
          const result = await this.publishPackage(absolutePath, pkgJson.name);
          if (result === "published") {
            log.verbose(` Republished workspace package on commit: ${pkgJson.name}`);
            this.invalidateVerdaccioVersionsCache();
          }
        } catch (err) {
          console.error("[Verdaccio] Failed to republish package:", err);
        } finally {
          this.publishingInProgress.delete(repoPath);
        }
      }, this.COMMIT_DEBOUNCE_MS);

      this.pendingPublishes.set(repoPath, timeout);
    });
  }

  /**
   * Publish all existing packages from a user workspace on startup.
   * This handles packages that existed before the app started (GitWatcher uses ignoreInitial).
   * Also publishes panels and workers so they can be dependencies of other panels/workers.
   *
   * @deprecated With lazy building, this is no longer strictly needed.
   * Packages will be built on-demand. However, pre-publishing can warm the cache.
   *
   * @param userWorkspacePath - Absolute path to the user's workspace root
   */
  async publishUserWorkspacePackages(userWorkspacePath: string): Promise<void> {
    // Update user workspace path for lazy building
    this.setUserWorkspacePath(userWorkspacePath);

    const packagesDir = path.join(userWorkspacePath, "packages");
    const panelsDir = path.join(userWorkspacePath, "panels");
    const workersDir = path.join(userWorkspacePath, "workers");

    // Clean up any orphaned .npmrc files from previous crashes
    if (fs.existsSync(packagesDir)) this.cleanupOrphanedNpmrc(packagesDir);
    if (fs.existsSync(panelsDir)) this.cleanupOrphanedNpmrc(panelsDir);
    if (fs.existsSync(workersDir)) this.cleanupOrphanedNpmrc(workersDir);

    // Collect packages from all publishable directories (discovery is cached)
    const allPackages: Array<{ path: string; name: string }> = [];

    if (fs.existsSync(packagesDir)) {
      allPackages.push(...this.discoverPackagesInDir(packagesDir));
    }

    if (fs.existsSync(panelsDir)) {
      allPackages.push(...this.discoverPackagesInDir(panelsDir));
    }
    if (fs.existsSync(workersDir)) {
      allPackages.push(...this.discoverPackagesInDir(workersDir));
    }

    if (allPackages.length === 0) {
      return;
    }

    log.verbose(` Pre-publishing ${allPackages.length} workspace packages...`);

    // Publish in parallel batches
    for (let i = 0; i < allPackages.length; i += this.PUBLISH_CONCURRENCY) {
      const batch = allPackages.slice(i, i + this.PUBLISH_CONCURRENCY);

      await Promise.allSettled(
        batch.map(async (pkg) => {
          try {
            const result = await this.publishPackage(pkg.path, pkg.name);
            if (result === "published") {
              log.verbose(` Published user workspace package: ${pkg.name}`);
            }
          } catch (err) {
            console.error(`[Verdaccio] Failed to publish ${pkg.name}:`, err);
          }
        })
      );
    }

    this.invalidateVerdaccioVersionsCache();
  }

  /**
   * Check which workspace packages have changed since last startup.
   * Compares expected content hashes against published Verdaccio versions.
   * Verdaccio is the source of truth - no separate hash file needed.
   *
   * @returns Object containing changed/unchanged package lists and freshStart flag
   */
  async checkWorkspaceChanges(): Promise<WorkspaceChangesResult> {
    const changed: string[] = [];
    const unchanged: string[] = [];

    const packagesDir = path.join(this.workspaceRoot, "packages");
    if (!fs.existsSync(packagesDir)) {
      return { changed, unchanged, freshStart: true };
    }

    // Discover all packages (supports scoped packages)
    const packages = this.discoverPackagesInDir(packagesDir);

    // Query all in parallel
    const checks = packages.map(async (pkg) => {
      try {
        const expectedVersion = await this.getExpectedVersion(pkg.path);  // Now async
        const actualVersion = await this.getPackageVersion(pkg.name);

        return {
          name: pkg.name,
          changed: actualVersion !== expectedVersion
        };
      } catch (error) {
        // On error (parse failure, Verdaccio query failed, etc.), treat as changed
        // so the package gets republished rather than silently skipped
        console.warn(`[VerdaccioServer] Error checking ${pkg.name}:`, error);
        return { name: pkg.name, changed: true };
      }
    });

    const results = await Promise.all(checks);
    for (const result of results) {
      (result.changed ? changed : unchanged).push(result.name);
    }

    // Fresh start = no packages in Verdaccio yet (all changed, none unchanged)
    const freshStart = unchanged.length === 0 && changed.length > 0;
    return { changed, unchanged, freshStart };
  }

  /**
   * Get the expected version string for a package based on its current git commit.
   * Falls back to content hash for non-git packages.
   */
  private async getExpectedVersion(pkgPath: string): Promise<string> {
    return this.getPackageGitVersion(pkgPath);
  }

  /**
   * Publish only the packages that have changed since last startup.
   * Also verifies "unchanged" packages exist in Verdaccio with correct version.
   *
   * @returns Publish result with only changed packages
   */
  async publishChangedPackages(): Promise<PublishResult & { changesDetected: WorkspaceChangesResult }> {
    const changes = await this.checkWorkspaceChanges();

    log.verbose(` Workspace changes: ${changes.changed.length} changed, ${changes.unchanged.length} unchanged`);

    if (changes.freshStart) {
      console.log("[VerdaccioServer] Fresh start - publishing all packages");
      const result = await this.publishWorkspacePackages();
      this.invalidateVerdaccioVersionsCache();
      return { ...result, changesDetected: changes };
    }

    // checkWorkspaceChanges() already verified unchanged packages against Verdaccio,
    // so we can trust the changed/unchanged lists directly
    if (changes.changed.length === 0) {
      console.log("[VerdaccioServer] No packages changed, skipping publish");
      return {
        success: true,
        published: [],
        failed: [],
        skipped: changes.unchanged,
        changesDetected: changes,
      };
    }

    const packagesDir = path.join(this.workspaceRoot, "packages");

    // Publish only changed packages (in parallel)
    const result: PublishResult = {
      success: true,
      published: [],
      failed: [],
      skipped: [...changes.unchanged],
    };

    // Discover all packages and filter by changed names
    const allPackages = this.discoverPackagesInDir(packagesDir);
    const changedSet = new Set(changes.changed);
    const packagesToPublish = allPackages.filter(pkg => changedSet.has(pkg.name));

    // Publish in parallel batches
    for (let i = 0; i < packagesToPublish.length; i += this.PUBLISH_CONCURRENCY) {
      const batch = packagesToPublish.slice(i, i + this.PUBLISH_CONCURRENCY);

      const batchResults = await Promise.allSettled(
        batch.map(async (pkg) => {
          const publishResult = await this.publishPackage(pkg.path, pkg.name);
          return { name: pkg.name, result: publishResult };
        })
      );

      for (const batchResult of batchResults) {
        if (batchResult.status === "fulfilled") {
          const { name, result: publishResult } = batchResult.value;
          if (publishResult === "published") {
            result.published.push(name);
          } else {
            result.skipped.push(name);
          }
        } else {
          const errorMsg = batchResult.reason instanceof Error
            ? batchResult.reason.message
            : String(batchResult.reason);
          const pkgName = batch[batchResults.indexOf(batchResult)]?.name ?? "unknown";
          console.error(`[VerdaccioServer] Failed to publish ${pkgName}:`, errorMsg);
          result.failed.push({ name: pkgName, error: errorMsg });
          result.success = false;
        }
      }
    }

    // Invalidate versions cache after publishing to ensure fresh data
    this.invalidateVerdaccioVersionsCache();

    return { ...result, changesDetected: changes };
  }
}
