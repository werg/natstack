/**
 * ServerProcessManager — spawns and manages the natstack-server child process.
 *
 * Uses utilityProcess.fork() in Electron or child_process.fork() in Node.js.
 * Communicates via IPC messages (ready, shutdown, error).
 *
 * Fail-fast on crash: if the server exits unexpectedly, the onCrash callback
 * fires (typically triggering app.relaunch + app.exit). No restart attempts —
 * stale tokens in running panels make partial recovery unreliable.
 */

import * as path from "path";
import {
  type ProcessAdapter,
  hasElectronUtilityProcess,
  createNodeProcessAdapter,
} from "@natstack/process-adapter";

export interface ServerPorts {
  rpcPort: number;
  gitPort: number;
  pubsubPort: number;
  workerdPort?: number;
  gatewayPort?: number;
  panelHttpPort?: number;
  adminToken: string;
}

export class ServerProcessManager {
  private proc: ProcessAdapter | null = null;
  private ports: ServerPorts | null = null;
  private isShuttingDown = false;

  constructor(private config: {
    /** Managed workspace root directory (contains source/ and state/) */
    wsDir: string;
    appRoot: string;
    logLevel?: string;
    /** Called if the server process exits unexpectedly */
    onCrash: (code: number | null) => void;
    /**
     * Called when the server requests an Electron-app-level relaunch into a
     * different workspace (via `workspace.select`). Typical implementation:
     * `app.relaunch({ args: ["--workspace", name] }); app.exit(0);`.
     */
    onRelaunch?: (name: string) => void;
    /**
     * Called when the server requests opening a URL in the user's default
     * browser (e.g. auth service OAuth flow). If omitted, the manager falls
     * back to Electron's `shell.openExternal` directly.
     */
    onOpenExternal?: (url: string) => void;
    /**
     * Handle typed IPC requests from the server that expect a response.
     * Called with the request type and full message; the return value is
     * merged into the response and sent back with the same correlation ID.
     */
    onIpcRequest?: (type: string, msg: Record<string, unknown>) => Promise<Record<string, unknown> | null>;
  }) {}

  async start(): Promise<ServerPorts> {
    const proc = this.spawn();
    this.proc = proc;

    // Pipe server stdout/stderr to our console
    if (proc.stdout) {
      proc.stdout.on("data", (chunk: Buffer) => {
        process.stdout.write(`[server] ${chunk}`);
      });
    }
    if (proc.stderr) {
      proc.stderr.on("data", (chunk: Buffer) => {
        process.stderr.write(`[server:err] ${chunk}`);
      });
    }

    const ports = await this.waitForReady(proc);
    this.ports = ports;

    // Wire up crash handler after startup succeeds
    proc.on("exit", (code) => {
      if (!this.isShuttingDown) {
        this.config.onCrash(code);
      }
    });

    // Listen for post-startup messages from the server. waitForReady() consumes
    // the one-shot `ready`/`error` messages; this handler picks up everything
    // afterwards.
    proc.on("message", (msg: any) => {
      if (msg?.type === "workspace-relaunch" && typeof msg.name === "string") {
        this.config.onRelaunch?.(msg.name);
      } else if (msg?.type === "open-external" && typeof msg.url === "string") {
        // Auth service (and potentially others) asks Electron main to open
        // a URL in the user's default browser. Used by the OAuth login flow
        // to hand off to shell.openExternal without exposing openExternal
        // access to panels/workers.
        if (this.config.onOpenExternal) {
          this.config.onOpenExternal(msg.url);
        } else if (hasElectronUtilityProcess()) {
          try {
            const { shell } = require("electron");
            shell.openExternal(msg.url);
          } catch (err) {
            console.error("[ServerProcessManager] shell.openExternal failed:", err);
          }
        }
      } else if (msg?.type?.endsWith("-request") && typeof msg.id === "string" && this.config.onIpcRequest) {
        // Request/response IPC: dispatch to handler, send correlated response
        const responseType = (msg.type as string).replace(/-request$/, "-response");
        void this.config.onIpcRequest(msg.type, msg).then((result) => {
          proc.postMessage({ type: responseType, id: msg.id, ...(result ?? {}) });
        }).catch((err) => {
          console.error(`[ServerProcessManager] IPC request handler error for ${msg.type}:`, err);
          proc.postMessage({ type: responseType, id: msg.id, error: String(err) });
        });
      }
    });

    return ports;
  }

  async shutdown(): Promise<void> {
    if (!this.proc) return;
    this.isShuttingDown = true;

    // Send shutdown via IPC
    this.proc.postMessage({ type: "shutdown" });

    // Wait up to 5s for clean exit, then SIGKILL
    await Promise.race([
      new Promise<void>((resolve) => this.proc!.on("exit", () => resolve())),
      new Promise<void>((resolve) =>
        setTimeout(() => {
          this.proc!.kill();
          resolve();
        }, 5000)
      ),
    ]);

    this.proc = null;
  }

  getPorts(): ServerPorts | null {
    return this.ports;
  }

  private spawn(): ProcessAdapter {
    const bundlePath = path.join(this.config.appRoot, "dist", "server-electron.cjs");
    const env: Record<string, string | undefined> = {
      ...process.env,
      NATSTACK_WORKSPACE_DIR: this.config.wsDir,
      NATSTACK_APP_ROOT: this.config.appRoot,
      ...(this.config.logLevel ? { NATSTACK_LOG_LEVEL: this.config.logLevel } : {}),
    };

    if (hasElectronUtilityProcess()) {
      const { utilityProcess } = require("electron");
      return utilityProcess.fork(bundlePath, [], {
        serviceName: "natstack-server",
        stdio: "pipe",
        env,
      }) as unknown as ProcessAdapter;
    }

    // Node.js fallback (testing, non-Electron environments)
    return createNodeProcessAdapter(bundlePath, env);
  }

  private waitForReady(proc: ProcessAdapter): Promise<ServerPorts> {
    return new Promise((resolve, reject) => {
      proc.on("message", (msg: any) => {
        if (msg?.type === "ready") {
          resolve({
            rpcPort: msg.rpcPort,
            gitPort: msg.gitPort,
            pubsubPort: msg.pubsubPort,
            workerdPort: msg.workerdPort,
            gatewayPort: msg.gatewayPort,
            panelHttpPort: msg.panelHttpPort,
            adminToken: msg.adminToken,
          });
        } else if (msg?.type === "error") {
          reject(new Error(`Server startup failed: ${msg.message}`));
        }
      });

      proc.on("exit", (code) => {
        reject(new Error(`Server exited during startup with code ${code}`));
      });
    });
  }
}
