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
 */

import * as path from "path";
import * as fs from "fs";
import * as crypto from "crypto";
import { app } from "electron";
import { spawn } from "child_process";
import { findAndBindPort, PORT_RANGES } from "./portUtils.js";
import type { GitWatcher } from "./workspace/gitWatcher.js";

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
 * Verdaccio configuration type (simplified).
 */
interface VerdaccioConfig {
  storage: string;
  uplinks: Record<string, { url: string; cache?: boolean }>;
  packages: Record<string, { access?: string; publish?: string; proxy?: string }>;
  log?: { type: string; level: string };
  self_path: string;
  web?: { enable: boolean };
  auth?: { htpasswd: { file: string; max_users?: number } };
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

export class VerdaccioServer {
  private server: ReturnType<typeof spawn> | null = null;
  private configuredPort: number;
  private actualPort: number | null = null;
  private storagePath: string;
  private workspaceRoot: string;
  private configPath: string | null = null;
  private isStarting = false;
  private startPromise: Promise<number> | null = null;
  /** Set to true when the process exits unexpectedly (not via stop()) */
  private unexpectedExit = false;
  /** Error from unexpected process exit */
  private exitError: Error | null = null;
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

  constructor(config?: VerdaccioServerConfig) {
    this.configuredPort = config?.port ?? PORT_RANGES.verdaccio.start;
    this.storagePath = config?.storagePath ?? path.join(app.getPath("userData"), "verdaccio-storage");
    this.workspaceRoot = config?.workspaceRoot ?? process.cwd();
    this.maxRestartAttempts = config?.maxRestartAttempts ?? 3;
    this.restartDelayMs = config?.restartDelayMs ?? 1000;
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
      console.log(`[VerdaccioServer] Already running on port ${this.actualPort}`);
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
    // Reset unexpected exit state from any previous run
    this.unexpectedExit = false;
    this.exitError = null;

    // Ensure storage directory exists
    if (!fs.existsSync(this.storagePath)) {
      fs.mkdirSync(this.storagePath, { recursive: true });
    }

    // Find available port
    const { port, server: tempServer } = await findAndBindPort(
      this.configuredPort,
      PORT_RANGES.verdaccio.end
    );

    if (port !== this.configuredPort) {
      console.log(`[VerdaccioServer] Configured port ${this.configuredPort} unavailable, using ${port}`);
    }

    // Close temp server before starting Verdaccio
    await new Promise<void>((resolve) => tempServer.close(() => resolve()));

    // Create Verdaccio config file
    this.configPath = await this.createConfigFile(port);

    // Start Verdaccio as a subprocess using npx
    await this.startVerdaccioProcess(port);

    this.actualPort = port;
    // Reset restart attempts on successful start
    this.restartAttempts = 0;
    console.log(`[VerdaccioServer] Started on http://localhost:${port}`);
    console.log(`[VerdaccioServer] Storage: ${this.storagePath}`);

    return port;
  }

  /**
   * Create the Verdaccio configuration file.
   */
  private async createConfigFile(port: number): Promise<string> {
    const configDir = path.join(this.storagePath, "config");
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true });
    }

    const config: VerdaccioConfig = {
      storage: path.join(this.storagePath, "packages"),
      uplinks: {
        npmjs: {
          url: "https://registry.npmjs.org/",
          cache: true,
        },
      },
      packages: {
        // Workspace packages are served locally (no uplink proxy)
        "@natstack/*": {
          access: "$all",
          publish: "$all",
        },
        // Workspace panels and workers (for panel-to-panel dependencies)
        "@workspace-panels/*": {
          access: "$all",
          publish: "$all",
        },
        "@workspace-workers/*": {
          access: "$all",
          publish: "$all",
        },
        // Shared workspace packages (workspace/packages/)
        "@workspace/*": {
          access: "$all",
          publish: "$all",
        },
        // All other packages proxy to npmjs
        "**": {
          access: "$all",
          proxy: "npmjs",
        },
      },
      log: { type: "stdout", level: "warn" },
      self_path: "./",
      web: { enable: false }, // Disable web UI for security
      auth: {
        htpasswd: {
          file: path.join(configDir, "htpasswd"),
          // Allow unlimited user creation (for dummy auth tokens)
          max_users: -1,
        },
      },
    };

    const configPath = path.join(configDir, "config.yaml");
    const yaml = this.configToYaml(config);
    fs.writeFileSync(configPath, yaml, "utf-8");

    // Create empty htpasswd file if it doesn't exist
    const htpasswdPath = path.join(configDir, "htpasswd");
    if (!fs.existsSync(htpasswdPath)) {
      fs.writeFileSync(htpasswdPath, "", "utf-8");
    }

    return configPath;
  }

  /**
   * Convert config object to YAML string (simple implementation).
   */
  private configToYaml(config: VerdaccioConfig): string {
    const lines: string[] = [];

    lines.push(`storage: ${config.storage}`);
    lines.push("");

    lines.push("uplinks:");
    for (const [name, uplink] of Object.entries(config.uplinks)) {
      lines.push(`  ${name}:`);
      lines.push(`    url: ${uplink.url}`);
      if (uplink.cache !== undefined) {
        lines.push(`    cache: ${uplink.cache}`);
      }
    }
    lines.push("");

    lines.push("packages:");
    for (const [pattern, pkg] of Object.entries(config.packages)) {
      lines.push(`  '${pattern}':`);
      if (pkg.access) lines.push(`    access: ${pkg.access}`);
      if (pkg.publish) lines.push(`    publish: ${pkg.publish}`);
      if (pkg.proxy) lines.push(`    proxy: ${pkg.proxy}`);
    }
    lines.push("");

    if (config.log) {
      lines.push("log:");
      lines.push(`  type: ${config.log.type}`);
      lines.push(`  level: ${config.log.level}`);
      lines.push("");
    }

    if (config.web) {
      lines.push("web:");
      lines.push(`  enable: ${config.web.enable}`);
      lines.push("");
    }

    if (config.auth) {
      lines.push("auth:");
      lines.push("  htpasswd:");
      lines.push(`    file: ${config.auth.htpasswd.file}`);
      if (config.auth.htpasswd.max_users !== undefined) {
        lines.push(`    max_users: ${config.auth.htpasswd.max_users}`);
      }
      lines.push("");
    }

    return lines.join("\n");
  }

  /**
   * Start the Verdaccio process and wait for it to be ready.
   */
  private async startVerdaccioProcess(port: number): Promise<void> {
    // Use npx to run verdaccio with the config file
    this.server = spawn(
      "npx",
      ["verdaccio", "--config", this.configPath!, "--listen", `${port}`],
      {
        cwd: this.workspaceRoot,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          // Disable Verdaccio telemetry
          VERDACCIO_DISABLE_ANALYTICS: "true",
        },
      }
    );

    let startupError: Error | null = null;

    // Capture stderr for error reporting
    this.server.stderr?.on("data", (data) => {
      const text = data.toString();
      // Only log warnings/errors, filter out noisy output
      if (text.includes("warn") || text.includes("error") || text.includes("fatal")) {
        console.error(`[VerdaccioServer] ${text.trim()}`);
      }
    });

    this.server.on("error", (error) => {
      startupError = error;
      // Also track as unexpected exit if this happens after startup
      if (this.actualPort !== null) {
        this.unexpectedExit = true;
        this.exitError = error;
        console.error("[VerdaccioServer] Process error:", error);
      }
    });

    this.server.on("exit", (code, signal) => {
      // Only log as unexpected if we didn't initiate the stop (actualPort still set)
      const wasRunning = this.actualPort !== null;
      if (wasRunning) {
        this.unexpectedExit = true;
        this.exitError = new Error(`Verdaccio process exited unexpectedly (code: ${code}, signal: ${signal})`);
        console.error(`[VerdaccioServer] Process exited unexpectedly with code ${code}, signal ${signal}`);
      } else {
        console.log(`[VerdaccioServer] Process exited with code ${code}`);
      }
      this.actualPort = null;
      this.server = null;
    });

    // Wait for server to be ready via HTTP polling
    await this.waitForServerReady(port, 30000);

    // Check if process crashed during startup
    if (startupError) {
      throw startupError;
    }
  }

  /**
   * Wait for Verdaccio to respond to HTTP requests.
   * More robust than parsing stdout messages.
   */
  private async waitForServerReady(port: number, timeoutMs: number = 30000): Promise<void> {
    const startTime = Date.now();
    const pollInterval = 100;

    while (Date.now() - startTime < timeoutMs) {
      // Check if process died
      if (this.server === null) {
        throw new Error("Verdaccio process exited during startup");
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
    if (!this.actualPort || !this.server) {
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
    const packages: Array<{ path: string; name: string }> = [];

    if (!fs.existsSync(packagesDir)) {
      return packages;
    }

    const entries = fs.readdirSync(packagesDir, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && !entry.name.startsWith("."));

    console.log(`[Verdaccio] discoverPackagesInDir: ${packagesDir} has ${entries.length} entries: ${entries.map(e => e.name).join(", ")}`);

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
              if (pkgJson.private) {
                console.log(`[Verdaccio] Skipping private package: ${pkgJson.name}`);
                continue;
              }
              packages.push({ path: scopedPkgPath, name: pkgJson.name });
            } catch (err) {
              console.log(`[Verdaccio] Failed to parse package.json at ${pkgJsonPath}: ${err}`);
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
            if (pkgJson.private) {
              console.log(`[Verdaccio] Skipping private package: ${pkgJson.name}`);
              continue;
            }
            console.log(`[Verdaccio] Found publishable package: ${pkgJson.name} at ${entryPath}`);
            packages.push({ path: entryPath, name: pkgJson.name });
          } catch (err) {
            console.log(`[Verdaccio] Failed to parse package.json at ${pkgJsonPath}: ${err}`);
          }
        } else {
          console.log(`[Verdaccio] No package.json at ${pkgJsonPath}`);
        }
      }
    }

    return packages;
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

    // Collect all packages to publish (supports scoped packages)
    const packagesToPublish = this.discoverPackagesInDir(packagesDir);

    console.log(`[VerdaccioServer] Publishing ${packagesToPublish.length} workspace packages (concurrency: ${this.PUBLISH_CONCURRENCY})...`);

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

    console.log(`[VerdaccioServer] Workspace packages: ${summary || "none"}`);
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
    const registryUrl = this.getBaseUrl();

    return new Promise((resolve, reject) => {
      const proc = spawn(
        "npm",
        ["dist-tag", "add", `${pkgName}@${version}`, "latest", "--registry", registryUrl],
        {
          cwd: this.workspaceRoot,
          stdio: ["ignore", "pipe", "pipe"],
        }
      );

      let stderr = "";
      proc.stderr?.on("data", (data) => {
        stderr += data.toString();
      });

      proc.on("close", (code) => {
        if (code === 0) {
          console.log(`[VerdaccioServer] Updated latest tag: ${pkgName}@${version}`);
          resolve();
        } else {
          reject(new Error(`Failed to update dist-tag for ${pkgName}: ${stderr}`));
        }
      });

      proc.on("error", reject);
    });
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

    if (!userWorkspacePath) {
      return null;
    }

    if (pkgName.startsWith("@workspace-panels/")) {
      const name = pkgName.replace("@workspace-panels/", "");
      return path.join(userWorkspacePath, "panels", name);
    }

    if (pkgName.startsWith("@workspace-workers/")) {
      const name = pkgName.replace("@workspace-workers/", "");
      return path.join(userWorkspacePath, "workers", name);
    }

    if (pkgName.startsWith("@workspace/")) {
      const name = pkgName.replace("@workspace/", "");
      return path.join(userWorkspacePath, "packages", name);
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
   * Ensure all workspace dependencies are published to Verdaccio.
   * Walks transitive dependencies to publish everything needed.
   *
   * @param dependencies - Direct dependencies (from panel's package.json)
   * @param userWorkspacePath - Path to user's workspace (for @workspace* packages)
   * @returns Summary of what was published, skipped, or not found
   */
  async ensureDependenciesPublished(
    dependencies: Record<string, string>,
    userWorkspacePath?: string
  ): Promise<{ published: string[]; skipped: string[]; notFound: string[] }> {
    const result = {
      published: [] as string[],
      skipped: [] as string[],
      notFound: [] as string[],
    };

    // Collect all workspace packages (direct + transitive)
    const toProcess = new Set<string>();
    const processed = new Set<string>();

    // Helper to check if a package is a workspace package
    const isWorkspacePackage = (name: string): boolean => {
      return (
        name.startsWith("@natstack/") ||
        name.startsWith("@workspace/") ||
        name.startsWith("@workspace-panels/") ||
        name.startsWith("@workspace-workers/")
      );
    };

    // Add direct workspace dependencies
    for (const depName of Object.keys(dependencies)) {
      if (isWorkspacePackage(depName)) {
        toProcess.add(depName);
      }
    }

    // Walk transitive deps
    while (toProcess.size > 0) {
      const pkgName = toProcess.values().next().value!;
      toProcess.delete(pkgName);

      if (processed.has(pkgName)) {
        continue;
      }
      processed.add(pkgName);

      // Read package.json to find transitive workspace deps
      const pkgPath = this.resolvePackagePath(pkgName, userWorkspacePath);
      if (!pkgPath) {
        continue;
      }

      const pkgJsonPath = path.join(pkgPath, "package.json");
      if (!fs.existsSync(pkgJsonPath)) {
        continue;
      }

      try {
        const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, "utf-8")) as {
          dependencies?: Record<string, string>;
        };
        if (pkgJson.dependencies) {
          for (const depName of Object.keys(pkgJson.dependencies)) {
            if (isWorkspacePackage(depName) && !processed.has(depName)) {
              toProcess.add(depName);
            }
          }
        }
      } catch {
        // Skip malformed package.json
      }
    }

    // Publish all collected packages in parallel (with locking for dedup)
    const publishPromises = Array.from(processed).map(async (pkgName) => {
      const status = await this.ensurePackagePublished(pkgName, userWorkspacePath);
      return { pkgName, status };
    });

    const results = await Promise.all(publishPromises);

    for (const { pkgName, status } of results) {
      if (status === "published") {
        result.published.push(pkgName);
      } else if (status === "skipped") {
        result.skipped.push(pkgName);
      } else {
        result.notFound.push(pkgName);
      }
    }

    // Invalidate cache if anything was published
    if (result.published.length > 0) {
      this.invalidateVerdaccioVersionsCache();
    }

    return result;
  }

  /**
   * Publish a single package to the local registry.
   * Uses content-hash based versioning to skip unchanged packages.
   * @returns "published" if newly published, "skipped" if content unchanged
   */
  private async publishPackage(pkgPath: string, pkgName: string): Promise<"published" | "skipped"> {
    const registryUrl = this.getBaseUrl();
    const pkgJsonPath = path.join(pkgPath, "package.json");
    const npmrcPath = path.join(pkgPath, ".npmrc");

    // Calculate content hash to create a unique version
    const contentHash = this.calculatePackageHash(pkgPath);

    // Parse original package.json to get base version
    const originalContent = fs.readFileSync(pkgJsonPath, "utf-8");
    const pkgJson = JSON.parse(originalContent) as { version: string };
    const baseVersion = pkgJson.version.split("-")[0]; // Strip any existing prerelease
    const hashVersion = `${baseVersion}-${contentHash}`;

    // Check if this exact version already exists
    const exists = await this.checkVersionExists(pkgName, hashVersion);
    if (exists) {
      // Version exists - check if it's already the "latest" tag
      const latestVersion = await this.getPackageVersion(pkgName);
      if (latestVersion === hashVersion) {
        console.log(`[VerdaccioServer] ${pkgName}@${hashVersion} unchanged (skipping)`);
        return "skipped";
      }
      // Version exists but isn't "latest" - update the tag
      console.log(`[VerdaccioServer] ${pkgName}@${hashVersion} exists, updating latest tag`);
      await this.updateLatestTag(pkgName, hashVersion);
      return "published"; // Treat tag update as a publish for cache invalidation purposes
    }

    // Rewrite workspace:* deps to * and set hash-based version
    const modifiedPkgJson = JSON.parse(originalContent) as Record<string, unknown>;
    modifiedPkgJson["version"] = hashVersion;

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

    fs.writeFileSync(pkgJsonPath, JSON.stringify(modifiedPkgJson, null, 2));

    // Save existing .npmrc if present
    const existingNpmrc = fs.existsSync(npmrcPath) ? fs.readFileSync(npmrcPath, "utf-8") : null;

    // Write temporary .npmrc with auth token for local registry
    const registryHost = new URL(registryUrl).host;
    const npmrcContent = `//${registryHost}/:_authToken="natstack-local-publish"\nregistry=${registryUrl}\n`;
    fs.writeFileSync(npmrcPath, npmrcContent);

    console.log(`[VerdaccioServer] Publishing ${pkgName}@${hashVersion}`);

    try {
      return await new Promise((resolve, reject) => {
        const proc = spawn(
          "npm",
          ["publish", "--registry", registryUrl, "--access", "public", "--tag", "latest"],
          {
            cwd: pkgPath,
            stdio: ["ignore", "pipe", "pipe"],
          }
        );

        let stdout = "";
        let stderr = "";

        proc.stdout?.on("data", (data) => {
          stdout += data.toString();
        });

        proc.stderr?.on("data", (data) => {
          stderr += data.toString();
        });

        proc.on("close", (code) => {
          if (code === 0) {
            console.log(`[VerdaccioServer] Published: ${pkgName}@${hashVersion}`);
            resolve("published");
          } else {
            // Log errors for debugging
            if (stderr.trim()) {
              console.log(`[VerdaccioServer] ${pkgName} stderr: ${stderr.trim()}`);
            }
            reject(new Error(`npm publish failed for ${pkgName} (exit code ${code}): ${stderr || stdout}`));
          }
        });

        proc.on("error", reject);
      });
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
    if (!this.server) {
      return;
    }

    const proc = this.server;
    this.server = null;
    this.actualPort = null;

    return new Promise((resolve) => {
      let resolved = false;

      const done = () => {
        if (!resolved) {
          resolved = true;
          console.log("[VerdaccioServer] Stopped");
          resolve();
        }
      };

      // Listen for exit (fires when process ends, before streams close)
      proc.on("exit", done);

      // Try graceful shutdown first
      proc.kill("SIGTERM");

      // Force kill and resolve after 3 seconds if still running
      setTimeout(() => {
        if (proc.exitCode === null) {
          proc.kill("SIGKILL");
        }
        // Resolve anyway after timeout
        done();
      }, 3000);
    });
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
   * Returns false if the process exited unexpectedly.
   */
  isRunning(): boolean {
    return this.actualPort !== null && this.server !== null && !this.unexpectedExit;
  }

  /**
   * Check if the server exited unexpectedly.
   * Use this to detect crashes and trigger recovery logic.
   */
  hasUnexpectedExit(): boolean {
    return this.unexpectedExit;
  }

  /**
   * Get the error from an unexpected exit, if any.
   */
  getExitError(): Error | null {
    return this.exitError;
  }

  /**
   * Attempt to restart the server after an unexpected exit.
   * Returns the new port if successful, or throws if restart fails.
   */
  async restart(): Promise<number> {
    if (this.isRunning()) {
      console.log("[VerdaccioServer] Server is already running, no restart needed");
      return this.actualPort!;
    }

    if (this.restartAttempts >= this.maxRestartAttempts) {
      throw new Error(
        `[VerdaccioServer] Max restart attempts (${this.maxRestartAttempts}) exceeded. ` +
        `Last error: ${this.exitError?.message ?? "unknown"}`
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
      // Process exists but not responding - mark as unexpected exit
      console.warn("[VerdaccioServer] Health check failed, marking as crashed");
      this.unexpectedExit = true;
      this.exitError = new Error("Verdaccio health check failed");
    }

    // Not running - try to restart if we haven't exceeded attempts
    if (this.unexpectedExit || this.server === null) {
      try {
        await this.restart();
        return true;
      } catch (error) {
        console.error("[VerdaccioServer] Failed to restart:", error);
        return false;
      }
    }

    return false;
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

    watcher.on("repoAdded", async (repoPath) => {
      if (!this.isInPublishableDir(repoPath)) return;
      if (!this.isRunning()) return;

      try {
        const absolutePath = toAbsolutePath(repoPath);
        const pkgJsonPath = path.join(absolutePath, "package.json");
        if (!fs.existsSync(pkgJsonPath)) return;

        const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, "utf-8")) as { name: string; private?: boolean };
        // Skip private packages
        if (pkgJson.private) return;
        await this.publishPackage(absolutePath, pkgJson.name);
        console.log(`[Verdaccio] Published new workspace package: ${pkgJson.name}`);
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
          console.log(`[Verdaccio] Skipping publish for ${repoPath} - already in progress`);
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
            console.log(`[Verdaccio] Republished workspace package on commit: ${pkgJson.name}`);
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
   * @param userWorkspacePath - Absolute path to the user's workspace root
   */
  async publishUserWorkspacePackages(userWorkspacePath: string): Promise<void> {
    console.log(`[Verdaccio] publishUserWorkspacePackages called with: ${userWorkspacePath}`);

    // Collect packages from all publishable directories
    const allPackages: Array<{ path: string; name: string }> = [];

    // Traditional packages directory
    const packagesDir = path.join(userWorkspacePath, "packages");
    console.log(`[Verdaccio] Checking packages dir: ${packagesDir} (exists: ${fs.existsSync(packagesDir)})`);
    if (fs.existsSync(packagesDir)) {
      const found = this.discoverPackagesInDir(packagesDir);
      console.log(`[Verdaccio] Found ${found.length} packages in packages/: ${found.map(p => p.name).join(", ") || "(none)"}`);
      allPackages.push(...found);
    }

    // Panels directory (for @workspace-panels/* dependencies)
    const panelsDir = path.join(userWorkspacePath, "panels");
    console.log(`[Verdaccio] Checking panels dir: ${panelsDir} (exists: ${fs.existsSync(panelsDir)})`);
    if (fs.existsSync(panelsDir)) {
      const found = this.discoverPackagesInDir(panelsDir);
      console.log(`[Verdaccio] Found ${found.length} packages in panels/: ${found.map(p => p.name).join(", ") || "(none)"}`);
      allPackages.push(...found);
    }

    // Workers directory (for @workspace-workers/* dependencies)
    const workersDir = path.join(userWorkspacePath, "workers");
    console.log(`[Verdaccio] Checking workers dir: ${workersDir} (exists: ${fs.existsSync(workersDir)})`);
    if (fs.existsSync(workersDir)) {
      const found = this.discoverPackagesInDir(workersDir);
      console.log(`[Verdaccio] Found ${found.length} packages in workers/: ${found.map(p => p.name).join(", ") || "(none)"}`);
      allPackages.push(...found);
    }

    if (allPackages.length === 0) {
      console.log(`[Verdaccio] No user workspace packages found to publish`);
      return;
    }

    console.log(`[Verdaccio] Publishing ${allPackages.length} existing user workspace packages...`);

    // Publish in parallel batches
    for (let i = 0; i < allPackages.length; i += this.PUBLISH_CONCURRENCY) {
      const batch = allPackages.slice(i, i + this.PUBLISH_CONCURRENCY);

      await Promise.allSettled(
        batch.map(async (pkg) => {
          try {
            const result = await this.publishPackage(pkg.path, pkg.name);
            if (result === "published") {
              console.log(`[Verdaccio] Published user workspace package: ${pkg.name}`);
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
        const expectedVersion = this.getExpectedVersion(pkg.path);
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
   * Get the expected version string for a package based on its current hash.
   */
  private getExpectedVersion(pkgPath: string): string {
    const pkgJsonPath = path.join(pkgPath, "package.json");
    const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, "utf-8")) as { version: string };
    const baseVersion = pkgJson.version.split("-")[0];
    const contentHash = this.calculatePackageHash(pkgPath);
    return `${baseVersion}-${contentHash}`;
  }

  /**
   * Publish only the packages that have changed since last startup.
   * Also verifies "unchanged" packages exist in Verdaccio with correct version.
   *
   * @returns Publish result with only changed packages
   */
  async publishChangedPackages(): Promise<PublishResult & { changesDetected: WorkspaceChangesResult }> {
    const changes = await this.checkWorkspaceChanges();

    console.log(`[VerdaccioServer] Workspace changes: ${changes.changed.length} changed, ${changes.unchanged.length} unchanged`);

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
