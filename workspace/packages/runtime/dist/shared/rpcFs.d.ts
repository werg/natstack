/**
 * RPC-backed RuntimeFs implementation.
 *
 * Each method calls rpc.call<T>("main", "fs.{method}", ...args).
 * Binary data is encoded as { __bin: true, data: base64String } for JSON transport.
 *
 * Shared between panels and workers — no Node.js or browser-specific dependencies.
 */
import type { RpcBridge } from "@natstack/rpc";
import type { RuntimeFs } from "../types.js";
export declare function createRpcFs(rpc: RpcBridge): RuntimeFs;
//# sourceMappingURL=rpcFs.d.ts.map