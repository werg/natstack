/**
 * Main process cache manager
 *
 * This is the single source of truth for the build cache.
 * All panels communicate with this via IPC.
 */

import { loadDiskCache, saveDiskCache } from './diskCache.js';
import { getCacheConfig } from './cacheConfig.js';

interface CacheEntry {
  key: string;
  value: string;
  timestamp: number;
  size: number;
}

class MainCacheManager {
  private cache = new Map<string, CacheEntry>();
  private accessOrder: string[] = [];
  private totalSize = 0; // Running counter for efficient size checks
  private saveTimer: NodeJS.Timeout | null = null;
  private initialized = false;
  private isDirty = false;

  // Cache limits loaded from central config (with defaults)
  // Main process stores everything, panels load subset based on repo
  private readonly config = getCacheConfig();
  private readonly MAX_ENTRIES = this.config.maxEntries;
  private readonly MAX_SIZE = this.config.maxSize;
  private readonly SAVE_DEBOUNCE_MS = 5000; // 5 seconds

  async initialize(): Promise<void> {
    if (this.initialized) return;

    const diskEntries = await loadDiskCache();
    for (const [key, entry] of Object.entries(diskEntries)) {
      this.cache.set(key, entry);
      this.accessOrder.push(key);
      this.totalSize += entry.size;
    }

    this.initialized = true;
    console.log(`[MainCache] Initialized with ${this.cache.size} entries from disk (${Math.round(this.totalSize / 1024 / 1024)}MB)`);
  }

  /**
   * Get a cache entry (updates LRU)
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

    // Update LRU (optimized: find and remove in one pass)
    const index = this.accessOrder.indexOf(key);
    if (index !== -1) {
      this.accessOrder.splice(index, 1);
    }
    this.accessOrder.push(key);

    return entry.value;
  }

  /**
   * Get a cache entry with metadata (updates LRU)
   */
  getEntry(key: string, devMode: boolean): CacheEntry | null {
    const entry = this.cache.get(key);
    if (!entry) return null;

    // Check expiration in dev mode
    if (devMode && this.isExpired(entry)) {
      this.cache.delete(key);
      this.totalSize -= entry.size;
      this.queueSave();
      return null;
    }

    // Update LRU (optimized: find and remove in one pass)
    const index = this.accessOrder.indexOf(key);
    if (index !== -1) {
      this.accessOrder.splice(index, 1);
    }
    this.accessOrder.push(key);

    return entry;
  }

  /**
   * Get multiple cache entries at once (for pre-populating panel cache)
   */
  getMany(keys: string[], devMode: boolean): Record<string, string> {
    const result: Record<string, string> = {};
    for (const key of keys) {
      const value = this.get(key, devMode);
      if (value !== null) {
        result[key] = value;
      }
    }
    return result;
  }

  /**
   * Get ALL cache entries (for pre-populating panel cache)
   */
  getAll(devMode: boolean): Record<string, CacheEntry> {
    const result: Record<string, CacheEntry> = {};

    // Filter out expired entries in dev mode
    for (const [key, entry] of this.cache.entries()) {
      if (devMode && this.isExpired(entry)) {
        this.cache.delete(key);
        this.totalSize -= entry.size;
        continue;
      }
      result[key] = entry;
    }

    if (devMode) {
      this.queueSave(); // Save after cleanup
    }

    return result;
  }

  /**
   * Set a cache entry
   */
  async set(key: string, value: string): Promise<void> {
    const size = value.length;

    if (size > this.MAX_SIZE) {
      console.warn(`[MainCache] Skipping ${key} (${size} bytes) because it exceeds max cache size of ${this.MAX_SIZE} bytes`);
      return;
    }

    const entry: CacheEntry = {
      key,
      value,
      timestamp: Date.now(),
      size,
    };

    // Remove old entry if updating (to maintain accurate size counter)
    const oldEntry = this.cache.get(key);
    if (oldEntry) {
      this.totalSize -= oldEntry.size;
    }

    // Evict if necessary
    await this.evictIfNeeded(size);

    // Add to cache
    this.cache.set(key, entry);
    this.totalSize += size;

    // Refresh LRU position: remove any existing instance then push to end
    const existingIndex = this.accessOrder.indexOf(key);
    if (existingIndex !== -1) {
      this.accessOrder.splice(existingIndex, 1);
    }
    this.accessOrder.push(key);

    this.queueSave();
  }

  /**
   * Set multiple entries at once (batch from panel)
   */
  async setMany(entries: Record<string, CacheEntry>): Promise<void> {
    for (const [key, entry] of Object.entries(entries)) {
      if (entry.size > this.MAX_SIZE) {
        console.warn(`[MainCache] Skipping ${key} (${entry.size} bytes) because it exceeds max cache size of ${this.MAX_SIZE} bytes`);
        continue;
      }

      // Remove old entry if updating (to maintain accurate size counter)
      const oldEntry = this.cache.get(key);
      if (oldEntry) {
        this.totalSize -= oldEntry.size;
      }

      // Evict if necessary
      await this.evictIfNeeded(entry.size);

      // Add to cache directly (preserving timestamp from panel)
      this.cache.set(key, entry);
      this.totalSize += entry.size;

      // Refresh LRU position: remove any existing instance then push to end
      const existingIndex = this.accessOrder.indexOf(key);
      if (existingIndex !== -1) {
        this.accessOrder.splice(existingIndex, 1);
      }
      this.accessOrder.push(key);
    }

    this.queueSave();
  }

  /**
   * Clear all cache entries
   */
  async clear(): Promise<void> {
    const size = this.cache.size;
    this.cache.clear();
    this.accessOrder = [];
    this.totalSize = 0;

    // Cancel pending save and save empty cache immediately
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }

    await saveDiskCache({});
    this.isDirty = false;

    console.log(`[MainCache] Cleared ${size} entries`);
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
    const timestamps = Array.from(this.cache.values()).map(e => e.timestamp);

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
      console.log(`[MainCache] Saved ${Object.keys(entries).length} entries to disk`);
    } catch (error) {
      console.error('[MainCache] Failed to save to disk, will retry on next change:', error);
      // Keep isDirty = true to retry on next change
    }
  }

  private async evictIfNeeded(newEntrySize: number): Promise<void> {
    // Check entry count limit
    while (this.cache.size >= this.MAX_ENTRIES && this.accessOrder.length > 0) {
      const oldestKey = this.accessOrder.shift()!;
      const entry = this.cache.get(oldestKey);
      if (entry) {
        this.cache.delete(oldestKey);
        this.totalSize -= entry.size;
        console.log(`[MainCache] Evicted ${oldestKey} (LRU, entry count limit)`);
      }
    }

    // Check total size limit (use running counter instead of recalculating)
    while (this.totalSize + newEntrySize > this.MAX_SIZE && this.accessOrder.length > 0) {
      const oldestKey = this.accessOrder.shift()!;
      const entry = this.cache.get(oldestKey);
      if (entry) {
        this.totalSize -= entry.size;
        this.cache.delete(oldestKey);
        console.log(`[MainCache] Evicted ${oldestKey} (LRU, size limit)`);
      }
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
