/**
 * Browser transport entry point — compiled to an IIFE by the build system.
 *
 * This reuses the same createWsTransport() from src/preload/wsTransport.ts,
 * eliminating duplication between the Electron preload and browser-served panels.
 *
 * Expects these globals to be set before this script runs:
 * - globalThis.__natstackId (string) — panel ID (viewId)
 * - globalThis.__natstackRpcPort (number) — RPC server port
 * - globalThis.__natstackRpcToken (string) — auth token for ws:auth
 *
 * Optional (Electron dual-process mode):
 * - globalThis.__natstackServerRpcPort (number) — server-process RPC port
 * - globalThis.__natstackServerRpcToken (string) — server-process auth token
 *
 * Sets:
 * - globalThis.__natstackTransport — the TransportBridge instance
 * - globalThis.__natstackServerTransport — server transport (if server globals present)
 */

import { createWsTransport } from "../preload/wsTransport.js";

declare const globalThis: any;

const viewId: string = globalThis.__natstackId;
const rpcPort: number = globalThis.__natstackRpcPort;
const authToken: string = globalThis.__natstackRpcToken;

// Derive WebSocket URL from page context (supports both ws:// and wss://)
const wsScheme = location.protocol === "https:" ? "wss" : "ws";
const wsHost = location.hostname || "127.0.0.1";
const wsUrl = `${wsScheme}://${wsHost}:${rpcPort}`;

globalThis.__natstackTransport = createWsTransport({
  viewId,
  wsPort: rpcPort,
  authToken,
  callerKind: "panel",
  wsUrl,
});

// ---------------------------------------------------------------------------
// Server-process transport (Electron dual-process mode)
// ---------------------------------------------------------------------------
// In Electron, panels need a second WS connection to the server process for
// AI streaming, DB, build, and other server-side services.  The routing bridge
// in @workspace/runtime dispatches calls to the appropriate transport.

const serverRpcPort: number | undefined = globalThis.__natstackServerRpcPort;
const serverAuthToken: string | undefined = globalThis.__natstackServerRpcToken;

if (serverRpcPort && serverAuthToken) {
  const serverWsUrl = `${wsScheme}://${wsHost}:${serverRpcPort}`;
  globalThis.__natstackServerTransport = createWsTransport({
    viewId,
    wsPort: serverRpcPort,
    authToken: serverAuthToken,
    callerKind: "panel",
    wsUrl: serverWsUrl,
  });
}

// ---------------------------------------------------------------------------
// stateArgs listener (mirrors setupStateArgsListener in preload)
// ---------------------------------------------------------------------------

globalThis.__natstackTransport.onMessage((_fromId: string, message: any) => {
  if (message?.type === "event" && message.event === "stateArgs:updated") {
    globalThis.__natstackStateArgs = message.payload;
    window.dispatchEvent(
      new CustomEvent("natstack:stateArgsChanged", { detail: message.payload }),
    );
  }
});

// ---------------------------------------------------------------------------
// History integration (mirrors setupHistoryIntegration in preload)
// ---------------------------------------------------------------------------

const transport = globalThis.__natstackTransport;

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
    fromId: viewId,
    method,
    args,
  }).catch((error: unknown) => {
    console.error(`Failed to call ${method}`, error);
  });
};

const originalPushState = history.pushState.bind(history);
const originalReplaceState = history.replaceState.bind(history);

history.pushState = (state: unknown, title: string, url?: string | URL | null): void => {
  originalPushState(state, title, url);
  sendRpc("bridge.historyPush", [{ state, path: resolvePath(url) }]);
};

history.replaceState = (state: unknown, title: string, url?: string | URL | null): void => {
  originalReplaceState(state, title, url);
  sendRpc("bridge.historyReplace", [{ state, path: resolvePath(url) }]);
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
transport.onMessage((_fromId: string, message: any) => {
  const msg = message as { type?: string; event?: string; payload?: unknown };
  if (msg.type === "event" && msg.event === "panel:history-popstate") {
    const payload = msg.payload as { state: unknown; path: string };
    originalReplaceState(payload.state, document.title, payload.path);
    window.dispatchEvent(new PopStateEvent("popstate", { state: payload.state }));
  }
});
