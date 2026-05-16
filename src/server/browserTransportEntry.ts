/**
 * Browser transport entry point — compiled to an IIFE by the build system.
 *
 * This reuses the same createWsTransport() from src/preload/wsTransport.ts,
 * eliminating duplication between the Electron preload and browser-served panels.
 *
 * Expects these globals to be set before this script runs (by configLoader):
 * - globalThis.__natstackId (string) — panel ID (viewId)
 * - globalThis.__natstackGatewayRpcWsUrl (string) — fully resolved gateway RPC WS URL
 *
 * Timing: configLoader runs as a blocking <script> and sets all globals
 * synchronously before dynamically loading this script, so the globals are
 * always available when this code executes.
 *
 * Sets:
 * - globalThis.__natstackTransport — the TransportBridge instance (single server WS)
 */

import { createWsTransport, type TransportBridge } from "../preload/wsTransport.js";

type BrowserTransportGlobals = typeof globalThis & {
  __natstackId: string;
  __natstackGatewayRpcWsUrl: string;
  __natstackTransport?: TransportBridge;
  __natstackStateArgs?: unknown;
};

type RuntimeEventMessage = {
  type: "event";
  event: string;
  payload: unknown;
};

function isRuntimeEventMessage(message: unknown): message is RuntimeEventMessage {
  return (
    typeof message === "object" &&
    message !== null &&
    (message as { type?: unknown }).type === "event" &&
    typeof (message as { event?: unknown }).event === "string"
  );
}

const globals = globalThis as BrowserTransportGlobals;

const viewId: string = globals.__natstackId;
const wsUrl: string = globals.__natstackGatewayRpcWsUrl;

globals.__natstackTransport = createWsTransport({
  viewId,
  wsPort: 0,
  callerKind: "panel",
  wsUrl,
});

// ---------------------------------------------------------------------------
// stateArgs listener
// ---------------------------------------------------------------------------
// The server emits stateArgs:updated back to the panel over the server WS
// after persisting. This listener works in both Electron and standalone.

globals.__natstackTransport.onMessage((_sourceId: string, message: unknown) => {
  if (isRuntimeEventMessage(message) && message.event === "stateArgs:updated") {
    globals.__natstackStateArgs = message.payload;
    window.dispatchEvent(new CustomEvent("natstack:stateArgsChanged", { detail: message.payload }));
  }
});
