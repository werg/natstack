import { Git } from "node-git-server";
import { app } from "electron";
import * as path from "path";
import * as fs from "fs";
import * as fsPromises from "fs/promises";
import * as http from "http";
import { spawn, spawnSync } from "child_process";
import { createDevLogger } from "./devLog.js";

const log = createDevLogger("GitServer");
import type { WorkspaceNode, WorkspaceTree, BranchInfo, CommitInfo } from "../shared/ipc/types.js";
import { GitAuthManager, getTokenManager } from "./tokenManager.js";
import { tryBindPort } from "./portUtils.js";
import type { GitWatcher } from "./workspace/gitWatcher.js";
import type { GitHubProxyConfig } from "./workspace/types.js";
import {
  parseGitHubPath,
  isGitHubPath,
  toGitHubRelativePath,
  toGitHubUrl,
  ensureGitHubRepo,
  errorTypeToHttpStatus,
  isGitRepo,
} from "./githubCloner.js";

const DEFAULT_GIT_SERVER_PORT = 63524;

/**
 * Configuration options for the git server
 */
export interface GitServerConfig {
  /** Port to listen on. If unavailable, will try to find an open port. */
  port?: number;
  /** Custom path for git repositories (workspace root). */
  reposPath?: string;
  /** Glob patterns for directories to initialize as git repos (e.g., ["panels/*"]) */
  initPatterns?: string[];
  /** GitHub proxy configuration for transparent cloning */
  github?: GitHubProxyConfig;
}

export class GitServer {
  private git: InstanceType<typeof Git> | null = null;
  private configuredReposPath: string | null;
  private resolvedReposPath: string | null = null;
  private authManager: GitAuthManager;
  private configuredPort: number;
  private actualPort: number | null = null;
  private initPatterns: string[];

  // Workspace tree discovery
  private cachedTree: WorkspaceTree | null = null;
  private treeCacheTime: number = 0;
  private readonly CACHE_TTL_MS = 5000; // 5 second cache
  // Track discovered repo paths for validation (normalized with forward slashes)
  private discoveredRepoPaths: Set<string> = new Set();

  // GitHub proxy configuration
  private githubConfig: Required<GitHubProxyConfig> = {
    enabled: true,
    token: undefined as unknown as string, // Will be undefined if not provided
    depth: 1,
  };

  constructor(config?: GitServerConfig) {
    this.configuredPort = config?.port ?? DEFAULT_GIT_SERVER_PORT;
    this.configuredReposPath = config?.reposPath ?? null;
    // Note: initPatterns is for auto-init of NEW directories as git repos.
    // scanDirectory() is already recursive and discovers repos at any depth.
    this.initPatterns = config?.initPatterns ?? ["panels/*", "workers/*", "packages/*"];
    this.authManager = new GitAuthManager(getTokenManager());

    // Apply GitHub proxy config
    if (config?.github) {
      this.githubConfig = {
        enabled: config.github.enabled ?? true,
        token: config.github.token as string,
        depth: config.github.depth ?? 1,
      };
    }
  }

  private ensureReposPath(): string {
    if (!this.resolvedReposPath) {
      this.resolvedReposPath = this.configuredReposPath ?? app.getPath("userData");
    }
    return this.resolvedReposPath;
  }

  /**
   * Find an available port starting from the configured port.
   * Returns the port and a temporary server holding it (to avoid TOCTOU).
   */
  private async findAvailablePort(
    startPort: number
  ): Promise<{ port: number; tempServer: import("net").Server }> {
    for (let port = startPort; port < startPort + 100; port++) {
      const server = await tryBindPort(port);
      if (server) {
        return { port, tempServer: server };
      }
    }
    throw new Error(`Could not find available port in range ${startPort}-${startPort + 99}`);
  }

  /**
   * Start the git server.
   * Tries the configured port first, then searches for an available one.
   */
  async start(): Promise<number> {
    const reposPath = this.ensureReposPath();

    // Ensure repos directory exists
    if (!fs.existsSync(reposPath)) {
      fs.mkdirSync(reposPath, { recursive: true });
    }

    this.git = new Git(reposPath, {
      autoCreate: true,
      checkout: true, // Use working directories instead of bare repos
      authenticate: ({ type, repo, headers }, next) => {
        // Extract bearer token from Authorization header
        const authHeader = headers["authorization"];
        if (!authHeader || !authHeader.startsWith("Bearer ")) {
          next(new Error("Bearer token required"));
          return;
        }

        const token = authHeader.slice("Bearer ".length);
        // Map git operation type to our fetch/push model
        const operation: "fetch" | "push" = type === "push" ? "push" : "fetch";
        const result = this.authManager.validateAccess(token, repo, operation);

        if (result.valid) {
          next();
        } else {
          log.verbose(` Auth failed for ${operation} on ${repo}: ${result.reason}`);
          next(new Error(result.reason || "Authentication failed"));
        }
      },
    });

    // Handle push events
    this.git.on("push", (push) => {
      log.verbose(` Push to ${push.repo}/${push.branch} (${push.commit})`);
      push.accept();
    });

    // Handle fetch events
    this.git.on("fetch", (fetch) => {
      log.verbose(` Fetch from ${fetch.repo} (${fetch.commit})`);
      fetch.accept();
    });

    // Find an available port, starting from the configured one (TOCTOU-safe)
    const { port, tempServer } = await this.findAvailablePort(this.configuredPort);
    if (port !== this.configuredPort) {
      log.verbose(` Configured port ${this.configuredPort} unavailable, using ${port}`);
    }

    // Close temp server and immediately bind our real server
    await new Promise<void>((resolve) => tempServer.close(() => resolve()));

    const git = this.git;
    if (!git) {
      throw new Error("Git server not initialized");
    }

    // Allow in-browser git fetches (isomorphic-git) by setting permissive CORS headers.
    const applyCors = (res: http.ServerResponse): void => {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader(
        "Access-Control-Allow-Headers",
        "Authorization, Content-Type, User-Agent, X-Requested-With"
      );
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    };

    return new Promise((resolve, reject) => {
      const server = http.createServer(async (req, res) => {
        applyCors(res);
        if (req.method === "OPTIONS") {
          res.writeHead(200);
          res.end();
          return;
        }

        // Check if this is a GitHub path that might need cloning
        if (this.githubConfig.enabled && req.url) {
          const urlPath = req.url.split("?")[0] ?? "";
          const repoPath = this.normalizePath(urlPath);

          if (isGitHubPath(repoPath)) {
            const handled = await this.handleGitHubRequest(repoPath, res);
            if (!handled) {
              // Error response already sent
              return;
            }
          }
        }

        git.handle(req, res);
      });

      server.on("error", (error: NodeJS.ErrnoException) => {
        reject(error);
      });

      server.listen(port, () => {
        this.actualPort = port;
        log.verbose(` Started on http://localhost:${port}`);
        log.verbose(` Repos directory: ${this.ensureReposPath()}`);
        resolve(port);
      });
    });
  }

  /**
   * Stop the git server
   */
  async stop(): Promise<void> {
    const server = this.git?.server;
    if (server) {
      return new Promise((resolve) => {
        server.close(() => {
          console.log("[GitServer] Stopped");
          this.actualPort = null;
          resolve();
        });
      });
    }
  }

  /**
   * Get the server port. Returns the actual port if running, otherwise the configured port.
   */
  getPort(): number {
    return this.actualPort ?? this.configuredPort;
  }

  /**
   * Get the base URL for git operations
   */
  getBaseUrl(): string {
    return `http://localhost:${this.getPort()}`;
  }

  /**
   * Get or create a bearer token for a panel ID
   */
  getTokenForPanel(panelId: string): string {
    return this.authManager.getOrCreateToken(panelId);
  }

  /**
   * Revoke token when panel is closed
   */
  revokeTokenForPanel(panelId: string): boolean {
    return this.authManager.revokeToken(panelId);
  }

  /**
   * Get the path to the repos directory
   */
  getReposPath(): string {
    return this.ensureReposPath();
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
      return; // Already a git repo
    }

    const dirName = path.basename(dirPath);
    log.verbose(` Initializing git repo: ${dirName}`);

    try {
      // Initialize git repo
      spawnSync("git", ["init"], { cwd: dirPath, stdio: "ignore" });

      // Configure user for this repo (required for commits)
      spawnSync("git", ["config", "user.email", "natstack@local"], {
        cwd: dirPath,
        stdio: "ignore",
      });
      spawnSync("git", ["config", "user.name", "NatStack"], {
        cwd: dirPath,
        stdio: "ignore",
      });

      // Add all files and create initial commit
      spawnSync("git", ["add", "-A"], { cwd: dirPath, stdio: "ignore" });
      spawnSync("git", ["commit", "-m", "Initial commit"], {
        cwd: dirPath,
        stdio: "ignore",
      });

      log.verbose(` Initialized git repo: ${dirName}`);
    } catch (error) {
      console.error(`[GitServer] Failed to initialize git repo ${dirName}:`, error);
    }
  }

  // ===========================================================================
  // GitWatcher Integration
  // ===========================================================================

  /**
   * Subscribe to GitWatcher events to invalidate the tree cache.
   * This ensures the workspace tree is always up-to-date when repos are added/removed
   * or when commits are made (which might change package.json).
   */
  subscribeToGitWatcher(watcher: GitWatcher): void {
    watcher.on("repoAdded", () => {
      console.log("[GitServer] Invalidating tree cache (repo added)");
      this.invalidateTreeCache();
    });
    watcher.on("repoRemoved", () => {
      console.log("[GitServer] Invalidating tree cache (repo removed)");
      this.invalidateTreeCache();
    });
    watcher.on("commitAdded", () => {
      // Commits might change package.json, so invalidate cache
      console.log("[GitServer] Invalidating tree cache (commit added)");
      this.invalidateTreeCache();
    });
  }

  // ===========================================================================
  // Workspace Tree Discovery
  // ===========================================================================

  /**
   * Normalize a path to use forward slashes.
   */
  private normalizePath(repoPath: string): string {
    return repoPath.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  }

  /**
   * Get the workspace tree of all git repos.
   * Caches result for performance.
   */
  async getWorkspaceTree(): Promise<WorkspaceTree> {
    const now = Date.now();
    if (this.cachedTree && now - this.treeCacheTime < this.CACHE_TTL_MS) {
      return this.cachedTree;
    }

    this.discoveredRepoPaths.clear();

    const reposPath = this.ensureReposPath();
    const children = await this.scanDirectory(reposPath, "");

    this.cachedTree = { children };
    this.treeCacheTime = now;
    return this.cachedTree;
  }

  /**
   * Invalidate the cached tree (call after repo operations).
   * Also clears discovered paths to ensure consistency.
   */
  invalidateTreeCache(): void {
    this.cachedTree = null;
    this.discoveredRepoPaths.clear();
  }

  /**
   * Check if a path is a valid discovered repo.
   * Validates against the cached tree to prevent directory traversal.
   */
  private isValidRepoPath(repoPath: string): boolean {
    const normalized = this.normalizePath(repoPath);
    if (!normalized) {
      return false;
    }
    // Check for traversal attempts
    if (normalized.includes("..") || path.isAbsolute(repoPath)) {
      return false;
    }
    // Must be in the discovered set
    return this.discoveredRepoPaths.has(normalized);
  }

  /**
   * Convert a relative repo path to absolute path.
   */
  private toAbsolutePath(repoPath: string): string {
    const normalized = this.normalizePath(repoPath);
    return path.join(this.ensureReposPath(), normalized);
  }

  // ===========================================================================
  // GitHub Proxy (Transparent Cloning)
  // ===========================================================================

  /**
   * Handle a GitHub repository request, cloning if necessary.
   *
   * This enables transparent access to GitHub repos via paths like:
   *   github.com/owner/repo
   *
   * If the repo isn't already cloned locally, it will be fetched from GitHub.
   *
   * @returns true if the request should continue to git.handle(), false if handled/errored
   */
  private async handleGitHubRequest(
    repoPath: string,
    res: http.ServerResponse
  ): Promise<boolean> {
    const spec = parseGitHubPath(repoPath);
    if (!spec) {
      // Not a valid GitHub path - let it fail normally
      return true;
    }

    const relPath = toGitHubRelativePath(spec);
    const targetPath = path.join(this.ensureReposPath(), relPath);

    // Fast path: already cloned and discovered
    if (this.discoveredRepoPaths.has(relPath)) {
      return true;
    }

    // Check if it exists on disk but wasn't discovered yet
    if (isGitRepo(targetPath)) {
      this.discoveredRepoPaths.add(relPath);
      return true;
    }

    // Need to clone from GitHub
    log.verbose(` Cloning GitHub repo: ${spec.owner}/${spec.repo}`);

    const remoteUrl = toGitHubUrl(spec);
    const result = await ensureGitHubRepo({
      targetPath,
      remoteUrl,
      token: this.githubConfig.token,
      depth: this.githubConfig.depth,
    });

    if (!result.success) {
      const status = errorTypeToHttpStatus(result.errorType ?? "unknown");
      res.writeHead(status, { "Content-Type": "text/plain" });
      res.end(`Failed to clone GitHub repository: ${result.error}`);
      return false;
    }

    // Add to discovered paths so validation passes
    this.discoveredRepoPaths.add(relPath);

    // Invalidate tree cache so the new repo appears in workspace tree
    this.invalidateTreeCache();
    // Re-add since invalidate clears the set
    this.discoveredRepoPaths.add(relPath);

    log.verbose(` GitHub repo ready: ${relPath}`);
    return true;
  }

  /**
   * Check if a directory is a git repo (async).
   */
  private async isGitRepoAsync(absolutePath: string): Promise<boolean> {
    try {
      await fsPromises.access(path.join(absolutePath, ".git"));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Recursively scan a directory, stopping at git repo boundaries.
   * Uses async fs operations to avoid blocking main process.
   */
  private async scanDirectory(absolutePath: string, relativePath: string): Promise<WorkspaceNode[]> {
    const nodes: WorkspaceNode[] = [];

    try {
      const entries = await fsPromises.readdir(absolutePath, { withFileTypes: true });

      for (const entry of entries) {
        // Skip hidden directories and node_modules
        if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name === "node_modules") {
          continue;
        }

        const childAbsPath = path.join(absolutePath, entry.name);
        // Always use forward slashes for consistency
        const childRelPath = relativePath ? `${relativePath}/${entry.name}` : entry.name;

        // Check if this is a git repo
        const isGitRepo = await this.isGitRepoAsync(childAbsPath);

        const node: WorkspaceNode = {
          name: entry.name,
          path: childRelPath,
          isGitRepo,
          children: [],
        };

        if (isGitRepo) {
          // Track discovered repo (already uses forward slashes)
          this.discoveredRepoPaths.add(childRelPath);
          // Extract metadata (launchable info, package info, skill info)
          const metadata = await this.extractMetadata(childAbsPath);
          node.launchable = metadata.launchable;
          node.packageInfo = metadata.packageInfo;
          node.skillInfo = metadata.skillInfo;
          // Git repos are leaves - don't recurse into them
        } else {
          // Recurse into non-git directories
          node.children = await this.scanDirectory(childAbsPath, childRelPath);
          // Skip empty non-repo folders
          if (node.children.length === 0) continue;
        }

        nodes.push(node);
      }
    } catch (error) {
      console.warn(`[GitServer] Failed to scan ${absolutePath}:`, error);
    }

    // Sort: folders first, then repos; alphabetically within each
    return nodes.sort((a, b) => {
      const aIsFolder = !a.isGitRepo && a.children.length > 0;
      const bIsFolder = !b.isGitRepo && b.children.length > 0;
      if (aIsFolder !== bIsFolder) return aIsFolder ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  }

  /**
   * Parse YAML frontmatter from a markdown file.
   * Returns the parsed frontmatter object or undefined if not present/invalid.
   */
  private parseYamlFrontmatter(content: string): Record<string, string> | undefined {
    if (!content.startsWith("---\n")) {
      return undefined;
    }
    const endIndex = content.indexOf("\n---", 4);
    if (endIndex === -1) {
      return undefined;
    }
    const yamlContent = content.slice(4, endIndex);

    // Simple YAML parser for key: value pairs
    const result: Record<string, string> = {};
    for (const line of yamlContent.split("\n")) {
      const colonIndex = line.indexOf(":");
      if (colonIndex === -1) continue;
      const key = line.slice(0, colonIndex).trim();
      let value = line.slice(colonIndex + 1).trim();
      // Remove quotes if present
      if ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (key && value) {
        result[key] = value;
      }
    }
    return Object.keys(result).length > 0 ? result : undefined;
  }

  /**
   * Extract metadata from a directory's package.json and SKILL.md.
   * Returns launchable info (natstack config), package info (npm package), and skill info.
   * Intentionally permissive - returns info even with missing fields so the
   * UI can show the entry and panelBuilder can report proper errors later.
   */
  private async extractMetadata(absolutePath: string): Promise<{
    launchable?: WorkspaceNode["launchable"];
    packageInfo?: WorkspaceNode["packageInfo"];
    skillInfo?: WorkspaceNode["skillInfo"];
  }> {
    const result: {
      launchable?: WorkspaceNode["launchable"];
      packageInfo?: WorkspaceNode["packageInfo"];
      skillInfo?: WorkspaceNode["skillInfo"];
    } = {};

    // Extract package.json metadata
    const packageJsonPath = path.join(absolutePath, "package.json");
    try {
      const content = await fsPromises.readFile(packageJsonPath, "utf-8");
      const packageJson = JSON.parse(content);

      // Extract package info (if it has a name, it's a publishable package)
      if (packageJson.name) {
        result.packageInfo = {
          name: packageJson.name as string,
          version: packageJson.version as string | undefined,
        };
      }

      // Extract natstack launchable info
      if (packageJson.natstack) {
        const ns = packageJson.natstack;
        result.launchable = {
          type: ns.type || (ns.runtime === "worker" ? "worker" : "app"),
          title: ns.title || packageJson.name || path.basename(absolutePath),
          repoArgs: ns.repoArgs,
          envArgs: ns.envArgs,
        };
      }
    } catch {
      // No package.json or invalid JSON
    }

    // Extract SKILL.md metadata (skill info) - only repos with SKILL.md are skills
    const skillMdPath = path.join(absolutePath, "SKILL.md");
    try {
      const content = await fsPromises.readFile(skillMdPath, "utf-8");
      const frontmatter = this.parseYamlFrontmatter(content);
      if (frontmatter && frontmatter["name"] && frontmatter["description"]) {
        result.skillInfo = {
          name: frontmatter["name"],
          description: frontmatter["description"],
        };
      }
    } catch {
      // No SKILL.md - not a skill (intentionally no fallback)
    }

    return result;
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

    const absolutePath = this.toAbsolutePath(repoPath);

    const stdout = await this.runGit(
      ["log", ref, `-${limit}`, "--format=%H|%s|%an|%at"],
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
   * For GitHub paths, triggers auto-clone if the repo doesn't exist locally.
   *
   * This is used by the context template resolver to get exact commit SHAs
   * for template dependencies, including GitHub repositories.
   *
   * @param repoPath - Relative path to repo (e.g., "panels/editor" or "github.com/owner/repo")
   * @param ref - Git ref (branch, tag, or commit) - if undefined, uses HEAD
   * @returns Full commit SHA
   */
  async resolveRef(repoPath: string, ref?: string): Promise<string> {
    const normalized = this.normalizePath(repoPath);

    // Handle GitHub paths - may need to clone first
    if (this.githubConfig.enabled && isGitHubPath(normalized)) {
      await this.ensureGitHubRepoCloned(normalized);
    }

    const absolutePath = this.toAbsolutePath(normalized);

    if (!fs.existsSync(absolutePath)) {
      throw new Error(`Repository not found: ${repoPath}`);
    }

    const targetRef = ref ?? "HEAD";

    try {
      const result = await this.runGit(["rev-parse", targetRef], absolutePath);
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
          const result = await this.runGit(["rev-parse", candidate], absolutePath);
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
   * Ensure a GitHub repo is cloned locally.
   * Called before ref resolution for GitHub paths.
   */
  private async ensureGitHubRepoCloned(repoPath: string): Promise<void> {
    const spec = parseGitHubPath(repoPath);
    if (!spec) return;

    const relPath = toGitHubRelativePath(spec);
    const targetPath = path.join(this.ensureReposPath(), relPath);

    // Already cloned?
    if (isGitRepo(targetPath)) {
      // Ensure it's in discovered paths
      if (!this.discoveredRepoPaths.has(relPath)) {
        this.discoveredRepoPaths.add(relPath);
      }
      return;
    }

    // Clone from GitHub (full clone for ref resolution - need all refs/tags)
    log.verbose(` Auto-cloning for ref resolution: ${spec.owner}/${spec.repo}`);
    const result = await ensureGitHubRepo({
      targetPath,
      remoteUrl: toGitHubUrl(spec),
      token: this.githubConfig.token,
      depth: 0, // Full clone - shallow clones may not have all refs
    });

    if (!result.success) {
      throw new Error(`Failed to clone GitHub repository ${spec.owner}/${spec.repo}: ${result.error}`);
    }

    // Add to discovered paths and invalidate cache
    this.discoveredRepoPaths.add(relPath);
    this.invalidateTreeCache();
    // Re-add since invalidate clears the set
    this.discoveredRepoPaths.add(relPath);

    log.verbose(` GitHub repo ready for ref resolution: ${relPath}`);
  }

  /**
   * Run a git command and return stdout or throw on error.
   */
  private runGit(args: string[], cwd: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn("git", args, { cwd });
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
