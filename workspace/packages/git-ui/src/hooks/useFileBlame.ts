import { useCallback, useEffect, useState } from "react";
import { useAtom, useAtomValue } from "jotai";
import { configAtom, blameCacheAtom, type BlameCacheEntry } from "../store";
import type { BlameLine } from "@natstack/git";
import { MAX_CACHED_BLAME_ENTRIES, BLAME_CACHE_TTL_MS } from "../constants";

interface UseFileBlameResult {
  blame: BlameLine[];
  loading: boolean;
  error: Error | null;
  refresh: () => Promise<void>;
}

/**
 * Hook to fetch git blame information for a file.
 *
 * Uses a shared Jotai atom for caching, so multiple hook instances
 * share the same cache. The cache has TTL-based invalidation and FIFO eviction.
 */
export function useFileBlame(path: string | null, enabled = true): UseFileBlameResult {
  const config = useAtomValue(configAtom);
  const [cache, setCache] = useAtom(blameCacheAtom);
  const [blame, setBlame] = useState<BlameLine[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const isCacheValid = useCallback((cacheKey: string): boolean => {
    const entry = cache.get(cacheKey);
    if (!entry) return false;
    return Date.now() - entry.fetchedAt < BLAME_CACHE_TTL_MS;
  }, [cache]);

  const fetchBlame = useCallback(
    async (force = false) => {
      if (!config || !path || !enabled) return;

      // Cache key includes dir to avoid collisions across repositories
      const cacheKey = `${config.dir}:${path}`;

      // Check cache unless forced
      if (!force && isCacheValid(cacheKey)) {
        const entry = cache.get(cacheKey);
        if (entry) {
          setBlame(entry.blame as BlameLine[]);
          return;
        }
      }

      setLoading(true);
      setError(null);

      try {
        const result = await config.gitClient.blame(config.dir, path);

        // Update shared cache with FIFO eviction
        setCache((prev) => {
          const next = new Map(prev);
          // FIFO eviction if at capacity
          if (next.size >= MAX_CACHED_BLAME_ENTRIES && !next.has(cacheKey)) {
            const firstKey = next.keys().next().value;
            if (firstKey) next.delete(firstKey);
          }
          next.set(cacheKey, { blame: result, fetchedAt: Date.now() } as BlameCacheEntry);
          return next;
        });
        setBlame(result);
      } catch (err) {
        setError(err instanceof Error ? err : new Error(String(err)));
      } finally {
        setLoading(false);
      }
    },
    [config, path, enabled, isCacheValid, cache, setCache]
  );

  useEffect(() => {
    if (!path || !enabled) {
      setBlame([]);
      setError(null);
      return;
    }

    // Check cache first (key includes dir to avoid cross-repo collisions)
    if (config) {
      const cacheKey = `${config.dir}:${path}`;
      if (isCacheValid(cacheKey)) {
        const entry = cache.get(cacheKey);
        if (entry) {
          setBlame(entry.blame as BlameLine[]);
          return;
        }
      }
      void fetchBlame();
    }
  }, [path, enabled, config, fetchBlame, isCacheValid, cache]);

  return {
    blame,
    loading,
    error,
    refresh: useCallback(() => fetchBlame(true), [fetchBlame]),
  };
}
