/**
 * Browser transport entry point — compiled to an IIFE by the build system.
 *
 * This reuses the same createWsTransport() from src/preload/wsTransport.ts,
 * eliminating duplication between the Electron preload and browser-served panels.
 *
 * Expects these globals to be set before this script runs (by configLoader):
 * - globalThis.__natstackEntityId (string) — runtime entity ID
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

import { applyStateArgsSnapshot } from "@natstack/shared/panel/applyStateArgsSnapshot";
import { createWsTransport, type TransportBridge } from "../preload/wsTransport.js";

type BrowserTransportGlobals = typeof globalThis & {
  __natstackEntityId: string;
  __natstackGatewayToken: string;
  __natstackGatewayRpcWsUrl: string;
  __natstackConnectionId?: string;
  __natstackClientLabel?: string;
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
const viewId: string = globals.__natstackEntityId;
const authToken: string = globals.__natstackGatewayToken;
const wsUrl: string = globals.__natstackGatewayRpcWsUrl;

globals.__natstackTransport = createWsTransport({
  viewId,
  wsPort: 0,
  authToken,
  callerKind: "panel",
  wsUrl,
  connectionId: globals.__natstackConnectionId,
  clientLabel: globals.__natstackClientLabel,
});

// ---------------------------------------------------------------------------
// stateArgs listener
// ---------------------------------------------------------------------------
// The server emits stateArgs:updated back to the panel over the server WS
// after persisting. This listener works in both Electron and standalone.

globals.__natstackTransport.onMessage((envelope) => {
  const message = envelope.message;
  if (isRuntimeEventMessage(message) && message.event === "stateArgs:updated") {
    const stateArgs =
      message.payload && typeof message.payload === "object"
        ? (message.payload as Record<string, unknown>)
        : {};
    applyStateArgsSnapshot(stateArgs);
  }
});
