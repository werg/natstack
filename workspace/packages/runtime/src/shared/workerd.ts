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
import {
  createDurableObjectServiceClient,
  type DORefParam,
  type DurableObjectServiceClient,
  type ResolvedDurableObjectTarget,
} from "@natstack/shared/userlandServiceRpc";

export {
  GAD_WORKSPACE_SERVICE_PROTOCOL,
  createDurableObjectServiceClient,
  createGadServiceClient,
  doTargetId,
  parseDoTargetId,
  resolveDurableObjectService,
} from "@natstack/shared/userlandServiceRpc";
export type {
  DORefParam,
  DurableObjectServiceClient,
  ResolvedDurableObjectTarget,
} from "@natstack/shared/userlandServiceRpc";

// ---------------------------------------------------------------------------
// Types (mirror server-side WorkerdManager types, minus internal fields)
// ---------------------------------------------------------------------------
// Worker→worker calls go through the RPC relay, not a live workerd capability,
// so there is no `service` binding — only serializable data bindings.
export type WorkerBindingDef = {
    type: "text";
    value: string;
} | {
    type: "json";
    value: unknown;
};
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
    /** Runtime entity id of the creating caller, when different from parentId. */
    parentEntityId?: string;
    /** Runtime kind of the creating caller. */
    parentKind?: "panel" | "worker" | "do";
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
    /** Parent panel/worker id injected into the worker runtime for getParent(). */
    parentId?: string;
    env: Record<string, string>;
    bindings: Record<string, WorkerBindingDef>;
    stateArgs?: Record<string, unknown>;
    buildKey?: string;
    /** Git ref this instance is built at. */
    ref?: string;
    parentEntityId?: string;
    parentKind?: "panel" | "worker" | "do";
    status: "building" | "starting" | "running" | "stopped" | "error";
}
export interface WorkerSourceInfo {
    name: string;
    source: string;
    title?: string;
}
export type UserlandServiceInfo = {
    name: string;
    title?: string;
    description?: string;
    protocols: string[];
    source: string;
} & ({
    kind: "durable-object";
    className: string;
    defaultObjectKey: string | null;
} | {
    kind: "worker";
    routePath: string;
});
export type ResolvedUserlandService = {
    name: string;
    title?: string;
    description?: string;
    protocols: string[];
    source: string;
} & ({
    kind: "durable-object";
    className: string;
    objectKey: string;
    targetId: string;
} | {
    kind: "worker";
    routePath: string;
    routeBasePath: string;
});
// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

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
  /** List manifest-declared userland services offered by worker packages. */
  listServices(): Promise<UserlandServiceInfo[]>;
  /** Resolve a manifest-declared userland service by name or protocol. */
  resolveService(query: string, objectKey?: string | null): Promise<ResolvedUserlandService>;
  /** Resolve a concrete Durable Object target and grant this caller relay access. */
  resolveDurableObject(
    source: string,
    className: string,
    objectKey: string,
  ): Promise<ResolvedDurableObjectTarget>;
  /** Resolve a Durable Object-backed service and call it through unified RPC. */
  durableObjectService(query: string, objectKey?: string | null): DurableObjectServiceClient;
  /** Get the workerd HTTP port (null if not running). */
  getPort(): Promise<number | null>;
  /** Restart all worker instances. */
  restartAll(): Promise<void>;
  /** Clone a DO's SQLite storage to a new object key. Returns the new DORef. */
  cloneDO(ref: DORefParam, newObjectKey: string): Promise<DORefParam>;
  /** Destroy a DO's SQLite storage (main + WAL/SHM files). */
  destroyDO(ref: DORefParam): Promise<void>;
}
export function createWorkerdClient(
  rpc: RpcCaller,
  parentDefaults?: Pick<WorkerCreateOptions, "parentId" | "parentEntityId" | "parentKind">
): WorkerdClient {
  const call = <T>(method: string, ...args: unknown[]) =>
    rpc.call<T>("main", `workerd.${method}`, args);
  const callWorkers = <T>(method: string, ...args: unknown[]) =>
    rpc.call<T>("main", `workers.${method}`, args);

  return {
    create: (options) =>
      call<WorkerInstanceInfo>("createInstance", {
        ...parentDefaults,
        ...options,
      }),
    destroy: (name) => call<void>("destroyInstance", name),
    update: (name, updates) => call<WorkerInstanceInfo>("updateInstance", name, updates),
    list: () => call<WorkerInstanceInfo[]>("listInstances"),
    status: (name) => call<WorkerInstanceInfo | null>("getInstanceStatus", name),
    listInstanceSources: () => call<WorkerSourceInfo[]>("listInstanceSources"),
    listServices: () => callWorkers<UserlandServiceInfo[]>("listServices"),
    resolveService: (query, objectKey) => callWorkers<ResolvedUserlandService>("resolveService", query, objectKey ?? null),
    resolveDurableObject: (source, className, objectKey) =>
      callWorkers<ResolvedDurableObjectTarget>("resolveDurableObject", source, className, objectKey),
    durableObjectService: (query, objectKey) => createDurableObjectServiceClient(rpc, query, objectKey),
    getPort: () => call<number | null>("getPort"),
    restartAll: () => call<void>("restartAll"),
    cloneDO: (ref, newObjectKey) => call<DORefParam>("cloneDO", ref, newObjectKey),
    destroyDO: (ref) => call<void>("destroyDO", ref),
  };
}
