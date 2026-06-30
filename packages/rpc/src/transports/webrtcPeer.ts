/**
 * Platform-agnostic WebRTC primitives — the seam between the transport logic
 * (workstream A, `webrtcClient.ts`) and the native stacks (workstream C):
 * `node-datachannel`/libdatachannel on desktop+server, `react-native-webrtc`
 * on mobile. The transport codes ONLY against these interfaces, so it is fully
 * unit-testable with fakes and never imports a native module.
 *
 * The shapes mirror `node-datachannel` (callback-registration style:
 * `.onMessage(cb)`, `.onLocalDescription(cb)`, `.onLocalCandidate(cb)`,
 * `.onStateChange(cb)`) more closely than the WHATWG `onmessage =` setters,
 * because callback registration composes and the native adapter is a thin map.
 * The `react-native-webrtc` adapter wraps WHATWG events into the same shape.
 */

import type { SignalingClient } from "./webrtcSignaling.js";

export type { SignalingClient } from "./webrtcSignaling.js";

/** ICE candidate-pair type — the fail-loud relay alarm reads this (plan §6/§12). */
export type RtcCandidateType = "host" | "srflx" | "prflx" | "relay";

export type RtcConnectionState =
  | "new"
  | "connecting"
  | "connected"
  | "disconnected"
  | "failed"
  | "closed";

export type RtcDataChannelState = "connecting" | "open" | "closing" | "closed";

export interface RtcSessionDescription {
  type: "offer" | "answer";
  sdp: string;
}

export interface RtcIceCandidate {
  candidate: string;
  sdpMid?: string | null;
  sdpMLineIndex?: number | null;
}

export interface RtcIceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

/**
 * One reliable/ordered SCTP data channel. The transport opens two: `control`
 * (RPC envelopes + events + session handshake) and `bulk` (binary stream v2
 * frames). Backpressure is driven by `bufferedAmount` + the low-threshold event.
 */
export interface RtcDataChannelLike {
  readonly label: string;
  readonly readyState: RtcDataChannelState;
  /** Bytes queued but not yet sent — chunk under `maxMessageSize` and watch this. */
  readonly bufferedAmount: number;
  bufferedAmountLowThreshold: number;
  /** Measured SCTP max message size (libdatachannel reports 256 KB — plan §11). */
  readonly maxMessageSize: number;
  send(data: Uint8Array): void;
  close(): void;
  onOpen(handler: () => void): () => void;
  onClose(handler: () => void): () => void;
  onError(handler: (error: Error) => void): () => void;
  onMessage(handler: (data: Uint8Array) => void): () => void;
  onBufferedAmountLow(handler: () => void): () => void;
}

export interface RtcDataChannelInit {
  ordered?: boolean;
  /** Pre-negotiated channel id so both peers agree without `ondatachannel`. */
  negotiated?: boolean;
  id?: number;
}

export interface RtcPeerConnectionLike {
  createDataChannel(label: string, init?: RtcDataChannelInit): RtcDataChannelLike;
  createOffer(): Promise<RtcSessionDescription>;
  createAnswer(): Promise<RtcSessionDescription>;
  setLocalDescription(desc?: RtcSessionDescription): Promise<void>;
  setRemoteDescription(desc: RtcSessionDescription): Promise<void>;
  addRemoteCandidate(candidate: RtcIceCandidate): Promise<void>;
  /** Trigger an ICE restart (recovery when the pipe is fully down, plan §1). */
  restartIce(): void;
  /**
   * DTLS SHA-256 fingerprint of the *remote* peer's certificate, observed on the
   * live wire — the value compared against the QR pin (`fp`). Null until DTLS is
   * established. Proven pinnable end-to-end in the §11 spike.
   */
  remoteFingerprint(): string | null;
  /** Selected ICE candidate-pair type — surfaced so over-relaying is loud (§12). */
  selectedCandidateType(): RtcCandidateType | null;
  readonly connectionState: RtcConnectionState;
  onConnectionStateChange(handler: (state: RtcConnectionState) => void): () => void;
  /** A local SDP (offer/answer) is ready to send to the peer via signaling. */
  onLocalDescription(handler: (desc: RtcSessionDescription) => void): () => void;
  /** A local ICE candidate is ready to send to the peer via signaling. */
  onLocalCandidate(handler: (candidate: RtcIceCandidate) => void): () => void;
  /** Inbound data channel (answerer side, when channels are not pre-negotiated). */
  onDataChannel(handler: (channel: RtcDataChannelLike) => void): () => void;
  close(): void;
}

export interface RtcPeerConfig {
  iceServers: RtcIceServer[];
  /** Force `relay` to validate TURN-over-TLS:443 reachability (plan §2). */
  iceTransportPolicy?: "all" | "relay";
  /**
   * Persistent DTLS cert (SERVER side) so the fingerprint is stable across
   * restarts → the QR pin keeps verifying. Loaded from
   * `certificatePemFile`/`keyPemFile` (plan §6.1, §11).
   */
  certificatePemFile?: string;
  keyPemFile?: string;
}

/**
 * Workstream C provides this. `create` returns a fresh peer; the transport owns
 * its lifecycle. The provider also exports the LOCAL fingerprint so the server
 * can publish it (QR) and the client can pin it.
 */
export interface PeerConnectionProvider {
  create(config: RtcPeerConfig): RtcPeerConnectionLike | Promise<RtcPeerConnectionLike>;
  /** Local cert's DTLS SHA-256 — computed offline from the PEM (no live peer needed). */
  localFingerprint?(config: Pick<RtcPeerConfig, "certificatePemFile" | "keyPemFile">): string | null;
}

export interface WebRtcPairing {
  /** Signaling rendezvous room id (unguessable UUID). */
  room: string;
  /** Pinned remote DTLS SHA-256 (QR `fp`); the transport accepts iff observed === this. */
  fingerprint: string;
  /** Pairing secret proving the QR holder. */
  code?: string;
  /** Protocol version negotiated via the link `v`. */
  version?: number;
  /** TURN policy from the link `ice` (e.g. force relay). */
  iceTransportPolicy?: "all" | "relay";
  /** Static ICE servers if not minted per-session by signaling. */
  iceServers?: RtcIceServer[];
}

export interface SignalingClientFactory {
  (room: string): SignalingClient | Promise<SignalingClient>;
}

/**
 * Extract the `sha-256` DTLS fingerprint (uppercase colon-hex) from an SDP blob.
 *
 * This is the fail-closed DTLS pin parse — the value the transport compares
 * (colons stripped) against the QR pin to accept or reject the pipe. It lives
 * here, in the platform-agnostic seam, so EVERY native adapter (node-datachannel
 * + react-native-webrtc) parses the pin identically: a fix to the regex can't
 * silently leave one platform completing a pipe the other rejects (the exact
 * divergence [[fail-loud-no-masking]] warns about for security-critical parses).
 */
export function parseSdpFingerprint(sdp: string): string | null {
  const match = sdp.match(/^a=fingerprint:sha-256\s+([0-9a-fA-F:]+)\s*$/im);
  return match?.[1]?.toUpperCase() ?? null;
}

// --- Wire contract --------------------------------------------------------
// The offerer and answerer MUST open the two pre-negotiated channels with the
// SAME labels + ids (a mismatch silently breaks pairing — there is no
// `ondatachannel` fallback) and frame under the SAME chunk size. Single source
// here so the two ends cannot drift.

/** Control channel (RPC envelopes + events + session handshake). */
export const CONTROL_LABEL = "control";
export const CONTROL_CHANNEL_ID = 0;
/** Bulk channel (binary stream v2 frames). */
export const BULK_LABEL = "bulk";
export const BULK_CHANNEL_ID = 1;
/** react-native-webrtc corrupts >16 KiB data-channel messages (RFC 8831 §6.6),
 * so both ends chunk/fragment under this. */
export const DEFAULT_CHUNK_SIZE = 16 * 1024;
