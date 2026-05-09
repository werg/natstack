/**
 * Browser transport entry point — compiled to an IIFE by the build system.
 *
 * This reuses the same createWsTransport() from src/preload/wsTransport.ts,
 * eliminating duplication between the Electron preload and browser-served panels.
 *
 * Expects these globals to be set before this script runs (by configLoader):
 * - globalThis.__natstackId (string) — panel ID (viewId)
 * - globalThis.__natstackGatewayRpcWsUrl (string) — fully resolved gateway RPC WS URL
 * - globalThis.__natstackGatewayToken (string) — auth token for ws:auth
 *
 * Timing: configLoader runs as a blocking <script> and sets all globals
 * synchronously before dynamically loading this script, so the globals are
 * always available when this code executes.
 *
 * Sets:
 * - globalThis.__natstackTransport — the TransportBridge instance (single server WS)
 */

import { createWsTransport } from "../preload/wsTransport.js";

declare const globalThis: any;

const viewId: string = globalThis.__natstackId;
const authToken: string = globalThis.__natstackGatewayToken;
const wsUrl: string = globalThis.__natstackGatewayRpcWsUrl;

globalThis.__natstackTransport = createWsTransport({
  viewId,
  wsPort: 0,
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
