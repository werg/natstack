/**
 * Shared utilities for preload scripts.
 *
 * This module provides unified initialization for both safe and unsafe preloads,
 * extracting common parsing, registration, and global setup logic.
 */

import { ipcRenderer } from "electron";
import { PANEL_ENV_ARG_PREFIX } from "../common/panelEnv.js";
import { createTransportBridge } from "./transport.js";

// =============================================================================
// Global type declarations for NatStack runtime
// =============================================================================

declare global {
  var __natstackTransport:
    | {
        send: (targetId: string, message: unknown) => Promise<void>;
        onMessage: (handler: (fromId: string, message: unknown) => void) => () => void;
      }
    | undefined;
  var __natstackContextId: string | undefined;
  var __natstackStateArgs: Record<string, unknown> | undefined;
}

// =============================================================================
// Constants for preload argument parsing
// =============================================================================

/** Argument prefix for panel/worker ID */
export const ARG_PANEL_ID = "--natstack-panel-id=";

/** Argument prefix for auth token */
export const ARG_AUTH_TOKEN = "--natstack-auth-token=";

/** Argument prefix for theme */
export const ARG_THEME = "--natstack-theme=";

/** Argument prefix for scope path (unsafe mode) */
export const ARG_SCOPE_PATH = "--natstack-scope-path=";

/** Argument prefix for kind (panel or worker) */
export const ARG_KIND = "--natstack-kind=";

/** Argument prefix for context ID */
export const ARG_CONTEXT_ID = "--natstack-context-id=";

/** Argument prefix for state args (base64 encoded JSON) */
export const ARG_STATE_ARGS = "--natstack-state-args=";

// =============================================================================
// Environment variable keys
// =============================================================================

/** Parent panel ID in synthetic env */
export const ENV_KEY_PARENT_ID = "PARENT_ID";

/** Git config JSON in synthetic env */
export const ENV_KEY_GIT_CONFIG = "__GIT_CONFIG";

/** PubSub config JSON in synthetic env */
export const ENV_KEY_PUBSUB_CONFIG = "__PUBSUB_CONFIG";

// =============================================================================
// Types
// =============================================================================

export interface GitConfig {
  serverUrl: string;
  token: string;
  sourceRepo: string;
  gitRef?: string;
  resolvedRepoArgs: Record<string, unknown>;
}

export interface PubSubConfig {
  serverUrl: string;
  token: string;
}

export interface ParsedPreloadConfig {
  panelId: string;
  contextId: string;
  kind: NatstackKind;
  authToken: string | undefined;
  initialTheme: "light" | "dark";
  scopePath: string | null;
  syntheticEnv: Record<string, string>;
  parentId: string | null;
  gitConfig: GitConfig | null;
  pubsubConfig: PubSubConfig | null;
  stateArgs: Record<string, unknown>;
}

export type NatstackKind = "panel" | "worker" | "shell";

// =============================================================================
// Parsing functions
// =============================================================================

export function parsePanelId(): string | null {
  const arg = process.argv.find((value) => value.startsWith(ARG_PANEL_ID));
  return arg ? (arg.split("=")[1] ?? null) : null;
}

export function parseAuthToken(): string | undefined {
  const arg = process.argv.find((value) => value.startsWith(ARG_AUTH_TOKEN));
  return arg ? arg.split("=")[1] : undefined;
}

export function parseTheme(): "light" | "dark" {
  const arg = process.argv.find((value) => value.startsWith(ARG_THEME));
  const theme = arg?.split("=")[1];
  return theme === "dark" ? "dark" : "light";
}

export function parseScopePath(): string | null {
  const arg = process.argv.find((value) => value.startsWith(ARG_SCOPE_PATH));
  return arg ? (arg.split("=")[1] ?? null) : null;
}

export function parseKind(): NatstackKind {
  const arg = process.argv.find((value) => value.startsWith(ARG_KIND));
  const kind = arg?.split("=")[1];
  if (kind === "worker") return "worker";
  if (kind === "shell") return "shell";
  return "panel";
}

export function parseContextId(): string {
  const arg = process.argv.find((value) => value.startsWith(ARG_CONTEXT_ID));
  return arg ? (arg.split("=")[1] ?? "") : "";
}

export function parseStateArgs(): Record<string, unknown> {
  const arg = process.argv.find((value) => value.startsWith(ARG_STATE_ARGS));
  if (!arg) return {};

  const encoded = arg.slice(ARG_STATE_ARGS.length);
  try {
    const decoded = Buffer.from(encoded, "base64").toString("utf-8");
    return JSON.parse(decoded) as Record<string, unknown>;
  } catch (error) {
    console.error("Failed to parse stateArgs payload", error);
    return {};
  }
}

export function parseEnvArg(): Record<string, string> {
  const arg = process.argv.find((value) => value.startsWith(PANEL_ENV_ARG_PREFIX));
  if (!arg) return {};

  const encoded = arg.slice(PANEL_ENV_ARG_PREFIX.length);
  try {
    const decoded = Buffer.from(encoded, "base64").toString("utf-8");
    const parsed = JSON.parse(decoded) as Record<string, unknown>;
    const sanitizedEntries = Object.entries(parsed ?? {}).filter(
      ([key, value]) => typeof key === "string" && typeof value === "string"
    ) as Array<[string, string]>;
    return Object.fromEntries(sanitizedEntries);
  } catch (error) {
    console.error("Failed to parse env payload", error);
    return {};
  }
}

export function parseGitConfig(env: Record<string, string>): GitConfig | null {
  const configStr = env[ENV_KEY_GIT_CONFIG];
  if (!configStr) return null;
  try {
    return JSON.parse(configStr) as GitConfig;
  } catch {
    console.error("[Preload] Failed to parse git config from env");
    return null;
  }
}

export function parsePubSubConfig(env: Record<string, string>): PubSubConfig | null {
  const configStr = env[ENV_KEY_PUBSUB_CONFIG];
  if (!configStr) return null;
  try {
    return JSON.parse(configStr) as PubSubConfig;
  } catch {
    console.error("[Preload] Failed to parse pubsub config from env");
    return null;
  }
}

/**
 * Parse all preload configuration from process.argv and environment.
 * Throws if panel ID is missing.
 */
export function parsePreloadConfig(): ParsedPreloadConfig {
  const panelId = parsePanelId();
  const kind = parseKind();
  if (!panelId) {
    throw new Error(`${kind === "worker" ? "Worker" : "Panel"} ID missing from additionalArguments`);
  }

  const syntheticEnv = parseEnvArg();
  const parentId =
    typeof syntheticEnv[ENV_KEY_PARENT_ID] === "string" ? syntheticEnv[ENV_KEY_PARENT_ID] : null;

  return {
    panelId,
    contextId: parseContextId(),
    kind,
    authToken: parseAuthToken(),
    initialTheme: parseTheme(),
    scopePath: parseScopePath(),
    syntheticEnv,
    parentId,
    gitConfig: parseGitConfig(syntheticEnv),
    pubsubConfig: parsePubSubConfig(syntheticEnv),
    stateArgs: parseStateArgs(),
  };
}

// =============================================================================
// Registration and transport
// =============================================================================

/**
 * Register the panel/worker view with the main process.
 */
export function registerView(config: ParsedPreloadConfig): void {
  if (config.authToken) {
    void ipcRenderer.invoke("panel-bridge:register", config.panelId, config.authToken).catch((error: unknown) => {
      console.error(`Failed to register ${config.kind} view`, error);
    });
  } else {
    console.error(`No auth token found for ${config.kind}`, config.panelId);
  }
}

/**
 * Create the transport bridge for RPC communication.
 */
export function createTransport(viewId: string) {
  return createTransportBridge(viewId);
}

/**
 * Set up DevTools keyboard shortcut (Cmd/Ctrl+Shift+I).
 */
export function setupDevToolsShortcut(config: ParsedPreloadConfig): void {
  window.addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === "i") {
      event.preventDefault();
      void ipcRenderer.invoke("panel:open-devtools", config.panelId).catch((error) => {
        console.error(`Failed to open ${config.kind} devtools`, error);
      });
    }
  });
}

/**
 * Integrate browser-like history with the main process for app panels.
 *
 * This patches the global `history` object to forward pushState/replaceState/back/forward/go
 * calls to the main process, enabling unified navigation history across panel types.
 *
 * IMPORTANT: The `config.panelId` is captured at setup time. Each panel gets its own
 * preload execution context in Electron, so this binding is safe. Even if two panels
 * share the same context (storage partition), they have separate WebContentsView
 * instances with separate preload scripts, so history calls route to the correct panel.
 */
export function setupHistoryIntegration(config: ParsedPreloadConfig): void {
  if (config.kind !== "panel") return;

  const resolvePath = (url: string | URL | null | undefined): string => {
    if (!url) return window.location.href;
    try {
      return new URL(url.toString(), window.location.href).toString();
    } catch {
      return window.location.href;
    }
  };

  const originalPushState = history.pushState.bind(history);
  const originalReplaceState = history.replaceState.bind(history);
  const originalBack = history.back.bind(history);
  const originalForward = history.forward.bind(history);
  const originalGo = history.go.bind(history);

  history.pushState = (state: unknown, title: string, url?: string | URL | null): void => {
    originalPushState(state, title, url);
    const path = resolvePath(url);
    void ipcRenderer.invoke("panel:history-push", config.panelId, { state, path }).catch((error) => {
      console.error("Failed to push history state", error);
    });
  };

  history.replaceState = (state: unknown, title: string, url?: string | URL | null): void => {
    originalReplaceState(state, title, url);
    const path = resolvePath(url);
    void ipcRenderer.invoke("panel:history-replace", config.panelId, { state, path }).catch((error) => {
      console.error("Failed to replace history state", error);
    });
  };

  history.back = (): void => {
    void ipcRenderer.invoke("panel:history-back", config.panelId).catch((error) => {
      console.error("Failed to navigate back", error);
    });
  };

  history.forward = (): void => {
    void ipcRenderer.invoke("panel:history-forward", config.panelId).catch((error) => {
      console.error("Failed to navigate forward", error);
    });
  };

  history.go = (delta?: number): void => {
    if (!delta) {
      void ipcRenderer.invoke("panel:history-reload", config.panelId).catch((error) => {
        console.error("Failed to reload history", error);
        originalGo(0);
      });
      return;
    }
    void ipcRenderer.invoke("panel:history-go", config.panelId, delta).catch((error) => {
      console.error("Failed to navigate history", error);
    });
  };

  ipcRenderer.on("panel:history-popstate", (_event, payload: { state: unknown; path: string }) => {
    originalReplaceState(payload.state, document.title, payload.path);
    window.dispatchEvent(new PopStateEvent("popstate", { state: payload.state }));
  });
}

/**
 * Set globals in preload context (for debugging).
 * Works with contextIsolation: true or false.
 */
export function setPreloadGlobals(
  config: ParsedPreloadConfig,
  transport: ReturnType<typeof createTransport>
): void {
  const g = globalThis as Record<string, unknown>;
  g["__natstackId"] = config.panelId;
  g["__natstackContextId"] = config.contextId;
  g["__natstackKind"] = config.kind;
  g["__natstackParentId"] = config.parentId;
  g["__natstackInitialTheme"] = config.initialTheme;
  g["__natstackGitConfig"] = config.gitConfig;
  g["__natstackPubSubConfig"] = config.pubsubConfig;
  g["__natstackEnv"] = config.syntheticEnv;
  g["__natstackStateArgs"] = config.stateArgs;
  g["__natstackTransport"] = transport;
}

/**
 * Expose NatStack globals via contextBridge for safe preloads (contextIsolation: true).
 * Must be called from a preload script with contextBridge available.
 */
export function exposeGlobalsViaContextBridge(
  contextBridge: Electron.ContextBridge,
  config: ParsedPreloadConfig,
  transport: ReturnType<typeof createTransport>
): void {
  // Minimal Node-ish env for libraries that expect process.env
  contextBridge.exposeInMainWorld("process", { env: config.syntheticEnv });

  // NatStack globals for @natstack/runtime
  contextBridge.exposeInMainWorld("__natstackId", config.panelId);
  contextBridge.exposeInMainWorld("__natstackContextId", config.contextId);
  contextBridge.exposeInMainWorld("__natstackKind", config.kind);
  contextBridge.exposeInMainWorld("__natstackParentId", config.parentId);
  contextBridge.exposeInMainWorld("__natstackInitialTheme", config.initialTheme);
  contextBridge.exposeInMainWorld("__natstackGitConfig", config.gitConfig);
  contextBridge.exposeInMainWorld("__natstackPubSubConfig", config.pubsubConfig);
  contextBridge.exposeInMainWorld("__natstackEnv", config.syntheticEnv);
  contextBridge.exposeInMainWorld("__natstackStateArgs", config.stateArgs);
  contextBridge.exposeInMainWorld("__natstackTransport", transport);
}

/**
 * Set globals directly on globalThis for unsafe preloads (contextIsolation: false).
 * Also sets __natstackFsRoot if scopePath is provided.
 */
export function setUnsafeGlobals(
  config: ParsedPreloadConfig,
  transport: ReturnType<typeof createTransport>
): void {
  globalThis.__natstackId = config.panelId;
  globalThis.__natstackContextId = config.contextId;
  globalThis.__natstackKind = config.kind;
  globalThis.__natstackParentId = config.parentId;
  globalThis.__natstackInitialTheme = config.initialTheme;
  globalThis.__natstackGitConfig = config.gitConfig as unknown as typeof globalThis.__natstackGitConfig;
  globalThis.__natstackPubSubConfig = config.pubsubConfig as unknown as typeof globalThis.__natstackPubSubConfig;
  globalThis.__natstackEnv = config.syntheticEnv;
  globalThis.__natstackStateArgs = config.stateArgs;
  globalThis.__natstackTransport = transport;

  // Set filesystem scope root for unsafe panels/workers
  if (config.scopePath) {
    Object.defineProperty(globalThis, "__natstackFsRoot", {
      value: config.scopePath,
      writable: false,
      enumerable: true,
      configurable: false,
    });
  }

  // Merge synthetic env with real process.env
  Object.assign(process.env, config.syntheticEnv);
}

/**
 * Set up IPC listener for stateArgs updates from main process.
 * Called by setStateArgs() in runtime, broadcasts to all listeners.
 */
export function setupStateArgsListener(): void {
  ipcRenderer.on("stateArgs:updated", (_event, newArgs: Record<string, unknown>) => {
    // Update the global
    globalThis.__natstackStateArgs = newArgs;
    // Dispatch custom event for reactive listeners (useStateArgs hook)
    window.dispatchEvent(new CustomEvent("natstack:stateArgsChanged", { detail: newArgs }));
  });
}

// =============================================================================
// Unified preload initialization
// =============================================================================

/**
 * Initialize a safe preload (contextIsolation: true).
 * Parses config, registers with main, creates transport, exposes globals via contextBridge.
 */
export function initSafePreload(contextBridge: Electron.ContextBridge): void {
  const config = parsePreloadConfig();
  registerView(config);
  const transport = createTransport(config.panelId);
  exposeGlobalsViaContextBridge(contextBridge, config, transport);
  setPreloadGlobals(config, transport);
  setupDevToolsShortcut(config);
  setupHistoryIntegration(config);
  setupStateArgsListener();
}

/**
 * Initialize an unsafe preload (contextIsolation: false, nodeIntegration: true).
 * Parses config, registers with main, creates transport, sets globals directly.
 */
export function initUnsafePreload(): void {
  const config = parsePreloadConfig();
  registerView(config);
  const transport = createTransport(config.panelId);
  setUnsafeGlobals(config, transport);
  setupDevToolsShortcut(config);
  setupHistoryIntegration(config);
  setupStateArgsListener();
}
