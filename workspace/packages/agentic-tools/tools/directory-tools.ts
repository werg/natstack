/**
 * Directory tools for pubsub RPC.
 *
 * Implements: tree, list_directory
 */

import * as fs from "fs";
import type { Dirent, Stats } from "fs";
import * as path from "path";
import type { MethodDefinition } from "@natstack/agentic-messaging";
import { resolvePath } from "./utils";
import {
  TreeArgsSchema,
  ListDirectoryArgsSchema,
  type TreeArgs,
  type ListDirectoryArgs,
} from "@natstack/agentic-messaging/tool-schemas";

/**
 * Default ignore patterns for tree
 */
const IGNORE_PATTERNS = ["node_modules", ".git", "dist", "build", ".next", "__pycache__", ".cache"];

/**
 * tree - Show directory structure as ASCII tree
 */
export async function tree(args: TreeArgs, workspaceRoot?: string): Promise<string> {
  const { depth = 3, show_hidden: showHidden = false, dirs_only: dirsOnly = false } = args;
  const targetPath = args.path ?? workspaceRoot ?? process.cwd();
  const absolutePath = resolvePath(targetPath, workspaceRoot);

  let dirCount = 0;
  let fileCount = 0;

  async function buildTree(dir: string, currentDepth: number, prefix: string): Promise<string> {
    if (currentDepth > depth) return "";

    let entries: Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return "";
    }

    // Filter entries
    entries = entries.filter((entry) => {
      // Filter hidden files
      if (!showHidden && entry.name.startsWith(".")) return false;

      // Filter ignored directories
      if (entry.isDirectory() && IGNORE_PATTERNS.includes(entry.name)) return false;

      // Filter files if dirsOnly
      if (dirsOnly && !entry.isDirectory()) return false;

      return true;
    });

    // Sort: directories first, then alphabetically
    entries.sort((a, b) => {
      if (a.isDirectory() && !b.isDirectory()) return -1;
      if (!a.isDirectory() && b.isDirectory()) return 1;
      return a.name.localeCompare(b.name);
    });

    let result = "";

    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      const isLast = i === entries.length - 1;
      const connector = isLast ? "└── " : "├── ";
      const childPrefix = prefix + (isLast ? "    " : "│   ");

      if (entry.isDirectory()) {
        dirCount++;
        result += `${prefix}${connector}${entry.name}/\n`;
        if (currentDepth < depth) {
          result += await buildTree(path.join(dir, entry.name), currentDepth + 1, childPrefix);
        }
      } else {
        fileCount++;
        result += `${prefix}${connector}${entry.name}\n`;
      }
    }

    return result;
  }

  // Get the root directory name
  const rootName = path.basename(absolutePath);
  let output = `${rootName}/\n`;
  output += await buildTree(absolutePath, 1, "");

  // Add summary
  output += `\n${dirCount} director${dirCount === 1 ? "y" : "ies"}`;
  if (!dirsOnly) {
    output += `, ${fileCount} file${fileCount === 1 ? "" : "s"}`;
  }

  return output;
}

/**
 * Format file mode as rwx string (like ls -la)
 */
function formatMode(mode: number, isDir: boolean): string {
  const typeChar = isDir ? "d" : "-";

  const ownerR = mode & 0o400 ? "r" : "-";
  const ownerW = mode & 0o200 ? "w" : "-";
  const ownerX = mode & 0o100 ? "x" : "-";

  const groupR = mode & 0o040 ? "r" : "-";
  const groupW = mode & 0o020 ? "w" : "-";
  const groupX = mode & 0o010 ? "x" : "-";

  const otherR = mode & 0o004 ? "r" : "-";
  const otherW = mode & 0o002 ? "w" : "-";
  const otherX = mode & 0o001 ? "x" : "-";

  return `${typeChar}${ownerR}${ownerW}${ownerX}${groupR}${groupW}${groupX}${otherR}${otherW}${otherX}`;
}

/**
 * Format size with padding
 */
function formatSize(size: number): string {
  return size.toString().padStart(8);
}

/**
 * Format date like ls -la
 * Handles both Date objects (Node fs) and ISO strings (fs shim)
 */
function formatDate(mtime: Date | string): string {
  const date = typeof mtime === "string" ? new Date(mtime) : mtime;
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const month = months[date.getMonth()];
  const day = date.getDate().toString().padStart(2);
  const hours = date.getHours().toString().padStart(2, "0");
  const minutes = date.getMinutes().toString().padStart(2, "0");
  return `${month} ${day} ${hours}:${minutes}`;
}

/**
 * list_directory - List directory contents like ls -la
 */
export async function listDirectory(args: ListDirectoryArgs, workspaceRoot?: string): Promise<string> {
  const { path: targetPath } = args;
  const absolutePath = resolvePath(targetPath, workspaceRoot);

  // Check if path exists and is a directory
  let stats: Stats;
  try {
    stats = await fs.promises.stat(absolutePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`Directory not found: ${targetPath}`);
    }
    throw err;
  }

  if (!stats.isDirectory()) {
    throw new Error(`Not a directory: ${targetPath}`);
  }

  // Read directory entries
  const entries = await fs.promises.readdir(absolutePath, { withFileTypes: true });

  // Get stats for each entry
  const entryStats: Array<{ name: string; stats: Stats; isDir: boolean }> = [];

  for (const entry of entries) {
    try {
      const entryPath = path.join(absolutePath, entry.name);
      const entryStat = await fs.promises.stat(entryPath);
      entryStats.push({
        name: entry.name,
        stats: entryStat,
        isDir: entry.isDirectory(),
      });
    } catch {
      // Skip entries we can't stat
      continue;
    }
  }

  // Sort: directories first, then alphabetically
  entryStats.sort((a, b) => {
    if (a.isDir && !b.isDir) return -1;
    if (!a.isDir && b.isDir) return 1;
    return a.name.localeCompare(b.name);
  });

  // Calculate total blocks (simplified - just sum of sizes / 512)
  const totalBlocks = entryStats.reduce((sum, e) => sum + Math.ceil(e.stats.size / 512), 0);

  // Format output
  const lines: string[] = [`total ${totalBlocks}`];

  // Add . and .. entries
  const parentPath = path.dirname(absolutePath);
  try {
    const dotStats = await fs.promises.stat(absolutePath);
    const dotDotStats = await fs.promises.stat(parentPath);

    lines.push(
      `${formatMode(dotStats.mode, true)} ${formatSize(dotStats.size)} ${formatDate(dotStats.mtime)} .`
    );
    lines.push(
      `${formatMode(dotDotStats.mode, true)} ${formatSize(dotDotStats.size)} ${formatDate(dotDotStats.mtime)} ..`
    );
  } catch {
    // Skip . and .. if we can't stat them
  }

  // Add entries
  for (const entry of entryStats) {
    const mode = formatMode(entry.stats.mode, entry.isDir);
    const size = formatSize(entry.stats.size);
    const date = formatDate(entry.stats.mtime);

    lines.push(`${mode} ${size} ${date} ${entry.name}`);
  }

  return lines.join("\n");
}

/**
 * Create method definitions for directory tools
 */
export function createDirectoryToolMethodDefinitions(workspaceRoot?: string): Record<string, MethodDefinition> {
  return {
    tree: {
      description: `Show directory structure as ASCII tree.

Ignores: node_modules, .git, dist, build, .next, __pycache__, .cache
Options: depth, show_hidden, dirs_only`,
      parameters: TreeArgsSchema,
      execute: async (args: unknown) => {
        return await tree(args as TreeArgs, workspaceRoot);
      },
    },
    list_directory: {
      description: `List directory contents (like ls -la).

Shows permissions, size, modification time, and name for each entry.`,
      parameters: ListDirectoryArgsSchema,
      execute: async (args: unknown) => {
        return await listDirectory(args as ListDirectoryArgs, workspaceRoot);
      },
    },
  };
}
