/**
 * Typed client for the workerd RPC service (worker instance management).
 *
 * Usage:
 * ```typescript
 * const workers = createWorkerdClient(rpc);
 * const instance = await workers.create({
 *   source: "workers/hello",
 *   contextId: "ctx-1",
 *   limits: { cpuMs: 100, subrequests: 10 },
 * });
 * const list = await workers.list();
 * await workers.destroy("hello");
 * ```
 *
 * Available to server, panel, and worker callers.
 */

import type { RpcBridge } from "@natstack/rpc";

// ---------------------------------------------------------------------------
// Types (mirror server-side WorkerdManager types, minus internal fields)
// ---------------------------------------------------------------------------

export type WorkerBindingDef =
  | { type: "service"; worker: string }
  | { type: "text"; value: string }
  | { type: "json"; value: unknown };

/** Resource limits enforced by workerd per request. */
export interface WorkerLimits {
  /** CPU time limit per request in milliseconds. */
  cpuMs: number;
  /** Maximum subrequests (outbound fetches) per invocation. */
  subrequests?: number;
}

export interface WorkerCreateOptions {
  /** Source path relative to workspace root (e.g., "workers/hello") */
  source: string;
  /** Context ID for storage partition */
  contextId: string;
  /** Resource limits enforced by workerd per request. */
  limits: WorkerLimits;
  /** Instance name (defaults to last segment of source) */
  name?: string;
  /** Extra text bindings injected as env vars */
  env?: Record<string, string>;
  /** Typed bindings (service, text, json) */
  bindings?: Record<string, WorkerBindingDef>;
  /** Initial state args (available via STATE_ARGS binding) */
  stateArgs?: Record<string, unknown>;
  /** Build at a specific git ref (branch, tag, or commit SHA).
   *  Use a commit SHA for immutable pinning (content-addressed cache guarantees same build). */
  ref?: string;
}

export interface WorkerUpdateOptions {
  env?: Record<string, string>;
  bindings?: Record<string, WorkerBindingDef>;
  stateArgs?: Record<string, unknown>;
  limits?: WorkerLimits;
  /** Change the git ref this instance builds at */
  ref?: string;
}

export interface WorkerInstanceInfo {
  name: string;
  source: string;
  contextId: string;
  callerId: string;
  env: Record<string, string>;
  bindings: Record<string, WorkerBindingDef>;
  stateArgs?: Record<string, unknown>;
  limits?: WorkerLimits;
  buildKey?: string;
  /** Git ref this instance is built at. */
  ref?: string;
  status: "building" | "starting" | "running" | "stopped" | "error";
}

export interface WorkerSourceInfo {
  name: string;
  source: string;
  title?: string;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export interface WorkerdClient {
  /** Create a new worker instance. Limits are mandatory. */
  create(options: WorkerCreateOptions): Promise<WorkerInstanceInfo>;
  /** Destroy a worker instance by name. */
  destroy(name: string): Promise<void>;
  /** Update a running worker instance. Triggers restart. */
  update(name: string, updates: WorkerUpdateOptions): Promise<WorkerInstanceInfo>;
  /** List all worker instances. */
  list(): Promise<WorkerInstanceInfo[]>;
  /** Get status of a specific worker instance (null if not found). */
  status(name: string): Promise<WorkerInstanceInfo | null>;
  /** List available worker sources from the build graph. */
  listSources(): Promise<WorkerSourceInfo[]>;
  /** Get the workerd HTTP port (null if not running). */
  getPort(): Promise<number | null>;
  /** Restart all worker instances. */
  restartAll(): Promise<void>;
}

export function createWorkerdClient(rpc: Pick<RpcBridge, "call">): WorkerdClient {
  const call = <T>(method: string, ...args: unknown[]) =>
    rpc.call<T>("main", `workerd.${method}`, ...args);

  return {
    create: (options) => call<WorkerInstanceInfo>("createInstance", options),
    destroy: (name) => call<void>("destroyInstance", name),
    update: (name, updates) => call<WorkerInstanceInfo>("updateInstance", name, updates),
    list: () => call<WorkerInstanceInfo[]>("listInstances"),
    status: (name) => call<WorkerInstanceInfo | null>("getInstanceStatus", name),
    listSources: () => call<WorkerSourceInfo[]>("listSources"),
    getPort: () => call<number | null>("getPort"),
    restartAll: () => call<void>("restartAll"),
  };
}
