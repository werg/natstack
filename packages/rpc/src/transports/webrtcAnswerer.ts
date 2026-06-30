/**
 * Server-side WebRTC answerer pipe (plan §1/§3). The complement of
 * `webrtcClient` (the offerer/host): the home server accepts ONE pipe per paired
 * host and exposes its control/bulk channels as a `PipeChannels` surface that
 * `rpcServer.attachWebRtcPipe` demultiplexes into N logical sessions.
 *
 * The answerer does NOT fingerprint-pin: the pin is one-directional (the CLIENT
 * pins the SERVER's persistent DTLS cert via the QR `fp`). The server presents
 * that cert (via `certificatePemFile`/`keyPemFile` in the provider config) and
 * authenticates each principal per-session through the grant redemption that runs
 * inside `attachWebRtcPipe` (handleAuth) — DTLS authenticates the pipe, grants
 * authorize the principals.
 *
 * Written against the platform-agnostic `webrtcPeer`/`webrtcSignaling`
 * interfaces, so it is unit-testable with the same in-memory fabric as the
 * client and carries no native dependency.
 */

import type { RpcConnectionStatus } from "../types.js";
import type {
  PeerConnectionProvider,
  RtcConnectionState,
  RtcDataChannelLike,
  RtcIceCandidate,
  RtcPeerConnectionLike,
  RtcSessionDescription,
  WebRtcPairing,
} from "./webrtcPeer.js";
import type { SignalingClient } from "./webrtcSignaling.js";
import {
  BULK_CHANNEL_ID,
  BULK_LABEL,
  CONTROL_CHANNEL_ID,
  CONTROL_LABEL,
  DEFAULT_CHUNK_SIZE,
} from "./webrtcPeer.js";
import { createControlCodec } from "./controlFraming.js";
import { awaitDrain, writeChunked } from "./channelIo.js";

// Backpressure high-water — kept SEPARATE from the chunk size. The 16 KiB chunk is
// a per-message interop limit; throughput needs many chunks in flight. Draining to
// one chunk before sending the next starves a relayed link to ~24 KB/s (one chunk
// per buffered-amount-low round-trip); a 256 KiB window keeps the SCTP pipe full.
const BULK_BUFFER_HIGH_WATER = 256 * 1024;

export interface WebRtcAnswererPipe {
  /** Write a serialized control frame to the client. Resolves once this frame's
   * fragments have drained, so a caller can meter its own un-drained bytes. */
  writeControl(data: Uint8Array): Promise<void> | void;
  /** Write a binary bulk frame to the client (chunked under maxMessageSize). */
  writeBulk(data: Uint8Array): void;
  /** Control-channel backpressure for the server's slow-consumer logic. */
  controlBufferedAmount(): number;
  /** Register the inbound control-frame handler (rpcServer.attachWebRtcPipe). */
  onControl(handler: (data: Uint8Array) => void): void;
  /** Register a handler fired when the underlying pipe is lost or closed. */
  onDown(handler: (reason: string) => void): () => void;
  /** Establish the pipe (idempotent); resolves once both channels are open. */
  connect(): Promise<void>;
  status(): RpcConnectionStatus;
  close(): Promise<void>;
}

type SignalingFactory = () => SignalingClient | Promise<SignalingClient>;

export interface WebRtcAnswererOptions {
  provider: PeerConnectionProvider;
  /**
   * A pre-created signaling client. Kept for tests/simple embedders; production
   * callers should prefer createSignaling so a closed room can be rejoined.
   */
  signaling?: SignalingClient;
  /** Create a fresh signaling client for the same room after a room websocket drop. */
  createSignaling?: SignalingFactory;
  pairing: Pick<WebRtcPairing, "iceServers" | "iceTransportPolicy"> & {
    certificatePemFile?: string;
    keyPemFile?: string;
  };
  chunkSize?: number;
  logPrefix?: string;
}

export function createWebRtcAnswererPipe(options: WebRtcAnswererOptions): WebRtcAnswererPipe {
  if (!options.signaling && !options.createSignaling) {
    throw new Error("createWebRtcAnswererPipe requires signaling or createSignaling");
  }
  const { provider, pairing } = options;
  const createSignaling: SignalingFactory =
    options.createSignaling ??
    (() => {
      if (!options.signaling) {
        throw new Error("createWebRtcAnswererPipe requires signaling or createSignaling");
      }
      return options.signaling;
    });
  const chunkSize = options.chunkSize ?? DEFAULT_CHUNK_SIZE;
  const log = options.logPrefix ?? "[webrtc-answerer]";

  let signaling: SignalingClient | null = null;
  let peer: RtcPeerConnectionLike | null = null;
  let control: RtcDataChannelLike | null = null;
  let bulk: RtcDataChannelLike | null = null;
  let status: RpcConnectionStatus = "disconnected";
  let connectPromise: Promise<void> | null = null;
  let resolveConnect: (() => void) | null = null;
  let rejectConnect: ((error: unknown) => void) | null = null;
  let closed = false;
  // See onDown: re-arm a resolved connect promise on pipe-down so connect()/ready()
  // while awaiting a re-pairing offer waits for the new pipe, not the stale promise.
  let connectResolved = false;
  let controlHandler: ((data: Uint8Array) => void) | null = null;
  // Control frames larger than the channel cap are fragmented on send and
  // reassembled here on receive (see controlFraming). Reset when the peer is torn
  // down so a re-pairing pipe never reassembles against a dead pipe's fragments.
  const controlCodec = createControlCodec();
  // `signalingUnsubs` holds the SIGNALING handlers — they outlive individual
  // peers so a re-pairing offer can swap the peer underneath them. `peerUnsubs`
  // holds the PEER-specific handlers, torn down + re-created on each (re-)establish.
  const signalingUnsubs: Array<() => void> = [];
  const peerUnsubs: Array<() => void> = [];
  let peerHasRemote = false;
  let signalingArmed = false;
  let signalingRecovery: Promise<void> | null = null;
  const downHandlers = new Set<(reason: string) => void>();
  const pendingDescriptions: RtcSessionDescription[] = [];
  const pendingCandidates: RtcIceCandidate[] = [];

  // Bulk-channel writes are SERIALIZED through this chain. N logical streams share
  // ONE bulk channel, and chunked sends await drain (yielding the event loop), so
  // without serialization the chunks of frames from parallel streams (e.g. a
  // panel's HTML/JS/CSS/transport fetched concurrently) interleave on the wire and
  // the byte-stream frame decoder mis-parses them. Each frame's chunks must be
  // contiguous; ordering across frames does not matter (each carries its streamId).
  let bulkWriteChain: Promise<void> = Promise.resolve();

  async function writeBulkChunks(data: Uint8Array): Promise<void> {
    const channel = bulk;
    if (!channel || channel.readyState !== "open") return;
    await writeChunked(channel, data, chunkSize);
  }

  // Control writes serialize through this chain and await drain between fragments,
  // exactly like the bulk path. Without it, a large control frame (now possible —
  // we fragment them) pushes every fragment synchronously and balloons the shared
  // control buffer with zero backpressure; the per-call promise lets a caller (the
  // server-side shim) meter its OWN un-drained bytes for per-session backpressure.
  let controlWriteChain: Promise<void> = Promise.resolve();

  async function writeControlParts(parts: Uint8Array[]): Promise<void> {
    const channel = control;
    if (!channel || channel.readyState !== "open") return;
    for (const part of parts) {
      await awaitDrain(channel);
      channel.send(part);
    }
  }

  // Signaling handlers reference the CURRENT `peer` (mutable), so a re-pairing
  // that swaps the peer underneath them keeps routing correctly. The signaling
  // client itself may be replaced after its websocket closes.
  async function armSignaling(): Promise<SignalingClient> {
    if (signaling && signalingArmed) return signaling;
    const next = await createSignaling();
    signaling = next;
    signalingArmed = true;
    signalingUnsubs.push(
      next.onDescription((desc) => {
        if (!peer) {
          pendingDescriptions.push(desc);
          return;
        }
        void onRemoteDescription(desc);
      }),
      next.onCandidate((cand) => {
        const current = peer;
        if (!current) {
          pendingCandidates.push(cand);
          return;
        }
        void current
          .addRemoteCandidate(cand)
          .catch((e) => console.warn(`${log} addRemoteCandidate`, e));
      }),
      next.onClosed((reason) => void onSignalingClosed(next, reason)),
    );
    return next;
  }

  function teardownSignaling(closeClient: boolean): void {
    for (const off of signalingUnsubs.splice(0)) {
      try {
        off();
      } catch {
        /* ignore */
      }
    }
    const current = signaling;
    signaling = null;
    signalingArmed = false;
    if (closeClient && current) {
      try {
        current.close();
      } catch {
        /* ignore */
      }
    }
  }

  function onSignalingClosed(source: SignalingClient, reason?: string): void {
    if (closed || source !== signaling) return;
    const message = `signaling closed: ${reason ?? ""}`;
    teardownSignaling(false);
    if (!options.createSignaling) {
      onDown(message);
      return;
    }
    signalingRecovery ??= recoverSignaling(message).finally(() => {
      signalingRecovery = null;
    });
  }

  async function recoverSignaling(reason: string): Promise<void> {
    const hadPipe = status === "connected";
    if (hadPipe) {
      console.warn(`${log} ${reason}; rejoining signaling room`);
    } else {
      onDown(reason);
      teardownPeer();
    }
    try {
      await armSignaling();
      if (!hadPipe && !closed) {
        await establishPeer();
      }
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      console.warn(`${log} signaling recovery failed`, err);
      if (!hadPipe) rejectConnect?.(err);
    }
  }

  async function establishPeer(): Promise<void> {
    const activeSignaling = await armSignaling();
    const iceServers = activeSignaling.fetchIceServers
      ? await activeSignaling.fetchIceServers()
      : pairing.iceServers ?? [];
    status = "connecting";
    const pc = await provider.create({
      iceServers,
      iceTransportPolicy: pairing.iceTransportPolicy,
      certificatePemFile: pairing.certificatePemFile,
      keyPemFile: pairing.keyPemFile,
    });
    peer = pc;
    peerHasRemote = false;
    // Pre-negotiated channels with the SAME ids the offerer opens.
    control = pc.createDataChannel(CONTROL_LABEL, { ordered: true, negotiated: true, id: CONTROL_CHANNEL_ID });
    bulk = pc.createDataChannel(BULK_LABEL, { ordered: true, negotiated: true, id: BULK_CHANNEL_ID });
    control.bufferedAmountLowThreshold = chunkSize;
    bulk.bufferedAmountLowThreshold = BULK_BUFFER_HIGH_WATER;

    peerUnsubs.push(
      control.onMessage((d) => {
        const full = controlCodec.accept(d);
        if (full) controlHandler?.(full);
      }),
      pc.onLocalDescription((desc) => {
        const current = signaling;
        if (!current) return;
        void current.sendDescription(desc).catch((e) => console.warn(`${log} sendDescription`, e));
      }),
      pc.onLocalCandidate((cand) => {
        const current = signaling;
        if (!current) return;
        void current.sendCandidate(cand).catch((e) => console.warn(`${log} sendCandidate`, e));
      }),
      pc.onConnectionStateChange((s) => onConnectionState(s)),
    );

    const queuedDescriptions = pendingDescriptions.splice(0);
    for (const desc of queuedDescriptions) {
      await onRemoteDescription(desc);
    }
    const queuedCandidates = pendingCandidates.splice(0);
    for (const cand of queuedCandidates) {
      await pc
        .addRemoteCandidate(cand)
        .catch((e) => console.warn(`${log} addRemoteCandidate`, e));
    }
  }

  function teardownPeer(): void {
    // Stale control fragments from the dead pipe must not reassemble against the
    // re-paired pipe's first frames.
    controlCodec.reset();
    pendingDescriptions.length = 0;
    pendingCandidates.length = 0;
    for (const off of peerUnsubs.splice(0)) {
      try {
        off();
      } catch {
        /* ignore */
      }
    }
    try {
      control?.close();
    } catch {
      /* ignore */
    }
    try {
      bulk?.close();
    } catch {
      /* ignore */
    }
    try {
      peer?.close();
    } catch {
      /* ignore */
    }
    peer = null;
    control = null;
    bulk = null;
    peerHasRemote = false;
  }

  async function onRemoteDescription(desc: { type: "offer" | "answer"; sdp: string }): Promise<void> {
    if (closed) return;
    if (desc.type === "offer" && peerHasRemote) {
      // Re-pairing: a fresh host offer arrived after the current peer was already
      // negotiated — e.g. the mobile host reloaded from the bootstrap into the
      // workspace app, or any offerer did a full re-establish (webrtcClient's
      // reestablish() builds a NEW PeerConnection + DTLS, not restartIce). A new
      // offer on the established peer is rejected by libdatachannel ("Invalid ICE
      // settings from remote SDP"), so tear the used peer down + re-arm a fresh one.
      console.warn(`${log} re-pairing: new offer on a used peer — resetting`);
      onDown("re-pairing offer");
      teardownPeer();
      await establishPeer();
    }
    if (!peer || closed) return;
    await peer.setRemoteDescription(desc);
    peerHasRemote = true;
    if (desc.type === "offer") {
      const answer = await peer.createAnswer();
      await peer.setLocalDescription(answer);
    }
  }

  function onConnectionState(state: RtcConnectionState): void {
    if (closed) return;
    if (state === "connected") {
      status = "connected";
      resolveConnect?.();
      connectResolved = true;
    } else if (state === "failed" || state === "disconnected") {
      onDown(`ICE ${state}`);
    }
  }

  function notifyDown(reason: string): void {
    for (const handler of [...downHandlers]) {
      try {
        handler(reason);
      } catch {
        /* ignore */
      }
    }
  }

  function onDown(reason: string): void {
    if (closed) return;
    const wasDisconnected = status === "disconnected";
    if (!wasDisconnected) {
      console.warn(`${log} pipe down: ${reason}`);
      notifyDown(reason);
    }
    status = "disconnected";
    // Re-arm a resolved connect promise so a connect()/ready() while waiting for the
    // re-pairing offer awaits the new pipe rather than returning the stale resolved one.
    if (connectResolved) {
      connectResolved = false;
      connectPromise = new Promise<void>((resolve, reject) => {
        resolveConnect = resolve;
        rejectConnect = (error) => {
          connectPromise = null;
          reject(error);
        };
      });
      void connectPromise.catch(() => {});
    }
    // The offerer drives reconnection (ICE-restart / re-establish) over the
    // persistent signaling room; the answerer just waits for the new offer.
  }

  return {
    writeControl(data: Uint8Array): Promise<void> {
      const ch = control;
      if (!ch || ch.readyState !== "open") return Promise.resolve();
      // Fragment large frames: RN corrupts >16 KiB data-channel messages, and an
      // RPC response/event can exceed the cap. The offerer reassembles by id. The
      // fragments serialize + drain through controlWriteChain (backpressure); the
      // returned promise resolves once THIS frame's fragments have drained.
      const max = Math.min(chunkSize, ch.maxMessageSize || chunkSize);
      const parts = controlCodec.frame(data, max);
      const p = controlWriteChain
        .then(() => writeControlParts(parts))
        .catch((e) => console.warn(`${log} writeControl`, e));
      controlWriteChain = p;
      return p;
    },
    writeBulk(data: Uint8Array): void {
      // Enqueue behind any in-flight bulk write so each frame's chunks stay
      // contiguous (see writeBulkChunks) — parallel streams must not interleave.
      bulkWriteChain = bulkWriteChain
        .then(() => writeBulkChunks(data))
        .catch((e) => console.warn(`${log} writeBulk`, e));
    },
    controlBufferedAmount(): number {
      return control?.bufferedAmount ?? 0;
    },
    onControl(handler: (data: Uint8Array) => void): void {
      controlHandler = handler;
    },
    onDown(handler: (reason: string) => void): () => void {
      downHandlers.add(handler);
      return () => downHandlers.delete(handler);
    },
    async connect(): Promise<void> {
      if (closed) throw new Error("Answerer pipe closed");
      if (status === "connected") return;
      if (connectPromise) return connectPromise;
      connectPromise = new Promise<void>((resolve, reject) => {
        resolveConnect = resolve;
        rejectConnect = (error) => {
          connectPromise = null;
          reject(error);
        };
      });
      void connectPromise.catch(() => {});
      try {
        await establishPeer();
      } catch (error) {
        // Provider/signaling setup threw — reject + clear so a later connect()
        // retries instead of awaiting a poisoned, never-settling promise.
        rejectConnect?.(error instanceof Error ? error : new Error(String(error)));
        throw error;
      }
      return connectPromise;
    },
    status(): RpcConnectionStatus {
      return status;
    },
    async close(): Promise<void> {
      if (!closed) notifyDown("answerer pipe closed");
      closed = true;
      // Settle a pending connect promise so an awaiting connect() rejects, not hangs.
      rejectConnect?.(new Error("Answerer pipe closed"));
      teardownPeer();
      teardownSignaling(true);
      status = "disconnected";
    },
  };
}
