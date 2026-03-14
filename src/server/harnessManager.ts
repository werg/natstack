/**
 * HarnessManager — server-side harness process lifecycle.
 *
 * Spawns harness processes (Node.js child processes via fork()), tracks their
 * RPC bridges, and detects crashes. Each harness authenticates back to the
 * RpcServer over WebSocket using a provisioned token.
 *
 * Communicates crashes to the WorkerRouter via the onCrash callback.
 */

import { fork, type ChildProcess } from "node:child_process";
import type { RpcBridge } from "@natstack/rpc";
import type { CallerKind } from "../shared/serviceDispatcher.js";

// ─── Public types ────────────────────────────────────────────────────────────

/** DO identity — source-scoped */
export interface DORef {
  source: string;
  className: string;
  objectKey: string;
}

export interface HarnessProcess {
  id: string;
  type: string;           // e.g. 'claude-sdk', 'pi'
  workerId: string;       // DO identifier (source:className:objectKey)
  channel: string;        // primary channel
  doRef?: DORef;          // source-scoped DO identity
  pid?: number;           // OS process ID
  status: "starting" | "running" | "stopped";
}

export interface HarnessManagerDeps {
  /** Get the RPC WebSocket URL harnesses should connect to */
  getRpcWsUrl(): string;
  /** Create an auth token for a harness process */
  createToken(callerId: string, callerKind: CallerKind): string;
  /** Revoke a harness's auth token */
  revokeToken(callerId: string): void;
  /** Get the RPC bridge for an authenticated client */
  getClientBridge(callerId: string): RpcBridge | undefined;
  /** Called when a harness crashes (unexpected exit or bridge disconnect) */
  onCrash(harnessId: string): void;
  /** Logger */
  log?: {
    info(...args: unknown[]): void;
    error(...args: unknown[]): void;
    warn(...args: unknown[]): void;
  };
}

export interface SpawnOptions {
  id: string;
  type: string;              // e.g. 'claude-sdk', 'pi'
  workerId: string;          // DO identifier
  channel: string;
  contextId: string;
  contextFolderPath?: string;
  resumeSessionId?: string;
  extraEnv?: Record<string, string>;
  /** Override the default harness entry point path */
  entryPath?: string;
}

// Default entry point for harness processes (compiled output)
const DEFAULT_HARNESS_ENTRY = "packages/harness/dist/entry.js";

// ─── Implementation ──────────────────────────────────────────────────────────

interface BridgeWaiter {
  resolve: (bridge: RpcBridge) => void;
  reject: (err: Error) => void;
}

export class HarnessManager {
  private processes = new Map<string, HarnessProcess>();
  private childProcesses = new Map<string, ChildProcess>();
  private bridgeWaiters = new Map<string, BridgeWaiter>();

  constructor(private deps: HarnessManagerDeps) {}

  /**
   * Spawn a new harness process.
   * Returns when the child process has been forked (not yet authenticated).
   */
  async spawn(options: SpawnOptions): Promise<void> {
    const {
      id,
      type,
      workerId,
      channel,
      contextId,
      contextFolderPath,
      resumeSessionId,
      extraEnv,
      entryPath,
    } = options;

    // Guard against duplicate spawn
    if (this.processes.has(id)) {
      throw new Error(`Harness "${id}" is already registered`);
    }

    // Create auth token for this harness
    const token = this.deps.createToken(id, "harness");

    // Build env vars for the child process
    const env: Record<string, string | undefined> = {
      ...process.env,
      RPC_WS_URL: this.deps.getRpcWsUrl(),
      RPC_AUTH_TOKEN: token,
      HARNESS_ID: id,
      HARNESS_TYPE: type,
      CHANNEL_ID: channel,
      CONTEXT_ID: contextId,
      ...(contextFolderPath ? { CONTEXT_FOLDER_PATH: contextFolderPath } : {}),
      ...(resumeSessionId ? { RESUME_SESSION_ID: resumeSessionId } : {}),
      ...extraEnv,
    };

    // Parse DORef from workerId if it has the source:className:objectKey format
    let doRef: DORef | undefined;
    const parts = workerId.split(":");
    if (parts.length >= 3) {
      doRef = { source: parts[0]!, className: parts[1]!, objectKey: parts[2]! };
    }

    // Record the process entry
    const proc: HarnessProcess = { id, type, workerId, channel, doRef, status: "starting" };
    this.processes.set(id, proc);

    // Spawn Node.js child process via fork
    const resolvedEntry = entryPath ?? DEFAULT_HARNESS_ENTRY;
    const child = fork(resolvedEntry, [], {
      env: env as NodeJS.ProcessEnv,
      stdio: "pipe",
    });
    this.childProcesses.set(id, child);

    if (child.pid) {
      proc.pid = child.pid;
    }

    // Handle process exit — guard against stale exits from old spawns.
    // If the harness was stopped and respawned with the same ID, the old
    // child's exit event fires asynchronously after the new child is registered.
    // We check that this child is still the current one for this ID.
    child.on("exit", (code, signal) => {
      if (this.childProcesses.get(id) === child) {
        this.handleProcessExit(id, code, signal);
      }
    });

    // Pipe stdout/stderr to logger
    child.stdout?.on("data", (data: Buffer) => {
      this.deps.log?.info(`[harness:${id}]`, data.toString().trim());
    });
    child.stderr?.on("data", (data: Buffer) => {
      this.deps.log?.warn(`[harness:${id}]`, data.toString().trim());
    });
  }

  /**
   * Wait for the harness to authenticate and return its RPC bridge.
   * Resolves immediately if the bridge already exists.
   */
  async waitForBridge(id: string, timeoutMs = 10000): Promise<RpcBridge> {
    // Check if bridge already exists (harness authenticated before we called waitForBridge)
    const existing = this.deps.getClientBridge(id);
    if (existing) {
      const proc = this.processes.get(id);
      if (proc) proc.status = "running";
      return existing;
    }

    // Wait for authentication
    return new Promise<RpcBridge>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.bridgeWaiters.delete(id);
        reject(new Error(`Harness "${id}" did not authenticate within ${timeoutMs}ms`));
      }, timeoutMs);

      this.bridgeWaiters.set(id, {
        resolve: (bridge) => {
          clearTimeout(timeout);
          const proc = this.processes.get(id);
          if (proc) proc.status = "running";
          resolve(bridge);
        },
        reject: (err) => {
          clearTimeout(timeout);
          reject(err);
        },
      });
    });
  }

  /**
   * Called by the RpcServer (or its disconnect handler wiring) when a harness
   * authenticates. Resolves any pending bridge waiter.
   */
  notifyAuthenticated(harnessId: string): void {
    const bridge = this.deps.getClientBridge(harnessId);
    const waiter = this.bridgeWaiters.get(harnessId);
    if (bridge && waiter) {
      this.bridgeWaiters.delete(harnessId);
      waiter.resolve(bridge);
    }
  }

  /**
   * Called when a harness's WebSocket bridge disconnects.
   * If the process is still "running", this is treated as a crash.
   */
  notifyDisconnected(harnessId: string): void {
    const proc = this.processes.get(harnessId);
    if (!proc) return;

    if (proc.status === "running") {
      this.deps.log?.error(`[harness:${harnessId}] Bridge disconnected while running`);
      proc.status = "stopped";
      this.deps.onCrash(harnessId);
    }

    // Kill the OS process if it's still alive
    const child = this.childProcesses.get(harnessId);
    if (child) {
      child.kill("SIGTERM");
      this.childProcesses.delete(harnessId);
    }

    this.cleanup(harnessId);
  }

  /** Get the RPC bridge for a running harness */
  getHarnessBridge(id: string): RpcBridge | undefined {
    return this.deps.getClientBridge(id);
  }

  /** Get the DORef for a harness */
  getDOForHarness(id: string): DORef | undefined {
    return this.processes.get(id)?.doRef;
  }

  /** Get harness info by ID */
  getHarness(id: string): HarnessProcess | undefined {
    return this.processes.get(id);
  }

  /** List all tracked harnesses */
  listHarnesses(): HarnessProcess[] {
    return [...this.processes.values()];
  }

  /** Stop a specific harness */
  async stop(id: string): Promise<void> {
    const child = this.childProcesses.get(id);
    if (child) {
      child.kill("SIGTERM");
      this.childProcesses.delete(id);
    }

    const proc = this.processes.get(id);
    if (proc) proc.status = "stopped";

    this.cleanup(id);
  }

  /** Stop all harnesses */
  async stopAll(): Promise<void> {
    const ids = [...this.processes.keys()];
    await Promise.all(ids.map((id) => this.stop(id)));
  }

  // ── Private ────────────────────────────────────────────────────────────────

  private handleProcessExit(id: string, code: number | null, signal: string | null): void {
    this.childProcesses.delete(id);
    const proc = this.processes.get(id);

    if (proc && proc.status !== "stopped") {
      // Unexpected exit — crash
      proc.status = "stopped";
      this.deps.log?.error(`[harness:${id}] Crashed with code=${code} signal=${signal}`);
      this.deps.onCrash(id);
    }

    this.cleanup(id);
  }

  /**
   * Shared cleanup: revoke token, remove process entry, reject pending waiter.
   */
  private cleanup(id: string): void {
    this.deps.revokeToken(id);
    this.processes.delete(id);

    const waiter = this.bridgeWaiters.get(id);
    if (waiter) {
      this.bridgeWaiters.delete(id);
      waiter.reject(new Error(`Harness "${id}" stopped before authenticating`));
    }
  }
}
