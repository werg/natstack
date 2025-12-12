/**
 * Unified RPC bridge for workers.
 *
 * This module provides a single RPC API for workers to communicate with:
 * - Panels (via __rpcSend/forward)
 * - Other workers (via __rpcSend/forward)
 * - Main process (via __rpcSend to "main" target)
 *
 * All communication uses the same RpcMessage protocol (request/response/event).
 * The main process is just another RPC endpoint that workers can call.
 *
 * Usage:
 * ```typescript
 * import { rpc } from "@natstack/worker-runtime";
 *
 * // Call main process services
 * const data = await rpc.call("main", "fs.readFile", path);
 * const roles = await rpc.call("main", "ai.listRoles");
 *
 * // Call panels/workers
 * const result = await rpc.call("panel:abc", "doSomething", arg);
 *
 * // Expose methods (callable by panels, workers, or main)
 * rpc.expose({
 *   async processData(data) { return transformedData; }
 * });
 *
 * // Listen for events (from panels, workers, or main)
 * rpc.onEvent("ai:stream-chunk", (fromId, payload) => { ... });
 * ```
 */

import { createRpcBridge } from "@natstack/rpc";
import type { WorkerRpc } from "./types.js";
import type { RpcBridgeInternal } from "@natstack/rpc";
import { createWorkerTransport } from "./transport.js";

// Declare globals injected by utility process
declare const __workerId: string;
const internal = createRpcBridge({
  selfId: `worker:${__workerId}`,
  transport: createWorkerTransport(),
}) as RpcBridgeInternal;

export const rpc: WorkerRpc = internal;
