/**
 * Shared cache timing and limit constants
 */

export const CACHE_TIMINGS = {
  /** Debounce time for saving cache to disk (ms) */
  SAVE_DEBOUNCE_MS: 5000,

  /** Debounce time for reporting cache hits to main process (ms) */
  HIT_REPORT_DEBOUNCE_MS: 10000,

  /** Interval for cleanup of expired cache entries (ms) */
  CLEANUP_INTERVAL_MS: 60000,

  /** Timeout for IPC operations (ms) - increased for type checking */
  IPC_TIMEOUT_MS: 120000, // 2 minutes

  /** Timeout for filesystem initialization (ms) - increased for large projects */
  INIT_TIMEOUT_MS: 60000, // 1 minute
} as const;

/**
 * Content hashing limits to prevent unbounded file tree walking
 */
export const CONTENT_HASH_LIMITS = {
  /** Maximum number of files to hash for content-based cache keys */
  MAX_FILES: 1000,

  /** Maximum total size of files to hash (100MB) */
  MAX_TOTAL_SIZE_BYTES: 100 * 1024 * 1024,

  /** Maximum size of individual file to hash (10MB) */
  MAX_FILE_SIZE_BYTES: 10 * 1024 * 1024,
} as const;

/**
 * Default cache size limits (per-panel)
 */
export const CACHE_DEFAULTS = {
  /** Default maximum entries per panel cache */
  MAX_ENTRIES_PER_PANEL: 50000,

  /** Default maximum cache size per panel (2GB) */
  MAX_SIZE_PER_PANEL: 2 * 1024 * 1024 * 1024,

  /** Default expiration time in dev mode (5 minutes) */
  DEV_EXPIRATION_MS: 5 * 60 * 1000,

  /** No expiration in production mode */
  PROD_EXPIRATION_MS: 0,
} as const;

/**
 * Main process cache limits (shared across all panels)
 */
export const MAIN_CACHE_DEFAULTS = {
  /** Maximum entries in main process cache */
  MAX_ENTRIES: 100000,

  /** Maximum cache size in main process (5GB) */
  MAX_SIZE: 5 * 1024 * 1024 * 1024,

  /** Debounce time for saving to disk (5 seconds) */
  SAVE_DEBOUNCE_MS: 5000,
} as const;

/**
 * Repo manifest tracking limits
 */
export const REPO_MANIFEST_DEFAULTS = {
  /** Maximum cache keys tracked per repo */
  MAX_KEYS_PER_REPO: 5000,

  /** Maximum repos to track */
  MAX_REPOS: 100,

  /** Debounce time for saving manifest to disk (5 seconds) */
  SAVE_DEBOUNCE_MS: 5000,
} as const;

/**
 * Circuit breaker thresholds
 */
export const CIRCUIT_BREAKER = {
  /** Maximum consecutive save failures before opening circuit breaker */
  MAX_FAILURES: 5,
} as const;
