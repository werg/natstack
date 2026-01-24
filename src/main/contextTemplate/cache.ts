/**
 * Template Build Cache Management
 *
 * Manages the lifecycle of cached template builds:
 * - Checking if builds exist and are ready
 * - Validating build readiness
 * - Cleaning up orphaned temp builds on startup
 */

import * as fs from "fs";
import * as path from "path";
import {
  getTemplateBuildDirectory,
  getTemplateBuildPath,
} from "../paths.js";
import type { TemplateBuild, ImmutableTemplateSpec } from "./types.js";

/** Name of the metadata file in each build directory */
const META_FILE_NAME = ".template-meta.json";

/**
 * Check if a template build exists and is ready to use.
 *
 * @param specHash - The spec hash to check (can be full or 12-char prefix)
 * @returns true if a ready build exists for this hash
 */
export function isTemplateBuildReady(specHash: string): boolean {
  const buildPath = getTemplateBuildPath(specHash);
  const metaPath = path.join(buildPath, META_FILE_NAME);

  if (!fs.existsSync(metaPath)) {
    return false;
  }

  try {
    const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8")) as TemplateBuild;

    // Must be ready AND match the expected specHash (at least prefix)
    return (
      meta.buildState === "ready" &&
      meta.specHash.startsWith(specHash.slice(0, 12))
    );
  } catch {
    // Corrupted metadata
    return false;
  }
}

/**
 * Load the metadata for a template build.
 *
 * @param specHash - The spec hash of the build
 * @returns Build metadata or null if not found/invalid
 */
export function loadTemplateBuildMeta(specHash: string): TemplateBuild | null {
  const buildPath = getTemplateBuildPath(specHash);
  const metaPath = path.join(buildPath, META_FILE_NAME);

  if (!fs.existsSync(metaPath)) {
    return null;
  }

  try {
    return JSON.parse(fs.readFileSync(metaPath, "utf-8")) as TemplateBuild;
  } catch {
    return null;
  }
}

/**
 * Save metadata for a template build.
 *
 * @param build - The build metadata to save
 */
export function saveTemplateBuildMeta(build: TemplateBuild): void {
  const metaPath = path.join(build.scopePath, META_FILE_NAME);
  fs.writeFileSync(metaPath, JSON.stringify(build, null, 2));
}

/**
 * Get the immutable spec from a cached build.
 *
 * @param specHash - The spec hash of the build
 * @returns The immutable spec or null if not found
 */
export function getCachedTemplateSpec(
  specHash: string
): ImmutableTemplateSpec | null {
  const meta = loadTemplateBuildMeta(specHash);
  return meta?.spec ?? null;
}

/**
 * List all template builds (ready or not).
 *
 * @returns Array of build metadata
 */
export function listTemplateBuilds(): TemplateBuild[] {
  const buildsDir = getTemplateBuildDirectory();
  const builds: TemplateBuild[] = [];

  if (!fs.existsSync(buildsDir)) {
    return builds;
  }

  for (const entry of fs.readdirSync(buildsDir, { withFileTypes: true })) {
    // Skip temp directories and lock files
    if (entry.name.startsWith(".tmp-") || entry.name.endsWith(".lock")) {
      continue;
    }

    if (entry.isDirectory()) {
      const meta = loadTemplateBuildMeta(entry.name);
      if (meta) {
        builds.push(meta);
      }
    }
  }

  return builds;
}

/**
 * Clean up orphaned temp directories from crashed builds.
 * Should be called on application startup.
 *
 * @returns Number of temp directories cleaned up
 */
export function cleanupOrphanedTempBuilds(): number {
  const buildsDir = getTemplateBuildDirectory();
  let cleaned = 0;

  if (!fs.existsSync(buildsDir)) {
    return 0;
  }

  for (const entry of fs.readdirSync(buildsDir, { withFileTypes: true })) {
    if (entry.name.startsWith(".tmp-") && entry.isDirectory()) {
      const tempPath = path.join(buildsDir, entry.name);

      try {
        fs.rmSync(tempPath, { recursive: true, force: true });
        cleaned++;
        console.log(`[ContextTemplate] Cleaned up orphaned temp build: ${entry.name}`);
      } catch (error) {
        console.warn(
          `[ContextTemplate] Failed to clean up orphaned temp build: ${entry.name}`,
          error
        );
      }
    }
  }

  return cleaned;
}

/**
 * Clean up stale lock files (older than staleness threshold).
 *
 * @param staleMs - Consider locks stale after this many milliseconds (default: 60000)
 * @returns Number of lock files cleaned up
 */
export function cleanupStaleLocks(staleMs = 60000): number {
  const buildsDir = getTemplateBuildDirectory();
  let cleaned = 0;
  const now = Date.now();

  if (!fs.existsSync(buildsDir)) {
    return 0;
  }

  for (const entry of fs.readdirSync(buildsDir, { withFileTypes: true })) {
    if (entry.name.endsWith(".lock") && entry.isFile()) {
      const lockPath = path.join(buildsDir, entry.name);

      try {
        const stat = fs.statSync(lockPath);
        const age = now - stat.mtimeMs;

        if (age > staleMs) {
          fs.rmSync(lockPath, { force: true });
          cleaned++;
          console.log(`[ContextTemplate] Cleaned up stale lock: ${entry.name}`);
        }
      } catch {
        // Ignore errors - lock might have been removed
      }
    }
  }

  return cleaned;
}

/**
 * Remove a template build from the cache.
 *
 * @param specHash - The spec hash of the build to remove
 * @returns true if the build was removed, false if it didn't exist
 */
export function removeTemplateBuild(specHash: string): boolean {
  const buildPath = getTemplateBuildPath(specHash);

  if (!fs.existsSync(buildPath)) {
    return false;
  }

  try {
    fs.rmSync(buildPath, { recursive: true, force: true });
    return true;
  } catch (error) {
    console.warn(`[ContextTemplate] Failed to remove build: ${specHash}`, error);
    return false;
  }
}

/**
 * Get cache statistics.
 *
 * @returns Cache statistics
 */
export function getCacheStats(): {
  totalBuilds: number;
  readyBuilds: number;
  errorBuilds: number;
  totalSizeBytes: number;
} {
  const builds = listTemplateBuilds();

  let totalSizeBytes = 0;
  let readyBuilds = 0;
  let errorBuilds = 0;

  for (const build of builds) {
    if (build.buildState === "ready") {
      readyBuilds++;
    } else if (build.buildState === "error") {
      errorBuilds++;
    }

    // Calculate size (rough estimate from directory)
    try {
      totalSizeBytes += getDirectorySize(build.scopePath);
    } catch {
      // Ignore size calculation errors
    }
  }

  return {
    totalBuilds: builds.length,
    readyBuilds,
    errorBuilds,
    totalSizeBytes,
  };
}

/**
 * Get the size of a directory recursively.
 */
function getDirectorySize(dirPath: string): number {
  let size = 0;

  if (!fs.existsSync(dirPath)) {
    return 0;
  }

  for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
    const entryPath = path.join(dirPath, entry.name);

    if (entry.isDirectory()) {
      size += getDirectorySize(entryPath);
    } else if (entry.isFile()) {
      size += fs.statSync(entryPath).size;
    }
  }

  return size;
}
