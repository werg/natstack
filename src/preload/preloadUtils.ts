/**
 * Shared utilities for preload scripts.
 *
 * This module provides unified initialization for both safe and unsafe preloads,
 * extracting common parsing, registration, and global setup logic.
 */

import { PANEL_ENV_ARG_PREFIX } from "../common/panelEnv.js";
import { createWsTransport, type TransportBridge } from "./wsTransport.js";

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
  var __natstackServerTransport:
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

/** Argument prefix for kind (panel) */
export const ARG_KIND = "--natstack-kind=";

/** Argument prefix for context ID */
export const ARG_CONTEXT_ID = "--natstack-context-id=";

/** Argument prefix for state args (base64 encoded JSON) */
export const ARG_STATE_ARGS = "--natstack-state-args=";

/** Argument prefix for WS port */
export const ARG_WS_PORT = "--natstack-ws-port=";

/** Argument prefix for shell token */
export const ARG_SHELL_TOKEN = "--natstack-shell-token=";

/** Argument prefix for server RPC port (direct panel→server connections) */
export const ARG_SERVER_PORT = "--natstack-server-port=";

/** Argument prefix for server auth token (direct panel→server connections) */
export const ARG_SERVER_TOKEN = "--natstack-server-token=";

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
  syntheticEnv: Record<string, string>;
  parentId: string | null;
  gitConfig: GitConfig | null;
  pubsubConfig: PubSubConfig | null;
  stateArgs: Record<string, unknown>;
}

export type NatstackKind = "panel" | "shell";

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

export function parseKind(): NatstackKind {
  const arg = process.argv.find((value) => value.startsWith(ARG_KIND));
  const kind = arg?.split("=")[1];
  // Note: "shell" kind is only used by the main shell UI which hardcodes it in index.ts.
  // Shell panels use kind=panel for full runtime API access.
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

export function parseWsPort(): number | null {
  const arg = process.argv.find((value) => value.startsWith(ARG_WS_PORT));
  if (!arg) return null;
  const port = parseInt(arg.slice(ARG_WS_PORT.length), 10);
  return isNaN(port) ? null : port;
}

export function parseShellToken(): string | null {
  const arg = process.argv.find((value) => value.startsWith(ARG_SHELL_TOKEN));
  return arg ? (arg.slice(ARG_SHELL_TOKEN.length) || null) : null;
}

export function parseServerPort(): number | null {
  const arg = process.argv.find((value) => value.startsWith(ARG_SERVER_PORT));
  if (!arg) return null;
  const port = parseInt(arg.slice(ARG_SERVER_PORT.length), 10);
  return isNaN(port) ? null : port;
}

export function parseServerToken(): string | null {
  const arg = process.argv.find((value) => value.startsWith(ARG_SERVER_TOKEN));
  return arg ? (arg.slice(ARG_SERVER_TOKEN.length) || null) : null;
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
    throw new Error("Panel ID missing from additionalArguments");
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
 * Create the transport bridge for RPC communication via WebSocket.
 */
export function createTransport(viewId: string, config: ParsedPreloadConfig): TransportBridge {
  const wsPort = parseWsPort();
  if (!wsPort) throw new Error("WS port not provided (--natstack-ws-port)");
  if (!config.authToken) throw new Error("Auth token not provided");
  return createWsTransport({ viewId, wsPort, authToken: config.authToken, callerKind: config.kind });
}

/**
 * Set up DevTools keyboard shortcut (Cmd/Ctrl+Shift+I).
 */
export function setupDevToolsShortcut(config: ParsedPreloadConfig, transport: TransportBridge): void {
  window.addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === "i") {
      event.preventDefault();
      void transport.send("main", {
        type: "request",
        requestId: crypto.randomUUID(),
        fromId: config.panelId,
        method: "bridge.openDevtools",
        args: [],
      }).catch((error) => {
        console.error(`Failed to open ${config.kind} devtools`, error);
      });
    }
  });
}

/**
 * Integrate browser-like history with the main process for app panels.
 *
 * This patches the global `history` object to forward pushState/replaceState/back/forward/go
 * calls to the main process via WS RPC, enabling unified navigation history across panel types.
 *
 * IMPORTANT: The `config.panelId` is captured at setup time. Each panel gets its own
 * preload execution context in Electron, so this binding is safe. Even if two panels
 * share the same context (storage partition), they have separate WebContentsView
 * instances with separate preload scripts, so history calls route to the correct panel.
 */
export function setupHistoryIntegration(config: ParsedPreloadConfig, transport: TransportBridge): void {
  if (config.kind !== "panel") return;

  const resolvePath = (url: string | URL | null | undefined): string => {
    if (!url) return window.location.href;
    try {
      return new URL(url.toString(), window.location.href).toString();
    } catch {
      return window.location.href;
    }
  };

  const sendRpc = (method: string, args: unknown[]) => {
    void transport.send("main", {
      type: "request",
      requestId: crypto.randomUUID(),
      fromId: config.panelId,
      method,
      args,
    }).catch((error) => {
      console.error(`Failed to call ${method}`, error);
    });
  };

  const originalPushState = history.pushState.bind(history);
  const originalReplaceState = history.replaceState.bind(history);
  const originalGo = history.go.bind(history);

  history.pushState = (state: unknown, title: string, url?: string | URL | null): void => {
    originalPushState(state, title, url);
    const path = resolvePath(url);
    sendRpc("bridge.historyPush", [{ state, path }]);
  };

  history.replaceState = (state: unknown, title: string, url?: string | URL | null): void => {
    originalReplaceState(state, title, url);
    const path = resolvePath(url);
    sendRpc("bridge.historyReplace", [{ state, path }]);
  };

  history.back = (): void => {
    sendRpc("bridge.historyBack", []);
  };

  history.forward = (): void => {
    sendRpc("bridge.historyForward", []);
  };

  history.go = (delta?: number): void => {
    if (!delta) {
      sendRpc("bridge.historyReload", []);
      return;
    }
    sendRpc("bridge.historyGo", [delta]);
  };

  // Listen for popstate events from main via WS transport
  transport.onMessage((_fromId, message) => {
    const msg = message as { type?: string; event?: string; payload?: unknown };
    if (msg.type === "event" && msg.event === "panel:history-popstate") {
      const payload = msg.payload as { state: unknown; path: string };
      originalReplaceState(payload.state, document.title, payload.path);
      window.dispatchEvent(new PopStateEvent("popstate", { state: payload.state }));
    }
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
  transport: ReturnType<typeof createTransport>,
  serverTransport?: TransportBridge | null
): void {
  // Minimal Node-ish env for libraries that expect process.env
  contextBridge.exposeInMainWorld("process", { env: config.syntheticEnv });

  // NatStack globals for @workspace/runtime
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
  if (serverTransport) {
    contextBridge.exposeInMainWorld("__natstackServerTransport", serverTransport);
  }
}


/**
 * Set up listener for stateArgs updates from main process via WS transport.
 * Called by setStateArgs() in runtime, broadcasts to all listeners.
 */
export function setupStateArgsListener(transport: TransportBridge): void {
  transport.onMessage((_fromId, message) => {
    const msg = message as { type?: string; event?: string; payload?: unknown };
    if (msg.type === "event" && msg.event === "stateArgs:updated") {
      const newArgs = msg.payload as Record<string, unknown>;
      globalThis.__natstackStateArgs = newArgs;
      window.dispatchEvent(new CustomEvent("natstack:stateArgsChanged", { detail: newArgs }));
    }
  });
}

// =============================================================================
// Unified preload initialization
// =============================================================================

/**
 * Initialize a safe preload (contextIsolation: true).
 * Parses config, creates WS transport, exposes globals via contextBridge.
 */
export function initSafePreload(contextBridge: Electron.ContextBridge): void {
  const config = parsePreloadConfig();
  const transport = createTransport(config.panelId, config);

  // Create server transport if server params are available (main mode)
  const serverPort = parseServerPort();
  const serverToken = parseServerToken();
  let serverTransport: TransportBridge | null = null;
  if (serverPort && serverToken) {
    serverTransport = createWsTransport({
      viewId: config.panelId,
      wsPort: serverPort,
      authToken: serverToken,
      callerKind: config.kind,
    });
  }

  exposeGlobalsViaContextBridge(contextBridge, config, transport, serverTransport);
  setPreloadGlobals(config, transport);
  if (serverTransport) {
    globalThis.__natstackServerTransport = serverTransport;
  }
  setupDevToolsShortcut(config, transport);
  setupHistoryIntegration(config, transport);
  setupStateArgsListener(transport);
}

