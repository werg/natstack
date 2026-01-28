/**
 * Unified Cache Management Utility
 *
 * Provides a single interface for clearing and inspecting all cache layers
 * in the natstack build system.
 *
 * Cache layers:
 * 1. MainCacheManager - In-memory LRU cache for build results
 * 2. DiskCache - ~/.config/natstack/build-cache.json
 * 3. VerdaccioStorage - ~/.config/natstack/verdaccio-storage/
 * 4. BuildArtifacts - ~/.config/natstack/build-artifacts/
 * 5. TypesCache - ~/.config/natstack/types-cache/
 * 6. npm cache - ~/.npm/_cacache/ (via npm cache clean)
 * 7. pnpm store - global pnpm store (via pnpm store prune)
 */

import { promises as fsPromises, existsSync } from "fs";
import * as path from "path";
import { app } from "electron";
import { exec } from "child_process";
import { promisify } from "util";
import { getMainCacheManager } from "./cacheManager.js";
import { clearDiskCache, getDiskCacheSize } from "./diskCache.js";
import { getBuildArtifactsDirectory, getCentralConfigDirectory } from "./paths.js";

const execAsync = promisify(exec);

export interface CacheClearOptions {
  /** Clear in-memory + disk build cache (default: true) */
  buildCache?: boolean;
  /** Clear Verdaccio package storage (default: true) */
  verdaccioStorage?: boolean;
  /** Clear build output directories (default: true) */
  buildArtifacts?: boolean;
  /** Clear TypeScript type definitions cache (default: true) */
  typesCache?: boolean;
  /** Clear npm's fetch cache (default: false - can be slow) */
  npmCache?: boolean;
  /** Prune pnpm global store (default: false - can be slow) */
  pnpmStore?: boolean;
}

export interface CacheClearResult {
  success: boolean;
  cleared: {
    buildCache: boolean;
    verdaccioStorage: boolean;
    buildArtifacts: boolean;
    typesCache: boolean;
    npmCache: boolean;
    pnpmStore: boolean;
  };
  errors: string[];
  /** Total bytes freed across all caches */
  bytesFreed: number;
}

/**
 * Get the Verdaccio storage directory path.
 */
function getVerdaccioStoragePath(): string {
  return path.join(app.getPath("userData"), "verdaccio-storage");
}

/**
 * Get the types cache directory path.
 */
function getTypesCachePath(): string {
  return path.join(app.getPath("userData"), "types-cache");
}

/**
 * Recursively calculate the size of a directory in bytes.
 */
async function getDirectorySize(dirPath: string): Promise<number> {
  if (!existsSync(dirPath)) return 0;

  let totalSize = 0;

  async function walkDir(dir: string): Promise<void> {
    try {
      const entries = await fsPromises.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await walkDir(fullPath);
        } else if (entry.isFile()) {
          try {
            const stats = await fsPromises.stat(fullPath);
            totalSize += stats.size;
          } catch {
            // Skip files we can't stat
          }
        }
      }
    } catch {
      // Skip directories we can't read
    }
  }

  await walkDir(dirPath);
  return totalSize;
}

/**
 * Recursively remove a directory and all its contents.
 * Uses shell rm -rf which is more reliable than fs.rm for complex directory trees
 * (e.g., electron node_modules with special files that can cause fs.rm to hang).
 */
async function removeDirectory(dirPath: string): Promise<boolean> {
  if (!existsSync(dirPath)) return true;

  try {
    await execAsync(`rm -rf "${dirPath}"`, { timeout: 30000 });
    return true;
  } catch (error) {
    console.error(`[CacheUtils] Failed to remove ${dirPath}:`, error);
    return false;
  }
}

/**
 * Clear all caches based on the provided options.
 *
 * By default, clears buildCache, verdaccioStorage, buildArtifacts, and typesCache.
 * npm cache and pnpm store are opt-in due to their system-wide nature.
 *
 * @param options - Which caches to clear (all local caches by default)
 * @returns Result indicating success/failure and bytes freed
 */
export async function clearAllCaches(options?: CacheClearOptions): Promise<CacheClearResult> {
  const opts: Required<CacheClearOptions> = {
    buildCache: options?.buildCache ?? true,
    verdaccioStorage: options?.verdaccioStorage ?? true,
    buildArtifacts: options?.buildArtifacts ?? true,
    typesCache: options?.typesCache ?? true,
    npmCache: options?.npmCache ?? false,
    pnpmStore: options?.pnpmStore ?? false,
  };

  const result: CacheClearResult = {
    success: true,
    cleared: {
      buildCache: false,
      verdaccioStorage: false,
      buildArtifacts: false,
      typesCache: false,
      npmCache: false,
      pnpmStore: false,
    },
    errors: [],
    bytesFreed: 0,
  };

  // Track sizes before clearing
  let sizesBefore = {
    buildCache: 0,
    verdaccioStorage: 0,
    buildArtifacts: 0,
    typesCache: 0,
  };

  try {
    // Get sizes before clearing (in parallel)
    const [diskCacheSize, verdaccioSize, buildArtifactsSize, typesCacheSize] = await Promise.all([
      getDiskCacheSize(),
      getDirectorySize(getVerdaccioStoragePath()),
      getDirectorySize(getBuildArtifactsDirectory()),
      getDirectorySize(getTypesCachePath()),
    ]);

    sizesBefore = {
      buildCache: diskCacheSize,
      verdaccioStorage: verdaccioSize,
      buildArtifacts: buildArtifactsSize,
      typesCache: typesCacheSize,
    };
  } catch (error) {
    console.warn("[CacheUtils] Failed to measure cache sizes:", error);
  }

  // Clear build cache (in-memory + disk + resolution cache)
  if (opts.buildCache) {
    try {
      await getMainCacheManager().clear();
      await clearDiskCache();
      // Also clear package store's resolution cache to ensure fresh dependency resolution
      try {
        const { getPackageStore } = await import("./package-store/store.js");
        const store = await getPackageStore();
        const cleared = store.clearResolutionCache();
        console.log(`[CacheUtils] Cleared ${cleared} resolution cache entries`);
      } catch (error) {
        console.warn("[CacheUtils] Failed to clear resolution cache:", error);
      }
      result.cleared.buildCache = true;
      result.bytesFreed += sizesBefore.buildCache;
      console.log("[CacheUtils] Cleared build cache");
    } catch (error) {
      result.errors.push(`buildCache: ${String(error)}`);
      result.success = false;
    }
  }

  // Clear Verdaccio storage
  if (opts.verdaccioStorage) {
    try {
      const verdaccioPath = getVerdaccioStoragePath();
      if (await removeDirectory(verdaccioPath)) {
        result.cleared.verdaccioStorage = true;
        result.bytesFreed += sizesBefore.verdaccioStorage;
        console.log("[CacheUtils] Cleared Verdaccio storage");
      } else {
        throw new Error("Failed to remove directory");
      }
    } catch (error) {
      result.errors.push(`verdaccioStorage: ${String(error)}`);
      result.success = false;
    }
  }

  // Clear build artifacts
  if (opts.buildArtifacts) {
    try {
      const artifactsPath = getBuildArtifactsDirectory();
      if (await removeDirectory(artifactsPath)) {
        result.cleared.buildArtifacts = true;
        result.bytesFreed += sizesBefore.buildArtifacts;
        console.log("[CacheUtils] Cleared build artifacts");
      } else {
        throw new Error("Failed to remove directory");
      }
    } catch (error) {
      result.errors.push(`buildArtifacts: ${String(error)}`);
      result.success = false;
    }
  }

  // Clear types cache
  if (opts.typesCache) {
    try {
      const typesCachePath = getTypesCachePath();
      if (await removeDirectory(typesCachePath)) {
        result.cleared.typesCache = true;
        result.bytesFreed += sizesBefore.typesCache;
        console.log("[CacheUtils] Cleared types cache");
      } else {
        throw new Error("Failed to remove directory");
      }
    } catch (error) {
      result.errors.push(`typesCache: ${String(error)}`);
      result.success = false;
    }
  }

  // Clear npm cache (opt-in, system-wide)
  if (opts.npmCache) {
    try {
      await execAsync("npm cache clean --force", { timeout: 60000 });
      result.cleared.npmCache = true;
      console.log("[CacheUtils] Cleared npm cache");
    } catch (error) {
      result.errors.push(`npmCache: ${String(error)}`);
      // Don't fail the whole operation for npm cache issues
    }
  }

  // Prune pnpm store (opt-in, system-wide)
  if (opts.pnpmStore) {
    try {
      await execAsync("pnpm store prune", { timeout: 120000 });
      result.cleared.pnpmStore = true;
      console.log("[CacheUtils] Pruned pnpm store");
    } catch (error) {
      result.errors.push(`pnpmStore: ${String(error)}`);
      // Don't fail the whole operation for pnpm store issues
    }
  }

  const freedMB = (result.bytesFreed / 1024 / 1024).toFixed(2);
  console.log(`[CacheUtils] Cache clearing complete. Freed ~${freedMB}MB`);

  return result;
}

