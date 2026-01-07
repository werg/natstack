import { useCallback, useEffect, useState } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import { configAtom, refreshStatusAtom, branchAtom } from "../store";
import type { BranchInfo, CreateBranchOptions } from "@natstack/git";

interface UseGitBranchesResult {
  branches: BranchInfo[];
  remoteBranches: BranchInfo[];
  currentBranch: string | null;
  loading: boolean;
  error: Error | null;
  refresh: () => Promise<void>;
  createBranch: (options: Omit<CreateBranchOptions, "dir">) => Promise<void>;
  deleteBranch: (name: string) => Promise<void>;
  checkoutBranch: (name: string) => Promise<void>;
}

export function useGitBranches(): UseGitBranchesResult {
  const config = useAtomValue(configAtom);
  const currentBranch = useAtomValue(branchAtom);
  const refreshStatus = useSetAtom(refreshStatusAtom);

  const [branches, setBranches] = useState<BranchInfo[]>([]);
  const [remoteBranches, setRemoteBranches] = useState<BranchInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const refresh = useCallback(async () => {
    if (!config) return;
    setLoading(true);
    setError(null);

    try {
      const [local, remote] = await Promise.all([
        config.gitClient.listBranches(config.dir),
        config.gitClient.listBranches(config.dir, { remote: true }),
      ]);
      const sortedLocal = [...local].sort((a, b) => a.name.localeCompare(b.name));
      const sortedRemote = [...remote].sort((a, b) => {
        const aKey = `${a.remote ?? ""}/${a.name}`;
        const bKey = `${b.remote ?? ""}/${b.name}`;
        return aKey.localeCompare(bKey);
      });
      setBranches(sortedLocal);
      setRemoteBranches(sortedRemote);
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setLoading(false);
    }
  }, [config]);

  // refresh already depends on config, so we just need to trigger when refresh changes
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const createBranch = useCallback(
    async (options: Omit<CreateBranchOptions, "dir">) => {
      if (!config) return;
      await config.gitClient.createBranch({ ...options, dir: config.dir });
      await refreshStatus({ type: "user-action", action: "create-branch" });
      await refresh();
    },
    [config, refreshStatus, refresh]
  );

  const deleteBranch = useCallback(
    async (name: string) => {
      if (!config) return;
      await config.gitClient.deleteBranch(config.dir, name);
      await refreshStatus({ type: "user-action", action: "delete-branch" });
      await refresh();
    },
    [config, refreshStatus, refresh]
  );

  const checkoutBranch = useCallback(
    async (name: string) => {
      if (!config) return;
      await config.gitClient.checkout(config.dir, name);
      await refreshStatus({ type: "user-action", action: "checkout-branch" });
      await refresh();
    },
    [config, refreshStatus, refresh]
  );

  return {
    branches,
    remoteBranches,
    currentBranch,
    loading,
    error,
    refresh,
    createBranch,
    deleteBranch,
    checkoutBranch,
  };
}
