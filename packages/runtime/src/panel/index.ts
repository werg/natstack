// Buffer polyfill for browser environments - must be first to ensure availability
// for any code that uses Buffer (including isomorphic-git via @natstack/git)
import { Buffer } from "buffer";
if (typeof globalThis.Buffer === "undefined") {
  globalThis.Buffer = Buffer;
}

import { createPanelTransport } from "./transport.js";
import { fs, fsReady } from "./fs.js"; // Conditional fs: Node.js for unsafe, ZenFS for safe
import { initRuntime } from "../setup/initRuntime.js";
export type { BootstrapResult } from "../shared/bootstrap.js";

// Initialize runtime with panel-specific providers
const { runtime, config } = initRuntime({
  createTransport: createPanelTransport,
  fs,
  fsReady,
});

// Configure dependency injection for shared packages
// These packages use injection to avoid circular dependencies with runtime
import { setDbOpen } from "@natstack/agentic-messaging";
import { setRpc } from "@natstack/ai";

// Inject db opener for agentic-messaging (session persistence, etc.)
setDbOpen(runtime.db.open);

// Inject RPC bridge for AI package (streaming, tool execution, etc.)
setRpc(runtime.rpc);

export * as Rpc from "../core/rpc.js";
export { z } from "../core/zod.js";
export { defineContract, noopParent } from "../core/defineContract.js";
export { buildNsLink, buildAboutLink, buildFocusLink } from "../core/nsLinks.js";
export {
  parseContextId,
  isValidContextId,
  isSafeContext,
  isUnsafeContext,
  getTemplateSpecHash,
  getInstanceId,
} from "../core/context.js";
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
  getInfo,
  closeSelf,
  unloadSelf,
  forceRepaint,
  ensurePanelLoaded,
  getWorkspaceTree,
  listBranches,
  listCommits,
  getTheme,
  onThemeChange,
  onFocus,
  exposeMethod,
  bootstrapPromise,
  contextId,
} = runtime;

export { runtimeParentId as parentId };

export { fs, fsReady, gitConfig, pubsubConfig };

// Path utilities for cross-platform path handling
export { normalizePath, getFileName, resolvePath } from "../shared/pathUtils.js";

// State args API for panel state management
export { getStateArgs, useStateArgs, setStateArgs } from "./stateArgs.js";

// Ad blocking programmatic interface
import { createAdBlockApi } from "./adblock.js";
export type { AdBlockStats, AdBlockApi } from "./adblock.js";
export const adblock = createAdBlockApi(rpc);
