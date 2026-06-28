/**
 * ServerProcessManager — spawns and manages the natstack-server child process.
 *
 * Uses Electron utilityProcess.fork().
 * Communicates via IPC messages (ready, shutdown, error).
 */

import { type ProcessAdapter } from "@natstack/process-adapter";
import { shell, utilityProcess } from "electron";
import { serverRpcWsUrl } from "@natstack/shared/connect";
import { getEsbuildBinaryPath, getServerProcessEntryPath } from "./paths.js";

const SERVER_SHUTDOWN_TIMEOUT_MS = 12_000;

export interface ServerPorts {
  workerdPort?: number;
  gatewayPort: number;
  adminToken: string;
  shellToken?: string;
}

class ServerStartupExitError extends Error {
  constructor(code: number | null) {
    super(`Server exited during startup with code ${code}`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export class ServerProcessManager {
  private proc: ProcessAdapter | null = null;
  private ports: ServerPorts | null = null;
  private isShuttingDown = false;
  private restartTimestamps: number[] = [];

  constructor(
    private config: {
      /** Managed workspace root directory (contains source/ and state/) */
      wsDir: string;
      appRoot: string;
      isEphemeral?: boolean;
      autoApproveStartupUnits?: boolean;
      logLevel?: string;
      /** Called if the server process exits unexpectedly */
      onCrash: (code: number | null) => void;
      /** Called after an unexpected server process exit is restarted in-place. */
      onRestart?: (ports: ServerPorts) => void;
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
      onIpcRequest?: (
        type: string,
        msg: Record<string, unknown>
      ) => Promise<Record<string, unknown> | null>;
    }
  ) {}

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

    let ports: ServerPorts;
    try {
      ports = await this.waitForReady(proc);
    } catch (error) {
      if (!(error instanceof ServerStartupExitError)) {
        await this.stopProcess(proc);
      }
      if (this.proc === proc) {
        this.proc = null;
      }
      throw error;
    }
    this.ports = ports;

    // Wire up crash handler after startup succeeds
    proc.on("exit", (code) => {
      if (!this.isShuttingDown) {
        void this.handleUnexpectedExit(code);
      }
    });

    // Listen for post-startup messages from the server. waitForReady() consumes
    // the one-shot `ready`/`error` messages; this handler picks up everything
    // afterwards.
    proc.on("message", (msg: unknown) => {
      if (!isRecord(msg)) return;
      if (msg["type"] === "workspace-relaunch" && typeof msg["name"] === "string") {
        this.config.onRelaunch?.(msg["name"]);
      } else if (msg["type"] === "open-external" && typeof msg["url"] === "string") {
        // Auth service (and potentially others) asks Electron main to open
        // a URL in the user's default browser. Used by the OAuth login flow
        // to hand off to shell.openExternal without exposing openExternal
        // access to panels/workers.
        if (this.config.onOpenExternal) {
          this.config.onOpenExternal(msg["url"]);
        } else {
          try {
            shell.openExternal(msg["url"]);
          } catch (err) {
            console.error("[ServerProcessManager] shell.openExternal failed:", err);
          }
        }
      } else if (
        typeof msg["type"] === "string" &&
        msg["type"].endsWith("-request") &&
        typeof msg["id"] === "string" &&
        this.config.onIpcRequest
      ) {
        // Request/response IPC: dispatch to handler, send correlated response
        const responseType = msg["type"].replace(/-request$/, "-response");
        void this.config
          .onIpcRequest(msg["type"], msg)
          .then((result) => {
            proc.postMessage({ type: responseType, id: msg["id"], ...(result ?? {}) });
          })
          .catch((err) => {
            console.error(
              `[ServerProcessManager] IPC request handler error for ${msg["type"]}:`,
              err
            );
            proc.postMessage({ type: responseType, id: msg["id"], error: String(err) });
          });
      }
    });

    return ports;
  }

  async shutdown(): Promise<void> {
    const proc = this.proc;
    if (!proc) return;
    this.isShuttingDown = true;

    await this.stopProcess(proc);

    if (this.proc === proc) {
      this.proc = null;
    }
  }

  getPorts(): ServerPorts | null {
    return this.ports;
  }

  getCurrentGatewayUrl(): string | null {
    return this.ports ? serverRpcWsUrl(`http://127.0.0.1:${this.ports.gatewayPort}`) : null;
  }

  private async handleUnexpectedExit(code: number | null): Promise<void> {
    const now = Date.now();
    this.restartTimestamps = this.restartTimestamps.filter((ts) => now - ts < 60_000);
    if (this.restartTimestamps.length >= 5) {
      this.config.onCrash(code);
      return;
    }

    this.restartTimestamps.push(now);
    this.proc = null;
    this.ports = null;

    try {
      const ports = await this.start();
      this.config.onRestart?.(ports);
    } catch (error) {
      console.error("[ServerProcessManager] Restart failed:", error);
      this.config.onCrash(code);
    }
  }

  private async stopProcess(proc: ProcessAdapter): Promise<void> {
    try {
      proc.postMessage({ type: "shutdown" });
    } catch (error) {
      console.warn("[ServerProcessManager] Failed to request server shutdown:", error);
    }

    let killTimer: ReturnType<typeof setTimeout> | null = null;
    await Promise.race([
      new Promise<void>((resolve) => proc.on("exit", () => resolve())),
      new Promise<void>((resolve) => {
        killTimer = setTimeout(() => {
          proc.kill();
          resolve();
        }, SERVER_SHUTDOWN_TIMEOUT_MS);
      }),
    ]);
    if (killTimer) {
      clearTimeout(killTimer);
    }
  }

  private spawn(): ProcessAdapter {
    const bundlePath = getServerProcessEntryPath();
    const esbuildBinaryPath = getEsbuildBinaryPath();
    const env: Record<string, string | undefined> = {
      ...process.env,
      NATSTACK_WORKSPACE_DIR: this.config.wsDir,
      NATSTACK_APP_ROOT: this.config.appRoot,
      ...(esbuildBinaryPath ? { ESBUILD_BINARY_PATH: esbuildBinaryPath } : {}),
      NATSTACK_WORKSPACE_EPHEMERAL: this.config.isEphemeral ? "1" : undefined,
      NATSTACK_AUTO_APPROVE_STARTUP_UNITS: this.config.autoApproveStartupUnits ? "1" : undefined,
      ...(this.config.logLevel ? { NATSTACK_LOG_LEVEL: this.config.logLevel } : {}),
    };
    if (!this.config.isEphemeral) delete env["NATSTACK_WORKSPACE_EPHEMERAL"];
    if (!this.config.autoApproveStartupUnits) {
      delete env["NATSTACK_AUTO_APPROVE_STARTUP_UNITS"];
    }

    // Heap headroom for the server child. It is a single Node process that runs
    // builds (esbuild), git, and the DO relay hub, so V8's default ~2 GB old-space
    // limit is tight under load. This is headroom, not a crash fix — the relay/
    // restart fixes prevent unbounded growth; this just avoids starving legit work.
    // Override with NATSTACK_SERVER_MAX_OLD_SPACE_MB.
    const maxOldSpaceMb = Number(process.env["NATSTACK_SERVER_MAX_OLD_SPACE_MB"]) || 4096;
    return utilityProcess.fork(bundlePath, [], {
      serviceName: "natstack-server",
      stdio: "pipe",
      env,
      execArgv: [`--max-old-space-size=${maxOldSpaceMb}`],
    }) as unknown as ProcessAdapter;
  }

  private waitForReady(proc: ProcessAdapter): Promise<ServerPorts> {
    return new Promise((resolve, reject) => {
      proc.on("message", (msg: unknown) => {
        if (!isRecord(msg)) return;
        if (msg["type"] === "ready") {
          if (
            typeof msg["gatewayPort"] !== "number" ||
            typeof msg["adminToken"] !== "string" ||
            (msg["workerdPort"] !== undefined && typeof msg["workerdPort"] !== "number") ||
            (msg["shellToken"] !== undefined && typeof msg["shellToken"] !== "string")
          ) {
            reject(new Error("Server startup returned an invalid ready payload"));
            return;
          }
          resolve({
            workerdPort: msg["workerdPort"],
            gatewayPort: msg["gatewayPort"],
            adminToken: msg["adminToken"],
            shellToken: msg["shellToken"],
          });
        } else if (msg["type"] === "error") {
          reject(new Error(`Server startup failed: ${String(msg["message"])}`));
        }
      });

      proc.on("exit", (code) => {
        reject(new ServerStartupExitError(code));
      });
    });
  }
}
