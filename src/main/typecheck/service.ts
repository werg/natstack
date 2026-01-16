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
import { createTypeDefinitionLoader } from "@natstack/runtime/typecheck";
import { app } from "electron";

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
  // Skip node built-ins
  if (NODE_BUILTINS.has(packageName)) {
    return true;
  }

  // Skip internal playwright/bundled package aliases
  for (const prefix of INTERNAL_PREFIXES) {
    if (packageName.startsWith(prefix)) {
      return true;
    }
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

/**
 * Simple LRU cache for type definitions.
 * Uses a Map (which maintains insertion order) and moves accessed items to end.
 */
class LRUTypeCache {
  private cache = new Map<string, Map<string, string>>();
  private maxSize: number;

  constructor(maxSize: number = MAX_TYPE_CACHE_ENTRIES) {
    this.maxSize = maxSize;
  }

  get(key: string): Map<string, string> | undefined {
    const value = this.cache.get(key);
    if (value !== undefined) {
      // Move to end (most recently used)
      this.cache.delete(key);
      this.cache.set(key, value);
    }
    return value;
  }

  set(key: string, value: Map<string, string>): void {
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
  /** Global cache: cacheKey -> types map (shared across all panels) with LRU eviction */
  private globalTypeCache = new LRUTypeCache();

  /** Per-panel deps directories */
  private panelDepsCache = new Map<string, string>();

  /** Lock for concurrent directory creation */
  private depsDirLocks = new Map<string, Promise<string>>();

  /** Lock for concurrent installations */
  private installLocks = new Map<string, Promise<void>>();

  /**
   * Get type definitions for a package.
   * Auto-installs via Arborist if not available.
   *
   * @param panelPath - Path to the panel requesting types
   * @param packageName - The package to get types for
   * @param version - Optional specific version
   * @returns Map of file paths to contents (as plain object for RPC)
   */
  async getPackageTypes(
    panelPath: string,
    packageName: string,
    version?: string
  ): Promise<Record<string, string>> {
    // Skip @natstack/* packages - they're bundled in the runtime TypeCheckService
    if (packageName.startsWith("@natstack/")) {
      console.log(`[TypeDefinitionService] ${packageName} types are bundled - skipping npm`);
      return {};
    }

    // Skip packages that aren't real npm packages
    if (shouldSkipPackage(packageName)) {
      return {};
    }

    const cacheKey = `${packageName}@${version || "latest"}`;

    // 1. Check global cache first
    const cached = this.globalTypeCache.get(cacheKey);
    if (cached) {
      return Object.fromEntries(cached);
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
      this.globalTypeCache.set(cacheKey, types.files);
      return Object.fromEntries(types.files);
    }

    return {}; // No types available
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
  ): Promise<{ files: Map<string, string> } | null> {
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
    return result;
  }

  /**
   * Install a package using Arborist.
   * Uses a lock to prevent concurrent installations of the same package.
   */
  private installPackage(
    depsDir: string,
    packageName: string,
    version?: string
  ): Promise<void> {
    const spec = version ? `${packageName}@${version}` : packageName;
    const lockKey = `${depsDir}:${spec}`;

    // Atomic getOrCreate: if lock exists, return it; otherwise create and store atomically
    const existingLock = this.installLocks.get(lockKey);
    if (existingLock) {
      return existingLock;
    }

    // Create the installation promise and store it atomically (synchronous operations)
    // This ensures no TOCTOU race: the check-and-set happens in the same synchronous block
    const installPromise = this.doInstall(depsDir, spec).finally(() => {
      // Clean up lock after completion (success or failure)
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

    // Read or create package.json
    let packageJson: { name: string; private: boolean; dependencies: Record<string, string> };
    try {
      const content = await fs.readFile(packageJsonPath, "utf-8");
      packageJson = JSON.parse(content);
    } catch {
      packageJson = {
        name: "natstack-types-cache",
        private: true,
        dependencies: {},
      };
    }

    // Clean up stale entries from cached package.json that shouldn't be installed:
    // - @natstack/* packages (bundled in runtime)
    // - @types/natstack__* (DefinitelyTyped naming for scoped @natstack packages)
    // - Node built-ins, internal playwright aliases, blacklisted names
    // - @types/* variants of packages that shouldn't be fetched
    for (const dep of Object.keys(packageJson.dependencies)) {
      if (
        dep.startsWith("@natstack/") ||
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
        const arborist = new Arborist({ path: depsDir });
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
        const arborist = new Arborist({ path: depsDir });
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
   * Clean up resources. Call when app is shutting down.
   */
  shutdown(): void {
    this.globalTypeCache.clear();
    this.panelDepsCache.clear();
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
  ): Promise<Record<string, string>> => {
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

/**
 * Reset the singleton for testing. DO NOT use in production code.
 * @internal
 * @deprecated Use shutdownTypeDefinitionService instead
 */
export function _resetTypeDefinitionServiceForTesting(): void {
  shutdownTypeDefinitionService();
}
