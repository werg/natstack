// Buffer polyfill for browser environments - must be first to ensure availability
// for any code that uses Buffer (including isomorphic-git via @natstack/git)
import { Buffer } from "buffer";
if (typeof globalThis.Buffer === "undefined") {
  globalThis.Buffer = Buffer;
}

import { createPanelTransport } from "./transport.js";
import { fs } from "./fs.js"; // RPC-backed fs (server-side per-context folders)
import { initRuntime } from "../setup/initRuntime.js";
import { helpfulNamespace } from "../shared/helpfulNamespace.js";
export type { ThemeAppearance, RuntimeFs, FileStats, MkdirOptions, RmOptions } from "../types.js";

// Initialize runtime with panel-specific providers
const { runtime, config } = initRuntime({
  createTransport: createPanelTransport,
  fs,
});

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

const {
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

export {
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
  runtimeParentId as parentId,
};

const { workers } = runtime;
const helpfulWorkers = helpfulNamespace("workers", workers);
export { fs, gitConfig, pubsubConfig, env, helpfulWorkers as workers };

// Path utilities for cross-platform path handling
export { normalizePath, getFileName, resolvePath } from "../shared/pathUtils.js";

// State args API for panel state management
export { getStateArgs, useStateArgs, setStateArgs } from "./stateArgs.js";

// Browser panel API (external URL panels with CDP access)
import { _initBrowserBridge, openPanel as _openPanel } from "./browser.js";
_initBrowserBridge(rpc);
export { createBrowserPanel, openExternal, onChildCreated, getBrowserHandle, openPanel } from "./browser.js";
export type { BrowserHandle } from "./browser.js";

// Ad blocking programmatic interface
import { createAdBlockApi } from "./adblock.js";
export type { AdBlockStats, AdBlockApi } from "./adblock.js";
export const adblock = helpfulNamespace("adblock", createAdBlockApi(rpc));

// Workspace management.
//
// The panel variant of `workspace` extends the shared WorkspaceClient with
// `openPanel`, which is a panel-only operation (workers have no concept of
// opening a UI panel). Exposing it under `workspace.openPanel` matches the
// natural mental model — "opening a panel is a workspace operation" — and
// is the form most agentic eval code reaches for. Top-level `openPanel` is
// still exported separately for callers that prefer the flat form.
import { createWorkspaceClient, type WorkspaceClient } from "../shared/workspace.js";
export type { WorkspaceClient, WorkspaceEntry, WorkspaceConfig } from "../shared/workspace.js";
const workspaceClientBase = createWorkspaceClient(rpc);
const workspaceClient: WorkspaceClient & { openPanel: typeof _openPanel } =
  Object.assign(workspaceClientBase, { openPanel: _openPanel });
export const workspace = helpfulNamespace("workspace", workspaceClient);

// OAuth token management
import { createOAuthClient } from "./oauth.js";
export type { OAuthToken, OAuthConnection, OAuthClient, OAuthStartAuthResult, ConsentRecord } from "./oauth.js";
export const oauth = helpfulNamespace("oauth", createOAuthClient(rpc));

// Shell notifications
import { createNotificationClient } from "./notifications.js";
export type { NotificationClient } from "./notifications.js";
export const notifications = helpfulNamespace("notifications", createNotificationClient(rpc));
