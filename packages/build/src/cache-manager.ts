/**
 * Unified cache manager for build artifacts and ESM dependencies
 *
 * Features:
 * - Content-addressable caching (SHA-256)
 * - Optional time-based expiration in dev mode
 * - Disk persistence via main process (shared across all panels)
 * - LRU eviction
 * - Shared across all panel contexts via globalThis
 * - Lazy-loaded from disk once per renderer process
 */

import { CACHE_TIMINGS, CACHE_DEFAULTS, CIRCUIT_BREAKER } from './cache-constants.js';

export interface CacheEntry<T> {
  key: string;
  value: T;
  timestamp: number;
  size: number;
}

export interface CacheStats {
  entries: number;
  totalSize: number;
  oldestEntry: number | null;
  newestEntry: number | null;
}

export interface CacheOptions {
  /** Maximum number of entries (LRU eviction) */
  maxEntries: number;
  /** Maximum total size in bytes */
  maxSize: number;
  /** Cache expiration in ms (0 = never expire) */
  expirationMs: number;
}

/**
 * Cache performance metrics
 */
export interface CacheMetrics {
  // Hit/Miss tracking
  hits: number;
  misses: number;
  hitRate: number;

  // Size tracking
  currentEntries: number;
  currentSize: number;
  maxEntries: number;
  maxSize: number;

  // Performance tracking
  evictions: number;
  expirations: number;

  // Timing (in milliseconds)
  averageGetTimeMs: number;
  averageSetTimeMs: number;

  // Sync tracking
  diskSyncs: number;
  diskSyncErrors: number;
  lastSyncTimestamp: number | null;

  // Uptime
  initTimestamp: number;
  uptimeMs: number;
}

/**
 * Global cache storage interface
 */
interface GlobalCacheStorage {
  __natstackUnifiedCache?: UnifiedCache;
  __natstackDevMode?: boolean;
  __natstackRepoUrl?: string; // Git repo URL for this panel (for cache hit tracking)
}

const globalStore = globalThis as GlobalCacheStorage;

/**
 * Unified cache for build artifacts and dependencies
 */
export class UnifiedCache {
  private cache = new Map<string, CacheEntry<string>>();
  private accessOrder: string[] = [];
  private options: CacheOptions;
  private initialized = false;
  private initPromise: Promise<void> | null = null; // Track initialization promise to prevent races
  private saveTimer: NodeJS.Timeout | null = null;
  private dirtyKeys = new Set<string>(); // Track which keys need syncing to main
  private saveFailureCount = 0; // Track consecutive save failures
  private readonly MAX_SAVE_FAILURES = CIRCUIT_BREAKER.MAX_FAILURES;
  private saveCircuitOpen = false; // Circuit breaker state
  private cacheHits = new Set<string>(); // Track cache hits for this panel (for repo manifest)
  private hitReportTimer: NodeJS.Timeout | null = null;
  private cleanupTimer: NodeJS.Timeout | null = null;
  private totalSize = 0; // Running counter for efficient size checks

  // Metrics tracking
  private metrics = {
    hits: 0,
    misses: 0,
    evictions: 0,
    expirations: 0,
    diskSyncs: 0,
    diskSyncErrors: 0,
    lastSyncTimestamp: null as number | null,
    initTimestamp: 0,
    getTimes: [] as number[],
    setTimes: [] as number[],
  };

  constructor(options: Partial<CacheOptions> = {}) {
    // Initialize with defaults, will be updated from config during initialize()
    this.options = {
      maxEntries: options.maxEntries ?? CACHE_DEFAULTS.MAX_ENTRIES_PER_PANEL,
      maxSize: options.maxSize ?? CACHE_DEFAULTS.MAX_SIZE_PER_PANEL,
      expirationMs: options.expirationMs ?? CACHE_DEFAULTS.PROD_EXPIRATION_MS,
    };
  }

  /**
   * Initialize cache with disk persistence via IPC
   *
   * Architecture (new repo-based warming):
   * - Main process holds single source of truth in memory + disk
   * - Each panel loads ONLY cache entries relevant to its git repo
   * - Panel keeps cache in local memory for synchronous access
   * - Panel syncs new entries back to main process (debounced)
   * - Panel reports cache hits to build repo manifest (debounced)
   *
   * Note: If initialization fails, the cache operates in memory-only mode.
   * This is intentional fail-open behavior to allow panels to continue working
   * even if IPC or disk access fails.
   */
  async initialize(): Promise<void> {
    // Return existing initialization promise if already in progress
    if (this.initPromise) {
      return this.initPromise;
    }

    // Already initialized, return immediately
    if (this.initialized) {
      return Promise.resolve();
    }

    // Create and store initialization promise to prevent concurrent calls
    this.initPromise = (async () => {
      try {
        await this.doInitialize();
        this.initialized = true;
        console.log('[Cache] Initialization successful');
      } catch (error) {
        // On failure, clear the promise to allow future retries
        this.initPromise = null;
        // Mark as initialized to allow in-memory-only operation (fail-open)
        this.initialized = true;
        console.error('[Cache] Initialization failed, operating in memory-only mode:', error);
        // Don't rethrow - allow cache to work in degraded mode
      }
    })();

    return this.initPromise;
  }

  /**
   * Internal initialization logic (called only once via initialize())
   */
  private async doInitialize(): Promise<void> {
    // Check if we're in a panel context with bridge access
    if (typeof window === 'undefined' || !window.__natstackPanelBridge) {
      console.warn('[Cache] Panel bridge not available, disk persistence disabled');
      this.initialized = true; // Mark as initialized even without disk
      return;
    }

    try {
      // Load cache config from main process
      const config = await window.__natstackPanelBridge.getCacheConfig();
      this.options.maxEntries = config.maxEntriesPerPanel;
      this.options.maxSize = config.maxSizePerPanel;
      this.options.expirationMs = config.expirationMs;
      console.log(`[Cache] Loaded config: ${config.maxEntriesPerPanel} entries, ${Math.round(config.maxSizePerPanel / 1024 / 1024)}MB`);

      // Check if we have a repo URL for selective loading
      const repoUrl = globalStore.__natstackRepoUrl;
      if (repoUrl) {
        console.log(`[Cache] Pre-populating cache for repo: ${repoUrl}`);
        await this.loadFromRepo(repoUrl);
      } else {
        console.log('[Cache] No repo URL, starting with empty cache');
      }

      // Start periodic cleanup if expiration is enabled
      this.startCleanupTimer();

      this.initialized = true;
      this.metrics.initTimestamp = Date.now();
      console.log(`[Cache] Initialized with ${this.cache.size} entries from main process`);
    } catch (error) {
      console.error('[Cache] Failed to initialize cache from main process:', error);
      this.initialized = true; // Still mark as initialized to prevent retries
      this.metrics.initTimestamp = Date.now();
      throw error; // Propagate error to caller
    }
  }

  /**
   * Load cache entries for a specific repo (selective loading)
   */
  private async loadFromRepo(repoUrl: string): Promise<void> {
    if (typeof window === 'undefined' || !window.__natstackPanelBridge) return;

    try {
      // Get the list of cache keys this repo has used before
      const cacheKeys = await window.__natstackPanelBridge.getRepoCacheKeys();
      if (cacheKeys.length === 0) {
        console.log('[Cache] No previous cache entries for this repo');
        return;
      }

      // Load only those specific entries
      const entries = await window.__natstackPanelBridge.loadCacheEntries(cacheKeys);

      let loadedCount = 0;
      let expiredCount = 0;

      for (const [key, entry] of Object.entries(entries)) {
        // Check expiration
        const typedEntry: CacheEntry<string> = {
          key: entry.key,
          value: entry.value,
          timestamp: entry.timestamp,
          size: entry.size,
        };
        if (this.isExpired(typedEntry)) {
          expiredCount++;
          if (expiredCount <= 5) {
            console.log(`[Cache] Skipping expired entry: ${key.slice(0, 50)}... (age: ${Math.round((Date.now() - entry.timestamp) / 1000)}s)`);
          }
          continue;
        }
        this.cache.set(key, typedEntry);
        this.accessOrder.push(key);
        this.totalSize += typedEntry.size;
        loadedCount++;
      }

      console.log(`[Cache] Loaded ${loadedCount} entries for repo ${repoUrl}${expiredCount > 0 ? ` (skipped ${expiredCount} expired)` : ''}`);
    } catch (error) {
      console.error('[Cache] Failed to load from repo:', error);
    }
  }

  /**
   * Start periodic cleanup timer for expired entries (dev mode only)
   */
  private startCleanupTimer(): void {
    const devMode = globalStore.__natstackDevMode ?? false;
    if (!devMode || this.options.expirationMs === 0) {
      return; // No cleanup needed in production or when expiration disabled
    }

    // Clear existing timer if any
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
    }

    // Run cleanup every minute
    this.cleanupTimer = setInterval(() => {
      this.cleanupExpiredEntries();
    }, CACHE_TIMINGS.CLEANUP_INTERVAL_MS);

    console.log(`[Cache] Started periodic cleanup timer (interval: ${CACHE_TIMINGS.CLEANUP_INTERVAL_MS / 1000}s)`);
  }

  /**
   * Remove all expired entries from cache
   */
  private cleanupExpiredEntries(): void {
    let removedCount = 0;
    const keysToRemove: string[] = [];

    for (const [key, entry] of this.cache.entries()) {
      if (this.isExpired(entry)) {
        keysToRemove.push(key);
      }
    }

    for (const key of keysToRemove) {
      const entry = this.cache.get(key);
      if (entry) {
        this.totalSize -= entry.size;
        this.cache.delete(key);
        this.accessOrder = this.accessOrder.filter(k => k !== key);
        removedCount++;
      }
    }

    if (removedCount > 0) {
      console.log(`[Cache] Cleanup: removed ${removedCount} expired entries`);
      this.queueDiskSave(); // Save after cleanup
    }
  }

  /**
   * Queue a debounced sync to main process
   * Only syncs entries that have been modified (tracked in dirtyKeys)
   */
  private queueDiskSave(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
    }

    this.saveTimer = setTimeout(() => {
      this.saveToDisk().catch((error) => {
        console.error('[Cache] Unhandled error in debounced save:', error);
      });
    }, CACHE_TIMINGS.SAVE_DEBOUNCE_MS);
  }

  private async saveToDisk(): Promise<void> {
    if (!this.initialized) return;
    if (typeof window === 'undefined' || !window.__natstackPanelBridge) return;
    if (this.dirtyKeys.size === 0) return; // Nothing to sync

    // Circuit breaker: Stop trying if we've failed too many times
    if (this.saveCircuitOpen) {
      console.warn(`[Cache] Circuit breaker open - skipping save (${this.dirtyKeys.size} dirty keys pending)`);
      return;
    }

    const entriesToSync = this.dirtyKeys.size;
    const startTime = Date.now();

    try {
      // Only sync dirty entries to main process
      const entries: Record<string, CacheEntry<string>> = {};
      for (const key of this.dirtyKeys) {
        const entry = this.cache.get(key);
        if (entry) {
          entries[key] = entry;
        }
      }

      await window.__natstackPanelBridge.saveDiskCache(entries);
      const duration = Date.now() - startTime;
      console.log(`[Cache] Synced ${Object.keys(entries).length} entries to main process (${duration}ms)`);

      // Clear dirty tracking after successful sync
      this.dirtyKeys.clear();
      this.metrics.diskSyncs++;
      this.metrics.lastSyncTimestamp = Date.now();

      // Reset failure counter on success
      this.saveFailureCount = 0;
      if (this.saveCircuitOpen) {
        console.log('[Cache] Circuit breaker closed - save successful');
        this.saveCircuitOpen = false;
      }
    } catch (error) {
      const duration = Date.now() - startTime;
      console.error(`[Cache] Failed to sync ${entriesToSync} entries to main process after ${duration}ms:`, error);

      // Track error and increment failure counter
      this.metrics.diskSyncErrors++;
      this.saveFailureCount++;

      // Open circuit breaker if too many consecutive failures
      if (this.saveFailureCount >= this.MAX_SAVE_FAILURES) {
        this.saveCircuitOpen = true;
        console.error(`[Cache] Circuit breaker opened after ${this.saveFailureCount} consecutive failures - disk persistence disabled`);
        console.error(`[Cache] WARNING: ${this.dirtyKeys.size} dirty keys will NOT be saved to disk`);
      }

      // Warn if dirty keys accumulating (but below circuit breaker threshold)
      if (this.dirtyKeys.size > 1000 && !this.saveCircuitOpen) {
        console.warn(`[Cache] WARNING: ${this.dirtyKeys.size} dirty keys pending sync - save failures: ${this.saveFailureCount}/${this.MAX_SAVE_FAILURES}`);
      }

      // Don't re-throw - allow operation to continue with in-memory cache
      // Re-throwing would cause the debounced save to keep retrying immediately
    }
  }

  /**
   * Queue a debounced report of cache hits to main process
   */
  private queueHitReport(): void {
    if (this.hitReportTimer) {
      clearTimeout(this.hitReportTimer);
    }

    this.hitReportTimer = setTimeout(() => {
      void this.reportCacheHits();
    }, CACHE_TIMINGS.HIT_REPORT_DEBOUNCE_MS);
  }

  private async reportCacheHits(): Promise<void> {
    if (this.cacheHits.size === 0) return;
    if (typeof window === 'undefined' || !window.__natstackPanelBridge) return;

    try {
      const hits = Array.from(this.cacheHits);
      await window.__natstackPanelBridge.recordCacheHits(hits);
      console.log(`[Cache] Reported ${hits.length} cache hit(s)`);
      this.cacheHits.clear();
    } catch (error) {
      console.warn('[Cache] Failed to report cache hits:', error);
      // Keep hits for retry
    }
  }

  /**
   * Check if entry is expired based on dev mode setting
   */
  private isExpired(entry: CacheEntry<string>): boolean {
    // Check global dev mode setting
    const devMode = globalStore.__natstackDevMode ?? false;

    if (!devMode || this.options.expirationMs === 0) {
      return false; // Never expire in production or if expiration disabled
    }

    const age = Date.now() - entry.timestamp;
    return age > this.options.expirationMs;
  }

  /**
   * Update LRU access order (move key to end, most recently used)
   * Uses indexOf + splice for O(n) performance instead of filter
   */
  private updateAccessOrder(key: string): void {
    // Remove existing instance if present (should only be one)
    const index = this.accessOrder.indexOf(key);
    if (index !== -1) {
      this.accessOrder.splice(index, 1);
    }
    // Add to end (most recently used)
    this.accessOrder.push(key);
  }

  /**
   * Remove key from access order (used when deleting expired entries)
   * Removes all instances to prevent corruption
   */
  private removeFromAccessOrder(key: string): void {
    this.accessOrder = this.accessOrder.filter(k => k !== key);
  }

  /**
   * Get cached value by key
   */
  get(key: string): string | null {
    const startTime = performance.now();
    const entry = this.cache.get(key);

    if (!entry) {
      this.metrics.misses++;
      this.recordGetTime(performance.now() - startTime);
      return null;
    }

    // Check expiration
    if (this.isExpired(entry)) {
      this.totalSize -= entry.size;
      this.cache.delete(key);
      this.removeFromAccessOrder(key);
      this.metrics.expirations++;
      this.metrics.misses++;
      this.queueDiskSave(); // Save after deletion
      this.recordGetTime(performance.now() - startTime);
      return null;
    }

    // Update access order (LRU)
    this.updateAccessOrder(key);

    // Track cache hit for repo manifest
    this.cacheHits.add(key);
    this.queueHitReport();

    this.metrics.hits++;
    this.recordGetTime(performance.now() - startTime);

    return entry.value;
  }

  /**
   * Set cached value
   */
  async set(key: string, value: string): Promise<void> {
    const startTime = performance.now();
    const size = value.length;
    const entry: CacheEntry<string> = {
      key,
      value,
      timestamp: Date.now(),
      size,
    };

    // Check size limits
    if (size > this.options.maxSize) {
      console.warn(`[Cache] Entry ${key} exceeds max size (${size} > ${this.options.maxSize}), skipping`);
      this.recordSetTime(performance.now() - startTime);
      return;
    }

    // Check if updating existing entry
    const existingEntry = this.cache.get(key);
    if (existingEntry) {
      this.totalSize -= existingEntry.size;
    }

    // Evict if necessary (before adding, to ensure space)
    await this.evictIfNeeded(size);

    // Add to cache
    this.cache.set(key, entry);
    this.totalSize += size;

    // Update access order (LRU) - move to end (most recently used)
    this.updateAccessOrder(key);

    // Mark as dirty for syncing to main process
    this.dirtyKeys.add(key);

    // Queue sync to main process (debounced)
    this.queueDiskSave();

    this.recordSetTime(performance.now() - startTime);
  }

  /**
   * Evict old entries if cache is full
   */
  private async evictIfNeeded(newEntrySize: number): Promise<void> {
    // Check entry count limit
    while (this.cache.size >= this.options.maxEntries && this.accessOrder.length > 0) {
      const oldestKey = this.accessOrder.shift()!;
      const entry = this.cache.get(oldestKey);
      if (entry) {
        this.totalSize -= entry.size;
        this.cache.delete(oldestKey);
        this.metrics.evictions++;
        console.log(`[Cache] Evicted ${oldestKey} (LRU, entry count limit)`);
      }
    }

    // Check total size limit (use running counter instead of recalculating)
    while (this.totalSize + newEntrySize > this.options.maxSize && this.accessOrder.length > 0) {
      const oldestKey = this.accessOrder.shift()!;
      const entry = this.cache.get(oldestKey);
      if (entry) {
        this.totalSize -= entry.size;
        this.cache.delete(oldestKey);
        this.metrics.evictions++;
        console.log(`[Cache] Evicted ${oldestKey} (LRU, size limit)`);
      }
    }

    // Queue save after eviction
    this.queueDiskSave();
  }

  /**
   * Get total cache size in bytes (uses running counter for O(1) performance)
   */
  private getTotalSize(): number {
    return this.totalSize;
  }

  /**
   * Clear all cached entries
   */
  async clear(): Promise<void> {
    const size = this.cache.size;
    this.cache.clear();
    this.accessOrder = [];
    this.totalSize = 0;
    this.dirtyKeys.clear();

    // Cancel pending saves
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }

    // Cancel cleanup timer
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }

    // Cancel pending hit reports
    if (this.hitReportTimer) {
      clearTimeout(this.hitReportTimer);
      this.hitReportTimer = null;
    }

    console.log(`[Cache] Cleared ${size} entries from local memory`);
    console.log(`[Cache] Note: Main process cache should be cleared via app:clear-build-cache`);
  }

  /**
   * Get cache statistics
   */
  getStats(): CacheStats {
    const timestamps = Array.from(this.cache.values()).map(e => e.timestamp);
    return {
      entries: this.cache.size,
      totalSize: this.getTotalSize(),
      oldestEntry: timestamps.length > 0 ? Math.min(...timestamps) : null,
      newestEntry: timestamps.length > 0 ? Math.max(...timestamps) : null,
    };
  }

  /**
   * Wait for all pending disk writes to complete
   */
  async flush(): Promise<void> {
    // Cancel timer and save immediately
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    await this.saveToDisk();
  }

  /**
   * Close the cache and flush to disk
   */
  async close(): Promise<void> {
    // Stop all timers
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }

    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }

    if (this.hitReportTimer) {
      clearTimeout(this.hitReportTimer);
      this.hitReportTimer = null;
    }

    // Flush pending saves and hit reports
    await this.flush();
  }

  /**
   * Get cache performance metrics
   */
  getMetrics(): CacheMetrics {
    const totalRequests = this.metrics.hits + this.metrics.misses;
    const hitRate = totalRequests > 0 ? this.metrics.hits / totalRequests : 0;

    // Calculate average timings (keep last 100 samples)
    const avgGetTime = this.metrics.getTimes.length > 0
      ? this.metrics.getTimes.reduce((a, b) => a + b, 0) / this.metrics.getTimes.length
      : 0;
    const avgSetTime = this.metrics.setTimes.length > 0
      ? this.metrics.setTimes.reduce((a, b) => a + b, 0) / this.metrics.setTimes.length
      : 0;

    return {
      hits: this.metrics.hits,
      misses: this.metrics.misses,
      hitRate,
      currentEntries: this.cache.size,
      currentSize: this.getTotalSize(),
      maxEntries: this.options.maxEntries,
      maxSize: this.options.maxSize,
      evictions: this.metrics.evictions,
      expirations: this.metrics.expirations,
      averageGetTimeMs: avgGetTime,
      averageSetTimeMs: avgSetTime,
      diskSyncs: this.metrics.diskSyncs,
      diskSyncErrors: this.metrics.diskSyncErrors,
      lastSyncTimestamp: this.metrics.lastSyncTimestamp,
      initTimestamp: this.metrics.initTimestamp,
      uptimeMs: this.metrics.initTimestamp > 0 ? Date.now() - this.metrics.initTimestamp : 0,
    };
  }

  /**
   * Record a get operation timing (keep rolling window of last 100)
   */
  private recordGetTime(timeMs: number): void {
    this.metrics.getTimes.push(timeMs);
    if (this.metrics.getTimes.length > 100) {
      this.metrics.getTimes.shift();
    }
  }

  /**
   * Record a set operation timing (keep rolling window of last 100)
   */
  private recordSetTime(timeMs: number): void {
    this.metrics.setTimes.push(timeMs);
    if (this.metrics.setTimes.length > 100) {
      this.metrics.setTimes.shift();
    }
  }

  /**
   * Reset metrics (useful for testing)
   */
  resetMetrics(): void {
    this.metrics = {
      hits: 0,
      misses: 0,
      evictions: 0,
      expirations: 0,
      diskSyncs: 0,
      diskSyncErrors: 0,
      lastSyncTimestamp: null,
      initTimestamp: this.metrics.initTimestamp,
      getTimes: [],
      setTimes: [],
    };
  }
}

/**
 * Get or create the global unified cache instance
 */
export function getUnifiedCache(): UnifiedCache {
  if (!globalStore.__natstackUnifiedCache) {
    // Create with defaults - will be updated from config during initialize()
    const devMode = globalStore.__natstackDevMode ?? false;
    globalStore.__natstackUnifiedCache = new UnifiedCache({
      maxEntries: CACHE_DEFAULTS.MAX_ENTRIES_PER_PANEL,
      maxSize: CACHE_DEFAULTS.MAX_SIZE_PER_PANEL,
      expirationMs: devMode ? CACHE_DEFAULTS.DEV_EXPIRATION_MS : CACHE_DEFAULTS.PROD_EXPIRATION_MS,
    });
  }
  return globalStore.__natstackUnifiedCache;
}

/**
 * Initialize the global cache (call once on app start)
 */
export async function initializeCache(): Promise<void> {
  const cache = getUnifiedCache();
  await cache.initialize();
}

/**
 * Clear the global cache
 */
export async function clearCache(): Promise<void> {
  const cache = getUnifiedCache();
  await cache.clear();
}

/**
 * Get cache statistics
 */
export function getCacheStats(): CacheStats {
  const cache = getUnifiedCache();
  return cache.getStats();
}

/**
 * Compute SHA-256 hash for cache key
 *
 * Uses full 256-bit hash (64 hex characters) to prevent collisions.
 * Birthday paradox: 50% collision probability only after 2^128 entries with full hash.
 *
 * For cache safety, we use the full hash rather than truncating to 64 bits.
 * Storage overhead is negligible (~48 bytes per key), and collision resistance is critical
 * for build cache integrity (collisions could serve wrong build artifacts).
 */
export async function computeHash(content: string): Promise<string> {
  if (typeof crypto !== 'undefined' && crypto.subtle) {
    const encoder = new TextEncoder();
    const data = encoder.encode(content);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    // Return full SHA-256 hash (256 bits = 64 hex characters)
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  }

  // Fallback: simple string hash (only in environments without crypto.subtle)
  // This is significantly weaker but better than nothing
  let hash = 0;
  for (let i = 0; i < content.length; i++) {
    const char = content.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  // Return as 16-character hex string (fallback only)
  return Math.abs(hash).toString(16).padStart(16, '0').slice(0, 16);
}
