/**
 * Disk-based cache storage for panel builds and ESM modules
 *
 * Stored in app data directory, shared across all panels
 */

import { promises as fsPromises } from "fs";
import * as path from "path";
import { app } from "electron";
import { createDevLogger } from "./devLog.js";

const log = createDevLogger("DiskCache");

export interface DiskCacheEntry {
  key: string;
  value: string;
  timestamp: number;
  size: number;
}

export interface DiskCacheData {
  version: string;
  entries: Record<string, DiskCacheEntry>;
}

const CACHE_VERSION = "8"; // Bumped: dirty packages now use content hash instead of mtime
const CACHE_FILENAME = "build-cache.json";

/**
 * Get the cache file path
 */
function getCacheFilePath(): string {
  const userDataPath = app.getPath("userData");
  return path.join(userDataPath, CACHE_FILENAME);
}

/**
 * Load cache from disk
 */
export async function loadDiskCache(): Promise<Record<string, DiskCacheEntry>> {
  const cacheFilePath = getCacheFilePath();

  try {
    // Check if file exists using fsPromises.access
    try {
      await fsPromises.access(cacheFilePath);
    } catch {
      console.log("[DiskCache] No cache file found, starting fresh");
      return {};
    }

    const content = await fsPromises.readFile(cacheFilePath, "utf-8");

    const data = JSON.parse(content) as DiskCacheData;

    if (data.version !== CACHE_VERSION) {
      console.log(
        `[DiskCache] Cache version mismatch (${data.version} vs ${CACHE_VERSION}), discarding`
      );
      return {};
    }

    const entryCount = Object.keys(data.entries).length;
    log.verbose(` Loaded ${entryCount} entries from disk`);
    return data.entries;
  } catch (error) {
    console.error("[DiskCache] Failed to load cache from disk:", error);
    return {};
  }
}

/**
 * Save cache to disk with atomic write
 */
export async function saveDiskCache(entries: Record<string, DiskCacheEntry>): Promise<void> {
  const cacheFilePath = getCacheFilePath();
  const tempPath = `${cacheFilePath}.tmp`;

  try {
    const data: DiskCacheData = {
      version: CACHE_VERSION,
      entries,
    };

    // Use compact JSON (no pretty-printing) to reduce disk usage
    const content = JSON.stringify(data);
    const contentSizeBytes = Buffer.byteLength(content, "utf-8");
    const contentSizeMB = (contentSizeBytes / 1024 / 1024).toFixed(2);

    // Check available disk space (require 2x content size for safety)
    const userDataPath = app.getPath("userData");
    try {
      const stats = await fsPromises.statfs(userDataPath);
      const availableBytes = stats.bavail * stats.bsize;
      const requiredBytes = contentSizeBytes * 2;

      if (availableBytes < requiredBytes) {
        const availableMB = (availableBytes / 1024 / 1024).toFixed(2);
        const requiredMB = (requiredBytes / 1024 / 1024).toFixed(2);
        throw new Error(
          `Insufficient disk space: ${availableMB}MB available, ${requiredMB}MB required (${contentSizeMB}MB cache + safety margin)`
        );
      }
    } catch (statfsError) {
      // statfs may not be available on all platforms, log warning but continue
      console.warn("[DiskCache] Unable to check disk space:", statfsError);
    }

    // Write to temporary file first (atomic write pattern)
    await fsPromises.writeFile(tempPath, content, "utf-8");

    // Atomically rename temp file to final location
    await fsPromises.rename(tempPath, cacheFilePath);

    const entryCount = Object.keys(entries).length;
    log.verbose(` Saved ${entryCount} entries to disk (${contentSizeMB}MB)`);
  } catch (error) {
    console.error("[DiskCache] Failed to save cache to disk:", error);

    // Clean up temp file if it exists
    try {
      await fsPromises.unlink(tempPath);
    } catch {
      // Ignore cleanup errors
    }

    throw error; // Re-throw to signal failure to caller
  }
}

/**
 * Clear disk cache
 */
export async function clearDiskCache(): Promise<void> {
  const cacheFilePath = getCacheFilePath();

  try {
    // Check if file exists before trying to delete
    try {
      await fsPromises.access(cacheFilePath);
      await fsPromises.unlink(cacheFilePath);
      console.log("[DiskCache] Cleared disk cache");
    } catch {
      // File doesn't exist, nothing to clear
    }
  } catch (error) {
    console.error("[DiskCache] Failed to clear disk cache:", error);
  }
}

/**
 * Get disk cache file size in bytes
 */
export async function getDiskCacheSize(): Promise<number> {
  const cacheFilePath = getCacheFilePath();

  try {
    const stats = await fsPromises.stat(cacheFilePath);
    return stats.size;
  } catch (error) {
    // File doesn't exist or can't be accessed
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return 0;
    }
    console.error("[DiskCache] Failed to get cache size:", error);
    return 0;
  }
}
