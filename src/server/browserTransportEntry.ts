/**
 * Browser transport entry point — compiled to an IIFE by the build system.
 *
 * This reuses the same createWsTransport() from src/preload/wsTransport.ts,
 * eliminating duplication between the Electron preload and browser-served panels.
 *
 * Expects these globals to be set before this script runs:
 * - globalThis.__natstackId (string) — panel ID (viewId)
 * - globalThis.__natstackRpcPort (number) — server RPC port
 * - globalThis.__natstackRpcToken (string) — auth token for ws:auth
 *
 * Sets:
 * - globalThis.__natstackTransport — the TransportBridge instance (single server WS)
 */

import { createWsTransport } from "../preload/wsTransport.js";

declare const globalThis: any;

const viewId: string = globalThis.__natstackId;
const rpcPort: number = globalThis.__natstackRpcPort;
const authToken: string = globalThis.__natstackRpcToken;

// Derive WebSocket URL from page context (supports both ws:// and wss://)
const wsScheme = location.protocol === "https:" ? "wss" : "ws";
const wsHost: string = location.hostname || "127.0.0.1";
const wsUrl = `${wsScheme}://${wsHost}:${rpcPort}`;

globalThis.__natstackTransport = createWsTransport({
  viewId,
  wsPort: rpcPort,
  authToken,
  callerKind: "panel",
  wsUrl,
});

// ---------------------------------------------------------------------------
// stateArgs listener
// ---------------------------------------------------------------------------
// The server emits stateArgs:updated back to the panel over the server WS
// after persisting. This listener works in both Electron and standalone.

globalThis.__natstackTransport.onMessage((_fromId: string, message: any) => {
  if (message?.type === "event" && message.event === "stateArgs:updated") {
    globalThis.__natstackStateArgs = message.payload;
    window.dispatchEvent(
      new CustomEvent("natstack:stateArgsChanged", { detail: message.payload }),
    );
  }
});
