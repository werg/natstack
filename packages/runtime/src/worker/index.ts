import { createWorkerTransport } from "./transport.js";
import { setupWorkerGlobals } from "./globals.js";
import { initRuntime } from "../setup/initRuntime.js";
import { createWorkerFsFromNodeFs } from "./fs.js";
// Import "fs" - this is intercepted at build time by the scoped fs shim plugin
// Workers get a scoped fs implementation that constrains paths to __natstackFsRoot
import * as nodeFs from "fs";
export { decodeBase64, encodeBase64 } from "../shared/base64.js";
export type { BootstrapResult } from "../shared/bootstrap.js";

// Create RuntimeFs from Node.js fs module (scoped by build-time shim)
const scopedFs = createWorkerFsFromNodeFs(nodeFs);

// Initialize runtime with worker-specific providers
const { runtime, config } = initRuntime({
  createTransport: createWorkerTransport,
  fs: scopedFs,
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
