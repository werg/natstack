/**
 * Cache configuration with centralized defaults
 */

import { loadCentralConfig } from "./workspace/loader.js";
import type { CacheConfig } from "./workspace/types.js";

/**
 * Default cache configuration values
 */
export const DEFAULT_CACHE_CONFIG: Required<CacheConfig> = {
  // Main process cache limits (global storage)
  maxEntries: 100000, // 100K entries
  maxSize: 5 * 1024 * 1024 * 1024, // 5GB

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
    expirationMs: userConfig.expirationMs ?? DEFAULT_CACHE_CONFIG.expirationMs,
  };

  return cachedConfig;
}
