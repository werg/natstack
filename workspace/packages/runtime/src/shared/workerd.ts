/**
 * Typed client for the workerd RPC service (worker instance management).
 *
 * Usage:
 * ```typescript
 * const workers = createWorkerdClient(rpc);
 * const instance = await workers.create({
 *   source: "workers/hello",
 *   contextId: "ctx-1",
 * });
 * const list = await workers.list();
 * await workers.destroy("hello");
 * ```
 *
 * Available to server, panel, and worker callers.
 */

import type { RpcCaller } from "@natstack/rpc";

// ---------------------------------------------------------------------------
// Types (mirror server-side WorkerdManager types, minus internal fields)
// ---------------------------------------------------------------------------

export type WorkerBindingDef =
  | { type: "service"; worker: string }
  | { type: "text"; value: string }
  | { type: "json"; value: unknown };

export interface WorkerCreateOptions {
  /** Source path relative to workspace root (e.g., "workers/hello") */
  source: string;
  /** Context ID for storage partition */
  contextId: string;
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
  /** ID of the creating caller. Worker can call getParent() to communicate back. */
  parentId?: string;
}

export interface WorkerUpdateOptions {
  env?: Record<string, string>;
  bindings?: Record<string, WorkerBindingDef>;
  stateArgs?: Record<string, unknown>;
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

/** DO reference for clone/destroy operations. */
export interface DORefParam {
  source: string;
  className: string;
  objectKey: string;
}

export interface WorkerdClient {
  /** Create a new worker instance. */
  create(options: WorkerCreateOptions): Promise<WorkerInstanceInfo>;
  /** Destroy a worker instance by name. */
  destroy(name: string): Promise<void>;
  /** Update a running worker instance. Triggers restart. */
  update(name: string, updates: WorkerUpdateOptions): Promise<WorkerInstanceInfo>;
  /** List all worker instances. */
  list(): Promise<WorkerInstanceInfo[]>;
  /** Get status of a specific worker instance (null if not found). */
  status(name: string): Promise<WorkerInstanceInfo | null>;
  /** List available worker-instance sources from the build graph. */
  listInstanceSources(): Promise<WorkerSourceInfo[]>;
  /** Get the workerd HTTP port (null if not running). */
  getPort(): Promise<number | null>;
  /** Restart all worker instances. */
  restartAll(): Promise<void>;
  /** Clone a DO's SQLite storage to a new object key. Returns the new DORef. */
  cloneDO(ref: DORefParam, newObjectKey: string): Promise<DORefParam>;
  /** Destroy a DO's SQLite storage (main + WAL/SHM files). */
  destroyDO(ref: DORefParam): Promise<void>;
}

export function createWorkerdClient(rpc: RpcCaller): WorkerdClient {
  const call = <T>(method: string, ...args: unknown[]) =>
    rpc.call<T>("main", `workerd.${method}`, ...args);

  return {
    create: (options) => call<WorkerInstanceInfo>("createInstance", options),
    destroy: (name) => call<void>("destroyInstance", name),
    update: (name, updates) => call<WorkerInstanceInfo>("updateInstance", name, updates),
    list: () => call<WorkerInstanceInfo[]>("listInstances"),
    status: (name) => call<WorkerInstanceInfo | null>("getInstanceStatus", name),
    listInstanceSources: () => call<WorkerSourceInfo[]>("listInstanceSources"),
    getPort: () => call<number | null>("getPort"),
    restartAll: () => call<void>("restartAll"),
    cloneDO: (ref, newObjectKey) => call<DORefParam>("cloneDO", ref, newObjectKey),
    destroyDO: (ref) => call<void>("destroyDO", ref),
  };
}
