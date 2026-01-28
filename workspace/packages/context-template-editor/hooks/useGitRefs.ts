/**
 * Hook for fetching git refs (branches, tags, commits) for a repo.
 */

import { useState, useEffect, useCallback } from "react";
import { rpc } from "@natstack/runtime";

export interface GitBranch {
  name: string;
  commit: string;
  isCurrent: boolean;
}

export interface GitCommit {
  hash: string;
  message: string;
  author: string;
  date: string;
}

export interface UseGitRefsResult {
  /** List of branches */
  branches: GitBranch[];
  /** Recent commits */
  commits: GitCommit[];
  /** Loading state */
  loading: boolean;
  /** Error message */
  error: string | null;
  /** Reload refs */
  reload: () => Promise<void>;
}

export function useGitRefs(repoSpec: string | null): UseGitRefsResult {
  const [branches, setBranches] = useState<GitBranch[]>([]);
  const [commits, setCommits] = useState<GitCommit[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!repoSpec) {
      setBranches([]);
      setCommits([]);
      return;
    }

    try {
      setLoading(true);
      setError(null);

      // Fetch branches and commits in parallel
      const [branchResult, commitResult] = await Promise.all([
        rpc.call<GitBranch[]>("main", "bridge.listBranches", repoSpec).catch(() => []),
        rpc.call<GitCommit[]>("main", "bridge.listCommits", repoSpec, { limit: 20 }).catch(() => []),
      ]);

      setBranches(branchResult);
      setCommits(commitResult);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load git refs");
      setBranches([]);
      setCommits([]);
    } finally {
      setLoading(false);
    }
  }, [repoSpec]);

  useEffect(() => {
    void load();
  }, [load]);

  return {
    branches,
    commits,
    loading,
    error,
    reload: load,
  };
}
