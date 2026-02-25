// Buffer polyfill for browser environments - must be first to ensure availability
// for any code that uses Buffer (including isomorphic-git via @natstack/git)
import { Buffer } from "buffer";
if (typeof globalThis.Buffer === "undefined") {
  globalThis.Buffer = Buffer;
}

import { createPanelTransport, createServerTransport } from "./transport.js";
import { fs, fsReady } from "./fs.js"; // RPC-backed fs (server-side per-context folders)
import { initRuntime } from "../setup/initRuntime.js";
export type { BootstrapResult } from "../shared/bootstrap.js";
export type { ThemeAppearance, RuntimeFs, FileStats, MkdirOptions, RmOptions } from "../types.js";

// Initialize runtime with panel-specific providers
const { runtime, config } = initRuntime({
  createTransport: createPanelTransport,
  createServerTransport,
  fs,
  fsReady,
});

// Configure dependency injection for shared packages
import { setDbOpen } from "@workspace/agentic-messaging";
import { createAiClient, type AiClient } from "@natstack/ai";

// Inject db opener for agentic-messaging (session persistence, etc.)
setDbOpen(runtime.db.open);

// Create AI client with the runtime's RPC bridge
const aiClient: AiClient = createAiClient(runtime.rpc);

export * as Rpc from "../core/rpc.js";
export { z } from "../core/zod.js";
export { defineContract, noopParent } from "../core/defineContract.js";
export { buildNsLink, buildAboutLink, buildFocusLink } from "../core/nsLinks.js";
export {
  parseContextId,
  isValidContextId,
  getInstanceId,
} from "../core/context.js";
export type * from "../core/types.js";
export type { Runtime } from "../setup/createRuntime.js";

export const id = config.id;
const gitConfig = config.gitConfig;
const pubsubConfig = config.pubsubConfig;
const env = config.env;

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
  onConnectionError,
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

export { fs, fsReady, gitConfig, pubsubConfig, env, aiClient as ai };

// Path utilities for cross-platform path handling
export { normalizePath, getFileName, resolvePath } from "../shared/pathUtils.js";

// State args API for panel state management
export { getStateArgs, useStateArgs, setStateArgs } from "./stateArgs.js";

// Ad blocking programmatic interface
import { createAdBlockApi } from "./adblock.js";
export type { AdBlockStats, AdBlockApi } from "./adblock.js";
export const adblock = createAdBlockApi(rpc);
