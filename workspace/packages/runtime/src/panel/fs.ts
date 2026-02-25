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
import { createRpcFs } from "./rpcFs.js";

let _fs: RuntimeFs | null = null;
let _resolve: (() => void) | null = null;
const _ready = new Promise<void>((r) => {
  _resolve = r;
});

/**
 * Initialize the fs implementation with an RPC bridge.
 * Called once from initRuntime after the runtime is created.
 */
export function _initFsWithRpc(rpc: RpcBridge): void {
  _fs = createRpcFs(rpc);
  _resolve?.();
}

/**
 * Promise that resolves when fs is ready (RPC connected).
 */
export const fsReady: Promise<void> = _ready;

/**
 * Proxy-based fs that waits for RPC initialization on each call.
 * Ensures the correct implementation is used regardless of import timing.
 */
export const fs: RuntimeFs = new Proxy({} as RuntimeFs, {
  get(_target, prop: string | symbol) {
    // Prevent the proxy from being treated as a thenable (e.g. `await fs`)
    if (prop === "then" || typeof prop === "symbol") return undefined;
    return async (...args: unknown[]) => {
      await _ready;
      if (!_fs) throw new Error("[NatStack] Filesystem not initialized");
      const method = (_fs as any)[prop] as (...args: unknown[]) => Promise<unknown>;
      return method.apply(_fs, args);
    };
  },
});
