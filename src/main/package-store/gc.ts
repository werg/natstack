/**
 * Garbage Collection for Package Store
 *
 * Removes packages not accessed recently and orphaned files.
 * Access tracking via last_accessed timestamp, updated on linkPackage().
 */

import * as fs from "fs";
import * as path from "path";
import { getDatabaseManager } from "../db/databaseManager.js";
import { PackageStore, getPackageStore } from "./store.js";
import type { GCOptions, GCResult, PackageRow, FileRow } from "./schema.js";

/** Default: remove packages not accessed in 30 days */
const DEFAULT_OLDER_THAN_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Run garbage collection on the package store.
 *
 * Removes:
 * 1. Package versions not accessed within the cutoff period
 * 2. Orphaned files (not referenced by any remaining package)
 *
 * @param store - PackageStore instance
 * @param options - GC options
 */
export async function gc(store: PackageStore, options: GCOptions = {}): Promise<GCResult> {
  const olderThan = options.olderThan ?? DEFAULT_OLDER_THAN_MS;
  const dryRun = options.dryRun ?? false;
  const cutoff = Date.now() - olderThan;

  // Get store directory from the provided store instance
  const storeDir = store.getStoreDir();
  const dbPath = path.join(storeDir, "store.db");

  const db = getDatabaseManager();
  const handle = db.openAtPath("gc", dbPath);

  try {
    // 1. Find packages to remove (last_accessed < cutoff)
    const packagesToRemove = db.query<PackageRow>(
      handle,
      "SELECT id, name, version FROM packages WHERE last_accessed < ?",
      [cutoff]
    );

    if (dryRun) {
      db.close(handle);
      return {
        packagesRemoved: packagesToRemove.length,
        filesRemoved: 0,
        bytesFreed: 0,
      };
    }

    // 2. Find files that will become orphaned after removing packages
    // A file is orphaned if it's not referenced by any package that will survive
    const orphanedFiles = db.query<FileRow>(
      handle,
      `SELECT f.hash, f.size FROM files f
       WHERE NOT EXISTS (
         SELECT 1 FROM package_files pf
         JOIN packages p ON pf.package_id = p.id
         WHERE pf.file_hash = f.hash AND p.last_accessed >= ?
       )`,
      [cutoff]
    );

    // 3. Delete package records (CASCADE deletes package_files entries)
    if (packagesToRemove.length > 0) {
      db.run(handle, "DELETE FROM packages WHERE last_accessed < ?", [cutoff]);
    }

    // 4. Delete orphaned file records
    if (orphanedFiles.length > 0) {
      db.run(
        handle,
        `DELETE FROM files WHERE hash IN (
           SELECT f.hash FROM files f
           WHERE NOT EXISTS (
             SELECT 1 FROM package_files pf WHERE pf.file_hash = f.hash
           )
         )`
      );
    }

    // 5. Delete orphaned files from disk
    let bytesFreed = 0;
    for (const { hash, size } of orphanedFiles) {
      const filePath = path.join(storeDir, "files", hash.slice(0, 2), hash);
      try {
        fs.unlinkSync(filePath);
        bytesFreed += size;
      } catch {
        // Ignore missing files (may have been deleted already)
      }
    }

    // 6. Clean up empty directories in files/
    await cleanupEmptyDirs(path.join(storeDir, "files"));

    // 7. Also clear old resolution cache entries
    db.run(handle, "DELETE FROM resolution_cache WHERE created_at < ?", [cutoff]);

    return {
      packagesRemoved: packagesToRemove.length,
      filesRemoved: orphanedFiles.length,
      bytesFreed,
    };
  } finally {
    db.close(handle);
  }
}

/**
 * Clean up empty directories.
 */
async function cleanupEmptyDirs(dir: string): Promise<void> {
  try {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
      if (entry.isDirectory()) {
        const subdir = path.join(dir, entry.name);
        await cleanupEmptyDirs(subdir);

        // Try to remove if empty
        try {
          await fs.promises.rmdir(subdir);
        } catch {
          // Not empty or other error, ignore
        }
      }
    }
  } catch {
    // Directory doesn't exist or other error, ignore
  }
}

/**
 * Get information about what would be collected without actually removing anything.
 */
export async function gcDryRun(options: Omit<GCOptions, "dryRun"> = {}): Promise<GCResult> {
  const store = await getPackageStore();
  return gc(store, { ...options, dryRun: true });
}

/**
 * Run GC asynchronously (non-blocking).
 * Returns a promise that resolves when GC is complete.
 */
export async function gcAsync(options: GCOptions = {}): Promise<GCResult> {
  const store = await getPackageStore();
  return gc(store, options);
}

/**
 * Schedule GC to run periodically.
 * Returns a function to cancel the scheduled GC.
 */
export function scheduleGC(
  intervalMs: number = 24 * 60 * 60 * 1000, // Default: daily
  options: GCOptions = {}
): () => void {
  let timeoutId: NodeJS.Timeout | null = null;

  const runGC = async () => {
    try {
      const result = await gcAsync(options);
      console.log(
        `[PackageStore GC] Removed ${result.packagesRemoved} packages, ` +
          `${result.filesRemoved} files, freed ${formatBytes(result.bytesFreed)}`
      );
    } catch (error) {
      console.error("[PackageStore GC] Error during garbage collection:", error);
    }

    // Schedule next run
    timeoutId = setTimeout(runGC, intervalMs);
  };

  // Start first run
  timeoutId = setTimeout(runGC, intervalMs);

  // Return cancellation function
  return () => {
    if (timeoutId) {
      clearTimeout(timeoutId);
      timeoutId = null;
    }
  };
}

/**
 * Format bytes as human-readable string.
 */
function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
}
