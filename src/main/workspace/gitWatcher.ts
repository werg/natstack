/**
 * Git-based filesystem watcher for workspace repos.
 *
 * Watches for:
 * 1. New .git directories (new repo appeared)
 * 2. Deleted .git directories (repo removed)
 * 3. Changes to .git/refs/heads/* (new commit on a branch)
 *
 * This is the source of truth for triggering GitServer cache invalidation
 * and Verdaccio republishing.
 */

import chokidar from "chokidar";
import { EventEmitter } from "events";
import * as path from "path";
import type { Workspace } from "./types.js";
import { createDevLogger } from "../devLog.js";

const log = createDevLogger("GitWatcher");

export type GitEvent = "repoAdded" | "repoRemoved" | "commitAdded";

export interface GitWatcher {
  on(event: GitEvent, callback: (repoPath: string) => void): () => void;
  close(): Promise<void>;
}

// Normalize path separators to forward slashes (cross-platform)
const normalizePath = (p: string) => p.replace(/\\/g, "/");

// Git ref path pattern (works on all platforms after normalization)
const GIT_REFS_HEADS = ".git/refs/heads/";

export function createGitWatcher(workspace: Workspace): GitWatcher {
  const emitter = new EventEmitter();

  // Workspace root for converting absolute paths to relative
  const workspaceRoot = workspace.path; // Already absolute, no trailing slash

  // Watch the same scope that GitServer scans (gitReposPath = workspace root)
  // This ensures any repo that appears in the tree also triggers cache invalidation
  const watchPaths = [workspace.gitReposPath];

  const watcher = chokidar.watch(watchPaths, {
    ignored: (filePath: string) => {
      const p = normalizePath(filePath);
      // Skip node_modules entirely (must match both the dir and contents)
      if (p.includes("/node_modules")) return true;
      // Skip .git/objects (too noisy)
      if (p.includes("/.git/objects")) return true;
      // Skip .git/logs (reflogs)
      if (p.includes("/.git/logs")) return true;
      // Skip .cache directory
      if (p.includes("/.cache")) return true;
      return false;
    },
    ignoreInitial: true,
    followSymlinks: false, // Don't follow symlinks (prevents traversing pnpm-linked packages)
    // No depth limit - support arbitrary nesting like packages/@scope/deep/nested/lib
  });

  // Convert absolute path to workspace-relative path (handles edge cases properly)
  const toRelativePath = (absolutePath: string): string => {
    return normalizePath(path.relative(workspaceRoot, absolutePath));
  };

  // Extract repo root from a path containing .git (returns relative path)
  // Finds the LAST .git in path to handle edge cases like "some.git/repo/.git/"
  const getRepoRoot = (filePath: string): string | null => {
    const normalized = normalizePath(filePath);
    const lastGitIndex = normalized.lastIndexOf("/.git");
    if (lastGitIndex === -1) return null;
    return toRelativePath(filePath.slice(0, lastGitIndex));
  };

  // Check if path ends with .git (handles both separators)
  const isGitDir = (p: string) => {
    const normalized = normalizePath(p);
    return normalized.endsWith("/.git") || normalized === ".git";
  };

  // Check if path is inside .git/refs/heads/
  const isRefPath = (p: string) => normalizePath(p).includes(GIT_REFS_HEADS);

  // Detect new .git directory = new repo
  watcher.on("addDir", (dirPath) => {
    if (isGitDir(dirPath)) {
      const repoRoot = toRelativePath(path.dirname(dirPath));
      log.verbose(` Repo added: ${repoRoot}`);
      emitter.emit("repoAdded", repoRoot);
    }
  });

  // Detect deleted .git directory = repo removed
  watcher.on("unlinkDir", (dirPath) => {
    if (isGitDir(dirPath)) {
      const repoRoot = toRelativePath(path.dirname(dirPath));
      log.verbose(` Repo removed: ${repoRoot}`);
      emitter.emit("repoRemoved", repoRoot);
    }
  });

  // Detect ref changes = new commit
  watcher.on("change", (filePath) => {
    if (isRefPath(filePath)) {
      const repoRoot = getRepoRoot(filePath);
      if (repoRoot) {
        log.verbose(` Commit detected in: ${repoRoot}`);
        emitter.emit("commitAdded", repoRoot);
      }
    }
  });

  watcher.on("add", (filePath) => {
    if (isRefPath(filePath)) {
      const repoRoot = getRepoRoot(filePath);
      if (repoRoot) {
        log.verbose(` New branch/commit in: ${repoRoot}`);
        emitter.emit("commitAdded", repoRoot);
      }
    }
  });

  return {
    on(event, callback) {
      emitter.on(event, callback);
      return () => emitter.off(event, callback);
    },
    close() {
      return watcher.close();
    },
  };
}
