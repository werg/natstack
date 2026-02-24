/**
 * ContextFolderManager — Manages per-context directories on disk.
 *
 * Each context gets a real folder at `{workspace.path}/.contexts/{contextId}/`
 * that starts as a copy of all workspace git repos (excluding .git/,
 * node_modules/, .cache/, .databases/). Panel fs calls are routed to these
 * folders via RPC, making files visible on disk and accessible to server-side
 * tools and agents.
 */

import * as fs from "fs/promises";
import * as path from "path";
import { createDevLogger } from "./devLog.js";

import type { WorkspaceNode } from "../shared/types.js";

const log = createDevLogger("ContextFolderManager");

/** Directories to skip when copying repos into context folders. */
const SKIP_DIRS = new Set([".git", "node_modules", ".cache", ".databases"]);

/**
 * Validate that a context ID is safe as a single directory name.
 * Rejects: contains / or \, equals . or .., contains null bytes, exceeds 200 chars.
 */
function validateContextId(contextId: string): void {
  if (!contextId || contextId.length > 200) {
    throw new Error(`Invalid context ID: length must be 1-200, got ${contextId.length}`);
  }
  if (contextId === "." || contextId === "..") {
    throw new Error(`Invalid context ID: '${contextId}' is reserved`);
  }
  if (contextId.includes("/") || contextId.includes("\\")) {
    throw new Error(`Invalid context ID: must not contain slashes`);
  }
  if (contextId.includes("\0")) {
    throw new Error(`Invalid context ID: must not contain null bytes`);
  }
}

/** fs.cp filter callback that skips SKIP_DIRS entries. */
function copyFilter(src: string): boolean {
  const base = path.basename(src);
  return !SKIP_DIRS.has(base);
}

export class ContextFolderManager {
  private readonly contextsRoot: string;
  private readonly workspacePath: string;
  private readonly getWorkspaceTree: () => Promise<{ children: WorkspaceNode[] }>;

  /** Concurrency guard: in-flight ensureContextFolder promises. */
  private readonly inflight = new Map<string, Promise<string>>();

  constructor(opts: {
    workspacePath: string;
    getWorkspaceTree: () => Promise<{ children: WorkspaceNode[] }>;
  }) {
    this.workspacePath = opts.workspacePath;
    this.contextsRoot = path.join(opts.workspacePath, ".contexts");
    this.getWorkspaceTree = opts.getWorkspaceTree;
  }

  /**
   * Returns absolute path to the context folder, creating it and copying
   * workspace git repos into it if it doesn't exist yet.
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

        // Copy each repo (minus excluded dirs)
        for (const repoPath of repos) {
          const src = path.join(this.workspacePath, repoPath);
          const dest = path.join(contextPath, repoPath);
          await fs.mkdir(path.dirname(dest), { recursive: true });
          await fs.cp(src, dest, { recursive: true, filter: copyFilter });
        }

        // Generate SDK plugin manifest for skill discovery
        const skillRepos = repos.filter((r) => r.startsWith("workspace/skills/"));
        if (skillRepos.length > 0) {
          const skillsDir = path.join(contextPath, "workspace", "skills");
          await fs.mkdir(skillsDir, { recursive: true });
          const manifest = {
            name: "natstack-skills",
            skills: skillRepos.map((r) => `./${r.slice("workspace/skills/".length)}`),
          };
          await fs.writeFile(
            path.join(skillsDir, "package.json"),
            JSON.stringify(manifest, null, 2),
          );
        }

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
