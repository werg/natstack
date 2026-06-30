import { createWebRtcTransport, type WebRtcTransport } from "./webrtcClient.js";
import { createSignalingClient } from "./webrtcSignalingClient.js";
import type { PeerConnectionProvider } from "./webrtcPeer.js";

export interface OffererTransportOptions {
  /** Platform peer factory: node-datachannel (desktop/CLI) or react-native-webrtc (mobile). */
  provider: PeerConnectionProvider;
  /** QR/pairing material: signaling room, the pinned server DTLS fingerprint, the
   * signaling URL, and the ICE transport policy. */
  pairing: { room: string; fp: string; sig: string; ice?: string };
  /** Node `ws` + `fetch` for the signaling client (desktop/CLI). Omit on React
   * Native — `createSignalingClient` falls back to the platform WebSocket/fetch globals. */
  webSocketImpl?: unknown;
  fetchImpl?: typeof fetch;
  logPrefix?: string;
  connectTimeoutMs?: number;
}

/**
 * Build the OFFERER (client / host / device) side of the WebRTC pipe — the shape
 * every caller (desktop shell, CLI, mobile) had hand-rolled identically: dial the
 * paired server's signaling room, stand up a DTLS pipe pinning the server's
 * fingerprint, and offer. Only the platform peer provider (and the Node ws/fetch
 * shims) differ across callers, so those are the parameters; the rest is fixed here
 * so the wiring lives in one place rather than three.
 */
export function createOffererTransport(options: OffererTransportOptions): WebRtcTransport {
  const { provider, pairing } = options;
  return createWebRtcTransport({
    provider,
    createSignaling: () =>
      createSignalingClient({
        room: pairing.room,
        sig: pairing.sig,
        ...(options.webSocketImpl ? { WebSocketImpl: options.webSocketImpl as never } : {}),
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      }),
    pairing: {
      room: pairing.room,
      fingerprint: pairing.fp,
      iceTransportPolicy: pairing.ice as "all" | "relay" | undefined,
    },
    role: "offerer",
    ...(options.logPrefix ? { logPrefix: options.logPrefix } : {}),
    ...(options.connectTimeoutMs ? { connectTimeoutMs: options.connectTimeoutMs } : {}),
  });
}
