/**
 * Main process TypeDefinitionService for NatStack type checking.
 *
 * This service provides type definitions to panels via RPC. It:
 * - Loads .d.ts files from Arborist-installed node_modules
 * - Auto-installs missing dependencies
 * - Caches types globally (shared across all panels)
 * - Keys per-panel deps directories by panel path
 */

import * as fs from "fs/promises";
import * as path from "path";
import * as crypto from "crypto";
import Arborist from "@npmcli/arborist";
import { createTypeDefinitionLoader, loadNatstackPackageTypes, type NatstackPackageTypes } from "@natstack/runtime/typecheck";
import { getPackagesDir } from "../paths.js";
import { app } from "electron";
import { isVerdaccioServerInitialized, getVerdaccioServer } from "../verdaccioServer.js";

/**
 * Check if Verdaccio is running and can serve @natstack/* packages.
 * Uses ensureRunning() to auto-restart Verdaccio if it crashed.
 */
async function canUseVerdaccio(): Promise<boolean> {
  if (!isVerdaccioServerInitialized()) {
    return false;
  }
  return getVerdaccioServer().ensureRunning();
}

/**
 * Node.js built-in modules that shouldn't be fetched from npm.
 */
const NODE_BUILTINS = new Set([
  "assert", "async_hooks", "buffer", "child_process", "cluster", "console",
  "constants", "crypto", "dgram", "dns", "domain", "events", "fs", "http",
  "http2", "https", "inspector", "module", "net", "os", "path", "perf_hooks",
  "process", "punycode", "querystring", "readline", "repl", "stream",
  "string_decoder", "sys", "timers", "tls", "trace_events", "tty", "url",
  "util", "v8", "vm", "wasi", "worker_threads", "zlib",
]);

/**
 * Internal package prefixes from playwright and other bundled packages.
 * These are module aliases that don't exist on npm.
 */
const INTERNAL_PREFIXES = [
  "@protocol/",
  "@injected/",
  "@trace/",
  "@recorder/",
  "@isomorphic/",
];

/**
 * Check if a package should be skipped (not fetched from npm).
 */
function shouldSkipPackage(packageName: string): boolean {
  // Skip node: protocol imports (node:fs, node:http, etc.)
  if (packageName.startsWith("node:")) {
    return true;
  }

  // Skip node built-ins (fs, path, etc. without node: prefix)
  if (NODE_BUILTINS.has(packageName)) {
    return true;
  }

  // Skip internal playwright/bundled package aliases
  for (const prefix of INTERNAL_PREFIXES) {
    if (packageName.startsWith(prefix)) {
      return true;
    }
  }

  // Skip # internal imports (TypeScript private imports, subpath imports)
  if (packageName.startsWith("#")) {
    return true;
  }

  // Skip blacklisted names
  if (packageName === "node_modules") {
    return true;
  }

  return false;
}

/**
 * Get the types cache directory for NatStack.
 */
function getTypesCacheDir(): string {
  return path.join(app.getPath("userData"), "types-cache");
}

/**
 * Extract package name from a 404 error message.
 * Handles both npm registry and Verdaccio URL formats:
 * - npm: "404 ... registry.npmjs.org/@types%2freact-markdown ..."
 * - Verdaccio: "404 Not Found - GET http://localhost:49564/@types%2freact-markdown - no such package"
 */
function extractPackageFrom404(errorMsg: string): string | null {
  if (!errorMsg.includes("404")) {
    return null;
  }

  // Pattern matches: URL ending with /@scope%2fname or /name, followed by space or end
  // Works for both registry.npmjs.org and localhost:PORT URLs
  const match = errorMsg.match(/https?:\/\/[^\s]+\/(@[a-z0-9_-]+%2f[a-z0-9_-]+|[a-z0-9_-]+)(?:\s|$|-)/i);
  if (match?.[1]) {
    return decodeURIComponent(match[1]);
  }

  return null;
}

/**
 * Hash a string for cache keys.
 */
function hashString(str: string): string {
  return crypto.createHash("sha256").update(str).digest("hex").slice(0, 16);
}

/** Maximum number of packages to cache type definitions for */
const MAX_TYPE_CACHE_ENTRIES = 100;

/** Cached type result with all metadata */
interface CachedTypeResult {
  files: Map<string, string>;
  referencedPackages: string[];
  entryPoint: string | null;
}

/** Result type for package types */
export interface PackageTypesResult {
  files: Record<string, string>;
  referencedPackages?: string[];
  entryPoint?: string;
  error?: string;
  skipped?: boolean;
}

/** Pending install request with its resolver */
interface PendingInstall {
  packageName: string;
  resolve: () => void;
  reject: (error: Error) => void;
}

/** Per-depsDir batch queue state */
interface BatchQueue {
  /** Pending packages keyed by package name */
  pending: Map<string, PendingInstall[]>;
  flushTimer: NodeJS.Timeout | null;
  activeFlush: Promise<void> | null;
}

/**
 * Simple LRU cache for type definitions.
 * Uses a Map (which maintains insertion order) and moves accessed items to end.
 */
class LRUTypeCache<T> {
  private cache = new Map<string, T>();
  private maxSize: number;

  constructor(maxSize: number = MAX_TYPE_CACHE_ENTRIES) {
    this.maxSize = maxSize;
  }

  get(key: string): T | undefined {
    const value = this.cache.get(key);
    if (value !== undefined) {
      // Move to end (most recently used)
      this.cache.delete(key);
      this.cache.set(key, value);
    }
    return value;
  }

  set(key: string, value: T): void {
    // If key exists, delete first to update position
    if (this.cache.has(key)) {
      this.cache.delete(key);
    }
    // Evict oldest entries if at capacity
    while (this.cache.size >= this.maxSize) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey !== undefined) {
        this.cache.delete(oldestKey);
      }
    }
    this.cache.set(key, value);
  }

  delete(key: string): boolean {
    return this.cache.delete(key);
  }

  clear(): void {
    this.cache.clear();
  }

  get size(): number {
    return this.cache.size;
  }
}

/**
 * Single instance service for providing type definitions to panels.
 */
export class TypeDefinitionService {
  /** Global cache: cacheKey -> types result with metadata (shared across all panels) with LRU eviction */
  private globalTypeCache = new LRUTypeCache<CachedTypeResult>();

  /** Per-panel deps directories */
  private panelDepsCache = new Map<string, string>();

  /** Lock for concurrent directory creation */
  private depsDirLocks = new Map<string, Promise<string>>();

  /** Batch queues for package installations, keyed by depsDir */
  private batchQueues = new Map<string, BatchQueue>();

  /** Debounce delay to collect concurrent requests into batches */
  private readonly BATCH_DEBOUNCE_MS = 20;

  /** Cached @natstack package types (loaded lazily from packages dist folders) */
  private natstackTypes: Record<string, NatstackPackageTypes> | null = null;

  /**
   * Get @natstack package types from the local packages directory.
   * Loads lazily and caches the result.
   */
  private getNatstackTypes(packageName: string): Record<string, string> {
    // Lazy load @natstack types from packages dist folders
    if (this.natstackTypes === null) {
      // Use app packages dir (returns null in packaged builds)
      const packagesDir = getPackagesDir();
      if (packagesDir) {
        this.natstackTypes = loadNatstackPackageTypes(packagesDir);
        console.log(`[TypeDefinitionService] Loaded ${Object.keys(this.natstackTypes).length} @natstack/* packages from ${packagesDir}`);
      } else {
        this.natstackTypes = {};
        console.log(`[TypeDefinitionService] No packages directory found, @natstack/* types unavailable`);
      }
    }

    const pkgData = this.natstackTypes[packageName];
    if (!pkgData) {
      return {};
    }

    return pkgData.files;
  }

  /**
   * Get type definitions for a package.
   * Auto-installs via Arborist if not available.
   * Always installs latest version (version parameter removed for batching simplicity).
   *
   * @param panelPath - Path to the panel requesting types
   * @param packageName - The package to get types for
   * @returns Object with files map and referenced packages
   */
  async getPackageTypes(
    panelPath: string,
    packageName: string
  ): Promise<{ files: Record<string, string>; referencedPackages?: string[]; entryPoint?: string }> {
    // Handle @natstack/* packages - try local packages directory first
    if (packageName.startsWith("@natstack/")) {
      const types = this.getNatstackTypes(packageName);
      if (Object.keys(types).length > 0) {
        console.log(`[TypeDefinitionService] Serving ${packageName} types (${Object.keys(types).length} files)`);
        return { files: types };
      }
      // If no local types found (non-monorepo context), fall through to try
      // loading from installed node_modules via Verdaccio/Arborist
      console.log(`[TypeDefinitionService] No local types for ${packageName}, will try installed packages`);
    }

    // Skip packages that aren't real npm packages
    if (shouldSkipPackage(packageName)) {
      return { files: {} };
    }

    const cacheKey = `${packageName}@latest`;

    // 1. Check global cache first (cache includes full metadata)
    const cached = this.globalTypeCache.get(cacheKey);
    if (cached && cached.files.size > 0) {
      return {
        files: Object.fromEntries(cached.files),
        referencedPackages: cached.referencedPackages,
        entryPoint: cached.entryPoint ?? undefined,
      };
    }

    // 2. Get or create deps directory for this panel
    const depsDir = await this.ensurePanelDepsDir(panelPath);

    // 3. Try to load from existing node_modules
    let types = await this.tryLoadTypes(depsDir, packageName);

    // 4. If not found, install via Arborist and retry
    if (!types) {
      await this.installPackage(depsDir, packageName);
      types = await this.tryLoadTypes(depsDir, packageName);
    }

    if (types && types.files.size > 0) {
      this.globalTypeCache.set(cacheKey, {
        files: types.files,
        referencedPackages: types.referencedPackages,
        entryPoint: types.entryPoint,
      });
      return {
        files: Object.fromEntries(types.files),
        referencedPackages: types.referencedPackages,
        entryPoint: types.entryPoint ?? undefined,
      };
    }

    return { files: {} }; // No types available
  }

  /**
   * Install and load types for multiple packages in a single batch.
   * This is the primary API - always use this instead of single-package calls when possible.
   *
   * @returns Map of package name -> result with types or error
   */
  async getPackageTypesBatch(
    panelPath: string,
    packageNames: string[]
  ): Promise<Map<string, PackageTypesResult>> {
    const depsDir = await this.ensurePanelDepsDir(panelPath);
    const results = new Map<string, PackageTypesResult>();

    // Partition: cached/skipped vs needs-install
    const toInstall: string[] = [];

    for (const packageName of packageNames) {
      // Skip non-npm packages
      if (shouldSkipPackage(packageName)) {
        results.set(packageName, { files: {}, skipped: true });
        continue;
      }

      // Check @natstack/* local packages
      if (packageName.startsWith("@natstack/")) {
        const types = this.getNatstackTypes(packageName);
        if (Object.keys(types).length > 0) {
          results.set(packageName, { files: types });
          continue;
        }
      }

      // Check global cache
      const cacheKey = `${packageName}@latest`;
      const cached = this.globalTypeCache.get(cacheKey);
      if (cached && cached.files.size > 0) {
        results.set(packageName, {
          files: Object.fromEntries(cached.files),
          referencedPackages: cached.referencedPackages,
          entryPoint: cached.entryPoint ?? undefined,
        });
        continue;
      }

      toInstall.push(packageName);
    }

    if (toInstall.length === 0) return results;

    // Batch install (they naturally batch via debounce)
    const installResults = await Promise.allSettled(
      toInstall.map(async pkg => {
        await this.installPackage(depsDir, pkg);
        return pkg;
      })
    );

    // Load types for successfully installed packages and populate cache
    for (let i = 0; i < toInstall.length; i++) {
      const packageName = toInstall[i]!;
      const result = installResults[i]!;

      if (result.status === "rejected") {
        const reason = result.reason;
        results.set(packageName, {
          files: {},
          error: reason instanceof Error ? reason.message : String(reason),
        });
        continue;
      }

      // Load types and populate cache
      const types = await this.tryLoadTypes(depsDir, packageName);
      if (types && types.files.size > 0) {
        const cacheKey = `${packageName}@latest`;
        this.globalTypeCache.set(cacheKey, {
          files: types.files,
          referencedPackages: types.referencedPackages,
          entryPoint: types.entryPoint,
        });
        results.set(packageName, {
          files: Object.fromEntries(types.files),
          referencedPackages: types.referencedPackages,
          entryPoint: types.entryPoint ?? undefined,
        });
      } else {
        results.set(packageName, { files: {} });
      }
    }

    return results;
  }

  /**
   * Get the deps directory for a panel.
   */
  async getDepsDir(panelPath: string): Promise<string> {
    return this.ensurePanelDepsDir(panelPath);
  }

  /**
   * Ensure a panel has a deps directory, creating if needed.
   * Uses double-check locking to prevent race conditions.
   */
  private async ensurePanelDepsDir(panelPath: string): Promise<string> {
    // Fast path: already cached
    const cached = this.panelDepsCache.get(panelPath);
    if (cached) return cached;

    // Check if already being created
    const existingLock = this.depsDirLocks.get(panelPath);
    if (existingLock) return existingLock;

    // Create with double-check locking
    const createPromise = (async () => {
      try {
        // Double-check after acquiring "lock"
        const cached2 = this.panelDepsCache.get(panelPath);
        if (cached2) return cached2;

        const panelHash = hashString(panelPath);
        const depsDir = path.join(getTypesCacheDir(), panelHash);
        await fs.mkdir(depsDir, { recursive: true });
        this.panelDepsCache.set(panelPath, depsDir);
        return depsDir;
      } finally {
        this.depsDirLocks.delete(panelPath);
      }
    })();

    this.depsDirLocks.set(panelPath, createPromise);
    return createPromise;
  }

  /**
   * Try to load types from a deps directory.
   */
  private async tryLoadTypes(
    depsDir: string,
    packageName: string
  ): Promise<{ files: Map<string, string>; referencedPackages: string[]; entryPoint: string | null } | null> {
    const nodeModulesPath = path.join(depsDir, "node_modules");

    try {
      await fs.access(nodeModulesPath);
    } catch {
      return null;
    }

    const loader = createTypeDefinitionLoader({
      nodeModulesPaths: [nodeModulesPath],
    });

    const result = await loader.loadPackageTypes(packageName);
    if (!result) return null;

    return {
      files: result.files,
      referencedPackages: result.referencedPackages,
      entryPoint: result.entryPoint,
    };
  }

  /**
   * Queue a package for batch installation.
   * Multiple packages queued within BATCH_DEBOUNCE_MS are installed together.
   *
   * Always installs latest version (no version parameter - simplifies batching).
   * All waiters for same package name share the result.
   */
  private async installPackage(
    depsDir: string,
    packageName: string
  ): Promise<void> {
    // Get or create queue for this depsDir
    let queue = this.batchQueues.get(depsDir);
    if (!queue) {
      queue = { pending: new Map(), flushTimer: null, activeFlush: null };
      this.batchQueues.set(depsDir, queue);
    }

    // If flush in progress, wait for it then check if package was installed
    while (queue.activeFlush) {
      await queue.activeFlush;
      if (await this.isPackageInstalled(depsDir, packageName)) {
        return;
      }
      // Re-get queue (may have been pruned)
      queue = this.batchQueues.get(depsDir);
      if (!queue) {
        queue = { pending: new Map(), flushTimer: null, activeFlush: null };
        this.batchQueues.set(depsDir, queue);
      }
    }

    // Create promise for this request
    return new Promise((resolve, reject) => {
      // Key by package NAME for deduplication
      if (!queue!.pending.has(packageName)) {
        queue!.pending.set(packageName, []);
      }
      queue!.pending.get(packageName)!.push({ packageName, resolve, reject });

      // Reset debounce timer
      if (queue!.flushTimer) {
        clearTimeout(queue!.flushTimer);
      }

      queue!.flushTimer = setTimeout(() => {
        void this.flushBatch(depsDir);
      }, this.BATCH_DEBOUNCE_MS);
    });
  }

  /**
   * Check if a package is already installed in node_modules.
   */
  private async isPackageInstalled(depsDir: string, packageName: string): Promise<boolean> {
    const pkgPath = path.join(depsDir, "node_modules", ...packageName.split("/"), "package.json");
    try {
      await fs.access(pkgPath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Flush the batch queue, installing all pending packages together.
   * Serializes with any in-flight flush to prevent concurrent Arborist operations.
   */
  private async flushBatch(depsDir: string): Promise<void> {
    const queue = this.batchQueues.get(depsDir);
    if (!queue) return;

    // CRITICAL: Wait for any in-flight flush to complete first
    // This prevents concurrent doBatchInstall() calls racing on package.json/node_modules
    while (queue.activeFlush) {
      await queue.activeFlush;
    }

    // Check again after waiting - another flush may have processed our packages
    if (queue.pending.size === 0) {
      // Prune empty queue to prevent memory leak
      this.batchQueues.delete(depsDir);
      return;
    }

    // Clear timer
    if (queue.flushTimer) {
      clearTimeout(queue.flushTimer);
      queue.flushTimer = null;
    }

    // Snapshot and clear pending
    const batch = new Map(queue.pending);
    queue.pending.clear();

    // Extract package names for batch install
    const packageNames = [...batch.keys()];
    console.log(`[TypeDefinitionService] Batch installing ${packageNames.length} packages: ${packageNames.join(", ")}`);

    // Execute batch install
    queue.activeFlush = (async () => {
      try {
        await this.doBatchInstall(depsDir, packageNames);
        // Resolve all waiters on success
        for (const waiters of batch.values()) {
          for (const w of waiters) w.resolve();
        }
      } catch (error) {
        // Handle partial failures (async - properly awaited)
        await this.handleBatchError(depsDir, batch, error as Error);
      } finally {
        queue.activeFlush = null;
        // Prune empty queue
        if (queue.pending.size === 0) {
          this.batchQueues.delete(depsDir);
        }
      }
    })();

    await queue.activeFlush;
  }

  /**
   * Perform batch package installation.
   * Installs all packages in a single Arborist cycle, then adds @types/* for packages without built-in types.
   */
  private async doBatchInstall(
    depsDir: string,
    packageNames: string[]
  ): Promise<void> {
    const packageJsonPath = path.join(depsDir, "package.json");
    const npmrcPath = path.join(depsDir, ".npmrc");

    // Check once if Verdaccio is available (will auto-restart if crashed)
    const canServeNatstack = await canUseVerdaccio();

    // If Verdaccio is running, use it as the registry
    if (canServeNatstack) {
      const verdaccioUrl = getVerdaccioServer().getBaseUrl();
      await fs.writeFile(npmrcPath, `registry=${verdaccioUrl}\n`);
    } else {
      // Remove .npmrc if Verdaccio is not running (use default registry)
      try {
        await fs.access(npmrcPath);
        await fs.rm(npmrcPath);
      } catch {
        // File doesn't exist, nothing to remove
      }
    }

    // Read or create package.json, with recovery for corrupted files
    let packageJson: { name: string; private: boolean; dependencies: Record<string, string> };
    try {
      const content = await fs.readFile(packageJsonPath, "utf-8");
      if (!content || content.trim() === "") {
        throw new Error("Empty package.json");
      }
      packageJson = JSON.parse(content);
      // Validate basic structure
      if (typeof packageJson !== "object" || packageJson === null) {
        throw new Error("Invalid package.json structure");
      }
      // Ensure required fields exist
      if (!packageJson.dependencies) {
        packageJson.dependencies = {};
      }
    } catch (error) {
      // Start fresh with a new package.json (handles missing, empty, or corrupted files)
      const errorMsg = error instanceof Error ? error.message : String(error);
      if (!errorMsg.includes("ENOENT")) {
        console.log(`[TypeDefinitionService] Resetting corrupted package.json: ${errorMsg}`);
        // Also clean node_modules to ensure consistent state
        const nodeModulesPath = path.join(depsDir, "node_modules");
        try {
          await fs.rm(nodeModulesPath, { recursive: true, force: true });
        } catch {
          // Ignore cleanup errors
        }
      }
      packageJson = {
        name: "natstack-types-cache",
        private: true,
        dependencies: {},
      };
    }

    // Clean up stale entries from cached package.json that shouldn't be installed:
    // - @natstack/* packages (only skip if Verdaccio is NOT running - it can serve them)
    // - @types/natstack__* (DefinitelyTyped naming for scoped @natstack packages)
    // - Node built-ins, internal playwright aliases, blacklisted names
    // - @types/* variants of packages that shouldn't be fetched
    for (const dep of Object.keys(packageJson.dependencies)) {
      if (
        (!canServeNatstack && dep.startsWith("@natstack/")) ||
        dep.startsWith("@types/natstack__") ||
        shouldSkipPackage(dep) ||
        // Also clean @types/* for skippable packages (e.g., @types/node is fine, but @types/protocol__* is not)
        (dep.startsWith("@types/") && shouldSkipPackage(dep.replace("@types/", "").replace("__", "/")))
      ) {
        delete packageJson.dependencies[dep];
      }
    }

    // Add ALL packages to dependencies (always latest/*)
    for (const name of packageNames) {
      packageJson.dependencies[name] = "*";
    }

    // Write package.json
    await fs.writeFile(packageJsonPath, JSON.stringify(packageJson, null, 2));

    // Install all packages with retry logic for stale @types/* 404 errors
    let retryCount = 0;
    const maxRetries = 5;

    while (retryCount < maxRetries) {
      try {
        // Pass registry directly to Arborist - .npmrc is not always read reliably
        // Use legacyPeerDeps to handle peer dependency conflicts (e.g., zod v3 vs v4)
        const arboristOptions: { path: string; registry?: string; legacyPeerDeps?: boolean } = {
          path: depsDir,
          legacyPeerDeps: true,
        };
        if (canServeNatstack) {
          arboristOptions.registry = getVerdaccioServer().getBaseUrl();
        }
        const arborist = new Arborist(arboristOptions);
        await arborist.buildIdealTree();
        await arborist.reify();
        break; // Success
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);

        // Check if it's a 404 for a package (stale cache entry)
        // Handles both npm registry and Verdaccio URLs
        const failedPackage = extractPackageFrom404(errorMsg);
        if (failedPackage && packageJson.dependencies[failedPackage]) {
          console.log(
            `[TypeDefinitionService] Removing stale entry: ${failedPackage}`
          );
          delete packageJson.dependencies[failedPackage];
          await fs.writeFile(packageJsonPath, JSON.stringify(packageJson, null, 2));
          retryCount++;
          continue; // Retry without the stale entry
        }

        // Check if it's an ERESOLVE error (peer dependency conflict)
        // This shouldn't happen with legacyPeerDeps but create a clear error if it does
        if (errorMsg.includes("ERESOLVE") || errorMsg.includes("could not resolve")) {
          // Extract conflicting package info for a cleaner error message
          const conflictMatch = errorMsg.match(/peer\s+(\S+@[^\s]+)\s+from\s+(\S+)/);
          const foundMatch = errorMsg.match(/Found:\s+(\S+@[^\s]+)/);

          let cleanError: string;
          if (conflictMatch && foundMatch) {
            cleanError = `Peer dependency conflict: ${conflictMatch[2]} requires ${conflictMatch[1]}, but found ${foundMatch[1]}`;
          } else if (conflictMatch) {
            cleanError = `Peer dependency conflict: ${conflictMatch[2]} requires ${conflictMatch[1]} at incompatible version`;
          } else {
            cleanError = `Peer dependency conflict during batch install`;
          }

          console.error(`[TypeDefinitionService] ${cleanError}`);
          throw new Error(cleanError);
        }

        // Check if it's an ENOTEMPTY error (corrupted node_modules/Arborist state)
        if (errorMsg.includes("ENOTEMPTY") && retryCount === 0) {
          // Only try this once - delete the entire deps directory for a fresh start
          console.log(`[TypeDefinitionService] Corrupted Arborist state detected, resetting deps directory...`);
          try {
            // Use shell rm -rf as a fallback since fs.rm can fail with ENOTEMPTY on some systems
            const { execSync } = await import("child_process");
            try {
              execSync(`rm -rf "${depsDir}"`, { timeout: 30000 });
            } catch {
              // Fallback to fs.rm if shell fails
              await fs.rm(depsDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
            }
            await fs.mkdir(depsDir, { recursive: true });
            // Recreate package.json with our packages
            packageJson = {
              name: "natstack-types-cache",
              private: true,
              dependencies: {},
            };
            for (const name of packageNames) {
              packageJson.dependencies[name] = "*";
            }
            await fs.writeFile(packageJsonPath, JSON.stringify(packageJson, null, 2));
            // Also recreate .npmrc if needed
            if (canServeNatstack) {
              const verdaccioUrl = getVerdaccioServer().getBaseUrl();
              await fs.writeFile(npmrcPath, `registry=${verdaccioUrl}\n`);
            }
          } catch (cleanupError) {
            console.error(`[TypeDefinitionService] Failed to reset deps directory:`, cleanupError);
          }
          retryCount++;
          continue; // Retry with completely fresh directory
        }

        // Not a recoverable error
        console.error(
          `[TypeDefinitionService] Failed batch install:`,
          errorMsg
        );
        throw new Error(
          `Failed to install types: ${errorMsg}`
        );
      }
    }

    if (retryCount >= maxRetries) {
      throw new Error(
        `Failed to install types: Too many stale @types/* entries in cache`
      );
    }

    // Batch @types/* installation for packages without built-in types
    await this.installMissingTypesPackages(depsDir, packageNames, packageJson, canServeNatstack);
  }

  /**
   * Check which packages need @types/* and install them in one batch.
   */
  private async installMissingTypesPackages(
    depsDir: string,
    packageNames: string[],
    packageJson: { name: string; private: boolean; dependencies: Record<string, string> },
    canServeNatstack: boolean
  ): Promise<void> {
    const packageJsonPath = path.join(depsDir, "package.json");
    const nodeModulesPath = path.join(depsDir, "node_modules");
    const typesNeeded: string[] = [];

    // Check each package for built-in types
    for (const name of packageNames) {
      if (name.startsWith("@types/")) continue;

      const pkgJsonPath = path.join(nodeModulesPath, ...name.split("/"), "package.json");
      try {
        const content = await fs.readFile(pkgJsonPath, "utf-8");
        const pkg = JSON.parse(content) as { types?: string; typings?: string };
        if (!pkg.types && !pkg.typings) {
          const typesPackage = `@types/${name.replace("@", "").replace("/", "__")}`;
          typesNeeded.push(typesPackage);
        }
      } catch {
        // Package doesn't exist or no package.json
      }
    }

    if (typesNeeded.length === 0) return;

    console.log(`[TypeDefinitionService] Installing @types/* for ${typesNeeded.length} packages`);

    // Add all @types/* packages
    for (const typesPkg of typesNeeded) {
      packageJson.dependencies[typesPkg] = "*";
    }
    await fs.writeFile(packageJsonPath, JSON.stringify(packageJson, null, 2));

    const arboristOptions: { path: string; registry?: string; legacyPeerDeps?: boolean } = {
      path: depsDir,
      legacyPeerDeps: true,
    };
    if (canServeNatstack) {
      arboristOptions.registry = getVerdaccioServer().getBaseUrl();
    }

    try {
      const arborist = new Arborist(arboristOptions);
      await arborist.buildIdealTree();
      await arborist.reify();
    } catch (error) {
      // Some @types/* don't exist - remove 404'd one and retry
      const errorMsg = String(error);
      const failedPkg = extractPackageFrom404(errorMsg);

      if (failedPkg && packageJson.dependencies[failedPkg]) {
        console.log(`[TypeDefinitionService] @types/* not found: ${failedPkg}`);
        delete packageJson.dependencies[failedPkg];
        await fs.writeFile(packageJsonPath, JSON.stringify(packageJson, null, 2));

        // Retry with remaining @types/*
        const remaining = typesNeeded.filter(t => packageJson.dependencies[t]);
        if (remaining.length > 0) {
          try {
            const arborist = new Arborist(arboristOptions);
            await arborist.buildIdealTree();
            await arborist.reify();
          } catch (retryError) {
            // Recursively handle additional 404s
            const retryMsg = String(retryError);
            const retryFailedPkg = extractPackageFrom404(retryMsg);
            if (retryFailedPkg && packageJson.dependencies[retryFailedPkg]) {
              console.log(`[TypeDefinitionService] @types/* not found: ${retryFailedPkg}`);
              delete packageJson.dependencies[retryFailedPkg];
              await fs.writeFile(packageJsonPath, JSON.stringify(packageJson, null, 2));
            }
            // Don't throw - @types/* failures are non-fatal
          }
        }
      }
      // Don't throw - @types/* failures are non-fatal
    }
  }

  /**
   * Handle batch install errors with partial failure isolation.
   * Returns a promise that resolves when all retries are complete.
   */
  private async handleBatchError(
    depsDir: string,
    batch: Map<string, PendingInstall[]>,  // keyed by package name
    error: Error
  ): Promise<void> {
    const errorMsg = error.message;

    // Check for 404 on specific package (handles both npm registry and Verdaccio)
    const failedPackage = extractPackageFrom404(errorMsg);

    if (failedPackage && batch.has(failedPackage)) {
      // Reject only failed package's waiters
      const failedWaiters = batch.get(failedPackage) || [];
      for (const w of failedWaiters) {
        w.reject(new Error(`Package not found: ${failedPackage}`));
      }
      batch.delete(failedPackage);

      // Retry remaining packages
      if (batch.size > 0) {
        const remainingNames = [...batch.keys()];
        try {
          await this.doBatchInstall(depsDir, remainingNames);
          for (const waiters of batch.values()) {
            for (const w of waiters) w.resolve();
          }
        } catch (retryError) {
          await this.handleBatchError(depsDir, batch, retryError as Error);
        }
        return;
      }
    }

    // Unknown error - reject all
    for (const waiters of batch.values()) {
      for (const w of waiters) w.reject(error);
    }
  }

  /**
   * Clear the global type cache.
   */
  clearCache(): void {
    this.globalTypeCache.clear();
  }

  /**
   * Clear cache for a specific package.
   */
  clearPackageCache(packageName: string, version?: string): void {
    const cacheKey = `${packageName}@${version || "latest"}`;
    this.globalTypeCache.delete(cacheKey);
  }

  /**
   * Invalidate @natstack/* types cache and panel deps cache.
   * Call when workspace packages change to ensure fresh types are loaded.
   */
  invalidateNatstackTypes(): void {
    this.natstackTypes = null;
    this.panelDepsCache.clear();
    console.log("[TypeDefinitionService] @natstack/* types and panel deps cache invalidated");
  }

  /**
   * Clean up resources. Call when app is shutting down.
   */
  shutdown(): void {
    this.globalTypeCache.clear();
    this.panelDepsCache.clear();
    this.natstackTypes = null;
    // Clear batch queues
    for (const queue of this.batchQueues.values()) {
      if (queue.flushTimer) {
        clearTimeout(queue.flushTimer);
      }
    }
    this.batchQueues.clear();
    // Note: depsDirLocks clean themselves up via .finally()
  }
}

// Singleton instance
let serviceInstance: TypeDefinitionService | null = null;

/**
 * Get the TypeDefinitionService singleton.
 */
export function getTypeDefinitionService(): TypeDefinitionService {
  if (!serviceInstance) {
    serviceInstance = new TypeDefinitionService();
  }
  return serviceInstance;
}

/**
 * RPC methods to expose via the service dispatcher.
 */
export const typeCheckRpcMethods = {
  "typecheck.getPackageTypes": async (
    panelPath: string,
    packageName: string
  ): Promise<{ files: Record<string, string>; referencedPackages?: string[]; entryPoint?: string }> => {
    return getTypeDefinitionService().getPackageTypes(panelPath, packageName);
  },

  "typecheck.getPackageTypesBatch": async (
    panelPath: string,
    packageNames: string[]
  ): Promise<Record<string, PackageTypesResult>> => {
    const results = await getTypeDefinitionService().getPackageTypesBatch(panelPath, packageNames);
    return Object.fromEntries(results);
  },

  "typecheck.getDepsDir": async (panelPath: string): Promise<string> => {
    return getTypeDefinitionService().getDepsDir(panelPath);
  },

  "typecheck.clearCache": async (): Promise<void> => {
    getTypeDefinitionService().clearCache();
  },

  "typecheck.clearPackageCache": async (
    packageName: string,
    version?: string
  ): Promise<void> => {
    getTypeDefinitionService().clearPackageCache(packageName, version);
  },
};

/**
 * Shutdown the TypeDefinitionService singleton and clean up resources.
 * Call when app is shutting down or for testing cleanup.
 */
export function shutdownTypeDefinitionService(): void {
  if (serviceInstance) {
    serviceInstance.shutdown();
    serviceInstance = null;
  }
}
