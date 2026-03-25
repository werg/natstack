/**
 * Worker runtime entry point for workerd workers.
 *
 * Usage:
 * ```typescript
 * import { createWorkerRuntime } from "@workspace/runtime/worker";
 * import type { WorkerEnv } from "@workspace/runtime/worker";
 *
 * export default {
 *   async fetch(request: Request, env: WorkerEnv, ctx: ExecutionContext) {
 *     const runtime = createWorkerRuntime(env);
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

import { createRpcBridge, type RpcBridge } from "@natstack/rpc";
import { createDbClient } from "../shared/database.js";
import { createRpcFs } from "../shared/rpcFs.js";
import { createWorkerdClient, type WorkerdClient } from "../shared/workerd.js";
import { createWorkspaceClient, type WorkspaceClient } from "../shared/workspace.js";
import { createOAuthClient, type OAuthWorkerClient } from "../shared/oauth.js";
import { createWorkerWsTransport } from "./transport.js";
import type { WorkerEnv } from "./types.js";
import type { RuntimeFs, ThemeAppearance } from "../types.js";

export type { WorkerEnv, ExecutionContext } from "./types.js";
export type { OAuthToken, OAuthConnection, OAuthWorkerClient, OAuthStartAuthResult, ConsentRecord } from "../shared/oauth.js";
export { DurableObjectBase } from "./durable-base.js";
export type { DurableObjectContext, SqlStorage, SqlResult, DORef } from "./durable-base.js";
export { ServerDOClient } from "./server-client.js";
export { validateToken } from "./ws-auth.js";
export type { TokenValidationResult } from "./ws-auth.js";
// Note: createTestDO is intentionally NOT exported here — it depends on better-sqlite3
// which is a Node.js-only dependency that can't be bundled for workerd.
// Import directly from "@workspace/runtime/src/worker/durable-test-utils" in tests.

// Cache runtime per worker ID to avoid creating multiple connections
let cachedRuntime: WorkerRuntime | null = null;
let cachedWorkerId: string | null = null;

export interface WorkerRuntime {
  readonly id: string;
  readonly rpc: RpcBridge;
  readonly db: ReturnType<typeof createDbClient>;
  readonly fs: RuntimeFs;
  readonly workers: WorkerdClient;
  readonly workspace: WorkspaceClient;
  readonly oauth: OAuthWorkerClient;
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
  onConnectionError(callback: (error: { code: number; reason: string }) => void): () => void;
  destroy(): void;
}

/**
 * Create or retrieve the worker runtime for the given environment.
 *
 * The runtime is cached per worker instance (same WORKER_ID returns same runtime).
 * This is important because workerd may call fetch() multiple times on the same
 * isolate, and we want to reuse the WebSocket connection.
 */
export function createWorkerRuntime(env: WorkerEnv): WorkerRuntime {
  const workerId = env.WORKER_ID;

  // Return cached runtime if same worker
  if (cachedRuntime && cachedWorkerId === workerId) {
    return cachedRuntime;
  }

  // Workers use a single WS transport with one bridge — no routing needed
  const transport = createWorkerWsTransport({
    wsUrl: env.RPC_WS_URL,
    authToken: env.RPC_AUTH_TOKEN,
    workerId,
  });

  const selfId = `worker:${workerId}`;
  const rpc = createRpcBridge({ selfId, transport });
  const fs = createRpcFs(rpc);
  const db = createDbClient(rpc);
  const workers = createWorkerdClient(rpc);
  const workspaceApi = createWorkspaceClient(rpc);
  const oauth = createOAuthClient(rpc);

  const callMain = <T>(method: string, ...args: unknown[]) =>
    rpc.call<T>("main", method, ...args);

  const eventUnsubs: Array<() => void> = [];

  const onConnectionError = (
    callback: (error: { code: number; reason: string }) => void
  ): (() => void) => {
    const unsub = rpc.onEvent("runtime:connection-error", (fromId: string, payload: unknown) => {
      if (fromId !== "main") return;
      const data = payload as { code?: unknown; reason?: unknown } | null;
      if (!data || typeof data.code !== "number" || typeof data.reason !== "string") return;
      callback({ code: data.code, reason: data.reason });
    });
    eventUnsubs.push(unsub);
    return unsub;
  };

  const runtime: WorkerRuntime = {
    id: workerId,
    rpc,
    db,
    fs,
    workers,
    workspace: workspaceApi,
    oauth,
    contextId: env.CONTEXT_ID,
    gitConfig: null,
    pubsubConfig: null,

    callMain,
    getWorkspaceTree: () => callMain<unknown>("bridge.getWorkspaceTree"),
    listBranches: (repoPath: string) => callMain<unknown[]>("bridge.listBranches", repoPath),
    listCommits: (repoPath: string, ref?: string, limit?: number) =>
      callMain<unknown[]>("bridge.listCommits", repoPath, ref, limit),
    exposeMethod: rpc.exposeMethod.bind(rpc),
    onConnectionError,
    destroy: () => {
      for (const unsub of eventUnsubs) unsub();
      eventUnsubs.length = 0;
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
