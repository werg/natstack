/**
 * Signaling client contract — the seam between the transport (workstream A) and
 * the Cloudflare signaling Durable Object (workstream B, `apps/signaling`). The
 * signaling box is deliberately dumb: a UUID-addressed rendezvous that
 * blind-relays SDP/ICE between two peers (security lives in the QR pin, not the
 * relay). The room PERSISTS for the connection's lifetime (WebSocket
 * Hibernation API) so it can carry ICE-restart, not just first connect.
 */

import type { RtcIceCandidate, RtcIceServer, RtcSessionDescription } from "./webrtcPeer.js";

export interface SignalingClient {
  /** Relay our local SDP (offer/answer) to the peer via the room. */
  sendDescription(desc: RtcSessionDescription): Promise<void>;
  /** Relay one local ICE candidate to the peer. */
  sendCandidate(candidate: RtcIceCandidate): Promise<void>;
  /** Inbound SDP from the peer. Returns an unsubscribe. */
  onDescription(handler: (desc: RtcSessionDescription) => void): () => void;
  /** Inbound ICE candidate from the peer. Returns an unsubscribe. */
  onCandidate(handler: (candidate: RtcIceCandidate) => void): () => void;
  /**
   * Short-lived TURN credentials minted per session and handed to both peers
   * through the room (Cloudflare Realtime TURN). When present the transport
   * prefers these over any static `iceServers` in the pairing payload.
   */
  fetchIceServers?(): Promise<RtcIceServer[]>;
  /** Signal that the room dropped/closed (so the transport can fail loud). */
  onClosed(handler: (reason?: string) => void): () => void;
  close(): void;
}
