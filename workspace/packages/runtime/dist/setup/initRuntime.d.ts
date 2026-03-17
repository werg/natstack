/**
 * Runtime initialization for panels.
 *
 * Panels run in WebContentsView with browser environment.
 */
import { createRuntime } from "./createRuntime.js";
import { type InjectedConfig } from "../shared/globals.js";
import type { RuntimeFs } from "../types.js";
import type { RpcTransport } from "@natstack/rpc";
export interface InitRuntimeOptions {
    /** Function to create the RPC transport */
    createTransport: () => RpcTransport;
    /** Function to create the server RPC transport (direct panel→server) */
    createServerTransport?: () => RpcTransport | null;
    /** Filesystem implementation (RPC-backed proxy) */
    fs: RuntimeFs;
    /** Optional function to set up globals before runtime initialization */
    setupGlobals?: () => void;
}
export interface InitRuntimeResult {
    /** The initialized runtime */
    runtime: ReturnType<typeof createRuntime>;
    /** The parsed configuration from injected globals */
    config: InjectedConfig;
    /** The filesystem (resolved from provider) */
    fs: RuntimeFs;
}
/**
 * Initialize the runtime with common logic for both panels and workers.
 */
export declare function initRuntime(options: InitRuntimeOptions): InitRuntimeResult;
//# sourceMappingURL=initRuntime.d.ts.map