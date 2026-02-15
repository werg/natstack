/**
 * Hook for fetching workspace tree.
 */

import { useState, useEffect, useCallback } from "react";
import { rpc } from "@workspace/runtime";
import type { WorkspaceTree, WorkspaceNode } from "../types";

export interface UseWorkspaceTreeResult {
  /** Workspace tree */
  tree: WorkspaceTree | null;
  /** Loading state */
  loading: boolean;
  /** Error message */
  error: string | null;
  /** Reload the tree */
  reload: () => Promise<void>;
}

/**
 * Find all git repos in the workspace tree.
 */
export function findGitRepos(nodes: WorkspaceNode[], parentPath = ""): WorkspaceNode[] {
  const repos: WorkspaceNode[] = [];

  for (const node of nodes) {
    const nodePath = parentPath ? `${parentPath}/${node.name}` : node.name;

    if (node.isGitRepo) {
      repos.push({ ...node, path: nodePath });
    }

    if (node.children.length > 0) {
      repos.push(...findGitRepos(node.children, nodePath));
    }
  }

  return repos;
}

/**
 * Filter repos by directory prefix.
 */
export function filterReposByPrefix(repos: WorkspaceNode[], prefix: string): WorkspaceNode[] {
  return repos.filter(r => r.path.startsWith(prefix));
}

/** Directories that can contain project repos */
export const PROJECT_DIRECTORIES = ["contexts", "panels", "workers", "projects"];

/**
 * Find all git repos in known project directories.
 */
export function findProjectRepos(nodes: WorkspaceNode[], parentPath = ""): WorkspaceNode[] {
  const repos: WorkspaceNode[] = [];

  for (const node of nodes) {
    const nodePath = parentPath ? `${parentPath}/${node.name}` : node.name;
    const topDir = nodePath.split("/")[0] ?? "";

    // Only include repos from known project directories
    if (PROJECT_DIRECTORIES.includes(topDir) && node.isGitRepo) {
      repos.push({ ...node, path: nodePath });
    }

    // Recurse into children
    if (node.children.length > 0) {
      repos.push(...findProjectRepos(node.children, nodePath));
    }
  }

  return repos;
}

/**
 * Group repos by their top-level directory.
 */
export function groupReposByDirectory(repos: WorkspaceNode[]): Record<string, WorkspaceNode[]> {
  const groups: Record<string, WorkspaceNode[]> = {};
  for (const repo of repos) {
    const topDir = repo.path.split("/")[0] ?? "";
    if (!groups[topDir]) {
      groups[topDir] = [];
    }
    groups[topDir].push(repo);
  }
  return groups;
}

export function useWorkspaceTree(): UseWorkspaceTreeResult {
  const [tree, setTree] = useState<WorkspaceTree | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const result = await rpc.call<WorkspaceTree>("main", "bridge.getWorkspaceTree");
      setTree(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load workspace tree");
      setTree(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return {
    tree,
    loading,
    error,
    reload: load,
  };
}
