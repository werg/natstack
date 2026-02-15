/**
 * File tree state management hook.
 *
 * Loads directory contents from the filesystem and manages
 * tree expansion state.
 */

import { useState, useCallback, useEffect } from "react";
import { fs } from "@workspace/runtime";
import type { TreeNode } from "../types";

export interface UseFileTreeResult {
  /** Root tree node containing the file hierarchy */
  root: TreeNode;
  /** Set of expanded directory paths */
  expandedPaths: Set<string>;
  /** Whether initial load is in progress */
  isLoading: boolean;
  /** Error message if loading failed */
  error: string | null;
  /** Toggle a directory's expanded state */
  toggleExpand: (path: string) => void;
  /** Expand a specific path (and all parents) */
  expandPath: (path: string) => void;
  /** Refresh the tree */
  refresh: () => Promise<void>;
}

/**
 * Build a tree structure from flat file entries.
 */
function buildTree(entries: Array<{ path: string; name: string; isDirectory: boolean }>): TreeNode {
  const root: TreeNode = {
    name: "",
    path: "",
    isDirectory: true,
    children: [],
  };

  for (const entry of entries) {
    const parts = entry.path.split("/").filter(Boolean);
    let current = root;

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (!part) continue;
      const isLast = i === parts.length - 1;
      const childPath = "/" + parts.slice(0, i + 1).join("/");

      let child = current.children.find((c) => c.name === part);
      if (!child) {
        child = {
          name: part,
          path: childPath,
          isDirectory: isLast ? entry.isDirectory : true,
          children: [],
        };
        current.children.push(child);
      }
      current = child;
    }
  }

  // Sort children: directories first, then alphabetically
  sortTreeChildren(root);
  return root;
}

/**
 * Recursively sort tree children.
 */
function sortTreeChildren(node: TreeNode): void {
  node.children.sort((a, b) => {
    if (a.isDirectory && !b.isDirectory) return -1;
    if (!a.isDirectory && b.isDirectory) return 1;
    return a.name.localeCompare(b.name);
  });
  for (const child of node.children) {
    if (child.isDirectory) {
      sortTreeChildren(child);
    }
  }
}

/**
 * Recursively collect all file entries from a directory.
 */
async function collectEntries(
  basePath: string,
  relativePath: string = ""
): Promise<Array<{ path: string; name: string; isDirectory: boolean }>> {
  const entries: Array<{ path: string; name: string; isDirectory: boolean }> = [];
  const currentPath = relativePath ? `${basePath}/${relativePath}` : basePath;

  try {
    const names = await fs.readdir(currentPath);

    for (const name of names) {
      // Skip hidden files and node_modules
      if (name.startsWith(".") || name === "node_modules") {
        continue;
      }

      const entryPath = relativePath ? `${relativePath}/${name}` : name;
      const fullPath = `${basePath}/${entryPath}`;

      try {
        const stats = await fs.stat(fullPath);
        const isDirectory = stats.isDirectory();

        entries.push({
          path: entryPath,
          name,
          isDirectory,
        });

        // Recursively load subdirectories
        if (isDirectory) {
          const subEntries = await collectEntries(basePath, entryPath);
          entries.push(...subEntries);
        }
      } catch {
        // Skip entries we can't stat
      }
    }
  } catch {
    // Directory doesn't exist or can't be read
  }

  return entries;
}

/**
 * Hook for managing file tree state.
 */
export function useFileTree(workspacePath: string): UseFileTreeResult {
  const [root, setRoot] = useState<TreeNode>({
    name: "",
    path: "",
    isDirectory: true,
    children: [],
  });
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set([""]));
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadTree = useCallback(async () => {
    setIsLoading(true);
    setError(null);

    try {
      const entries = await collectEntries(workspacePath);
      const tree = buildTree(entries);
      setRoot(tree);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load file tree");
    } finally {
      setIsLoading(false);
    }
  }, [workspacePath]);

  // Load tree on mount and when workspace changes
  useEffect(() => {
    void loadTree();
  }, [loadTree]);

  const toggleExpand = useCallback((path: string) => {
    setExpandedPaths((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  }, []);

  const expandPath = useCallback((path: string) => {
    setExpandedPaths((prev) => {
      const next = new Set(prev);
      // Expand all parent paths
      const parts = path.split("/").filter(Boolean);
      let current = "";
      next.add(current); // Root
      for (const part of parts) {
        current = current ? `${current}/${part}` : `/${part}`;
        next.add(current);
      }
      return next;
    });
  }, []);

  const refresh = useCallback(async () => {
    await loadTree();
  }, [loadTree]);

  return {
    root,
    expandedPaths,
    isLoading,
    error,
    toggleExpand,
    expandPath,
    refresh,
  };
}
