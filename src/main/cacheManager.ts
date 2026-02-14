/**
 * Main process cache manager
 *
 * This is the single source of truth for the build cache.
 * All panels communicate with this via IPC.
 */

import { loadDiskCache, saveDiskCache } from "./diskCache.js";
import { getCacheConfig } from "./cacheConfig.js";
import { createDevLogger } from "./devLog.js";

const log = createDevLogger("MainCache");

interface CacheEntry {
  key: string;
  value: string;
  timestamp: number;
  size: number;
}

export class MainCacheManager {
  private cache = new Map<string, CacheEntry>();
  private totalSize = 0; // Running counter for efficient size checks
  private saveTimer: NodeJS.Timeout | null = null;
  private initialized = false;
  private isDirty = false;
  private initPromise: Promise<void> | null = null;

  // Cache limits loaded from central config (with defaults)
  private readonly config = getCacheConfig();
  private readonly MAX_ENTRIES = this.config.maxEntries;
  private readonly MAX_SIZE = this.config.maxSize;
  private readonly SAVE_DEBOUNCE_MS = 5000; // 5 seconds

  /**
   * Start initialization in the background (fire-and-forget).
   * Safe to call multiple times — only the first call starts the load.
   */
  startInitialize(): void {
    if (!this.initPromise) {
      this.initPromise = this.initialize();
      this.initPromise.catch((err) => {
        console.error("[MainCache] Background initialization failed:", err);
      });
    }
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;

    const diskEntries = await loadDiskCache();
    // Memory-wins merge: don't overwrite entries that were set() during init
    let loadedCount = 0;
    for (const [key, entry] of Object.entries(diskEntries)) {
      if (!this.cache.has(key)) {
        this.cache.set(key, entry);
        this.totalSize += entry.size;
        loadedCount++;
      }
    }

    this.initialized = true;
    console.log(
      `[MainCache] Initialized with ${loadedCount} entries from disk (${Math.round(this.totalSize / 1024 / 1024)}MB, ${this.cache.size} total)`
    );
  }

  /**
   * Get a cache entry
   */
  get(key: string, devMode: boolean): string | null {
    const entry = this.cache.get(key);
    if (!entry) return null;

    // Check expiration in dev mode
    if (devMode && this.isExpired(entry)) {
      this.cache.delete(key);
      this.totalSize -= entry.size;
      this.queueSave();
      return null;
    }

    return entry.value;
  }


  /**
   * Set a cache entry
   */
  async set(key: string, value: string): Promise<void> {
    const size = value.length;

    if (size > this.MAX_SIZE) {
      console.warn(
        `[MainCache] Skipping ${key} (${size} bytes) because it exceeds max cache size of ${this.MAX_SIZE} bytes`
      );
      return;
    }

    const entry: CacheEntry = {
      key,
      value,
      timestamp: Date.now(),
      size,
    };

    // Remove old entry if updating (adjusts size counter AND resets
    // insertion order so eviction always removes the oldest entry first)
    const oldEntry = this.cache.get(key);
    if (oldEntry) {
      this.totalSize -= oldEntry.size;
      this.cache.delete(key);
    }

    // Evict if necessary
    await this.evictIfNeeded(size);

    // Add to cache (appended at end of iteration order)
    this.cache.set(key, entry);
    this.totalSize += size;

    this.queueSave();
  }


  /**
   * Clear all cache entries
   */
  async clear(): Promise<void> {
    const size = this.cache.size;
    this.cache.clear();
    this.totalSize = 0;

    // Cancel pending save and save empty cache immediately
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }

    await saveDiskCache({});
    this.isDirty = false;

    log.verbose(` Cleared ${size} entries`);
  }

  /**
   * Invalidate all cache entries whose keys start with the given prefix.
   * Used for targeted cache invalidation when packages are published.
   *
   * @param prefix - Key prefix to match (e.g., "panel:/path/to/panel:")
   * @returns Number of entries invalidated
   */
  invalidateByPrefix(prefix: string): number {
    let count = 0;

    for (const [key, entry] of this.cache) {
      if (key.startsWith(prefix)) {
        this.totalSize -= entry.size;
        this.cache.delete(key);
        count++;
      }
    }

    if (count > 0) {
      this.queueSave();
      log.verbose(` Invalidated ${count} entries with prefix: ${prefix}`);
    }

    return count;
  }

  /**
   * Get cache statistics
   */
  getStats(): {
    entries: number;
    totalSize: number;
    oldestEntry: number | null;
    newestEntry: number | null;
  } {
    const timestamps = Array.from(this.cache.values()).map((e) => e.timestamp);

    return {
      entries: this.cache.size,
      totalSize: this.totalSize, // Use running counter instead of recalculating
      oldestEntry: timestamps.length > 0 ? Math.min(...timestamps) : null,
      newestEntry: timestamps.length > 0 ? Math.max(...timestamps) : null,
    };
  }

  /**
   * Flush pending saves to disk
   */
  async flush(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    if (this.isDirty) {
      this.saveToDisk();
    }
  }

  private isExpired(entry: CacheEntry): boolean {
    const age = Date.now() - entry.timestamp;
    return age > this.config.expirationMs;
  }

  private queueSave(): void {
    this.isDirty = true;

    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
    }

    this.saveTimer = setTimeout(() => {
      void this.saveToDisk(); // Fire and forget
    }, this.SAVE_DEBOUNCE_MS);
  }

  private async saveToDisk(): Promise<void> {
    if (!this.isDirty) return;

    const entries: Record<string, CacheEntry> = {};
    for (const [key, entry] of this.cache.entries()) {
      entries[key] = entry;
    }

    try {
      await saveDiskCache(entries);
      this.isDirty = false;
      log.verbose(` Saved ${Object.keys(entries).length} entries to disk`);
    } catch (error) {
      console.error("[MainCache] Failed to save to disk, will retry on next change:", error);
      // Keep isDirty = true to retry on next change
    }
  }

  private async evictIfNeeded(newEntrySize: number): Promise<void> {
    // Map is insertion-ordered; set() always delete+reinserts (see above),
    // so the first entry is always the oldest.
    const evictOldest = (reason: string): boolean => {
      const first = this.cache.entries().next();
      if (first.done) return false;

      const [key, entry] = first.value;
      this.totalSize -= entry.size;
      this.cache.delete(key);
      log.verbose(` Evicted ${key} (${reason})`);
      return true;
    };

    // Check entry count limit
    while (this.cache.size >= this.MAX_ENTRIES) {
      if (!evictOldest("entry count limit exceeded")) break;
    }

    // Check total size limit
    while (this.totalSize + newEntrySize > this.MAX_SIZE) {
      if (!evictOldest("size limit exceeded")) break;
    }
  }
}

// Global singleton instance
let cacheManager: MainCacheManager | null = null;

export function getMainCacheManager(): MainCacheManager {
  if (!cacheManager) {
    cacheManager = new MainCacheManager();
  }
  return cacheManager;
}
