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

  /** Lock for concurrent installations */
  private installLocks = new Map<string, Promise<void>>();

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
   *
   * @param panelPath - Path to the panel requesting types
   * @param packageName - The package to get types for
   * @param version - Optional specific version
   * @returns Object with files map and referenced packages
   */
  async getPackageTypes(
    panelPath: string,
    packageName: string,
    version?: string
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

    const cacheKey = `${packageName}@${version || "latest"}`;

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
      await this.installPackage(depsDir, packageName, version);
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
   * Install a package using Arborist.
   * Uses a per-directory lock to prevent concurrent installations from corrupting package.json.
   * Multiple packages for the same depsDir are serialized properly.
   */
  private async installPackage(
    depsDir: string,
    packageName: string,
    version?: string
  ): Promise<void> {
    const spec = version ? `${packageName}@${version}` : packageName;
    // Lock per-directory, not per-package, since all packages share the same package.json
    const lockKey = depsDir;

    // Spin-wait for lock to become available (proper serialization)
    while (true) {
      const existingLock = this.installLocks.get(lockKey);
      if (!existingLock) {
        break; // Lock is free, we can proceed
      }
      // Wait for existing install to complete
      await existingLock;
      // Loop back to check again (another waiter may have grabbed the lock)
    }

    // Create the installation promise and store it atomically
    const installPromise = this.doInstall(depsDir, spec).finally(() => {
      this.installLocks.delete(lockKey);
    });

    this.installLocks.set(lockKey, installPromise);
    return installPromise;
  }

  /**
   * Perform the actual package installation.
   * Installs the main package first, then tries @types/* only if needed.
   */
  private async doInstall(depsDir: string, spec: string): Promise<void> {
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

    // Parse spec to get package name and version
    const atIndex = spec.lastIndexOf("@");
    let pkgName: string;
    let pkgVersion: string;

    if (atIndex > 0) {
      pkgName = spec.slice(0, atIndex);
      pkgVersion = spec.slice(atIndex + 1);
    } else {
      pkgName = spec;
      pkgVersion = "*";
    }

    // Add only the main package first (not @types/*)
    // Many packages ship their own types (zod, @radix-ui/*, etc.)
    packageJson.dependencies[pkgName] = pkgVersion;

    // Write package.json
    await fs.writeFile(packageJsonPath, JSON.stringify(packageJson, null, 2));

    // Install the main package, with retry logic for stale @types/* 404 errors
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
        // URL format: https://registry.npmjs.org/@types%2fzod or https://registry.npmjs.org/some-pkg
        const pkg404Match = errorMsg.match(/404.*registry\.npmjs\.org\/(@?[a-z0-9_-]+(?:%2f[a-z0-9_-]+)?)/i);
        if (pkg404Match?.[1]) {
          // Decode URL-encoded package name: @types%2fzod -> @types/zod
          const failedPackage = decodeURIComponent(pkg404Match[1]);
          if (packageJson.dependencies[failedPackage]) {
            console.log(
              `[TypeDefinitionService] Removing stale entry: ${failedPackage}`
            );
            delete packageJson.dependencies[failedPackage];
            await fs.writeFile(packageJsonPath, JSON.stringify(packageJson, null, 2));
            retryCount++;
            continue; // Retry without the stale entry
          }
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
            cleanError = `Peer dependency conflict (run 'npm install ${spec} --legacy-peer-deps' manually to see details)`;
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
            // Recreate package.json with just our package
            packageJson = {
              name: "natstack-types-cache",
              private: true,
              dependencies: { [pkgName]: pkgVersion },
            };
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
          `[TypeDefinitionService] Failed to install ${spec}:`,
          errorMsg
        );
        throw new Error(
          `Failed to install types for ${spec}: ${errorMsg}`
        );
      }
    }

    if (retryCount >= maxRetries) {
      throw new Error(
        `Failed to install types for ${spec}: Too many stale @types/* entries in cache`
      );
    }

    // Check if the installed package has its own types
    const nodeModulesPath = path.join(depsDir, "node_modules");
    const pkgJsonPath = path.join(nodeModulesPath, ...pkgName.split("/"), "package.json");
    let hasOwnTypes = false;

    try {
      const pkgContent = await fs.readFile(pkgJsonPath, "utf-8");
      const pkg = JSON.parse(pkgContent) as { types?: string; typings?: string };
      hasOwnTypes = Boolean(pkg.types || pkg.typings);
    } catch {
      // Package might not exist or have package.json
    }

    // If package doesn't have its own types and it's not already a @types package, try @types/*
    if (!hasOwnTypes && !pkgName.startsWith("@types/")) {
      const typesPackage = `@types/${pkgName.replace("@", "").replace("/", "__")}`;

      // Add @types/* and try to install (but don't fail if it doesn't exist)
      packageJson.dependencies[typesPackage] = "*";
      await fs.writeFile(packageJsonPath, JSON.stringify(packageJson, null, 2));

      try {
        // Pass registry directly to Arborist - .npmrc is not always read reliably
        // Use legacyPeerDeps to handle peer dependency conflicts
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
      } catch (typesError) {
        // @types/* doesn't exist - that's okay, remove it from dependencies
        delete packageJson.dependencies[typesPackage];
        await fs.writeFile(packageJsonPath, JSON.stringify(packageJson, null, 2));
        console.log(
          `[TypeDefinitionService] No @types/${pkgName} available (package may ship its own types)`
        );
      }
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
    // Note: depsDirLocks and installLocks clean themselves up via .finally()
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
    packageName: string,
    version?: string
  ): Promise<{ files: Record<string, string>; referencedPackages?: string[]; entryPoint?: string }> => {
    return getTypeDefinitionService().getPackageTypes(panelPath, packageName, version);
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
