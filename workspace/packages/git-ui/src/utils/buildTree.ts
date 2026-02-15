import type { FileChange } from "../store/types";

/**
 * Tree node representation for file hierarchy
 */
export interface TreeNode {
  name: string;
  path: string;
  isDirectory: boolean;
  children: TreeNode[];
  file?: FileChange;
}

/**
 * Build a tree structure from a flat list of file changes.
 * Used by both FileTree and FileOverview components.
 *
 * @param files - Array of file changes to build tree from
 * @returns Root tree node with nested children
 */
export function buildTree(files: FileChange[]): TreeNode {
  const root: TreeNode = {
    name: "",
    path: "",
    isDirectory: true,
    children: [],
  };

  for (const file of files) {
    const parts = file.path.split("/");
    let current = root;

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (part === undefined) continue;
      const isLast = i === parts.length - 1;
      const childPath = parts.slice(0, i + 1).join("/");

      let child = current.children.find((c) => c.name === part);
      if (!child) {
        // For directory entries (isDirectory: true), the entire path is a directory
        const isDirectory = file.isDirectory ? true : !isLast;
        child = {
          name: part,
          path: childPath,
          isDirectory,
          children: [],
          // Only set file reference for actual files (not directories)
          file: isLast && !file.isDirectory ? file : undefined,
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
 * Recursively sort tree children: directories first, then alphabetically by name.
 */
function sortTreeChildren(node: TreeNode): void {
  node.children.sort((a, b) => {
    // Directories before files
    if (a.isDirectory && !b.isDirectory) return -1;
    if (!a.isDirectory && b.isDirectory) return 1;
    // Alphabetical within same type
    return a.name.localeCompare(b.name);
  });
  // Recursively sort children
  for (const child of node.children) {
    if (child.isDirectory) {
      sortTreeChildren(child);
    }
  }
}
