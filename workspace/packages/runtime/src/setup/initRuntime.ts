/**
 * Runtime initialization for panels.
 *
 * Panels run in WebContentsView with browser environment.
 */

import { createRuntime } from "./createRuntime.js";
import { getInjectedConfig, type InjectedConfig } from "../shared/globals.js";
import type { RuntimeFs } from "../types.js";
import type { RpcTransport } from "@natstack/rpc";
import { _initFsWithRpc } from "../panel/fs.js";

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
export function initRuntime(options: InitRuntimeOptions): InitRuntimeResult {
  const config = getInjectedConfig();

  // Apply globals setup if provided
  options.setupGlobals?.();

  const runtime = createRuntime({
    selfId: `${config.kind}:${config.id}`,
    createTransport: options.createTransport,
    createServerTransport: options.createServerTransport,
    id: config.id,
    contextId: config.contextId,
    parentId: config.parentId,
    initialTheme: config.initialTheme,
    fs: options.fs,
    setupGlobals: options.setupGlobals,
    gitConfig: config.gitConfig,
    pubsubConfig: config.pubsubConfig,
  });

  // Initialize RPC-backed fs with the runtime's RPC bridge
  _initFsWithRpc(runtime.rpc);

  return {
    runtime,
    config,
    fs: runtime.fs,
  };
}
