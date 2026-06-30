/**
 * Server-side WebRTC answerer bootstrap. Stands up the answerer side of the pipe
 * (plan §1/§3) and attaches it to the live `RpcServer`, so a paired client can
 * reach this server over WebRTC with no public endpoint. It is the runtime entry
 * point for the seam documented in `index.ts`.
 *
 * The server presents a PERSISTENT DTLS cert (stable fingerprint across restarts)
 * and publishes that fingerprint in the QR pairing link (`fp`); the client pins
 * it (fail-closed on mismatch). Per-principal auth still happens per-session
 * inside `attachWebRtcPipe` (the shim runs the real `handleAuth`).
 *
 * This wires the native `node-datachannel` provider (under the Electron-main host
 * dir, but Electron-free and boundary-legal to import from `src/server`) — loaded
 * lazily so a server built without the native module still starts.
 */

import {
  createWebRtcAnswererPipe,
  type WebRtcAnswererPipe,
} from "@natstack/rpc/transports/webrtcAnswerer";
import { createSignalingClient } from "@natstack/rpc/transports/webrtcSignalingClient";
import { createConnectDeepLink, type TurnPolicy } from "@natstack/shared/connect";

/** Minimal surface of RpcServer this bootstrap needs (avoids a hard type dep). */
export interface WebRtcAttachable {
  attachWebRtcPipe(pipe: {
    writeControl(data: Uint8Array): Promise<void> | void;
    writeBulk(data: Uint8Array): void;
    controlBufferedAmount?(): number;
    onControl(handler: (data: Uint8Array) => void): void;
    onDown?(handler: (reason: string) => void): () => void;
  }): void;
}

export interface WebRtcAnswererOptions {
  rpcServer: WebRtcAttachable;
  /** Signaling endpoint base (the QR `sig=`), e.g. wss://signal.example or ws://127.0.0.1:8787. */
  signalUrl: string;
  /** Rendezvous room id (the QR `room=`) — the server picks it and publishes it. */
  room: string;
  /** Persistent cert (stable fingerprint → stable QR pin). */
  certificatePemFile: string;
  keyPemFile: string;
  /** Pairing secret to embed in the QR `code=` (the server's pairing code). */
  pairingCode: string;
  iceTransportPolicy?: TurnPolicy;
  /** Optional server/workspace label (`srv=`). */
  srv?: string;
  log?: (message: string) => void;
}

export interface WebRtcAnswererHandle {
  /** The server's DTLS SHA-256 fingerprint (the published pin). */
  fingerprint: string;
  /** The `natstack://connect?...` pairing link a client scans/pastes. */
  pairingLink: string;
  pipe: WebRtcAnswererPipe;
  close(): Promise<void>;
}

export async function startWebRtcAnswerer(
  options: WebRtcAnswererOptions
): Promise<WebRtcAnswererHandle> {
  const log = options.log ?? ((m: string) => console.log(`[webrtc-answerer] ${m}`));

  // Lazy native import — a build without node-datachannel still boots; this only
  // runs when WebRTC ingress is explicitly enabled.
  const { createNodeDatachannelProvider } = await import("../main/webrtc/nodeDatachannelPeer.js");
  const { certFileFingerprint } = await import("../main/webrtc/cert.js");
  const { default: WS } = (await import("ws")) as unknown as {
    default: new (url: string) => unknown;
  };

  const provider = createNodeDatachannelProvider({ peerName: "natstack-server" });
  const fingerprint =
    provider.localFingerprint?.({ certificatePemFile: options.certificatePemFile }) ??
    certFileFingerprint(options.certificatePemFile);

  const createSignaling = () =>
    createSignalingClient({
      room: options.room,
      sig: options.signalUrl,
      WebSocketImpl: WS as never,
      fetchImpl: fetch,
    });
  const pipe = createWebRtcAnswererPipe({
    provider,
    createSignaling,
    pairing: {
      iceServers: [],
      iceTransportPolicy: options.iceTransportPolicy,
      certificatePemFile: options.certificatePemFile,
      keyPemFile: options.keyPemFile,
    },
  });
  options.rpcServer.attachWebRtcPipe(pipe);

  // Join the signaling room and await the first offerer. We do NOT block startup
  // on a client arriving — connect() resolves on the first pairing and re-arms on
  // reconnect; failures are logged loud, never swallowed.
  void pipe
    .connect()
    .then(() => log(`pipe connected (client paired)`))
    .catch((error) =>
      log(`pipe connect failed: ${error instanceof Error ? error.message : String(error)}`)
    );

  const pairingLink = createConnectDeepLink({
    room: options.room,
    fp: fingerprint,
    code: options.pairingCode,
    sig: options.signalUrl,
    ice: options.iceTransportPolicy ?? "all",
    srv: options.srv,
  });

  log(`answerer armed — room=${options.room} fp=${fingerprint}`);
  log(`pairing link: ${pairingLink}`);

  return {
    fingerprint,
    pairingLink,
    pipe,
    close: () => pipe.close(),
  };
}
