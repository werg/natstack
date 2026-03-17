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
import { type RpcBridge } from "@natstack/rpc";
import { createDbClient } from "../shared/database.js";
import { type WorkerdClient } from "../shared/workerd.js";
import { type WorkspaceClient } from "../shared/workspace.js";
import type { WorkerEnv } from "./types.js";
import type { RuntimeFs } from "../types.js";
export type { WorkerEnv, ExecutionContext } from "./types.js";
export { DurableObjectBase } from "./durable-base.js";
export type { DurableObjectContext, SqlStorage, SqlResult, DORef } from "./durable-base.js";
export { ServerDOClient } from "./server-client.js";
export { validateToken } from "./ws-auth.js";
export type { TokenValidationResult } from "./ws-auth.js";
export interface WorkerRuntime {
    readonly id: string;
    readonly rpc: RpcBridge;
    readonly db: ReturnType<typeof createDbClient>;
    readonly fs: RuntimeFs;
    readonly workers: WorkerdClient;
    readonly workspace: WorkspaceClient;
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
    onConnectionError(callback: (error: {
        code: number;
        reason: string;
    }) => void): () => void;
    destroy(): void;
}
/**
 * Create or retrieve the worker runtime for the given environment.
 *
 * The runtime is cached per worker instance (same WORKER_ID returns same runtime).
 * This is important because workerd may call fetch() multiple times on the same
 * isolate, and we want to reuse the WebSocket connection.
 */
export declare function createWorkerRuntime(env: WorkerEnv): WorkerRuntime;
//# sourceMappingURL=index.d.ts.map