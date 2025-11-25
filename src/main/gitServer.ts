import { Git } from "node-git-server";
import { app } from "electron";
import * as path from "path";
import * as fs from "fs";
import { GitAuthManager } from "./gitAuthManager.js";

const GIT_SERVER_PORT = 63524;

export class GitServer {
  private git: InstanceType<typeof Git> | null = null;
  private reposPath: string | null = null;
  private authManager: GitAuthManager;

  constructor() {
    this.authManager = new GitAuthManager();
  }

  private ensureReposPath(): string {
    if (!this.reposPath) {
      this.reposPath = path.join(app.getPath("userData"), "git-repos");
    }
    return this.reposPath;
  }

  /**
   * Start the git server on fixed port.
   * Throws if port is already in use.
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

    // Start on fixed port - crashes with clear error if port in use
    const git = this.git;
    return new Promise((resolve, reject) => {
      const server = git.listen(GIT_SERVER_PORT, { type: "http" }, () => {
        console.log(`[GitServer] Started on http://localhost:${GIT_SERVER_PORT}`);
        console.log(`[GitServer] Repos directory: ${this.ensureReposPath()}`);
        resolve(GIT_SERVER_PORT);
      });

      server.on("error", (error: NodeJS.ErrnoException) => {
        if (error.code === "EADDRINUSE") {
          reject(new Error(`Git server port ${GIT_SERVER_PORT} is already in use`));
        } else {
          reject(error);
        }
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
          resolve();
        });
      });
    }
  }

  /**
   * Get the server port (always fixed)
   */
  getPort(): number {
    return GIT_SERVER_PORT;
  }

  /**
   * Get the base URL for git operations
   */
  getBaseUrl(): string {
    return `http://localhost:${GIT_SERVER_PORT}`;
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
