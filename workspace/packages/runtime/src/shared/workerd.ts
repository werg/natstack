/**
 * Typed client for the workerd RPC service.
 *
 * Worker instance lifecycle is launched via `runtime.createEntity({kind:"worker"})`
 * and retired via `runtime.retireEntity({id})` — there is no `workerd.*` lifecycle
 * client anymore. What remains here are manifest-declared userland service
 * resolution (`listServices`/`resolveService`/`resolveDurableObject`/
 * `durableObjectService`) and the fork/storage DO primitives (`cloneDO`/`destroyDO`).
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
// Types
// ---------------------------------------------------------------------------
export type UserlandServiceInfo = {
  name: string;
  title?: string;
  description?: string;
  protocols: string[];
  source: string;
} & (
  | {
      kind: "durable-object";
      className: string;
      defaultObjectKey: string | null;
    }
  | {
      kind: "worker";
      routePath: string;
    }
);
export type ResolvedUserlandService = {
  name: string;
  title?: string;
  description?: string;
  protocols: string[];
  source: string;
} & (
  | {
      kind: "durable-object";
      className: string;
      objectKey: string;
      targetId: string;
    }
  | {
      kind: "worker";
      routePath: string;
      routeBasePath: string;
    }
);
// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export interface WorkerdClient {
  /** List manifest-declared userland services offered by worker packages. */
  listServices(): Promise<UserlandServiceInfo[]>;
  /** Resolve a manifest-declared userland service by name or protocol. */
  resolveService(query: string, objectKey?: string | null): Promise<ResolvedUserlandService>;
  /** Resolve a concrete Durable Object target and grant this caller relay access. */
  resolveDurableObject(
    source: string,
    className: string,
    objectKey: string
  ): Promise<ResolvedDurableObjectTarget>;
  /** Resolve a Durable Object-backed service and call it through unified RPC. */
  durableObjectService(query: string, objectKey?: string | null): DurableObjectServiceClient;
  /** Clone a DO's SQLite storage to a new object key. Returns the new DORef. */
  cloneDO(ref: DORefParam, newObjectKey: string): Promise<DORefParam>;
  /** Destroy a DO's SQLite storage (main + WAL/SHM files). */
  destroyDO(ref: DORefParam): Promise<void>;
}
export function createWorkerdClient(rpc: RpcCaller): WorkerdClient {
  const call = <T>(method: string, ...args: unknown[]) =>
    rpc.call<T>("main", `workerd.${method}`, args);
  const callWorkers = <T>(method: string, ...args: unknown[]) =>
    rpc.call<T>("main", `workers.${method}`, args);

  return {
    listServices: () => callWorkers<UserlandServiceInfo[]>("listServices"),
    resolveService: (query, objectKey) =>
      callWorkers<ResolvedUserlandService>("resolveService", query, objectKey ?? null),
    resolveDurableObject: (source, className, objectKey) =>
      callWorkers<ResolvedDurableObjectTarget>(
        "resolveDurableObject",
        source,
        className,
        objectKey
      ),
    durableObjectService: (query, objectKey) =>
      createDurableObjectServiceClient(rpc, query, objectKey),
    cloneDO: (ref, newObjectKey) => call<DORefParam>("cloneDO", ref, newObjectKey),
    destroyDO: (ref) => call<void>("destroyDO", ref),
  };
}
