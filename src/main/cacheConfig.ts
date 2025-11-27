/**
 * Cache configuration with centralized defaults
 */

import { loadCentralConfig } from './workspace/loader.js';
import type { CacheConfig } from './workspace/types.js';

/**
 * Default cache configuration values
 */
export const DEFAULT_CACHE_CONFIG: Required<CacheConfig> = {
  // Main process cache limits (global storage)
  maxEntries: 100000, // 100K entries
  maxSize: 5 * 1024 * 1024 * 1024, // 5GB

  // Panel cache limits (per-panel selective loading)
  maxEntriesPerPanel: 50000, // 50K entries per panel
  maxSizePerPanel: 2 * 1024 * 1024 * 1024, // 2GB per panel

  // Repo manifest tracking limits
  maxKeysPerRepo: 5000, // Track up to 5K cache keys per repo
  maxRepos: 100, // Track up to 100 repos

  // Cache expiration (dev mode only)
  expirationMs: 5 * 60 * 1000, // 5 minutes in dev mode
};

let cachedConfig: Required<CacheConfig> | null = null;

/**
 * Get cache configuration from central config, with defaults
 * This is cached after first load for performance
 */
export function getCacheConfig(): Required<CacheConfig> {
  if (cachedConfig) {
    return cachedConfig;
  }

  const centralConfig = loadCentralConfig();
  const userConfig = centralConfig.cache ?? {};

  cachedConfig = {
    maxEntries: userConfig.maxEntries ?? DEFAULT_CACHE_CONFIG.maxEntries,
    maxSize: userConfig.maxSize ?? DEFAULT_CACHE_CONFIG.maxSize,
    maxEntriesPerPanel: userConfig.maxEntriesPerPanel ?? DEFAULT_CACHE_CONFIG.maxEntriesPerPanel,
    maxSizePerPanel: userConfig.maxSizePerPanel ?? DEFAULT_CACHE_CONFIG.maxSizePerPanel,
    maxKeysPerRepo: userConfig.maxKeysPerRepo ?? DEFAULT_CACHE_CONFIG.maxKeysPerRepo,
    maxRepos: userConfig.maxRepos ?? DEFAULT_CACHE_CONFIG.maxRepos,
    expirationMs: userConfig.expirationMs ?? DEFAULT_CACHE_CONFIG.expirationMs,
  };

  return cachedConfig;
}

/**
 * Clear cached config (for testing or hot reload)
 */
export function clearCachedConfig(): void {
  cachedConfig = null;
}
