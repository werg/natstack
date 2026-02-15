import { useCallback, useEffect, useState } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import { configAtom, refreshStatusAtom } from "../store";
import type { ConflictInfo, ConflictResolution } from "@natstack/git";

interface UseConflictsResult {
  conflicts: ConflictInfo[];
  loading: boolean;
  resolving: boolean;
  error: Error | null;
  refresh: () => Promise<void>;
  resolve: (resolution: ConflictResolution) => Promise<void>;
}

export function useConflicts(): UseConflictsResult {
  const config = useAtomValue(configAtom);
  const refreshStatus = useSetAtom(refreshStatusAtom);
  const [conflicts, setConflicts] = useState<ConflictInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [resolving, setResolving] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const refresh = useCallback(async () => {
    if (!config) return;
    setLoading(true);
    setError(null);
    try {
      const result = await config.gitClient.getConflicts(config.dir);
      setConflicts(result);
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setLoading(false);
    }
  }, [config]);

  useEffect(() => {
    if (!config) return;
    void refresh();
  }, [config, refresh]);

  const resolve = useCallback(
    async (resolution: ConflictResolution) => {
      if (!config) return;
      setResolving(true);
      setError(null);
      try {
        await config.gitClient.resolveConflict(config.dir, resolution);
        await refreshStatus({ type: "user-action", action: "resolve-conflict" });
        await refresh();
      } catch (err) {
        setError(err instanceof Error ? err : new Error(String(err)));
        throw err;
      } finally {
        setResolving(false);
      }
    },
    [config, refreshStatus, refresh]
  );

  return { conflicts, loading, resolving, error, refresh, resolve };
}
