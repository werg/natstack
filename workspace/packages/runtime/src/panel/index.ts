// Buffer polyfill for browser environments - must be first to ensure availability
// for any code that uses Buffer (including isomorphic-git via @natstack/git)
import { Buffer } from "buffer";
if (typeof globalThis.Buffer === "undefined") {
  globalThis.Buffer = Buffer;
}

import { createPanelTransport, createServerTransport } from "./transport.js";
import { fs } from "./fs.js"; // RPC-backed fs (server-side per-context folders)
import { initRuntime } from "../setup/initRuntime.js";
export type { ThemeAppearance, RuntimeFs, FileStats, MkdirOptions, RmOptions } from "../types.js";

// Initialize runtime with panel-specific providers
const { runtime, config } = initRuntime({
  createTransport: createPanelTransport,
  createServerTransport,
  fs,
});

import { createAiClient, type AiClient } from "@natstack/ai";

// Create AI client with the runtime's RPC bridge, scoped to this panel's context
const aiClient: AiClient = createAiClient(runtime.rpc, runtime.contextId);

export * as Rpc from "../core/rpc.js";
export { z } from "../core/zod.js";
export { defineContract, noopParent } from "../core/defineContract.js";
export { buildPanelLink, contextIdToSubdomain } from "../core/panelLinks.js";
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
  onConnectionError,
  getInfo,
  closeSelf,
  focusPanel,
  getWorkspaceTree,
  listBranches,
  listCommits,
  getTheme,
  onThemeChange,
  onFocus,
  exposeMethod,
  contextId,
} = runtime;

export { runtimeParentId as parentId };

const { workers } = runtime;
export { fs, gitConfig, pubsubConfig, env, workers, aiClient as ai };

// Path utilities for cross-platform path handling
export { normalizePath, getFileName, resolvePath } from "../shared/pathUtils.js";

// State args API for panel state management
export { getStateArgs, useStateArgs, setStateArgs } from "./stateArgs.js";

// Browser panel API (external URL panels with CDP access)
import { _initBrowserBridge } from "./browser.js";
_initBrowserBridge(rpc);
export { createBrowserPanel, openExternal, onChildCreated, getBrowserHandle, openPanel } from "./browser.js";
export type { BrowserHandle } from "./browser.js";

// Ad blocking programmatic interface
import { createAdBlockApi } from "./adblock.js";
export type { AdBlockStats, AdBlockApi } from "./adblock.js";
export const adblock = createAdBlockApi(rpc);

// Workspace management
import { createWorkspaceClient } from "../shared/workspace.js";
export type { WorkspaceClient, WorkspaceEntry, WorkspaceConfig } from "../shared/workspace.js";
const workspaceClient = createWorkspaceClient(rpc);
export { workspaceClient as workspace };
