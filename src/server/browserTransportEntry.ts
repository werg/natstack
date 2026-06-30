/**
 * Browser transport entry point — compiled to an IIFE by the build system and
 * served as `__transport.js` under each panel route.
 *
 * Panels no longer open a direct `ws://…/rpc` WebSocket. Panel RPC rides the
 * **shell bridge** (`__natstackShell` — Electron `contextBridge` on desktop, the
 * React-Native `postMessage` bridge on mobile), which the host muxes onto its
 * single WebRTC control channel as the panel's own logical session. The panel
 * runtime's `createPanelTransport()` consumes that bridge directly, so this
 * entry no longer constructs any transport global.
 *
 * Its remaining job is to apply early `stateArgs:updated` events the host pushes
 * over the bridge before the panel bundle's runtime is up.
 *
 * Timing: configLoader runs as a blocking <script> and sets the panel globals
 * (and `__natstackShell` is exposed by the host preload/injection) before
 * dynamically loading this script.
 */

import { applyStateArgsSnapshot } from "@natstack/shared/panel/applyStateArgsSnapshot";
import type { RpcEnvelope } from "@natstack/rpc";

type ShellEnvelopeBridge = {
  onEnvelope?: (handler: (envelope: RpcEnvelope) => void) => () => void;
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

// ---------------------------------------------------------------------------
// stateArgs listener
// ---------------------------------------------------------------------------
// The host pushes runtime events (incl. stateArgs:updated) over the shell bridge
// back to the panel's logical session. This early listener applies them before
// the panel bundle's runtime takes over; applyStateArgsSnapshot is idempotent.

const shell = ((
  globalThis as typeof globalThis & {
    __natstackShell?: ShellEnvelopeBridge;
    __natstackElectron?: ShellEnvelopeBridge;
  }
).__natstackShell ??
  (globalThis as typeof globalThis & { __natstackElectron?: ShellEnvelopeBridge })
    .__natstackElectron) as ShellEnvelopeBridge | undefined;

shell?.onEnvelope?.((envelope) => {
  const message = envelope.message;
  if (isRuntimeEventMessage(message) && message.event === "stateArgs:updated") {
    const stateArgs =
      message.payload && typeof message.payload === "object"
        ? (message.payload as Record<string, unknown>)
        : {};
    applyStateArgsSnapshot(stateArgs);
  }
});
