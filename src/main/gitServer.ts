import { Git } from "node-git-server";
import { app } from "electron";
import * as path from "path";
import * as fs from "fs";
import * as http from "http";
import { spawnSync } from "child_process";
import { GitAuthManager, getTokenManager } from "./tokenManager.js";
import { tryBindPort } from "./portUtils.js";

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
}

export class GitServer {
  private git: InstanceType<typeof Git> | null = null;
  private configuredReposPath: string | null;
  private resolvedReposPath: string | null = null;
  private authManager: GitAuthManager;
  private configuredPort: number;
  private actualPort: number | null = null;
  private initPatterns: string[];

  constructor(config?: GitServerConfig) {
    this.configuredPort = config?.port ?? DEFAULT_GIT_SERVER_PORT;
    this.configuredReposPath = config?.reposPath ?? null;
    this.initPatterns = config?.initPatterns ?? ["panels/*"];
    this.authManager = new GitAuthManager(getTokenManager());
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
          console.log(`[GitServer] Auth failed for ${operation} on ${repo}: ${result.reason}`);
          next(new Error(result.reason || "Authentication failed"));
        }
      },
    });

    // Handle push events
    this.git.on("push", (push) => {
      console.log(`[GitServer] Push to ${push.repo}/${push.branch} (${push.commit})`);
      push.accept();
    });

    // Handle fetch events
    this.git.on("fetch", (fetch) => {
      console.log(`[GitServer] Fetch from ${fetch.repo} (${fetch.commit})`);
      fetch.accept();
    });

    // Find an available port, starting from the configured one (TOCTOU-safe)
    const { port, tempServer } = await this.findAvailablePort(this.configuredPort);
    if (port !== this.configuredPort) {
      console.log(`[GitServer] Configured port ${this.configuredPort} unavailable, using ${port}`);
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
      const server = http.createServer((req, res) => {
        applyCors(res);
        if (req.method === "OPTIONS") {
          res.writeHead(200);
          res.end();
          return;
        }
        git.handle(req, res);
      });

      server.on("error", (error: NodeJS.ErrnoException) => {
        reject(error);
      });

      server.listen(port, () => {
        this.actualPort = port;
        console.log(`[GitServer] Started on http://localhost:${port}`);
        console.log(`[GitServer] Repos directory: ${this.ensureReposPath()}`);
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
    console.log(`[GitServer] Initializing git repo: ${dirName}`);

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

      console.log(`[GitServer] Initialized git repo: ${dirName}`);
    } catch (error) {
      console.error(`[GitServer] Failed to initialize git repo ${dirName}:`, error);
    }
  }
}
