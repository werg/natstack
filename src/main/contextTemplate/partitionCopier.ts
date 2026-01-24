/**
 * Partition Folder Copy Operations
 *
 * Handles copying Electron partition folders between contexts.
 * Used to clone template partitions to context-specific partitions.
 */

import * as fs from "fs";
import * as path from "path";
import { getPartitionPath, getPartitionsDirectory } from "../paths.js";

/**
 * Copy a partition folder from source to destination.
 * Performs a recursive copy of all files and directories.
 * Cleans up the destination on failure.
 *
 * @param sourcePartitionName - Source partition name (e.g., "tpl_abc123456789")
 * @param destPartitionName - Destination partition name (e.g., "safe_tpl_abc123_instance")
 * @throws Error if source doesn't exist or copy fails
 */
export async function copyPartitionFolder(
  sourcePartitionName: string,
  destPartitionName: string
): Promise<void> {
  const sourcePath = getPartitionPath(sourcePartitionName);
  const destPath = getPartitionPath(destPartitionName);

  console.log(`[PartitionCopier] Copying partition ${sourcePartitionName} -> ${destPartitionName}`);

  // Verify source exists
  if (!fs.existsSync(sourcePath)) {
    throw new Error(`Source partition does not exist: ${sourcePath}`);
  }

  // Remove existing destination if present
  if (fs.existsSync(destPath)) {
    console.log(`[PartitionCopier] Removing existing destination: ${destPath}`);
    fs.rmSync(destPath, { recursive: true, force: true });
  }

  try {
    // Perform recursive copy
    await copyDirRecursive(sourcePath, destPath);
    console.log(`[PartitionCopier] Copy complete: ${destPartitionName}`);
  } catch (error) {
    // Clean up partial copy on failure
    console.error(`[PartitionCopier] Copy failed, cleaning up: ${destPartitionName}`);
    try {
      fs.rmSync(destPath, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
    throw error;
  }
}

/**
 * Recursively copy a directory.
 */
async function copyDirRecursive(src: string, dest: string): Promise<void> {
  // Create destination directory
  fs.mkdirSync(dest, { recursive: true });

  const entries = fs.readdirSync(src, { withFileTypes: true });

  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    if (entry.isDirectory()) {
      await copyDirRecursive(srcPath, destPath);
    } else if (entry.isFile()) {
      fs.copyFileSync(srcPath, destPath);
    } else if (entry.isSymbolicLink()) {
      // Preserve symlinks
      const linkTarget = fs.readlinkSync(srcPath);
      fs.symlinkSync(linkTarget, destPath);
    }
    // Skip other types (sockets, devices, etc.)
  }
}

/**
 * Remove a partition folder entirely.
 *
 * @param partitionName - The partition name to remove
 */
export async function cleanupPartition(partitionName: string): Promise<void> {
  const partitionPath = getPartitionPath(partitionName);

  if (fs.existsSync(partitionPath)) {
    console.log(`[PartitionCopier] Cleaning up partition: ${partitionName}`);
    fs.rmSync(partitionPath, { recursive: true, force: true });
  }
}

/**
 * Check if a partition folder exists and has content.
 *
 * @param partitionName - The partition name to check
 * @returns true if partition exists and is not empty
 */
export function partitionExists(partitionName: string): boolean {
  const partitionPath = getPartitionPath(partitionName);

  if (!fs.existsSync(partitionPath)) {
    return false;
  }

  // Check if it has any content
  try {
    const entries = fs.readdirSync(partitionPath);
    return entries.length > 0;
  } catch {
    return false;
  }
}

/**
 * List all partition folders.
 *
 * @returns Array of partition names
 */
export function listPartitions(): string[] {
  const partitionsDir = getPartitionsDirectory();

  try {
    const entries = fs.readdirSync(partitionsDir, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory() && !e.name.startsWith("."))
      .map((e) => e.name);
  } catch {
    return [];
  }
}

/**
 * Get the size of a partition folder in bytes.
 *
 * @param partitionName - The partition name
 * @returns Size in bytes, or 0 if partition doesn't exist
 */
export function getPartitionSize(partitionName: string): number {
  const partitionPath = getPartitionPath(partitionName);

  if (!fs.existsSync(partitionPath)) {
    return 0;
  }

  return getDirSize(partitionPath);
}

/**
 * Recursively calculate directory size.
 */
function getDirSize(dirPath: string): number {
  let size = 0;

  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);

      if (entry.isDirectory()) {
        size += getDirSize(fullPath);
      } else if (entry.isFile()) {
        try {
          const stat = fs.statSync(fullPath);
          size += stat.size;
        } catch {
          // Ignore stat errors
        }
      }
    }
  } catch {
    // Ignore read errors
  }

  return size;
}
