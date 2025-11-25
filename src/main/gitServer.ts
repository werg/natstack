import { Git } from "node-git-server";
import { app } from "electron";
import * as path from "path";
import * as fs from "fs";
import * as net from "net";
import { GitAuthManager } from "./gitAuthManager.js";

const DEFAULT_GIT_SERVER_PORT = 63524;

/**
 * Configuration options for the git server
 */
export interface GitServerConfig {
  /** Port to listen on. If unavailable, will try to find an open port. */
  port?: number;
  /** Custom path for git repositories. Defaults to userData/git-repos. */
  reposPath?: string;
}

export class GitServer {
  private git: InstanceType<typeof Git> | null = null;
  private configuredReposPath: string | null;
  private resolvedReposPath: string | null = null;
  private authManager: GitAuthManager;
  private configuredPort: number;
  private actualPort: number | null = null;

  constructor(config?: GitServerConfig) {
    this.configuredPort = config?.port ?? DEFAULT_GIT_SERVER_PORT;
    this.configuredReposPath = config?.reposPath ?? null;
    this.authManager = new GitAuthManager();
  }

  private ensureReposPath(): string {
    if (!this.resolvedReposPath) {
      this.resolvedReposPath =
        this.configuredReposPath ?? path.join(app.getPath("userData"), "git-repos");
    }
    return this.resolvedReposPath;
  }

  /**
   * Check if a port is available
   */
  private async isPortAvailable(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const server = net.createServer();
      server.once("error", () => resolve(false));
      server.once("listening", () => {
        server.close(() => resolve(true));
      });
      server.listen(port);
    });
  }

  /**
   * Find an available port starting from the configured port
   */
  private async findAvailablePort(startPort: number): Promise<number> {
    for (let port = startPort; port < startPort + 100; port++) {
      if (await this.isPortAvailable(port)) {
        return port;
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

    // Find an available port, starting from the configured one
    const port = await this.findAvailablePort(this.configuredPort);
    if (port !== this.configuredPort) {
      console.log(
        `[GitServer] Configured port ${this.configuredPort} unavailable, using ${port}`
      );
    }

    const git = this.git;
    return new Promise((resolve, reject) => {
      const server = git.listen(port, { type: "http" }, () => {
        this.actualPort = port;
        console.log(`[GitServer] Started on http://localhost:${port}`);
        console.log(`[GitServer] Repos directory: ${this.ensureReposPath()}`);
        resolve(port);
      });

      server.on("error", (error: NodeJS.ErrnoException) => {
        reject(error);
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
}
