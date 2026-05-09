import { Git } from "node-git-server";
import { getUserDataPath } from "@natstack/env-paths";
import * as path from "path";
import * as fs from "fs";
import * as http from "http";
import { execFile } from "child_process";
import { AsyncLocalStorage } from "async_hooks";
import { createDevLogger } from "@natstack/dev-log";
import { execGitFile, spawnGit, spawnGitSync } from "@natstack/shared/gitRuntime";

const log = createDevLogger("GitServer");
import type {
  WorkspaceTree,
  BranchInfo,
  CommitInfo,
  GitWatcherLike,
  GitWriteAuthorizer,
} from "./types.js";
import { GitAuthManager } from "./auth.js";
import { WorkspaceTreeManager } from "./git/workspaceTree.js";

/**
 * Strict allow-list for user-controlled git refs / branches / paths that flow
 * into `spawn("git", [...args])`. Refs starting with "-" would be parsed as
 * git options (e.g. `--upload-pack=…`, `--exec=…`). We reject them and any
 * char outside `[A-Za-z0-9._/@-]`. This is a subset of git's full ref
 * grammar — sufficient for our use cases (branch names, tags, panel paths).
 */
const SAFE_GIT_REF_RE = /^[A-Za-z0-9._/@-]+$/;
function assertSafeGitRef(ref: string, label = "ref"): string {
  if (!ref || ref.startsWith("-") || !SAFE_GIT_REF_RE.test(ref)) {
    throw new Error(`Invalid ${label}: ${ref}`);
  }
  return ref;
}

/**
 * Structured push event emitted after a git push is accepted.
 */
export interface GitPushEvent {
  /** Normalized repo path: e.g. "panels/chat" (no leading /, no .git suffix) */
  repo: string;
  /** Normalized branch name: e.g. "main" (no refs/heads/ prefix) */
  branch: string;
  /** New commit SHA */
  commit: string;
}

/**
 * Configuration options for the git server
 */
export interface GitServerConfig {
  /** Custom path for git repositories (workspace root). */
  reposPath?: string;
  /** Glob patterns for directories to initialize as git repos (e.g., ["panels/*"]) */
  initPatterns?: string[];
  /**
   * When set, every push mirrors the updated working tree (excluding .git)
   * to `<devTargetDir>/<repo>/`, keeping a dev template directory in sync.
   */
  devTargetDir?: string;
  /**
   * Host permission gate for pushes. Authentication identifies the caller;
   * this authorizer decides whether that caller may write this repo. Pushes
   * fail closed when no authorizer is configured.
   */
  writeAuthorizer?: GitWriteAuthorizer;
  /** Resolve source repo path for a caller id (workers/DOs). */
  getSourceForCaller?: (callerId: string) => string | null;
  /** Dynamic CORS allowlist for browser git clients. */
  getAllowedOrigins?: () => string[];
}

export class GitServer {
  private git: InstanceType<typeof Git> | null = null;
  private configuredReposPath: string | null;
  private resolvedReposPath: string | null = null;
  private authManager: GitAuthManager;
  private initPatterns: string[];
  private identityStore = new AsyncLocalStorage<{ callerId: string; callerKind: string }>();

  // Workspace tree discovery (delegated to WorkspaceTreeManager)
  private treeManager: WorkspaceTreeManager | null = null;

  // Push event listeners
  private pushListeners: Set<(event: GitPushEvent) => void> = new Set();

  // Dev target directory for mirroring pushes
  private devTargetDir: string | null;
  private writeAuthorizer: GitWriteAuthorizer | null;

  constructor(config?: GitServerConfig) {
    this.configuredReposPath = config?.reposPath ?? null;
    this.initPatterns = config?.initPatterns ?? ["panels/*", "packages/*", "projects/*"];
    this.devTargetDir = config?.devTargetDir ?? null;
    this.writeAuthorizer = config?.writeAuthorizer ?? null;
    this.authManager = new GitAuthManager(config?.getSourceForCaller);
    this.getAllowedOrigins = config?.getAllowedOrigins ?? (() => []);
  }

  private getAllowedOrigins: () => string[];

  private getTreeManager(): WorkspaceTreeManager {
    if (!this.treeManager) {
      this.treeManager = new WorkspaceTreeManager(this.ensureReposPath());
    }
    return this.treeManager;
  }

  private ensureReposPath(): string {
    if (!this.resolvedReposPath) {
      this.resolvedReposPath = this.configuredReposPath ?? getUserDataPath();
    }
    return this.resolvedReposPath;
  }

  async init(): Promise<void> {
    const reposPath = this.ensureReposPath();

    // Ensure repos directory exists
    if (!fs.existsSync(reposPath)) {
      fs.mkdirSync(reposPath, { recursive: true });
    }

    // Pass a custom dirMap function instead of a plain string.
    // node-git-server's create() always appends ".git" to repo names internally,
    // but our system (package graph, build system, panel manager) expects
    // directories without the .git suffix. The constructor accepts a function
    // as first argument (documented API) — we use it to strip the suffix.
    this.git = new Git(
      (dir?: string): string => {
        const cleaned = dir ? dir.replace(/\.git$/, "") : dir;
        return path.normalize(
          cleaned ? path.join(reposPath, cleaned) : reposPath
        );
      },
      {
      autoCreate: true,
      checkout: true, // Use working directories instead of bare repos
      authenticate: ({ type, repo }, next) => {
        const identity = this.identityStore.getStore();
        if (!identity) {
          next(new Error("Authenticated caller identity missing"));
          return;
        }

        // Map git operation type to our fetch/push model
        const operation: "fetch" | "push" = type === "push" ? "push" : "fetch";
        const result = this.authManager.canAccess(identity.callerId, identity.callerKind, repo, operation);

        if (!result.allowed) {
          log.verbose(` Auth failed for ${operation} on ${repo}: ${result.reason}`);
          next(new Error(result.reason || "Authentication failed"));
          return;
        }

        if (operation !== "push") {
          next();
          return;
        }
        if (!this.writeAuthorizer) {
          next(new Error("Git write permission unavailable"));
          return;
        }

        const repoPath = this.normalizePath(repo);
        Promise.resolve(this.writeAuthorizer({
          callerId: identity.callerId,
          callerKind: identity.callerKind,
          repoPath,
        }))
          .then((authorization) => {
            if (authorization.allowed) {
              next();
              return;
            }
            const reason = authorization.reason || "Git write permission denied";
            log.verbose(` Write permission denied for ${identity.callerId} on ${repoPath}: ${reason}`);
            next(new Error(reason));
          })
          .catch((error: unknown) => {
            const reason = error instanceof Error ? error.message : String(error);
            log.verbose(` Write permission check failed for ${identity.callerId} on ${repoPath}: ${reason}`);
            next(new Error(reason || "Git write permission check failed"));
          });
      },
    });

    // Handle push events
    this.git.on("push", (push) => {
      const pushRepo = push.repo.replace(/^\/+/, "").replace(/\.git(\/.*)?$/, "").replace(/\/+$/, "");

      // Ensure repo allows pushes to checked-out branches (may be auto-created
      // by node-git-server, which doesn't set this config)
      const pushRepoDir = path.join(reposPath, pushRepo);
      spawnGitSync(["config", "receive.denyCurrentBranch", "ignore"], {
        cwd: pushRepoDir,
        stdio: "ignore",
      });

      push.accept();

      // Wait for git-receive-pack to finish writing refs before post-push
      // operations. The push event fires when the HTTP request arrives, but
      // git-receive-pack runs asynchronously. The "exit" event fires after
      // the process completes and refs are on disk.
      push.on("exit", () => {
        const repo = push.repo.replace(/^\/+/, "").replace(/\.git(\/.*)?$/, "").replace(/\/+$/, "");
        const branch = push.branch.replace(/^refs\/heads\//, "");
        log.verbose(` Push to ${repo}/${branch} (${push.commit})`);

        // Update working tree: node-git-server creates repos with `git init`
        // (default branch: master), but pushes target `main`. Switch HEAD to
        // the pushed branch and checkout files.
        const repoDir = path.join(reposPath, repo);
        const pushedRef = `refs/heads/${branch}`;
        execGitFile(["symbolic-ref", "HEAD", pushedRef], { cwd: repoDir }, (symErr) => {
          if (symErr) {
            log.verbose(` symbolic-ref failed for ${repo}: ${symErr.message}`);
          }
          execGitFile(["reset", "--hard", "HEAD"], { cwd: repoDir }, (resetErr) => {
            if (resetErr) {
              log.verbose(` Post-push checkout failed for ${repo}: ${resetErr.message}`);
            }

            // Mirror working tree to dev target directory (if configured)
            if (this.devTargetDir) {
              this.syncToDevTarget(repo, repoDir);
            }

            // Emit push event after checkout so listeners see the updated working tree
            const event: GitPushEvent = { repo, branch, commit: push.commit };
            for (const fn of this.pushListeners) fn(event);
          });
        });
      });
    });

    // Handle fetch events
    this.git.on("fetch", (fetch) => {
      log.verbose(` Fetch from ${fetch.repo} (${fetch.commit})`);
      fetch.accept();
    });

    const git = this.git;
    if (!git) {
      throw new Error("Git server not initialized");
    }

    log.verbose(` Repos directory: ${this.ensureReposPath()}`);
  }

  async handleHttpRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    callerId: string | null,
    callerKind: string | null,
  ): Promise<void> {
    const corsHandled = this.handleCors(req, res);
    if (corsHandled) return;
    if (!this.git) {
      res.writeHead(503, { "Content-Type": "text/plain" });
      res.end("Git server not initialized");
      return;
    }
    if (!callerId || !callerKind) {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("Git caller identity missing");
      return;
    }
    const originalUrl = req.url ?? "/";
    req.url = originalUrl.startsWith("/_git/") ? originalUrl.slice("/_git".length) : originalUrl;
    this.identityStore.run({ callerId, callerKind }, () => this.git!.handle(req, res));
  }

  private handleCors(req: http.IncomingMessage, res: http.ServerResponse): boolean {
    const origin = req.headers.origin;
    const originValue = Array.isArray(origin) ? origin[0] : origin;
    const allowed = originValue ? this.getAllowedOrigins().includes(originValue) : true;
    if (originValue && !allowed) {
      res.writeHead(403, { "Content-Type": "text/plain" });
      res.end("Origin not allowed");
      return true;
    }
    if (originValue) {
      res.setHeader("Access-Control-Allow-Origin", originValue);
      res.setHeader("Access-Control-Allow-Credentials", "true");
      res.setHeader("Vary", "Origin");
    }
    if (req.method === "OPTIONS") {
      if (originValue) {
        res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
        res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
      }
      res.writeHead(204);
      res.end();
      return true;
    }
    return false;
  }

  /**
   * Get the path to the repos directory
   */
  getReposPath(): string {
    return this.ensureReposPath();
  }

  /**
   * Subscribe to push events. Returns an unsubscribe function.
   */
  onPush(handler: (event: GitPushEvent) => void): () => void {
    this.pushListeners.add(handler);
    return () => { this.pushListeners.delete(handler); };
  }

  /**
   * Initialize git repos for directories matching the configured patterns.
   * This ensures panels are git repos before panels try to clone them.
   */
  async initializeRepos(): Promise<void> {
    const reposPath = this.ensureReposPath();

    for (const pattern of this.initPatterns) {
      // Simple glob expansion for "dir/*" patterns
      if (pattern.endsWith("/*")) {
        const parentDir = path.join(reposPath, pattern.slice(0, -2));
        if (!fs.existsSync(parentDir)) continue;

        const entries = fs.readdirSync(parentDir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory() && !entry.name.startsWith(".")) {
            const dirPath = path.join(parentDir, entry.name);
            await this.ensureGitRepo(dirPath);
          }
        }
      } else {
        // Direct path
        const dirPath = path.join(reposPath, pattern);
        if (fs.existsSync(dirPath)) {
          await this.ensureGitRepo(dirPath);
        }
      }
    }
  }

  /**
   * Ensure a directory is a git repository.
   * If not, initialize it and create an initial commit.
   */
  private async ensureGitRepo(dirPath: string): Promise<void> {
    const gitDir = path.join(dirPath, ".git");
    if (fs.existsSync(gitDir)) {
      // Ensure existing repos allow pushes to checked-out branches
      // (required for non-bare repos served via node-git-server)
      this.ensureDenyCurrentBranch(dirPath);
      return; // Already a git repo
    }

    const dirName = path.basename(dirPath);
    log.verbose(` Initializing git repo: ${dirName}`);

    try {
      // Initialize git repo
      spawnGitSync(["init"], { cwd: dirPath, stdio: "ignore" });

      // Configure user for this repo (required for commits)
      spawnGitSync(["config", "user.email", "natstack@local"], {
        cwd: dirPath,
        stdio: "ignore",
      });
      spawnGitSync(["config", "user.name", "NatStack"], {
        cwd: dirPath,
        stdio: "ignore",
      });

      // Allow pushes to checked-out branches — the post-push handler
      // updates the working tree via git reset --hard
      spawnGitSync(["config", "receive.denyCurrentBranch", "ignore"], {
        cwd: dirPath,
        stdio: "ignore",
      });

      // Add all files and create initial commit
      spawnGitSync(["add", "-A"], { cwd: dirPath, stdio: "ignore" });
      spawnGitSync(["commit", "-m", "Initial commit"], {
        cwd: dirPath,
        stdio: "ignore",
      });

      log.verbose(` Initialized git repo: ${dirName}`);
    } catch (error) {
      console.error(`[GitServer] Failed to initialize git repo ${dirName}:`, error);
    }
  }

  /**
   * Ensure receive.denyCurrentBranch=ignore is set on an existing repo.
   * Only writes if not already configured.
   */
  private ensureDenyCurrentBranch(dirPath: string): void {
    try {
      const result = spawnGitSync(["config", "receive.denyCurrentBranch"], {
        cwd: dirPath,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      if (result.stdout?.toString().trim() !== "ignore") {
        spawnGitSync(["config", "receive.denyCurrentBranch", "ignore"], {
          cwd: dirPath,
          stdio: "ignore",
        });
      }
    } catch { /* ignore — non-critical */ }
  }

  // ===========================================================================
  // Dev Target Sync
  // ===========================================================================

  /**
   * Mirror a repo's working tree to the dev target directory, excluding .git
   * and runtime artifacts. Runs async — errors are logged but don't block.
   */
  private syncToDevTarget(repo: string, repoDir: string): void {
    const targetDir = path.join(this.devTargetDir!, repo);
    fs.mkdirSync(targetDir, { recursive: true });

    // rsync with --delete so removed files are reflected; trailing slashes
    // ensure we sync contents, not the directory itself.
    execFile(
      "rsync",
      ["-a", "--delete",
       "--exclude", ".git",
       "--exclude", "node_modules",
       "--exclude", ".cache",
       `${repoDir}/`, `${targetDir}/`],
      (err) => {
        if (err) {
          log.verbose(` Dev-target sync failed for ${repo}: ${err.message}`);
        } else {
          log.verbose(` Synced ${repo} -> ${targetDir}`);
        }
      }
    );
  }

  // ===========================================================================
  // GitWatcher Integration
  // ===========================================================================

  /**
   * Subscribe to GitWatcher events to invalidate the tree cache.
   * This ensures the workspace tree is always up-to-date when repos are added/removed
   * or when commits are made (which might change package.json).
   */
  subscribeToGitWatcher(watcher: GitWatcherLike): void {
    watcher.on("repoAdded", () => {
      console.log("[GitServer] Invalidating tree cache (repo added)");
      this.invalidateTreeCache();
    });
    watcher.on("repoRemoved", () => {
      console.log("[GitServer] Invalidating tree cache (repo removed)");
      this.invalidateTreeCache();
    });
    watcher.on("commitAdded", () => {
      console.log("[GitServer] Invalidating tree cache (commit added)");
      this.invalidateTreeCache();
    });
  }

  // ===========================================================================
  // Workspace Tree Discovery (delegated to WorkspaceTreeManager)
  // ===========================================================================

  async getWorkspaceTree(): Promise<WorkspaceTree> {
    return this.getTreeManager().getWorkspaceTree();
  }

  invalidateTreeCache(): void {
    this.treeManager?.invalidateTreeCache();
  }

  private isValidRepoPath(repoPath: string): boolean {
    return this.getTreeManager().isValidRepoPath(repoPath);
  }

  private toAbsolutePath(repoPath: string): string {
    return this.getTreeManager().toAbsolutePath(repoPath);
  }

  private normalizePath(p: string): string {
    return this.getTreeManager().normalizePath(p);
  }

  /**
   * List branches for a repo using git CLI (async).
   * @param repoPath - Relative path to repo (e.g., "panels/editor")
   */
  async listBranches(repoPath: string): Promise<BranchInfo[]> {
    // Ensure tree is built so we have discovered paths
    await this.getWorkspaceTree();

    // Validate path against discovered repos
    if (!this.isValidRepoPath(repoPath)) {
      throw new Error(`Invalid repo path: ${repoPath}`);
    }

    const absolutePath = this.toAbsolutePath(repoPath);

    const stdout = await this.runGit(
      ["branch", "--format=%(HEAD) %(refname:short)"],
      absolutePath
    );

    const branches: BranchInfo[] = [];

    for (const line of stdout.trim().split("\n")) {
      if (!line) continue;
      const current = line.startsWith("*");
      const name = line.slice(2).trim();
      if (name) {
        branches.push({ name, current });
      }
    }

    return branches;
  }

  /**
   * List recent commits for a repo/branch using git CLI (async).
   * @param repoPath - Relative path to repo (e.g., "panels/editor")
   * @param ref - Branch/tag/commit to show log for (default: HEAD)
   * @param limit - Max commits to return (default: 30)
   */
  async listCommits(repoPath: string, ref: string = "HEAD", limit: number = 30): Promise<CommitInfo[]> {
    // Ensure tree is built so we have discovered paths
    await this.getWorkspaceTree();

    // Validate path against discovered repos
    if (!this.isValidRepoPath(repoPath)) {
      throw new Error(`Invalid repo path: ${repoPath}`);
    }

    // Strict ref validation + `--` separator: a ref beginning with `-` would
    // otherwise be consumed as a git option.
    assertSafeGitRef(ref, "ref");
    const safeLimit = Number.isFinite(limit) && limit > 0 && limit <= 10000
      ? Math.floor(limit)
      : 30;

    const absolutePath = this.toAbsolutePath(repoPath);

    const stdout = await this.runGit(
      ["log", `-${safeLimit}`, "--format=%H|%s|%an|%at", "--end-of-options", ref, "--"],
      absolutePath
    );

    const commits: CommitInfo[] = [];

    for (const line of stdout.trim().split("\n")) {
      if (!line) continue;
      const [oid, message, name, timestamp] = line.split("|");
      if (oid && message && name && timestamp) {
        commits.push({
          oid,
          message,
          author: { name, timestamp: parseInt(timestamp, 10) },
        });
      }
    }

    return commits;
  }

  // ===========================================================================
  // Ref Resolution (for context templates)
  // ===========================================================================

  /**
   * Resolve a git ref to a commit SHA.
   *
   * @param repoPath - Relative path to repo (e.g., "panels/editor")
   * @param ref - Git ref (branch, tag, or commit) - if undefined, uses HEAD
   * @returns Full commit SHA
   */
  async resolveRef(repoPath: string, ref?: string): Promise<string> {
    const normalized = this.normalizePath(repoPath);

    const absolutePath = this.toAbsolutePath(normalized);

    if (!fs.existsSync(absolutePath)) {
      throw new Error(`Repository not found: ${repoPath}`);
    }

    const targetRef = ref ?? "HEAD";
    assertSafeGitRef(targetRef, "ref");

    try {
      const result = await this.runGit(["rev-parse", "--verify", "--end-of-options", targetRef], absolutePath);
      return result.trim();
    } catch (error) {
      // Try fallback refs for common branch name variations
      const candidates: string[] = [];

      if (targetRef === "main") candidates.push("master");
      if (targetRef === "master") candidates.push("main");

      // Try origin/<branch> for plain branch names
      if (!targetRef.includes("/") && !targetRef.startsWith("refs/")) {
        candidates.push(`origin/${targetRef}`);
      }

      for (const candidate of candidates) {
        try {
          // candidates are derived from the (already validated) targetRef plus
          // hard-coded prefixes — they cannot start with `-`.
          const result = await this.runGit(["rev-parse", "--verify", "--end-of-options", candidate], absolutePath);
          return result.trim();
        } catch {
          // continue to next candidate
        }
      }

      const msg = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to resolve ref "${targetRef}" in ${repoPath}: ${msg}`);
    }
  }

  /**
   * Run a git command and return stdout or throw on error.
   */
  private runGit(args: string[], cwd: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawnGit(args, { cwd });
      let stdout = "";
      let stderr = "";
      child.stdout?.on("data", (data) => {
        stdout += data.toString();
      });
      child.stderr?.on("data", (data) => {
        stderr += data.toString();
      });
      child.on("error", (error) => reject(error));
      child.on("close", (code) => {
        if (code === 0) {
          resolve(stdout);
        } else {
          reject(new Error(stderr.trim() || `git exited with code ${code}`));
        }
      });
    });
  }
}
