/**
 * ContextFolderManager — Manages per-context directories on disk.
 *
 * Each context gets a folder at `{contextsRoot}/{contextId}/` that starts as
 * a copy of all workspace git repos from the source tree. Working tree files
 * and mutable git state (HEAD, index, refs, config) are copied per-context,
 * while the immutable object store (.git/objects/) is symlinked to share storage.
 * Panel fs calls are routed to these folders via RPC, making files visible on
 * disk and accessible to server-side tools and agents.
 */

import * as fs from "fs/promises";
import * as path from "path";
import { createDevLogger } from "@natstack/dev-log";

import type { WorkspaceNode } from "./types.js";

const log = createDevLogger("ContextFolderManager");

/** Directories to skip when copying working tree files. */
const SKIP_DIRS = new Set([".git", "node_modules", ".cache", ".databases"]);

/**
 * Mutable git entries to copy into context .git/ (everything else is symlinked).
 * These are the files/dirs that change per-working-tree: staging area, branch
 * pointers, reflogs, config, and local excludes.
 */
const GIT_MUTABLE = new Set(["HEAD", "index", "refs", "logs", "config", "packed-refs", "COMMIT_EDITMSG", "info"]);

/**
 * Validate that a context ID is DNS-safe (lowercase alphanumeric + hyphens).
 * This ensures contextId round-trips through contextIdToSubdomain without lossy normalization.
 */
function validateContextId(contextId: string): void {
  if (!contextId || contextId.length > 63) {
    throw new Error(`Invalid context ID: length must be 1-63, got ${contextId.length}`);
  }
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(contextId)) {
    throw new Error(
      `Invalid context ID: must be lowercase alphanumeric with hyphens, not starting/ending with hyphen. Got "${contextId}"`,
    );
  }
}

/** fs.cp filter callback that skips SKIP_DIRS entries. */
function copyFilter(src: string): boolean {
  const base = path.basename(src);
  return !SKIP_DIRS.has(base);
}

/**
 * Create a context-local .git directory that shares the immutable object store
 * with the source repo via symlink, while copying mutable state (HEAD, index,
 * refs, config, etc.) so each context can commit independently.
 */
async function setupContextGit(srcGit: string, destGit: string): Promise<void> {
  await fs.mkdir(destGit, { recursive: true });

  const entries = await fs.readdir(srcGit, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(srcGit, entry.name);
    const destPath = path.join(destGit, entry.name);

    if (GIT_MUTABLE.has(entry.name)) {
      // Copy mutable state — each context needs its own
      if (entry.isDirectory()) {
        await fs.cp(srcPath, destPath, { recursive: true });
      } else {
        await fs.copyFile(srcPath, destPath);
      }
    } else {
      // Symlink immutable content (objects/, hooks/, description, etc.)
      const relTarget = path.relative(destGit, srcPath);
      await fs.symlink(relTarget, destPath);
    }
  }
}

export class ContextFolderManager {
  private readonly contextsRoot: string;
  private readonly sourcePath: string;
  private readonly getWorkspaceTree: () => Promise<{ children: WorkspaceNode[] }>;

  /** Concurrency guard: in-flight ensureContextFolder promises. */
  private readonly inflight = new Map<string, Promise<string>>();

  constructor(opts: {
    /** Path to the source tree (git repos to copy from) */
    sourcePath: string;
    /** Path to the contexts root directory (where context copies are stored) */
    contextsRoot: string;
    getWorkspaceTree: () => Promise<{ children: WorkspaceNode[] }>;
  }) {
    this.sourcePath = opts.sourcePath;
    this.contextsRoot = opts.contextsRoot;
    this.getWorkspaceTree = opts.getWorkspaceTree;
  }

  /**
   * Returns absolute path to the context folder, creating it if needed.
   * Copies working tree files and sets up .git with shared object store
   * (symlinked) and per-context mutable state (copied).
   */
  async ensureContextFolder(contextId: string): Promise<string> {
    validateContextId(contextId);

    // If another call for the same contextId is in flight, return the existing promise
    const existing = this.inflight.get(contextId);
    if (existing) return existing;

    const contextPath = path.join(this.contextsRoot, contextId);

    const promise = (async () => {
      try {
        // Check if already exists
        try {
          await fs.access(contextPath);
          return contextPath; // Already exists
        } catch {
          // Does not exist, create it
        }

        log.info(`Creating context folder: ${contextId}`);
        await fs.mkdir(contextPath, { recursive: true });

        // Discover all git repos in the workspace
        const tree = await this.getWorkspaceTree();
        const repos = this.collectRepos(tree.children);

        // Copy each repo: working tree files + context-local git state
        for (const repoPath of repos) {
          const src = path.join(this.sourcePath, repoPath);
          const dest = path.join(contextPath, repoPath);
          await fs.mkdir(path.dirname(dest), { recursive: true });
          // Copy working tree (skip .git, node_modules, etc.)
          await fs.cp(src, dest, { recursive: true, filter: copyFilter });
          // Set up .git with shared objects + copied mutable state
          const srcGit = path.join(src, ".git");
          try {
            await fs.access(srcGit);
          } catch {
            continue; // Source repo has no .git (shouldn't happen for isGitRepo, but be safe)
          }
          try {
            await setupContextGit(srcGit, path.join(dest, ".git"));
          } catch (err) {
            console.warn(`[ContextFolder] Failed to setup context git for ${repoPath}:`, err);
          }
        }

        // Generate Claude Agent plugin manifest so skills/ is discovered as a plugin.
        // The CLI expects .claude-plugin/plugin.json at the plugin root, with skills
        // in a skills/ subdirectory (each containing SKILL.md).
        const pluginDir = path.join(contextPath, ".claude-plugin");
        await fs.mkdir(pluginDir, { recursive: true });
        await fs.writeFile(
          path.join(pluginDir, "plugin.json"),
          JSON.stringify({
            name: "natstack-workspace",
            description: "NatStack workspace skills",
            version: "0.1.0",
          }, null, 2),
        );

        log.info(`Context folder ready: ${contextId} (${repos.length} repo(s) copied)`);
        return contextPath;
      } finally {
        this.inflight.delete(contextId);
      }
    })();

    this.inflight.set(contextId, promise);
    return promise;
  }

  /**
   * Returns the absolute path if the context folder exists, null otherwise.
   */
  getContextRoot(contextId: string): string | null {
    validateContextId(contextId);
    const contextPath = path.join(this.contextsRoot, contextId);
    try {
      // Synchronous check — fast path for already-created folders
      require("fs").accessSync(contextPath);
      return contextPath;
    } catch {
      return null;
    }
  }

  /**
   * Deletes a context folder. NOT called automatically — context folders
   * persist as long as any non-archived panel references them.
   * For future explicit admin/GC use only.
   */
  async removeContext(contextId: string): Promise<void> {
    validateContextId(contextId);
    const contextPath = path.join(this.contextsRoot, contextId);
    await fs.rm(contextPath, { recursive: true, force: true });
    log.info(`Removed context folder: ${contextId}`);
  }

  /**
   * Recursively collect repo paths (relative, forward slashes) from workspace tree.
   */
  private collectRepos(nodes: WorkspaceNode[]): string[] {
    const repos: string[] = [];
    for (const node of nodes) {
      if (node.isGitRepo) {
        repos.push(node.path);
      }
      if (node.children.length > 0) {
        repos.push(...this.collectRepos(node.children));
      }
    }
    return repos;
  }
}
