/**
 * Context Transfer API — Server-Mediated OPFS Snapshot/Restore
 *
 * In Electron, context transfer is a simple filesystem copy between partition
 * folders. In the browser, each subdomain is a separate origin, so cross-origin
 * storage access is impossible. Instead, we mediate through the server:
 *
 * Export flow (source panel → server):
 *   1. Panel serializes its OPFS contents to JSON
 *   2. Panel POSTs the snapshot to /api/context/{contextId}/snapshot
 *   3. Server stores the snapshot in memory (with TTL)
 *
 * Import flow (server → destination panel):
 *   1. Panel GETs /api/context/{contextId}/snapshot
 *   2. Panel writes the snapshot contents to its own OPFS
 *   3. Panel writes the .template-initialized marker
 *
 * This enables:
 * - Context cloning (create new panel with existing panel's storage)
 * - Context migration (move panel to new subdomain)
 * - Template pre-seeding (server creates snapshot from git, panel imports)
 */

import { createDevLogger } from "../../main/devLog.js";

const log = createDevLogger("ContextTransfer");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single file entry in a context snapshot */
export interface SnapshotFileEntry {
  /** Relative path within OPFS (e.g., "/workspace/panels/editor/src/main.ts") */
  path: string;
  /** File content (UTF-8 string or base64-encoded binary) */
  content: string;
  /** Encoding: "utf8" (default) or "base64" */
  encoding?: "utf8" | "base64";
  /** File size in bytes (for validation) */
  size?: number;
}

/** IndexedDB store entry */
export interface SnapshotIDBEntry {
  /** Database name */
  dbName: string;
  /** Object store name */
  storeName: string;
  /** Key-value pairs (JSON-serializable) */
  entries: Array<{ key: string; value: unknown }>;
}

/** localStorage entries */
export interface SnapshotLocalStorageEntry {
  key: string;
  value: string;
}

/** A full context snapshot */
export interface ContextSnapshot {
  /** Context ID this snapshot was taken from */
  sourceContextId: string;
  /** Spec hash of the template (if template-based context) */
  specHash?: string;
  /** Timestamp when snapshot was created */
  createdAt: number;
  /** OPFS file tree */
  opfsFiles: SnapshotFileEntry[];
  /** IndexedDB databases (optional — only included if panel opted in) */
  indexedDB?: SnapshotIDBEntry[];
  /** localStorage entries (optional) */
  localStorage?: SnapshotLocalStorageEntry[];
  /** Total uncompressed size in bytes */
  totalSize: number;
}

/** Snapshot metadata (without the actual data) */
export interface SnapshotMetadata {
  sourceContextId: string;
  specHash?: string;
  createdAt: number;
  totalSize: number;
  fileCount: number;
  expiresAt: number;
}

// ---------------------------------------------------------------------------
// In-Memory Snapshot Store
// ---------------------------------------------------------------------------

/** Default TTL: 10 minutes */
const SNAPSHOT_TTL_MS = 10 * 60 * 1000;

/** Maximum snapshot size: 100MB */
const MAX_SNAPSHOT_SIZE = 100 * 1024 * 1024;

/** Maximum number of cached snapshots */
const MAX_SNAPSHOTS = 20;

interface StoredSnapshot {
  snapshot: ContextSnapshot;
  expiresAt: number;
}

const snapshotStore = new Map<string, StoredSnapshot>();

/** Periodic cleanup interval */
let cleanupInterval: ReturnType<typeof setInterval> | null = null;

function ensureCleanupRunning(): void {
  if (cleanupInterval) return;
  cleanupInterval = setInterval(() => {
    const now = Date.now();
    for (const [key, stored] of snapshotStore) {
      if (stored.expiresAt <= now) {
        snapshotStore.delete(key);
        log.verbose(`Expired snapshot: ${key}`);
      }
    }
    if (snapshotStore.size === 0 && cleanupInterval) {
      clearInterval(cleanupInterval);
      cleanupInterval = null;
    }
  }, 60_000);
}

// ---------------------------------------------------------------------------
// Store / Retrieve
// ---------------------------------------------------------------------------

/**
 * Store a context snapshot for later retrieval.
 *
 * @param contextId - The context ID to store the snapshot under
 * @param snapshot - The snapshot data
 * @param ttlMs - Time-to-live in milliseconds (default: 10 minutes)
 * @throws Error if snapshot exceeds size limit or store is full
 */
export function storeSnapshot(
  contextId: string,
  snapshot: ContextSnapshot,
  ttlMs: number = SNAPSHOT_TTL_MS,
): void {
  if (snapshot.totalSize > MAX_SNAPSHOT_SIZE) {
    throw new Error(
      `Snapshot too large: ${snapshot.totalSize} bytes (max: ${MAX_SNAPSHOT_SIZE})`,
    );
  }

  // Evict oldest if at capacity
  if (snapshotStore.size >= MAX_SNAPSHOTS && !snapshotStore.has(contextId)) {
    let oldestKey: string | null = null;
    let oldestTime = Infinity;
    for (const [key, stored] of snapshotStore) {
      if (stored.snapshot.createdAt < oldestTime) {
        oldestTime = stored.snapshot.createdAt;
        oldestKey = key;
      }
    }
    if (oldestKey) {
      snapshotStore.delete(oldestKey);
      log.verbose(`Evicted oldest snapshot: ${oldestKey}`);
    }
  }

  snapshotStore.set(contextId, {
    snapshot,
    expiresAt: Date.now() + ttlMs,
  });

  ensureCleanupRunning();
  log.info(`Stored snapshot for ${contextId}: ${snapshot.opfsFiles.length} files, ${snapshot.totalSize} bytes`);
}

/**
 * Retrieve a context snapshot.
 *
 * @param contextId - The context ID to retrieve
 * @returns The snapshot, or null if not found/expired
 */
export function getSnapshot(contextId: string): ContextSnapshot | null {
  const stored = snapshotStore.get(contextId);
  if (!stored) return null;

  if (stored.expiresAt <= Date.now()) {
    snapshotStore.delete(contextId);
    return null;
  }

  return stored.snapshot;
}

/**
 * Get snapshot metadata without the full data.
 */
export function getSnapshotMetadata(contextId: string): SnapshotMetadata | null {
  const stored = snapshotStore.get(contextId);
  if (!stored) return null;

  if (stored.expiresAt <= Date.now()) {
    snapshotStore.delete(contextId);
    return null;
  }

  return {
    sourceContextId: stored.snapshot.sourceContextId,
    specHash: stored.snapshot.specHash,
    createdAt: stored.snapshot.createdAt,
    totalSize: stored.snapshot.totalSize,
    fileCount: stored.snapshot.opfsFiles.length,
    expiresAt: stored.expiresAt,
  };
}

/**
 * Delete a stored snapshot.
 */
export function deleteSnapshot(contextId: string): boolean {
  return snapshotStore.delete(contextId);
}

/**
 * List all stored snapshot metadata.
 */
export function listSnapshots(): SnapshotMetadata[] {
  const now = Date.now();
  const result: SnapshotMetadata[] = [];

  for (const [contextId, stored] of snapshotStore) {
    if (stored.expiresAt <= now) {
      snapshotStore.delete(contextId);
      continue;
    }

    result.push({
      sourceContextId: stored.snapshot.sourceContextId,
      specHash: stored.snapshot.specHash,
      createdAt: stored.snapshot.createdAt,
      totalSize: stored.snapshot.totalSize,
      fileCount: stored.snapshot.opfsFiles.length,
      expiresAt: stored.expiresAt,
    });
  }

  return result;
}
