/**
 * ESM dependency caching with content-addressable storage
 *
 * Fetches ESM modules from CDN and caches them with disk persistence
 */

import { getUnifiedCache, computeHash } from './cache-manager.js';

export interface FetchOptions {
  /** CDN base URL */
  cdnBaseUrl?: string;
  /** Custom fetch function (for testing) */
  fetchFn?: typeof fetch;
}

/**
 * Fetch an ESM module with caching
 * Returns the module code as a string
 */
export async function fetchEsmModule(
  packageSpec: string,
  options: FetchOptions = {}
): Promise<string> {
  const cache = getUnifiedCache();
  const cdnBaseUrl = options.cdnBaseUrl ?? 'https://esm.sh';
  const fetchFn = options.fetchFn ?? fetch;

  // Build CDN URL
  const url = `${cdnBaseUrl}/${packageSpec}`;

  // Try cache first with URL as key
  const cacheKey = `esm:${url}`;
  const cached = cache.get(cacheKey);
  if (cached) {
    console.log(`[ESM Cache] Hit for ${packageSpec}`);
    return cached;
  }

  // Fetch from CDN
  console.log(`[ESM Cache] Fetching ${packageSpec} from ${url}`);
  try {
    const response = await fetchFn(url);
    if (!response.ok) {
      throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`);
    }

    const code = await response.text();

    // Cache it
    await cache.set(cacheKey, code);

    console.log(`[ESM Cache] Cached ${packageSpec} (${code.length} bytes)`);
    return code;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to fetch ESM module ${packageSpec}: ${errorMessage}`);
  }
}

/**
 * Prefetch multiple ESM modules in parallel
 */
export async function prefetchEsmModules(
  packages: string[],
  options: FetchOptions = {}
): Promise<Map<string, string>> {
  const results = new Map<string, string>();

  await Promise.all(
    packages.map(async (pkg) => {
      try {
        const code = await fetchEsmModule(pkg, options);
        results.set(pkg, code);
      } catch (error) {
        console.warn(`[ESM Cache] Failed to prefetch ${pkg}:`, error);
      }
    })
  );

  return results;
}

/**
 * Check if an ESM module is cached
 */
export function isEsmModuleCached(packageSpec: string, cdnBaseUrl = 'https://esm.sh'): boolean {
  const cache = getUnifiedCache();
  const url = `${cdnBaseUrl}/${packageSpec}`;
  const cacheKey = `esm:${url}`;
  return cache.get(cacheKey) !== null;
}

/**
 * Clear all ESM module cache entries
 * Note: This clears the entire unified cache
 */
export async function clearEsmCache(): Promise<void> {
  const cache = getUnifiedCache();
  await cache.clear();
}
