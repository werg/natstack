/**
 * Template Partition Builder
 *
 * Orchestrates building template partitions via hidden WebContentsView workers.
 * Creates isolated OPFS storage for template dependencies that can be copied
 * to context-specific partitions.
 *
 * Flow:
 * 1. Check if template partition exists (by specHash)
 * 2. If not, create hidden worker view with template partition
 * 3. Worker clones all deps to OPFS, signals completion
 * 4. Destroy view, wait for writes to flush
 * 5. Write marker file to partition folder
 * 6. Copy partition to context partition
 */

import * as fs from "fs";
import * as path from "path";
import {
  getPartitionPath,
  getPartitionBuildLockPath,
  getTemplatePartitionName,
} from "../paths.js";
import type { ImmutableTemplateSpec, TemplateProgress, PartitionBuildGitConfig } from "./types.js";
import { createDevLogger } from "../devLog.js";

const log = createDevLogger("PartitionBuilder");

/** Lock retry configuration */
const LOCK_RETRIES = 10;
const LOCK_RETRY_DELAY_MS = 1000;
const LOCK_STALE_MS = 60000;

/** Build timeout (5 minutes) */
const BUILD_TIMEOUT_MS = 5 * 60 * 1000;

/** Quiesce delay after view destruction */
const QUIESCE_DELAY_MS = 500;

/** Marker file written when partition is ready */
const PARTITION_READY_MARKER = ".template-partition-ready";

/**
 * Pending template build tracking.
 * Maps worker panel ID -> resolve/reject handlers.
 */
const pendingBuilds = new Map<
  string,
  {
    resolve: (result: TemplateCompleteResult) => void;
    reject: (error: Error) => void;
    timeoutId: NodeJS.Timeout;
  }
>();

/**
 * Result from template completion signal.
 */
export interface TemplateCompleteResult {
  success: boolean;
  specHash?: string;
  error?: string;
}

/**
 * Get the path to the template partition folder.
 *
 * @param specHash - The template spec hash
 * @returns Absolute path to the partition folder
 */
export function getTemplatePartitionPath(specHash: string): string {
  const partitionName = getTemplatePartitionName(specHash);
  return getPartitionPath(partitionName);
}

/**
 * Check if a template partition is ready (exists and has marker file).
 *
 * @param specHash - The template spec hash
 * @returns true if partition is ready to use
 */
export function isTemplatePartitionReady(specHash: string): boolean {
  const partitionPath = getTemplatePartitionPath(specHash);
  const markerPath = path.join(partitionPath, PARTITION_READY_MARKER);

  if (!fs.existsSync(partitionPath)) {
    return false;
  }

  if (!fs.existsSync(markerPath)) {
    return false;
  }

  // Verify marker contains matching hash
  try {
    const markerContent = fs.readFileSync(markerPath, "utf-8");
    const marker = JSON.parse(markerContent);
    return marker.specHash?.startsWith(specHash.slice(0, 12));
  } catch {
    return false;
  }
}

/**
 * Write the partition ready marker file.
 *
 * @param specHash - The template spec hash
 */
function writePartitionMarker(specHash: string): void {
  const partitionPath = getTemplatePartitionPath(specHash);
  const markerPath = path.join(partitionPath, PARTITION_READY_MARKER);

  fs.mkdirSync(partitionPath, { recursive: true });
  fs.writeFileSync(
    markerPath,
    JSON.stringify({
      specHash,
      createdAt: Date.now(),
    })
  );
}

/**
 * Clean up a template partition folder.
 *
 * @param specHash - The template spec hash
 */
function cleanupPartition(specHash: string): void {
  const partitionPath = getTemplatePartitionPath(specHash);
  if (fs.existsSync(partitionPath)) {
    try {
      fs.rmSync(partitionPath, { recursive: true, force: true });
    } catch (error) {
      console.error(`[PartitionBuilder] Failed to cleanup partition: ${error}`);
    }
  }
}

/**
 * Handle template completion signal from a worker.
 * Called by bridge handler when worker signals completion.
 *
 * @param workerId - The worker panel ID
 * @param result - The completion result
 */
export function handleTemplateComplete(
  workerId: string,
  result: TemplateCompleteResult
): void {
  const pending = pendingBuilds.get(workerId);
  if (!pending) {
    console.warn(
      `[PartitionBuilder] Received completion for unknown worker: ${workerId}`
    );
    return;
  }

  // Clear timeout and remove from pending
  clearTimeout(pending.timeoutId);
  pendingBuilds.delete(workerId);

  // Resolve or reject based on result
  if (result.success) {
    pending.resolve(result);
  } else {
    pending.reject(new Error(result.error ?? "Template build failed"));
  }
}

/**
 * Build a template partition using a hidden worker view.
 *
 * @param spec - The immutable template spec
 * @param gitConfig - Git configuration for cloning
 * @param onProgress - Optional progress callback
 * @returns Promise that resolves when build is complete
 */
export async function buildTemplatePartition(
  spec: ImmutableTemplateSpec,
  gitConfig: PartitionBuildGitConfig,
  onProgress?: (progress: TemplateProgress) => void
): Promise<void> {
  const partitionName = getTemplatePartitionName(spec.specHash);
  console.log(
    `[PartitionBuilder] Building template partition: ${partitionName}`
  );
  onProgress?.({
    stage: "cloning",
    message: `Building template partition ${partitionName}...`,
  });

  // Import PanelManager dynamically to avoid circular dependencies
  const { getPanelManager } = await import("../panelManager.js");
  const pm = getPanelManager();

  if (!pm) {
    throw new Error("PanelManager not available");
  }

  // Generate unique worker ID for this build
  const workerId = `tpl-builder-${spec.specHash.slice(0, 12)}-${Date.now()}`;

  // Create config for the template builder worker
  const templateConfig = {
    structure: spec.structure,
    specHash: spec.specHash,
    gitConfig: {
      serverUrl: gitConfig.serverUrl,
      token: gitConfig.token,
    },
  };

  // Create promise that will be resolved when worker signals completion
  const completionPromise = new Promise<TemplateCompleteResult>(
    (resolve, reject) => {
      // Set up timeout
      const timeoutId = setTimeout(() => {
        pendingBuilds.delete(workerId);
        reject(new Error(`Template build timed out after ${BUILD_TIMEOUT_MS}ms`));
      }, BUILD_TIMEOUT_MS);

      pendingBuilds.set(workerId, { resolve, reject, timeoutId });
    }
  );

  try {
    // Create hidden worker view with template partition
    // The worker will read config from env and clone repos to OPFS
    await pm.createTemplateBuilderWorker(workerId, partitionName, templateConfig);

    // Wait for completion signal (rejects on failure or timeout)
    await completionPromise;

    // Destroy the worker view
    await pm.closeTemplateBuilderWorker(workerId);

    // Wait for writes to flush
    await sleep(QUIESCE_DELAY_MS);

    // Write marker file
    writePartitionMarker(spec.specHash);

    console.log(
      `[PartitionBuilder] Template partition ready: ${partitionName}`
    );
  } catch (error) {
    // Clean up on failure
    console.error(`[PartitionBuilder] Build failed:`, error);
    try {
      await pm.closeTemplateBuilderWorker(workerId);
    } catch {
      // Ignore close errors
    }
    cleanupPartition(spec.specHash);
    throw error;
  }
}

/**
 * Ensure a template partition exists, building it if necessary.
 * Uses file locking for concurrency safety.
 *
 * @param spec - The immutable template spec
 * @param gitConfig - Git configuration for cloning
 * @param onProgress - Optional progress callback
 * @returns The partition name
 */
export async function ensureTemplatePartition(
  spec: ImmutableTemplateSpec,
  gitConfig: PartitionBuildGitConfig,
  onProgress?: (progress: TemplateProgress) => void
): Promise<string> {
  const partitionName = getTemplatePartitionName(spec.specHash);

  // Quick check without lock
  if (isTemplatePartitionReady(spec.specHash)) {
    log.verbose(` Using cached partition: ${partitionName}`);
    return partitionName;
  }

  // Acquire lock
  const releaseLock = await acquirePartitionBuildLock(partitionName);

  try {
    // Double-check after acquiring lock
    if (isTemplatePartitionReady(spec.specHash)) {
      console.log(
        `[PartitionBuilder] Partition built by another process: ${partitionName}`
      );
      return partitionName;
    }

    // Build the partition
    await buildTemplatePartition(spec, gitConfig, onProgress);

    return partitionName;
  } finally {
    releaseLock();
  }
}

/**
 * Acquire a build lock for the given partition.
 */
async function acquirePartitionBuildLock(
  partitionName: string
): Promise<() => void> {
  const lockPath = getPartitionBuildLockPath(partitionName);

  for (let attempt = 0; attempt < LOCK_RETRIES; attempt++) {
    try {
      // Try to create lock file exclusively
      const fd = fs.openSync(lockPath, "wx");
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);

      // Successfully acquired lock
      return () => {
        try {
          fs.rmSync(lockPath, { force: true });
        } catch {
          // Ignore errors releasing lock
        }
      };
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        // Lock exists - check if it's stale
        try {
          const stat = fs.statSync(lockPath);
          const age = Date.now() - stat.mtimeMs;

          if (age > LOCK_STALE_MS) {
            // Stale lock - try to remove it
            console.warn(
              `[PartitionBuilder] Removing stale lock for ${partitionName} (age: ${age}ms)`
            );
            fs.rmSync(lockPath, { force: true });
            continue; // Retry immediately
          }
        } catch {
          // Lock file disappeared - retry
          continue;
        }

        // Wait and retry
        await sleep(LOCK_RETRY_DELAY_MS);
      } else {
        throw error;
      }
    }
  }

  throw new Error(
    `Failed to acquire partition build lock for ${partitionName} after ${LOCK_RETRIES} attempts`
  );
}

/**
 * Sleep for a given number of milliseconds.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
