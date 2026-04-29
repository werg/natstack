/**
 * Worker runtime entry point for workerd workers.
 *
 * Usage:
 * ```typescript
 * import { createWorkerRuntime, handleWorkerRpc } from "@workspace/runtime/worker";
 * import type { WorkerEnv } from "@workspace/runtime/worker";
 *
 * export default {
 *   async fetch(request: Request, env: WorkerEnv, ctx: ExecutionContext) {
 *     const runtime = createWorkerRuntime(env);
 *
 *     // Handle incoming RPC calls from other callers
 *     const rpcResponse = handleWorkerRpc(runtime, request);
 *     if (rpcResponse) return rpcResponse;
 *
 *     const content = await runtime.fs.readFile("/src/index.ts", "utf8");
 *     return new Response(content);
 *   },
 * };
 * ```
 */

// Buffer polyfill for non-Node environments
import { Buffer } from "buffer";
if (typeof globalThis.Buffer === "undefined") {
  (globalThis as any).Buffer = Buffer;
}

import type { RpcBridge } from "@natstack/rpc";
import { createHttpRpcBridge } from "../shared/httpRpcBridge.js";
import { createDbClient } from "../shared/database.js";
import { createRpcFs } from "../shared/rpcFs.js";
import { createCredentialClient, type CredentialClient } from "../shared/credentials.js";
import { createWorkerdClient, type WorkerdClient } from "../shared/workerd.js";
import { createWorkspaceClient, type WorkspaceClient } from "../shared/workspace.js";
import { createNotificationClient, type NotificationClient } from "../shared/notifications.js";
import { createParentHandle } from "../shared/handles.js";
import { helpfulNamespace } from "../shared/helpfulNamespace.js";
import type { ParentHandle } from "../core/index.js";
import type { WorkerEnv } from "./types.js";
import type { RuntimeFs } from "../types.js";

export type { WorkerEnv, ExecutionContext } from "./types.js";
export type {
  CredentialClient,
  StoredCredentialSummary,
  StoreUrlBoundCredentialRequest,
  BeginOAuthPkceCredentialResult,
  CompleteOAuthPkceCredentialRequest,
  CreateOAuthPkceCredentialRequest,
} from "../shared/credentials.js";
export type { NotificationClient } from "../shared/notifications.js";
export { DurableObjectBase } from "./durable-base.js";
export type { DurableObjectContext, SqlStorage, SqlResult, DORef } from "./durable-base.js";
// Note: createTestDO is intentionally NOT exported here — it depends on better-sqlite3
// which is a Node.js-only dependency that can't be bundled for workerd.
// Import directly from "@workspace/runtime/src/worker/durable-test-utils" in tests.

// Cache runtime per worker ID to avoid creating multiple bridges
let cachedRuntime: WorkerRuntime | null = null;
let cachedWorkerId: string | null = null;

export interface WorkerRuntime {
  readonly id: string;
  readonly rpc: RpcBridge;
  readonly db: ReturnType<typeof createDbClient>;
  readonly fs: RuntimeFs;
  readonly workers: WorkerdClient;
  readonly workspace: WorkspaceClient;
  readonly credentials: CredentialClient;
  readonly notifications: NotificationClient;
  readonly contextId: string;
  readonly gitConfig: null;
  readonly pubsubConfig: null;

  /** Call a server-side service method via RPC. */
  callMain<T>(method: string, ...args: unknown[]): Promise<T>;
  getWorkspaceTree(): Promise<unknown>;
  listBranches(repoPath: string): Promise<unknown[]>;
  listCommits(repoPath: string, ref?: string, limit?: number): Promise<unknown[]>;
  /** Expose a method callable by other callers (panels, workers, server). */
  exposeMethod: RpcBridge["exposeMethod"];
  /** Get a handle to the parent panel/worker (null if no parent). */
  getParent(): ParentHandle | null;
  /** Handle an incoming RPC POST body, returning the response payload. */
  handleRpcPost(body: unknown): Promise<unknown>;
  destroy(): void;
}

/**
 * Create or retrieve the worker runtime for the given environment.
 *
 * The runtime is cached per worker instance (same WORKER_ID returns same runtime).
 * This is important because workerd may call fetch() multiple times on the same
 * isolate, and we want to reuse the HTTP RPC bridge.
 */
export function createWorkerRuntime(env: WorkerEnv): WorkerRuntime {
  const workerId = env.WORKER_ID;

  // Return cached runtime if same worker
  if (cachedRuntime && cachedWorkerId === workerId) {
    return cachedRuntime;
  }

  const serverUrl = env.SERVER_URL;
  if (!serverUrl) {
    throw new Error("Worker env must provide SERVER_URL");
  }

  const selfId = `worker:${workerId}`;
  const rpc = createHttpRpcBridge({
    selfId,
    serverUrl,
    authToken: env.RPC_AUTH_TOKEN,
  });

  const fs = createRpcFs(rpc);
  const db = createDbClient(rpc);
  const workers = helpfulNamespace("workers", createWorkerdClient(rpc));
  const workspaceApi = helpfulNamespace("workspace", createWorkspaceClient(rpc));
  const credentials = helpfulNamespace("credentials", createCredentialClient(rpc));
  const notifications = helpfulNamespace("notifications", createNotificationClient(rpc));

  const parentId = (env.PARENT_ID as string) || null;

  const callMain = <T>(method: string, ...args: unknown[]) =>
    rpc.call<T>("main", method, ...args);

  const runtime: WorkerRuntime = {
    id: workerId,
    rpc,
    db,
    fs,
    workers,
    workspace: workspaceApi,
    credentials,
    notifications,
    contextId: env.CONTEXT_ID,
    gitConfig: null,
    pubsubConfig: null,

    callMain,
    getWorkspaceTree: () => callMain<unknown>("git.getWorkspaceTree"),
    listBranches: (repoPath: string) => callMain<unknown[]>("git.listBranches", repoPath),
    listCommits: (repoPath: string, ref?: string, limit?: number) =>
      callMain<unknown[]>("git.listCommits", repoPath, ref, limit),
    exposeMethod: rpc.exposeMethod.bind(rpc),
    getParent: () => createParentHandle({ rpc, parentId }),
    handleRpcPost: (body: unknown) => rpc.handleIncomingPost(body),
    destroy: () => {
      if (cachedWorkerId === workerId) {
        cachedRuntime = null;
        cachedWorkerId = null;
      }
    },
  };

  cachedRuntime = runtime;
  cachedWorkerId = workerId;

  return runtime;
}

/**
 * Handle incoming RPC POST requests for a worker.
 *
 * Workers must wire this into their fetch handler so that the server
 * (or other callers) can invoke methods exposed via `runtime.exposeMethod()`.
 *
 * @returns A Response promise if the request is an RPC call, or null if not.
 */
export function handleWorkerRpc(runtime: WorkerRuntime, request: Request): Promise<Response> | null {
  const url = new URL(request.url);
  if (url.pathname.endsWith("/__rpc") && request.method === "POST") {
    return (async () => {
      const body = await request.json();
      const result = await runtime.handleRpcPost(body);
      return new Response(JSON.stringify(result), {
        headers: { "Content-Type": "application/json" },
      });
    })();
  }
  return null;
}
