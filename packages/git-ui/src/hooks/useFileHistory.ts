import { useCallback, useEffect, useState } from "react";
import { useAtom, useAtomValue } from "jotai";
import { configAtom, historyCacheAtom, type HistoryCacheEntry } from "../store";
import type { FileHistoryEntry } from "@natstack/git";
import { MAX_CACHED_HISTORY_ENTRIES } from "../constants";

interface UseFileHistoryResult {
  history: FileHistoryEntry[];
  loading: boolean;
  error: Error | null;
  refresh: () => Promise<void>;
}

/**
 * Hook to fetch git file history.
 *
 * Uses a shared Jotai atom for caching, so multiple hook instances
 * share the same cache. The cache has FIFO eviction when it exceeds the max size.
 */
export function useFileHistory(path: string | null, enabled = true): UseFileHistoryResult {
  const config = useAtomValue(configAtom);
  const [cache, setCache] = useAtom(historyCacheAtom);
  const [history, setHistory] = useState<FileHistoryEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const fetchHistory = useCallback(
    async (force = false) => {
      if (!config || !path || !enabled) return;

      // Cache key includes dir to avoid collisions across repositories
      const cacheKey = `${config.dir}:${path}`;

      // Check cache unless forced
      if (!force) {
        const cached = cache.get(cacheKey);
        if (cached) {
          setHistory(cached.history as FileHistoryEntry[]);
          return;
        }
      }

      setLoading(true);
      setError(null);

      try {
        const result = await config.gitClient.getFileHistory(config.dir, path);

        // Update shared cache with FIFO eviction
        setCache((prev) => {
          const next = new Map(prev);
          // FIFO eviction if at capacity
          if (next.size >= MAX_CACHED_HISTORY_ENTRIES && !next.has(cacheKey)) {
            const firstKey = next.keys().next().value;
            if (firstKey) next.delete(firstKey);
          }
          next.set(cacheKey, { history: result, fetchedAt: Date.now() } as HistoryCacheEntry);
          return next;
        });
        setHistory(result);
      } catch (err) {
        setError(err instanceof Error ? err : new Error(String(err)));
      } finally {
        setLoading(false);
      }
    },
    [config, path, enabled, cache, setCache]
  );

  useEffect(() => {
    if (!path || !enabled) {
      setHistory([]);
      setError(null);
      return;
    }

    // Check cache first (key includes dir to avoid cross-repo collisions)
    if (config) {
      const cacheKey = `${config.dir}:${path}`;
      const cached = cache.get(cacheKey);
      if (cached) {
        setHistory(cached.history as FileHistoryEntry[]);
        return;
      }
      void fetchHistory();
    }
  }, [path, enabled, config, fetchHistory, cache]);

  return {
    history,
    loading,
    error,
    refresh: useCallback(() => fetchHistory(true), [fetchHistory]),
  };
}
