// Buffer polyfill for browser environments - must be first to ensure availability
// for any code that uses Buffer (including isomorphic-git via @natstack/git)
import { Buffer } from "buffer";
if (typeof globalThis.Buffer === "undefined") {
  globalThis.Buffer = Buffer;
}

import { createPanelTransport } from "./transport.js";
import { fs, fsReady } from "./fs.js"; // Conditional fs: Node.js for unsafe, ZenFS for safe
import { initRuntime } from "../setup/initRuntime.js";
export { decodeBase64, encodeBase64 } from "../shared/base64.js";
export type { BootstrapResult } from "../shared/bootstrap.js";

// Initialize runtime with panel-specific providers
const { runtime, config } = initRuntime({
  createTransport: createPanelTransport,
  fs,
  fsReady,
});

export * as Rpc from "../core/rpc.js";
export { z } from "../core/zod.js";
export { defineContract, noopParent } from "../core/defineContract.js";
export { buildChildLink } from "../core/childLinks.js";
export type * from "../core/types.js";
export type { Runtime } from "../setup/createRuntime.js";

export const id = config.id;
const gitConfig = config.gitConfig;
const pubsubConfig = config.pubsubConfig;

export const {
  parentId: runtimeParentId,
  rpc,
  db,
  parent,
  getParent,
  getParentWithContract,
  createChild,
  createBrowserChild,
  createChildWithContract,
  children,
  getChild,
  onChildAdded,
  onChildRemoved,
  onChildCreationError,
  removeChild,
  setTitle,
  close,
  getInfo,
  getTheme,
  onThemeChange,
  onFocus,
  expose,
  bootstrapPromise,
} = runtime;

export { runtimeParentId as parentId };

export { fs, fsReady, gitConfig, pubsubConfig };
