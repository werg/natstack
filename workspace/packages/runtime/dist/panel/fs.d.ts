/**
 * Filesystem provider backed by server-side RPC.
 *
 * Panel fs calls are routed to the server's fsService via RPC, which
 * operates on real files in per-context folders on disk.
 *
 * The Proxy pattern ensures panels can import `fs` before RPC is ready —
 * each call awaits the _ready promise which resolves once _initFsWithRpc
 * is called.
 */
import type { RuntimeFs } from "../types.js";
import type { RpcBridge } from "@natstack/rpc";
/**
 * Initialize the fs implementation with an RPC bridge.
 * Called once from initRuntime after the runtime is created.
 */
export declare function _initFsWithRpc(rpc: RpcBridge): void;
/**
 * Proxy-based fs that waits for RPC initialization on each call.
 * Ensures the correct implementation is used regardless of import timing.
 */
export declare const fs: RuntimeFs;
//# sourceMappingURL=fs.d.ts.map