/**
 * ServerProcessManager — Electron wrapper around the shared ManagedServer.
 */

import { shell, utilityProcess } from "electron";
import type { ProcessAdapter } from "@natstack/process-adapter";
import {
  type ManagedServerConfig,
  ManagedServer,
  type ServerPorts,
} from "@natstack/server-supervisor/managedServer";
import { getEsbuildBinaryPath, getServerProcessEntryPath } from "./paths.js";

export type { ServerPorts };

export class ServerProcessManager {
  private readonly managed: ManagedServer;
  private proc: ProcessAdapter | null = null;

  constructor(
    private readonly config: {
      /** Managed workspace root directory (contains source/ and state/) */
      wsDir: string;
      /** Managed workspace name. Falls back to basename(wsDir) for older callers. */
      workspaceName?: string;
      appRoot: string;
      isEphemeral?: boolean;
      logLevel?: string;
      onCrash: (code: number | null) => void;
      onRestart?: (ports: ServerPorts) => void;
      onRelaunch?: (name: string) => void;
      onOpenExternal?: (url: string) => void;
      onIpcRequest?: ManagedServerConfig["onIpcRequest"];
    }
  ) {
    this.managed = new ManagedServer({
      spawn: () => this.spawn(),
      stdioLabel: "server",
      stderrLabel: "server:err",
      onCrash: config.onCrash,
      onRestart: config.onRestart,
      onRelaunch: config.onRelaunch,
      onIpcRequest: config.onIpcRequest,
      onOpenExternal: (url) => {
        if (config.onOpenExternal) {
          config.onOpenExternal(url);
          return;
        }
        try {
          shell.openExternal(url);
        } catch (err) {
          console.error("[ServerProcessManager] shell.openExternal failed:", err);
        }
      },
    });
  }

  start(): Promise<ServerPorts> {
    return this.managed.start();
  }

  shutdown(): Promise<void> {
    if (this.proc) return shutdownProcessForCompatibilityTest(this.proc);
    return this.managed.shutdown();
  }

  getPorts(): ServerPorts | null {
    return this.managed.getPorts();
  }

  getCurrentGatewayUrl(): string | null {
    return this.managed.getCurrentGatewayUrl();
  }

  private spawn() {
    const bundlePath = getServerProcessEntryPath();
    const esbuildBinaryPath = getEsbuildBinaryPath();
    const env: Record<string, string | undefined> = {
      ...process.env,
      NATSTACK_WORKSPACE: this.config.workspaceName ?? this.config.wsDir.split(/[\\/]/).pop(),
      NATSTACK_APP_ROOT: this.config.appRoot,
      ...(esbuildBinaryPath ? { ESBUILD_BINARY_PATH: esbuildBinaryPath } : {}),
      ...(this.config.isEphemeral ? { NATSTACK_WORKSPACE_EPHEMERAL: "1" } : {}),
      ...(this.config.logLevel ? { NATSTACK_LOG_LEVEL: this.config.logLevel } : {}),
    };

    return utilityProcess.fork(bundlePath, [], {
      serviceName: "natstack-server",
      stdio: "pipe",
      env,
    });
  }
}

async function shutdownProcessForCompatibilityTest(proc: ProcessAdapter): Promise<void> {
  proc.postMessage({ type: "shutdown" });
  let killTimer: ReturnType<typeof setTimeout> | null = null;
  await Promise.race([
    new Promise<void>((resolve) => proc.on("exit", () => resolve())),
    new Promise<void>((resolve) => {
      killTimer = setTimeout(() => {
        proc.kill();
        resolve();
      }, 5000);
    }),
  ]);
  if (killTimer) clearTimeout(killTimer);
}
