import { createProcessAdapter, type ProcessAdapter } from "@natstack/process-adapter";
import type { ConnectionGrantService } from "@natstack/shared/connectionGrants";
import { artifactFilePath } from "./buildV2/buildStore.js";

export interface TerminalAppBuild {
  dir: string;
  metadata: { ev: string };
  artifacts?: Array<{
    path: string;
    role: string;
  }>;
}

export interface TerminalAppLaunch {
  appId: string;
  source: string;
  buildKey: string;
  effectiveVersion: string | null;
  gatewayUrl: string;
  build: TerminalAppBuild;
}

export interface TerminalAppRunnerDeps {
  connectionGrants: Pick<ConnectionGrantService, "grant" | "revokeForPrincipal">;
  onStatus(appId: string, status: "running" | "stopped" | "error", error?: string | null): void;
  onLog(
    appId: string,
    level: "info" | "error",
    message: string,
    source: "stdout" | "stderr" | "runner"
  ): void;
}

interface RunningTerminalApp {
  launch: TerminalAppLaunch;
  proc: ProcessAdapter;
  stopping: boolean;
  exitHandler: (code: number | null) => void;
}

const TERMINAL_APP_CONNECTION_GRANT_TTL_MS = 24 * 60 * 60 * 1000;

export class TerminalAppRunner {
  private readonly running = new Map<string, RunningTerminalApp>();

  constructor(private readonly deps: TerminalAppRunnerDeps) {}

  isRunning(appId: string): boolean {
    return this.running.has(appId);
  }

  async start(launch: TerminalAppLaunch): Promise<void> {
    await this.stop(launch.appId, "restart");
    const artifact = (launch.build.artifacts ?? []).find(
      (candidate) => candidate.role === "primary"
    );
    if (!artifact) throw new Error(`Terminal app ${launch.appId} has no primary artifact`);
    const entryPath = artifactFilePath(launch.build, artifact);
    const rpcGrant = this.deps.connectionGrants.grant(
      launch.appId,
      "terminal-app-runner",
      TERMINAL_APP_CONNECTION_GRANT_TTL_MS
    );
    const connectionId = `terminal:${launch.appId}:${launch.buildKey}`;
    const proc = createProcessAdapter(
      entryPath,
      {
        ...process.env,
        NATSTACK_TERMINAL_APP_ID: launch.appId,
        NATSTACK_TERMINAL_APP_SOURCE: launch.source,
        NATSTACK_TERMINAL_APP_BUILD_KEY: launch.buildKey,
        NATSTACK_TERMINAL_APP_EFFECTIVE_VERSION: launch.effectiveVersion ?? "",
        NATSTACK_TERMINAL_APP_GATEWAY_URL: launch.gatewayUrl,
        NATSTACK_TERMINAL_APP_RPC_TOKEN: rpcGrant.token,
        NATSTACK_TERMINAL_APP_CONNECTION_ID: connectionId,
      },
      { preferNode: true }
    );
    const exitHandler = (code: number | null) => this.handleExit(launch.appId, code);
    this.running.set(launch.appId, { launch, proc, stopping: false, exitHandler });
    proc.on("exit", exitHandler);
    proc.stdout?.on("data", (chunk) => this.handleOutput(launch.appId, "info", "stdout", chunk));
    proc.stderr?.on("data", (chunk) => this.handleOutput(launch.appId, "error", "stderr", chunk));
    this.deps.onStatus(launch.appId, "running", null);
    this.deps.onLog(launch.appId, "info", `started ${entryPath}`, "runner");
  }

  async stop(appId: string, reason = "stop"): Promise<void> {
    const running = this.running.get(appId);
    this.deps.connectionGrants.revokeForPrincipal(appId);
    if (!running) return;
    running.stopping = true;
    running.proc.postMessage({ type: "shutdown", reason });
    await new Promise<void>((resolve) => {
      let settled = false;
      const settle = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve();
      };
      const timeout = setTimeout(() => {
        running.proc.kill();
        settle();
      }, 2_000);
      const onExit = () => settle();
      running.proc.on("exit", onExit);
    });
    running.proc.off("exit", running.exitHandler);
    this.running.delete(appId);
    this.deps.onStatus(appId, "stopped", null);
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.running.keys()].map((appId) => this.stop(appId, "shutdown")));
  }

  private handleExit(appId: string, code: number | null): void {
    const running = this.running.get(appId);
    if (!running) return;
    this.running.delete(appId);
    this.deps.connectionGrants.revokeForPrincipal(appId);
    if (running.stopping) {
      this.deps.onStatus(appId, "stopped", null);
      return;
    }
    const message = `Terminal app exited${code === null ? "" : ` with code ${code}`}`;
    this.deps.onLog(appId, "error", message, "runner");
    this.deps.onStatus(appId, "error", message);
  }

  private handleOutput(
    appId: string,
    level: "info" | "error",
    source: "stdout" | "stderr",
    chunk: unknown
  ): void {
    const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
    for (const line of text.split(/\r?\n/)) {
      const message = line.trimEnd();
      if (message) this.deps.onLog(appId, level, message, source);
    }
  }
}
