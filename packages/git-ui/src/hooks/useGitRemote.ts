import { useCallback, useEffect, useState } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import { configAtom, branchAtom, refreshStatusAtom } from "../store";
import type { GitProgress, RemoteStatus } from "@natstack/git";
import { GitAuthError } from "@natstack/git";

interface UseGitRemoteResult {
  status: RemoteStatus | null;
  loading: boolean;
  progress: GitProgress | null;
  isPulling: boolean;
  isPushing: boolean;
  authError: GitAuthError | null;
  error: Error | null;
  refresh: () => Promise<void>;
  pull: () => Promise<void>;
  push: () => Promise<void>;
  clearAuthError: () => void;
}

export function useGitRemote(): UseGitRemoteResult {
  const config = useAtomValue(configAtom);
  const branch = useAtomValue(branchAtom);
  const refreshStatus = useSetAtom(refreshStatusAtom);

  const [status, setStatus] = useState<RemoteStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState<GitProgress | null>(null);
  const [isPulling, setIsPulling] = useState(false);
  const [isPushing, setIsPushing] = useState(false);
  const [authError, setAuthError] = useState<GitAuthError | null>(null);
  const [error, setError] = useState<Error | null>(null);

  const refresh = useCallback(async () => {
    if (!config) return;
    setLoading(true);
    setError(null);
    try {
      const next = await config.gitClient.getRemoteStatus(config.dir);
      setStatus(next);
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setLoading(false);
    }
  }, [config]);

  useEffect(() => {
    if (!config) return;
    void refresh();
  }, [config, branch, refresh]);

  const onProgress = useCallback((value: GitProgress) => {
    setProgress(value);
  }, []);

  const clearAuthError = useCallback(() => {
    setAuthError(null);
  }, []);

  const pull = useCallback(async () => {
    if (!config) return;
    setIsPulling(true);
    setProgress(null);
    setError(null);
    setAuthError(null);
    try {
      await config.gitClient.pull({ dir: config.dir, onProgress });
      await refreshStatus({ type: "user-action", action: "pull" });
      await refresh();
    } catch (err) {
      if (err instanceof GitAuthError) {
        setAuthError(err);
      } else {
        setError(err instanceof Error ? err : new Error(String(err)));
      }
    } finally {
      setIsPulling(false);
      setProgress(null);
    }
  }, [config, onProgress, refresh, refreshStatus]);

  const push = useCallback(async () => {
    if (!config) return;
    setIsPushing(true);
    setProgress(null);
    setError(null);
    setAuthError(null);
    try {
      await config.gitClient.push({ dir: config.dir, onProgress });
      await refreshStatus({ type: "user-action", action: "push" });
      await refresh();
    } catch (err) {
      if (err instanceof GitAuthError) {
        setAuthError(err);
      } else {
        setError(err instanceof Error ? err : new Error(String(err)));
      }
    } finally {
      setIsPushing(false);
      setProgress(null);
    }
  }, [config, onProgress, refresh, refreshStatus]);

  return {
    status,
    loading: loading || isPulling || isPushing,
    progress,
    isPulling,
    isPushing,
    authError,
    error,
    refresh,
    pull,
    push,
    clearAuthError,
  };
}
