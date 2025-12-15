/**
 * Unified runtime initialization for panels and workers.
 *
 * This module extracts common initialization logic to reduce duplication
 * between panel/index.ts and worker/index.ts.
 */

import { createRuntime, type FsProvider } from "./createRuntime.js";
import { createBootstrapState, runBootstrap, getBootstrapPromise } from "../shared/bootstrap.js";
import { getInjectedConfig, type InjectedConfig } from "../shared/globals.js";
import type { RuntimeFs, BootstrapResult } from "../types.js";
import type { RpcTransport } from "@natstack/rpc";

export interface InitRuntimeOptions {
  /** Function to create the RPC transport */
  createTransport: () => RpcTransport;
  /** Filesystem provider (direct RuntimeFs or factory) */
  fs: FsProvider;
  /** Promise that resolves when fs is ready (panel ZenFS), or undefined for workers */
  fsReady?: Promise<void>;
  /** Optional function to set up globals (worker console/env injection) */
  setupGlobals?: () => void;
}

export interface InitRuntimeResult {
  /** The initialized runtime */
  runtime: ReturnType<typeof createRuntime>;
  /** The parsed configuration from injected globals */
  config: InjectedConfig;
  /** The filesystem (resolved from provider) */
  fs: RuntimeFs;
  /** Promise that resolves when bootstrap completes, or null if no bootstrap needed */
  bootstrapPromise: Promise<BootstrapResult | null>;
}

/**
 * Initialize the runtime with common logic for both panels and workers.
 */
export function initRuntime(options: InitRuntimeOptions): InitRuntimeResult {
  const config = getInjectedConfig();

  // Apply globals setup if provided (worker console/env injection)
  options.setupGlobals?.();

  // Create bootstrap state - this will hold the promise once runBootstrap starts
  const bootstrapState = createBootstrapState();

  // Create a lazy bootstrap promise getter that returns the state's promise.
  // This allows us to pass the promise to createRuntime before runBootstrap sets it,
  // because createRuntime just stores it and consumers await it later.
  // We use getBootstrapPromise which returns a resolved null if bootstrap hasn't started.
  const getBootstrap = () => getBootstrapPromise(bootstrapState);

  // Create runtime - passes null for bootstrapPromise initially
  // We'll provide the actual promise via the runtime wrapper below
  const runtime = createRuntime({
    selfId: `${config.kind}:${config.id}`,
    createTransport: options.createTransport,
    id: config.id,
    parentId: config.parentId,
    initialTheme: config.initialTheme,
    fs: options.fs,
    setupGlobals: options.setupGlobals,
    gitConfig: config.gitConfig,
    pubsubConfig: config.pubsubConfig,
    // Pass a getter wrapper that defers to bootstrapState.promise
    bootstrapPromise: null,
  });

  // Start bootstrap after runtime creation (fs may be factory-created)
  if (config.gitConfig) {
    runBootstrap({
      fs: runtime.fs,
      gitConfig: config.gitConfig,
      state: bootstrapState,
      fsReady: options.fsReady,
      logPrefix: `[${config.kind === "panel" ? "Panel" : "Worker"} Bootstrap]`,
    });
  }

  // Create a wrapped runtime that provides the bootstrap promise from state
  const wrappedRuntime = Object.create(runtime, {
    bootstrapPromise: {
      get: getBootstrap,
      enumerable: true,
    },
  }) as typeof runtime;

  return {
    runtime: wrappedRuntime,
    config,
    fs: runtime.fs,
    bootstrapPromise: getBootstrap(),
  };
}
