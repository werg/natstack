import type { ProcessAdapter } from "@natstack/process-adapter";

export interface ServerPorts {
  workerdPort?: number;
  gatewayPort: number;
  adminToken: string;
  shellToken?: string;
}

export interface ManagedServerConfig {
  spawn: () => ProcessAdapter;
  stdioLabel?: string;
  stderrLabel?: string;
  onCrash: (code: number | null) => void;
  onRestart?: (ports: ServerPorts) => void;
  onRelaunch?: (name: string) => void;
  onOpenExternal?: (url: string) => void;
  onIpcRequest?: (
    type: string,
    msg: Record<string, unknown>
  ) => Promise<Record<string, unknown> | null>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseReadyPayload(msg: Record<string, unknown>): ServerPorts {
  if (
    typeof msg["gatewayPort"] !== "number" ||
    typeof msg["adminToken"] !== "string" ||
    (msg["workerdPort"] !== undefined && typeof msg["workerdPort"] !== "number") ||
    (msg["shellToken"] !== undefined && typeof msg["shellToken"] !== "string")
  ) {
    throw new Error("Server startup returned an invalid ready payload");
  }
  return {
    workerdPort: msg["workerdPort"],
    gatewayPort: msg["gatewayPort"],
    adminToken: msg["adminToken"],
    shellToken: msg["shellToken"],
  };
}

class ServerExitedDuringStartupError extends Error {
  constructor(readonly code: number | null) {
    super(`Server exited during startup with code ${code}`);
  }
}

export class ManagedServer {
  private proc: ProcessAdapter | null = null;
  private ports: ServerPorts | null = null;
  private isShuttingDown = false;
  private restartTimestamps: number[] = [];

  constructor(private readonly config: ManagedServerConfig) {}

  async start(): Promise<ServerPorts> {
    this.isShuttingDown = false;
    const proc = this.config.spawn();
    this.proc = proc;
    this.attachStdio(proc);

    let ports: ServerPorts;
    try {
      ports = await this.waitForReady(proc);
      if (this.proc !== proc) {
        throw new Error("Server process changed before readiness completed");
      }
      this.ports = ports;
    } catch (error) {
      if (this.proc === proc) {
        if (!(error instanceof ServerExitedDuringStartupError)) {
          await this.shutdownProcess(proc);
        }
        this.proc = null;
        this.ports = null;
      }
      throw error;
    }

    proc.on("exit", (code) => {
      if (!this.isShuttingDown && this.proc === proc) {
        void this.handleUnexpectedExit(code);
      }
    });

    proc.on("message", (msg: unknown) => this.handleMessage(proc, msg));

    return ports;
  }

  async shutdown(): Promise<void> {
    const proc = this.proc;
    if (!proc) return;
    this.isShuttingDown = true;
    await this.shutdownProcess(proc);

    if (this.proc === proc) {
      this.proc = null;
      this.ports = null;
    }
  }

  getPorts(): ServerPorts | null {
    return this.ports;
  }

  getProcessId(): number | undefined {
    return this.proc?.pid;
  }

  getCurrentGatewayUrl(): string | null {
    return this.ports ? `ws://127.0.0.1:${this.ports.gatewayPort}/rpc` : null;
  }

  private attachStdio(proc: ProcessAdapter): void {
    const stdoutLabel = this.config.stdioLabel ?? "server";
    const stderrLabel = this.config.stderrLabel ?? `${stdoutLabel}:err`;
    if (proc.stdout) {
      proc.stdout.on("data", (chunk: Buffer) => {
        process.stdout.write(`[${stdoutLabel}] ${chunk}`);
      });
    }
    if (proc.stderr) {
      proc.stderr.on("data", (chunk: Buffer) => {
        process.stderr.write(`[${stderrLabel}] ${chunk}`);
      });
    }
  }

  private async shutdownProcess(proc: ProcessAdapter): Promise<void> {
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

  private handleMessage(proc: ProcessAdapter, msg: unknown): void {
    if (!isRecord(msg)) return;
    if (msg["type"] === "workspace-relaunch" && typeof msg["name"] === "string") {
      this.config.onRelaunch?.(msg["name"]);
      return;
    }
    if (msg["type"] === "open-external" && typeof msg["url"] === "string") {
      this.config.onOpenExternal?.(msg["url"]);
      return;
    }
    if (
      typeof msg["type"] === "string" &&
      msg["type"].endsWith("-request") &&
      typeof msg["id"] === "string" &&
      this.config.onIpcRequest
    ) {
      const responseType = msg["type"].replace(/-request$/, "-response");
      void this.config
        .onIpcRequest(msg["type"], msg)
        .then((result) => {
          proc.postMessage({ type: responseType, id: msg["id"], ...(result ?? {}) });
        })
        .catch((err) => {
          console.error(`[ManagedServer] IPC request handler error for ${msg["type"]}:`, err);
          proc.postMessage({ type: responseType, id: msg["id"], error: String(err) });
        });
    }
  }

  private async handleUnexpectedExit(code: number | null): Promise<void> {
    const now = Date.now();
    this.restartTimestamps = this.restartTimestamps.filter((ts) => now - ts < 60_000);
    if (this.restartTimestamps.length >= 5) {
      this.proc = null;
      this.ports = null;
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
      console.error("[ManagedServer] Restart failed:", error);
      this.config.onCrash(code);
    }
  }

  private waitForReady(proc: ProcessAdapter): Promise<ServerPorts> {
    return new Promise((resolve, reject) => {
      const onMessage = (msg: unknown) => {
        if (!isRecord(msg)) return;
        if (msg["type"] === "ready") {
          cleanup();
          try {
            resolve(parseReadyPayload(msg));
          } catch (error) {
            reject(error);
          }
        } else if (msg["type"] === "error") {
          cleanup();
          reject(new Error(`Server startup failed: ${String(msg["message"])}`));
        }
      };
      const onExit = (code: number | null) => {
        cleanup();
        reject(new ServerExitedDuringStartupError(code));
      };
      const cleanup = () => {
        proc.removeListener("message", onMessage);
        proc.removeListener("exit", onExit);
      };
      proc.on("message", onMessage);
      proc.on("exit", onExit);
    });
  }
}
