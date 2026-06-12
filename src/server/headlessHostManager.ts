/**
 * HeadlessHostManager — spawns the standalone headless Chromium panel host
 * (apps/headless-host) on demand, making it the renderer of last resort: when
 * a worker/agent needs a panel hosted and no CDP-capable client is connected,
 * the manager forks the host, waits for it to register, and the caller
 * retries lease assignment.
 *
 * The shell-remote token is delivered over the fork IPC channel (never via
 * env/argv). Idle shutdown: when the spawned host holds zero leases for
 * idleShutdownMs, it gets SIGTERM (the host also self-exits via its own
 * idle-exit backstop). Crash backoff: respawn only on next demand, with
 * exponential delay; hard-disable after repeated failures.
 */
import { fork, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { createDevLogger } from "@natstack/dev-log";
import type { ClientSession } from "@natstack/shared/panel/panelLease";
import type { TokenManager } from "@natstack/shared/tokenManager";
import type { PanelRuntimeCoordinator } from "./panelRuntimeCoordinator.js";

const log = createDevLogger("HeadlessHostManager");

const HEADLESS_HOST_CALLER_ID = "headless-host";

export interface HeadlessHostManagerConfig {
  enabled: boolean;
  /** Entry of the built headless host; resolved from the repo by default. */
  entryPath?: string;
  spawnTimeoutMs?: number;
  idleShutdownMs?: number;
  maxRestarts?: number;
}

export interface HeadlessHostManagerDeps {
  tokenManager: TokenManager;
  coordinator: PanelRuntimeCoordinator;
  isHostAvailable: (hostConnectionId: string) => boolean;
  getServerUrl: () => string;
  config: HeadlessHostManagerConfig;
  /** Test seam. */
  spawnFn?: (entryPath: string) => ChildProcess;
}

function defaultEntryPath(): string {
  const override = process.env["NATSTACK_HEADLESS_HOST_ENTRY"];
  if (override) return override;

  const baseDirs = new Set<string>();
  const addDir = (value: unknown): void => {
    if (typeof value === "string" && value.length > 0) baseDirs.add(path.resolve(value));
  };
  addDir(typeof __dirname === "string" ? __dirname : undefined);
  addDir(
    typeof require === "function" && typeof require.main?.filename === "string"
      ? path.dirname(require.main.filename)
      : undefined
  );
  addDir(process.argv[1] ? path.dirname(process.argv[1]) : undefined);
  addDir(process.cwd());

  const candidates: string[] = [];
  for (const base of baseDirs) {
    candidates.push(
      // Root build copies the bundle here; from dist/server.mjs, base is dist/.
      path.resolve(base, "headless-host", "main.js"),
      // Repo root layout after a root build.
      path.resolve(base, "dist", "headless-host", "main.js"),
      // Source/dev layout from repo root, dist, or src/server.
      path.resolve(base, "apps", "headless-host", "dist", "main.js"),
      path.resolve(base, "..", "apps", "headless-host", "dist", "main.js"),
      path.resolve(base, "..", "..", "apps", "headless-host", "dist", "main.js")
    );
  }

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return path.resolve(process.cwd(), "dist", "headless-host", "main.js");
}

export class HeadlessHostManager {
  private child: ChildProcess | null = null;
  private spawnInFlight: Promise<ClientSession | null> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private consecutiveFailures = 0;
  private firstFailureAt = 0;
  private nextAttemptAt = 0;
  private disabled = false;
  private stopLeaseListener: (() => void) | null = null;
  private spawnedClientSessionId: string | null = null;

  constructor(private readonly deps: HeadlessHostManagerDeps) {
    this.stopLeaseListener = deps.coordinator.onLeaseChanged(() => this.updateIdleTimer());
  }

  private get config() {
    return this.deps.config;
  }

  /** A default CDP host that is registered AND bridge-connected, if any. */
  private availableDefaultHost(): ClientSession | null {
    return this.deps.coordinator.getDefaultCdpHostClient({
      isHostAvailable: (id) => this.deps.isHostAvailable(id),
    });
  }

  /**
   * Ensure a default CDP host exists, spawning the headless host if needed.
   * Single-flight; returns null when disabled, backing off, or timed out.
   */
  async ensureDefaultHost(timeoutMs?: number): Promise<ClientSession | null> {
    const existing = this.availableDefaultHost();
    if (existing) return existing;
    if (!this.config.enabled || this.disabled) return null;
    if (Date.now() < this.nextAttemptAt) return null;
    this.spawnInFlight ??= this.spawnAndWait(timeoutMs).finally(() => {
      this.spawnInFlight = null;
    });
    return this.spawnInFlight;
  }

  async stop(): Promise<void> {
    this.stopLeaseListener?.();
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.terminateChild("manager stopping");
  }

  // ── internals ────────────────────────────────────────────────────────────

  private async spawnAndWait(timeoutMs?: number): Promise<ClientSession | null> {
    const entryPath = this.config.entryPath ?? defaultEntryPath();
    if (!fs.existsSync(entryPath) && !this.deps.spawnFn) {
      log.warn(`headless host entry not found at ${entryPath} — build apps/headless-host first`);
      this.recordFailure();
      return null;
    }
    const timeout = timeoutMs ?? this.config.spawnTimeoutMs ?? 45_000;
    log.info(`spawning headless host (${entryPath})`);

    let child: ChildProcess;
    try {
      child =
        this.deps.spawnFn?.(entryPath) ??
        fork(entryPath, [], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
    } catch (error) {
      log.warn(`headless host spawn failed: ${String(error)}`);
      this.recordFailure();
      return null;
    }
    this.child = child;
    child.stdout?.on("data", (chunk: Buffer) => {
      log.info(`[host] ${String(chunk).trimEnd()}`);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      log.warn(`[host] ${String(chunk).trimEnd()}`);
    });
    child.once("exit", (code) => {
      if (this.child === child) this.child = null;
      log.info(`headless host exited (code ${code})`);
    });

    // Token over the IPC channel — not visible in /proc/*/environ or ps.
    const token = this.deps.tokenManager.ensureToken(HEADLESS_HOST_CALLER_ID, "shell-remote");
    child.send({
      type: "init",
      token,
      serverUrl: this.deps.getServerUrl(),
      label: "Headless (server)",
    });

    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const host = this.availableDefaultHost();
      if (host) {
        this.consecutiveFailures = 0;
        this.spawnedClientSessionId = host.clientSessionId;
        this.updateIdleTimer();
        log.info(`headless host registered as ${host.clientSessionId}`);
        return host;
      }
      if (child.exitCode !== null) break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    log.warn("headless host did not register in time");
    this.terminateChild("registration timeout");
    this.recordFailure();
    return null;
  }

  private recordFailure(): void {
    const now = Date.now();
    if (now - this.firstFailureAt > 5 * 60_000) {
      this.firstFailureAt = now;
      this.consecutiveFailures = 0;
    }
    this.consecutiveFailures += 1;
    const maxRestarts = this.config.maxRestarts ?? 3;
    if (this.consecutiveFailures >= maxRestarts) {
      this.disabled = true;
      log.warn(
        `headless host failed ${this.consecutiveFailures} times in 5 minutes — auto-spawn disabled ` +
          `until server restart (run \`natstack remote host\` manually or fix the host build)`
      );
      return;
    }
    const delay = Math.min(1_000 * 2 ** (this.consecutiveFailures - 1), 60_000);
    this.nextAttemptAt = now + delay;
  }

  private updateIdleTimer(): void {
    if (!this.child || !this.spawnedClientSessionId) return;
    const sessionId = this.spawnedClientSessionId;
    const holdsLeases = this.deps.coordinator
      .getSnapshot()
      .leases.some((lease) => lease.clientSessionId === sessionId);
    if (holdsLeases) {
      if (this.idleTimer) clearTimeout(this.idleTimer);
      this.idleTimer = null;
      return;
    }
    if (this.idleTimer) return;
    const idleMs = this.config.idleShutdownMs ?? 10 * 60_000;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      const stillIdle = !this.deps.coordinator
        .getSnapshot()
        .leases.some((lease) => lease.clientSessionId === sessionId);
      if (stillIdle) this.terminateChild("idle shutdown");
    }, idleMs);
    this.idleTimer.unref?.();
  }

  private terminateChild(reason: string): void {
    if (!this.child) return;
    log.info(`terminating headless host: ${reason}`);
    const child = this.child;
    this.child = null;
    this.spawnedClientSessionId = null;
    child.kill("SIGTERM");
    const killTimer = setTimeout(() => {
      if (child.exitCode === null) child.kill("SIGKILL");
    }, 5_000);
    killTimer.unref?.();
  }
}
