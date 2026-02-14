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
} from "./processAdapter.js";

export interface ServerPorts {
  rpcPort: number;
  verdaccioPort: number;
  gitPort: number;
  pubsubPort: number;
  adminToken: string;
}

export class ServerProcessManager {
  private proc: ProcessAdapter | null = null;
  private ports: ServerPorts | null = null;
  private isShuttingDown = false;

  constructor(private config: {
    workspacePath: string;
    appRoot: string;
    dataDir?: string;
    logLevel?: string;
    /** Called if the server process exits unexpectedly */
    onCrash: (code: number | null) => void;
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
      NATSTACK_WORKSPACE: this.config.workspacePath,
      NATSTACK_APP_ROOT: this.config.appRoot,
      ...(this.config.dataDir ? { NATSTACK_USER_DATA_PATH: this.config.dataDir } : {}),
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
            verdaccioPort: msg.verdaccioPort,
            gitPort: msg.gitPort,
            pubsubPort: msg.pubsubPort,
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
