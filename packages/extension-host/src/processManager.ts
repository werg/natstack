import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createProcessAdapter, type ProcessAdapter } from "@natstack/process-adapter";

import type { ExtensionHealth, ExtensionProcessState } from "./types.js";

interface RunningExtension {
  state: ExtensionProcessState;
  proc: ProcessAdapter;
  ready: boolean;
  methods: string[];
  hasFetch: boolean;
  pending: Map<string, { resolve: (value: unknown) => void; reject: (err: Error) => void; timeout: ReturnType<typeof setTimeout> }>;
  lastStartedAt: number;
  stopping: boolean;
  health: ExtensionHealth | null;
  inspectorUrl: string | null;
}

interface CrashState {
  attempts: number;
  windowStart: number;
  timer: ReturnType<typeof setTimeout> | null;
  nextAttemptAt: number | null;
}

const CRASH_BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 16_000] as const;
const CRASH_WINDOW_MS = 60_000;

export interface ExtensionProcessManagerDeps {
  onStatus(name: string, status: "running" | "stopped" | "error", error?: string | null): void;
  onError?(name: string, error: string, attempts: number): void;
  onHealth(name: string, health: ExtensionHealth): void;
  onLog(
    name: string,
    level: "debug" | "info" | "warn" | "error",
    message: string,
    fields?: Record<string, unknown>,
    source?: "stdout" | "stderr" | "ctx.log" | "console",
  ): void;
  onCrashLimit?(name: string, error: string, attempts: number): void;
  onInspectorUrl?(name: string, inspectorUrl: string | null): void;
}

export class ExtensionProcessManager {
  private running = new Map<string, RunningExtension>();
  private crashes = new Map<string, CrashState>();

  constructor(private readonly deps: ExtensionProcessManagerDeps) {}

  async start(state: ExtensionProcessState): Promise<void> {
    await this.stop(state.name, "restart");
    this.resetCrashState(state.name);
    await this.spawn(state);
  }

  private async spawn(state: ExtensionProcessState): Promise<void> {
    const childRuntime = resolveChildRuntimePath();
    const proc = createProcessAdapter(
      childRuntime,
      {
        ...process.env,
        NATSTACK_EXTENSION_NAME: state.name,
        NATSTACK_EXTENSION_VERSION: state.version,
        NATSTACK_EXTENSION_BUNDLE_PATH: state.bundlePath,
        NATSTACK_EXTENSION_STORAGE_DIR: state.storageDir,
        NATSTACK_EXTENSION_GATEWAY_URL: state.gatewayUrl,
        NATSTACK_EXTENSION_RPC_TOKEN: state.rpcToken,
      },
      {
        execArgv: extensionInspectorEnabled() ? ["--inspect=0"] : undefined,
      },
    );
    const running: RunningExtension = {
      state,
      proc,
      ready: false,
      methods: [],
      hasFetch: false,
      pending: new Map(),
      lastStartedAt: Date.now(),
      stopping: false,
      health: null,
      inspectorUrl: null,
    };
    this.running.set(state.name, running);

    proc.on("exit", (code) => this.handleExit(state, code));
    proc.stdout?.on("data", (chunk) => this.handleStdout(state.name, "info", chunk));
    proc.stderr?.on("data", (chunk) => this.handleStdout(state.name, "error", chunk));

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        running.proc.kill();
        reject(new Error(`Extension ${state.name} did not become ready within 10s`));
      }, 10_000);
      running.pending.set("__ready__", {
        resolve: () => {
          clearTimeout(timeout);
          resolve();
        },
        reject: (err) => {
          clearTimeout(timeout);
          reject(err);
        },
        timeout,
      });
    });
  }

  async stop(name: string, reason = "stop"): Promise<void> {
    if (reason !== "crash-restart") {
      this.resetCrashState(name);
    }
    const running = this.running.get(name);
    if (!running) return;
    running.stopping = true;
    running.proc.postMessage({ type: "shutdown" });
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        running.proc.kill();
        resolve();
      }, 2_000);
      running.proc.on("exit", () => {
        clearTimeout(timeout);
        resolve();
      });
    });
    this.running.delete(name);
    if (reason !== "restart") this.deps.onStatus(name, "stopped", null);
  }

  async shutdown(): Promise<void> {
    await Promise.all([...this.running.keys()].map((name) => this.stop(name)));
  }

  listRunning(): Array<{
    name: string;
    methods: string[];
    hasFetch: boolean;
    health: ExtensionHealth | null;
    inspectorUrl: string | null;
  }> {
    return [...this.running.values()].map((running) => ({
      name: running.state.name,
      methods: running.methods,
      hasFetch: running.hasFetch,
      health: running.health,
      inspectorUrl: running.inspectorUrl,
    }));
  }

  isRunning(name: string): boolean {
    return this.running.get(name)?.ready ?? false;
  }

  markReady(name: string, readyState: { methods: string[]; hasFetch: boolean }): void {
    const running = this.running.get(name);
    if (!running) return;
    running.ready = true;
    running.methods = readyState.methods;
    running.hasFetch = readyState.hasFetch;
    this.deps.onStatus(name, "running", null);
    if (!running.health) {
      const health: ExtensionHealth = {
        state: "healthy",
        summary: "healthy",
        reportedAt: Date.now(),
      };
      running.health = health;
      this.deps.onHealth(name, health);
    }
    const ready = running.pending.get("__ready__");
    if (ready) {
      running.pending.delete("__ready__");
      ready.resolve(undefined);
    }
  }

  private handleExit(state: ExtensionProcessState, code: number | null): void {
    const running = this.running.get(state.name);
    if (!running) return;
    this.running.delete(state.name);
    const ready = running.pending.get("__ready__");
    if (ready) {
      ready.reject(new Error(`Extension ${state.name} exited before ready (code ${code ?? "signal"})`));
    }
    for (const [requestId, pending] of running.pending) {
      if (requestId === "__ready__") continue;
      clearTimeout(pending.timeout);
      pending.reject(new Error(`Extension ${state.name} exited`));
    }
    if (running.stopping) return;
    if (code === 0 && running.ready) {
      this.deps.onStatus(state.name, "stopped", null);
      return;
    }
    this.scheduleCrashRestart(
      state,
      running.ready
        ? `Exited with code ${code ?? "signal"}`
        : `Exited before ready with code ${code ?? "signal"}`,
    );
  }

  private handleStdout(name: string, level: "info" | "error", chunk: unknown): void {
    for (const line of String(chunk).split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const inspectorUrl = parseInspectorUrl(trimmed);
      if (inspectorUrl) {
        const running = this.running.get(name);
        if (running) running.inspectorUrl = inspectorUrl;
        this.deps.onInspectorUrl?.(name, inspectorUrl);
        continue;
      }
      if (isInspectorHelpLine(trimmed)) continue;
      this.deps.onLog(name, level, trimmed, undefined, level === "error" ? "stderr" : "stdout");
    }
  }

  getRespawn(name: string): { attempts: number; nextAttemptAt: number | null } | null {
    const crashState = this.crashes.get(name);
    return crashState
      ? { attempts: crashState.attempts, nextAttemptAt: crashState.nextAttemptAt }
      : null;
  }

  private scheduleCrashRestart(state: ExtensionProcessState, error: string): void {
    const now = Date.now();
    const current = this.crashes.get(state.name);
    const crashState: CrashState = current && now - current.windowStart <= CRASH_WINDOW_MS
      ? current
      : { attempts: 0, windowStart: now, timer: null, nextAttemptAt: null };
    crashState.attempts += 1;
    if (crashState.timer) {
      clearTimeout(crashState.timer);
      crashState.timer = null;
    }
    this.crashes.set(state.name, crashState);

    if (crashState.attempts >= CRASH_BACKOFF_MS.length) {
      crashState.nextAttemptAt = null;
      this.deps.onStatus(state.name, "error", error);
      this.deps.onError?.(state.name, error, crashState.attempts);
      this.deps.onCrashLimit?.(state.name, error, crashState.attempts);
      return;
    }

    const delay = CRASH_BACKOFF_MS[crashState.attempts - 1]!;
    crashState.nextAttemptAt = Date.now() + delay;
    this.deps.onStatus(state.name, "stopped", `${error}; restarting in ${delay}ms`);
    crashState.timer = setTimeout(() => {
      crashState.timer = null;
      crashState.nextAttemptAt = null;
      this.spawn(state).catch((err) => {
        if (this.running.has(state.name)) return;
        this.scheduleCrashRestart(
          state,
          err instanceof Error ? err.message : String(err),
        );
      });
    }, delay);
  }

  private resetCrashState(name: string): void {
    const crashState = this.crashes.get(name);
    if (crashState?.timer) clearTimeout(crashState.timer);
    this.crashes.delete(name);
  }
}

function resolveChildRuntimePath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const dist = path.join(here, "childRuntime.js");
  return dist;
}

function extensionInspectorEnabled(): boolean {
  return process.env["NATSTACK_PROD"] !== "1" && process.env["NODE_ENV"] !== "production";
}

function parseInspectorUrl(line: string): string | null {
  const match = line.match(/\bDebugger listening on (ws:\/\/\S+)/);
  return match?.[1] ?? null;
}

function isInspectorHelpLine(line: string): boolean {
  return line.startsWith("For help, see:");
}
