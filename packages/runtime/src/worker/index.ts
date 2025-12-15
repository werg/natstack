import { createWorkerTransport } from "./transport.js";
import { setupWorkerGlobals } from "./globals.js";
import { createWorkerFs } from "./fs.js";
import { createWorkerFetch } from "./fetch.js";
import { initRuntime } from "../setup/initRuntime.js";
export { decodeBase64, encodeBase64 } from "../shared/base64.js";
export type { BootstrapResult } from "../shared/bootstrap.js";

// Initialize runtime with worker-specific providers
const { runtime, config } = initRuntime({
  createTransport: createWorkerTransport,
  fs: createWorkerFs,
  fetch: createWorkerFetch,
  setupGlobals: setupWorkerGlobals,
});

export * as Rpc from "../core/rpc.js";
export { z } from "../core/zod.js";
export { defineContract, noopParent } from "../core/defineContract.js";
export type * from "../core/types.js";
export type { Runtime } from "../setup/createRuntime.js";

export const id = config.id;

export const {
  parentId,
  rpc,
  db,
  fs,
  fetch,
  parent,
  getParent,
  getParentWithContract,
  createChild,
  createChildWithContract,
  children,
  getChild,
  onChildAdded,
  onChildRemoved,
  removeChild,
  setTitle,
  close,
  getEnv,
  getInfo,
  getTheme,
  onThemeChange,
  onFocus,
  expose,
  gitConfig: exportedGitConfig,
  pubsubConfig: exportedPubsubConfig,
  bootstrapPromise,
} = runtime;

// Re-export gitConfig and pubsubConfig (same values as module-level, just from runtime)
export { exportedGitConfig as gitConfig, exportedPubsubConfig as pubsubConfig };

// For API compatibility with panels: workers don't need fsReady (RPC is ready immediately),
// but we export it as a resolved promise so userland code can use the same pattern.
export const fsReady: Promise<void> = Promise.resolve();
