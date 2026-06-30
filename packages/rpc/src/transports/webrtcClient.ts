/**
 * WebRTC RPC transport — the single peer-to-peer pipe that replaces remote-mode
 * WebSocket ingress (plan §1). It is the **host↔server** pipe; the host (shell)
 * multiplexes N logically-authenticated sessions over it: its own `shell`
 * session plus one `panel:<key>` session per panel (each redeeming its own
 * one-time connection grant — per-panel principal identity is preserved, the
 * pipe never collapses panels into the host principal).
 *
 * - **control channel** (reliable/ordered): JSON `SessionControlFrame`s —
 *   handshake, RPC envelopes, events, routing, stream init/cancel, keepalive.
 * - **bulk channel** (reliable/ordered): binary `streamCodec` v2 frames
 *   (`[streamId:4]…`) carrying proxyFetch/asset bodies, demuxed by stream id.
 *
 * Security: DTLS authenticates the *pipe* (the observed remote fingerprint is
 * pinned against the QR `fp`, FAIL-CLOSED on mismatch); per-session grants
 * authorize each *principal*. Confidentiality holds end-to-end even when relayed
 * through TURN (DTLS is never terminated by the relay).
 *
 * The transport is written entirely against the `webrtcPeer`/`webrtcSignaling`
 * interfaces, so it carries NO native dependency and is exercised in tests with
 * in-memory fakes (`webrtcClient.test.ts`).
 */

import type {
  AuthenticatedCaller,
  CallerKind,
  EnvelopeRpcTransport,
  RpcConnectionStatus,
  RpcEnvelope,
  RpcStreamRequest,
} from "../types.js";
import {
  type InboundStreamMux,
  type DecodedFramedStream,
  createInboundStreamMux,
  decodeFramedResponseToStreaming,
  decodeFramedStream,
  StreamFrameDecoderV2,
} from "../protocol/streamCodec.js";
import { createControlCodec } from "./controlFraming.js";
import { awaitDrain, writeChunked } from "./channelIo.js";
import {
  SESSION_CLOSE,
  SESSION_OPEN,
  SESSION_PING,
  SESSION_RPC,
  SESSION_ROUTE,
  SESSION_STREAM_CANCEL,
  SESSION_STREAM_OPEN,
  type SessionControlFrame,
  type SessionEventFrame,
  type SessionOpenResultFrame,
  type SessionRoutedFrame,
  type SessionRoutedResponseErrorFrame,
  type SessionRpcFrame,
  decodeControlFrame,
  encodeControlFrame,
} from "../protocol/sessionNegotiation.js";
import type { RecoveryKind } from "../protocol/recoveryCoordinator.js";
import type {
  PeerConnectionProvider,
  RtcCandidateType,
  RtcConnectionState,
  RtcDataChannelLike,
  RtcPeerConnectionLike,
  WebRtcPairing,
} from "./webrtcPeer.js";
import {
  BULK_CHANNEL_ID,
  BULK_LABEL,
  CONTROL_CHANNEL_ID,
  CONTROL_LABEL,
  DEFAULT_CHUNK_SIZE,
} from "./webrtcPeer.js";
import type { SignalingClient } from "./webrtcSignaling.js";
// Upper bound on the INITIAL connect. Generous enough for a slow relayed (TURN)
// DTLS handshake, but finite so an unreachable peer fails loud instead of hanging
// the caller's "connecting" spinner forever. Reconnects (reestablish) are NOT
// bounded by this — the caller is already up and the transport recovers in place.
const DEFAULT_CONNECT_TIMEOUT_MS = 30_000;
const KEEPALIVE_INTERVAL_MS = 15_000;
const KEEPALIVE_TIMEOUT_MS = 45_000;

export const PIPE_CLOSED_CODE = "PIPE_CLOSED";
export const FINGERPRINT_MISMATCH_CODE = "DTLS_FINGERPRINT_MISMATCH";

function errorWithCode(message: string, code: string): Error {
  const e = new Error(message) as Error & { code?: string };
  e.code = code;
  return e;
}

/** Normalize a DTLS SHA-256 fingerprint for comparison (strip colons, upcase). */
function normalizeFingerprint(fp: string): string {
  return fp.replace(/[:\s]/g, "").toUpperCase();
}

export interface WebRtcSessionOptions {
  /** Logical session id (defaults to the connectionId, or a random id). */
  sid?: string;
  /** This principal's caller kind ('panel' | 'shell' | …). */
  callerKind?: CallerKind | "unknown";
  /** Host-chosen connection id — the lease key the server's gate matches. */
  connectionId?: string;
  clientLabel?: string;
  clientSessionId?: string;
  clientPlatform?: "desktop" | "headless" | "mobile";
  /**
   * Token provider for this session's one-time connection grant. Re-invoked on
   * every (re)open because grants are one-shot (rpcServer redeem consumes them).
   */
  getToken(): Promise<string> | string;
  /** Recovery hook — fired with 'cold-recover' | 'resubscribe' on re-open. */
  onRecovery?: (kind: RecoveryKind) => void;
  /**
   * Fired once when this session authenticated by redeeming a pairing code: the
   * freshly issued device credential to persist for reconnects. Only the first
   * (pairing) open delivers it.
   */
  onPaired?: (credential: { deviceId: string; refreshToken: string }) => void;
}

/** A logical session over the pipe — a full `EnvelopeRpcTransport`. */
export interface WebRtcSession extends EnvelopeRpcTransport {
  readonly sid: string;
  /** Resolved server identity after handshake (callerId the server assigned). */
  callerId(): string | undefined;
  /** True once the server terminally closed this logical session (e.g. a lease
   * revoke). `send()` then throws "Session is closed"; callers must not reuse it —
   * the transport status can still read "connected" (the pipe outlives sessions). */
  isClosed(): boolean;
  close(): void;
}

export interface WebRtcTransportOptions {
  provider: PeerConnectionProvider;
  /**
   * Factory for the signaling-room client. Invoked once per (re)establish so a
   * recovery gets a FRESH signaling connection: the room WS idle-closes after the
   * pipe connects (e.g. a dev-worker 1006 timeout), and that closed instance
   * cannot be reused to exchange the next offer/answer.
   */
  createSignaling: () => SignalingClient;
  pairing: WebRtcPairing;
  /** 'offerer' (client/host) creates the offer; 'answerer' is the server side. */
  role?: "offerer" | "answerer";
  chunkSize?: number;
  logPrefix?: string;
  /** Upper bound (ms) on the initial connect before it rejects (default 30s).
   * Reconnects are not bounded by this. */
  connectTimeoutMs?: number;
  /** Observability: selected ICE candidate type changed (host/srflx/**relay**). */
  onCandidateType?: (type: RtcCandidateType | null) => void;
}

export interface WebRtcTransport {
  /** Establish the pipe (idempotent); resolves once DTLS is pinned + channels open. */
  connect(): Promise<void>;
  ready(): Promise<void>;
  status(): RpcConnectionStatus;
  onStatusChange(handler: (status: RpcConnectionStatus) => void): () => void;
  /** Open a logical authenticated session — returns its `EnvelopeRpcTransport`. */
  openSession(options: WebRtcSessionOptions): WebRtcSession;
  /** Last selected ICE candidate-pair type — 'relay' means TURN engaged (alarm). */
  candidateType(): RtcCandidateType | null;
  close(): Promise<void>;
}

export function createWebRtcTransport(options: WebRtcTransportOptions): WebRtcTransport {
  const { provider, pairing } = options;
  // The CURRENT signaling client — (re)created per establishPeer via
  // options.createSignaling and closed on teardown. Held so close() can release it.
  let signaling: SignalingClient | null = null;
  const role = options.role ?? "offerer";
  const chunkSize = options.chunkSize ?? DEFAULT_CHUNK_SIZE;
  const log = options.logPrefix ?? "[webrtc]";

  let peer: RtcPeerConnectionLike | null = null;
  let control: RtcDataChannelLike | null = null;
  let bulk: RtcDataChannelLike | null = null;
  // Control writes serialize + drain through this chain (backpressure for large
  // fragmented control frames); survives reconnect (awaitDrain escapes on close).
  let controlWriteChain: Promise<void> = Promise.resolve();
  let generation = 0;
  let status: RpcConnectionStatus = "disconnected";
  let connectPromise: Promise<void> | null = null;
  let resolveConnect: (() => void) | null = null;
  let rejectConnect: ((error: unknown) => void) | null = null;
  let connectTimer: ReturnType<typeof setTimeout> | null = null;
  // Whether connectPromise has resolved (the pipe came up). Gates re-arming it on
  // pipe-down: re-arm a SETTLED promise so recovery-time connect()/ready() awaits
  // the new pipe, but leave a still-pending initial connect alone (its caller awaits it).
  let connectResolved = false;
  let closed = false;
  let lastPongAt = 0;
  let keepaliveTimer: ReturnType<typeof setInterval> | null = null;
  let reconnectAttempt = 0;
  let recovering = false;
  let pinVerified = false;
  const unsubs: Array<() => void> = [];

  const statusListeners = new Set<(status: RpcConnectionStatus) => void>();
  const sessions = new Map<string, SessionImpl>();
  const inboundMux: InboundStreamMux = createInboundStreamMux();
  // Bulk channel → demux v2 frames into per-stream bodies. The Response itself
  // resolves inside decodeFramedResponseToStreaming when the HEAD frame lands.
  const bulkDecoder = new StreamFrameDecoderV2((streamId, type, payload) => {
    inboundMux.push(streamId, type, payload);
  });
  // Control-channel framing: fragment large frames on send + reassemble on receive,
  // plus the frame-id counter — bundled in one codec, reset on reconnect. RN corrupts
  // >16 KiB messages, so the fragmentation is what keeps large RPC envelopes intact.
  const controlCodec = createControlCodec();
  let nextStreamId = 1;

  function setStatus(next: RpcConnectionStatus): void {
    if (status === next) return;
    status = next;
    for (const listener of statusListeners) {
      try {
        listener(next);
      } catch (error) {
        console.warn(`${log} status listener threw`, error);
      }
    }
  }

  // -- channel writes (drain + chunking shared via channelIo) ---------------

  function writeControlFrame(frame: SessionControlFrame): void {
    if (!control || control.readyState !== "open") {
      throw errorWithCode("WebRTC control channel not open", PIPE_CLOSED_CODE);
    }
    const bytes = new TextEncoder().encode(encodeControlFrame(frame));
    const max = Math.min(chunkSize, control.maxMessageSize || chunkSize);
    const parts = controlCodec.frame(bytes, max);
    // Keep the synchronous open-check/throw (callers rely on it), but serialize +
    // drain the actual fragment sends so a large control frame (now fragmented)
    // doesn't push every fragment at once and balloon the shared control buffer.
    controlWriteChain = controlWriteChain
      .then(() => writeControlParts(parts))
      .catch((error) => console.warn(`${log} writeControl error: ${(error as Error).message}`));
  }

  async function writeControlParts(parts: Uint8Array[]): Promise<void> {
    const channel = control;
    if (!channel || channel.readyState !== "open") return;
    for (const part of parts) {
      await awaitDrain(channel);
      channel.send(part);
    }
  }

  async function writeBulk(bytes: Uint8Array): Promise<void> {
    const channel = bulk;
    if (!channel || channel.readyState !== "open") {
      throw errorWithCode("WebRTC bulk channel not open", PIPE_CLOSED_CODE);
    }
    await writeChunked(channel, bytes, chunkSize);
  }

  // -- inbound control demux ------------------------------------------------

  function handleControlMessage(data: Uint8Array, forGeneration: number): void {
    if (forGeneration !== generation || closed) return;
    const full = controlCodec.accept(data);
    if (!full) return; // incomplete fragment set (or malformed — dropped)
    let frame: SessionControlFrame;
    try {
      frame = decodeControlFrame(new TextDecoder().decode(full));
    } catch (error) {
      console.warn(`${log} dropping malformed control frame`, error);
      return;
    }
    switch (frame.t) {
      case "pong":
        lastPongAt = Date.now();
        return;
      case "ping":
        try {
          writeControlFrame({ t: "pong", ts: frame.ts });
        } catch {
          /* pipe gone */
        }
        return;
      case "open-result":
        sessions.get(frame.sid)?.onOpenResult(frame);
        return;
      case "closed":
        sessions.get(frame.sid)?.onServerClosed(frame.code, frame.reason, frame.terminal ?? false);
        return;
      case "rpc":
      case "routed":
        sessions.get(frame.sid)?.deliverEnvelope((frame as SessionRpcFrame | SessionRoutedFrame).envelope);
        return;
      case "event":
        sessions.get(frame.sid)?.deliverServerEvent(frame as SessionEventFrame);
        return;
      case "routed-response-error":
        sessions.get(frame.sid)?.deliverRoutedResponseError(frame as SessionRoutedResponseErrorFrame);
        return;
      case "routed-event-error":
        // Best-effort events: warn only (parity with wsClient.ts:204-212).
        console.warn(`${log} routed event undeliverable`, frame);
        return;
      default:
        // open/close/route/stream-* are answerer-handled; offerer ignores.
        return;
    }
  }

  function reopenSession(session: SessionImpl): void {
    // Fire-and-forget reopen drives the session handshake. Callers that care await
    // ready(), which observes the same openPromise rejection; this catch only
    // prevents the background reopen() promise from becoming an unhandled
    // rejection on expected terminal auth failures.
    void session.reopen().catch(() => undefined);
  }

  // -- signaling + peer lifecycle ------------------------------------------

  async function establishPeer(): Promise<void> {
    // Fresh signaling per (re)establish — see createSignaling. Close the previous
    // one first; the local `sig` binds this establish's handlers to ITS signaling
    // so a later re-establish (which reassigns the outer `signaling`) cannot make
    // an in-flight handler send into the wrong socket.
    try {
      signaling?.close();
    } catch {
      /* already closed */
    }
    const sig = options.createSignaling();
    signaling = sig;
    const iceServers = sig.fetchIceServers
      ? await sig.fetchIceServers()
      : pairing.iceServers ?? [];
    const thisGeneration = ++generation;
    setStatus("connecting");

    const pc = await provider.create({
      iceServers,
      iceTransportPolicy: pairing.iceTransportPolicy,
    });
    peer = pc;

    // Pre-negotiated channels: both peers open matching ids, no ondatachannel race.
    const controlChannel = pc.createDataChannel(CONTROL_LABEL, {
      ordered: true,
      negotiated: true,
      id: CONTROL_CHANNEL_ID,
    });
    const bulkChannel = pc.createDataChannel(BULK_LABEL, {
      ordered: true,
      negotiated: true,
      id: BULK_CHANNEL_ID,
    });
    control = controlChannel;
    bulk = bulkChannel;
    controlChannel.bufferedAmountLowThreshold = chunkSize;
    bulkChannel.bufferedAmountLowThreshold = chunkSize;

    unsubs.push(
      controlChannel.onMessage((d) => handleControlMessage(d, thisGeneration)),
      // Channels open just AFTER ICE 'connected'; completion waits for both
      // (writing a frame to a still-'connecting' channel would throw).
      controlChannel.onOpen(() => tryComplete(thisGeneration)),
      bulkChannel.onOpen(() => tryComplete(thisGeneration)),
      bulkChannel.onMessage((d) => {
        if (thisGeneration !== generation || closed) return;
        void bulkDecoder.push(d);
      }),
      controlChannel.onClose(() => {
        if (thisGeneration !== generation) return;
        onPipeDown("control channel closed");
      }),
    );

    // Signaling glue.
    unsubs.push(
      pc.onLocalDescription((desc) => void sig.sendDescription(desc).catch((e) => console.warn(`${log} sendDescription`, e))),
      pc.onLocalCandidate((cand) => void sig.sendCandidate(cand).catch((e) => console.warn(`${log} sendCandidate`, e))),
      sig.onDescription((desc) => void onRemoteDescription(desc, thisGeneration)),
      sig.onCandidate((cand) => void pc.addRemoteCandidate(cand).catch((e) => console.warn(`${log} addRemoteCandidate`, e))),
      sig.onClosed((reason) => {
        // Signaling is the rendezvous for the handshake (offer/answer/ICE) only.
        // Once the pipe is connected it is independent of signaling, so a
        // signaling-WS close — e.g. an idle dev-worker timeout (code 1006) — must
        // NOT tear down a healthy pipe. Only a close DURING the handshake is fatal.
        if (status !== "connected") onPipeDown(`signaling closed: ${reason ?? ""}`);
      }),
      pc.onConnectionStateChange((state) => onConnectionState(state, thisGeneration)),
    );

    if (role === "offerer") {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
    }
  }

  async function onRemoteDescription(desc: { type: "offer" | "answer"; sdp: string }, forGeneration: number): Promise<void> {
    if (forGeneration !== generation || !peer) return;
    await peer.setRemoteDescription(desc);
    if (desc.type === "offer" && role === "answerer") {
      const answer = await peer.createAnswer();
      await peer.setLocalDescription(answer);
    }
  }

  function onConnectionState(state: RtcConnectionState, forGeneration: number): void {
    if (forGeneration !== generation || closed) return;
    if (state === "connected") {
      options.onCandidateType?.(peer?.selectedCandidateType() ?? null);
      tryComplete(forGeneration);
    } else if (state === "failed") {
      onPipeDown(`ICE ${state}`);
    }
    // ICE "disconnected" is TRANSIENT — the agent keeps probing and usually
    // recovers to "connected" (common on relay paths / flaky links). Tearing the
    // pipe down here would abort a recoverable connection mid-transfer; the
    // keepalive timeout is the backstop if it never comes back.
  }

  /**
   * Idempotently complete the connection once BOTH the DTLS pin is verified and
   * the control+bulk channels are open. Triggered by ICE 'connected' AND by each
   * channel's onOpen (whichever lands last), so we never declare the pipe ready
   * before a frame can actually be written.
   */
  function tryComplete(forGeneration: number): void {
    if (forGeneration !== generation || closed || status === "connected") return;
    if (!peer || !control || !bulk) return;
    if (!pinVerified) {
      const observed = peer.remoteFingerprint();
      if (!observed) return; // DTLS not settled yet — a later trigger retries
      if (normalizeFingerprint(observed) !== normalizeFingerprint(pairing.fingerprint)) {
        // FAIL CLOSED — a signaling box that swapped the fingerprint is rejected;
        // no RPC ever flows over an unpinned pipe (plan §6.1, proven §11).
        const error = errorWithCode(
          `DTLS fingerprint mismatch: observed ${observed} != pinned ${pairing.fingerprint}`,
          FINGERPRINT_MISMATCH_CODE,
        );
        console.error(`${log} ${error.message}`);
        rejectConnect?.(error);
        void hardClose();
        return;
      }
      pinVerified = true;
    }
    if (control.readyState !== "open" || bulk.readyState !== "open") return; // wait for channel-open
    setStatus("connected");
    lastPongAt = Date.now();
    reconnectAttempt = 0;
    startKeepalive();
    resolveConnect?.();
    connectResolved = true;
    // (Re)open every live session over the (re)established pipe.
    for (const session of sessions.values()) reopenSession(session);
  }

  function onPipeDown(reason: string): void {
    if (closed || recovering) return;
    setStatus("disconnected");
    stopKeepalive();
    // The connect promise resolved when this (now-dead) pipe first came up, so
    // re-arm it to a fresh pending one — otherwise ready()/connect() during recovery
    // would return the stale resolved promise and proceed over a down pipe. Only
    // re-arm a promise that HAD resolved (don't disturb a pending initial connect).
    if (connectResolved) {
      connectResolved = false;
      connectPromise = new Promise<void>((resolve, reject) => {
        resolveConnect = resolve;
        rejectConnect = (error) => {
          connectPromise = null;
          reject(error);
        };
      });
    }
    // Fail loud: reject in-flight streams + server→client bridge calls now; the
    // sessions re-open after recovery (callers retry against a live pipe).
    inboundMux.closeAll(errorWithCode(`WebRTC pipe down: ${reason}`, PIPE_CLOSED_CODE));
    for (const session of sessions.values()) session.onPipeDown(reason);
    void reestablish(reason);
  }

  /**
   * Recover by re-establishing the peer over the PERSISTENT signaling room
   * (plan §1/§2). We do a full re-establish (new PeerConnection + DTLS) rather
   * than relying on `restartIce()`, which `node-datachannel` may not expose —
   * full re-establish is the reliable path on every native stack, re-verifies
   * the fingerprint pin, and auto-reopens every session. Backoff+jitter mirrors
   * the WS transport (capped 30 s). `generation` (bumped inside establishPeer)
   * fences any late callbacks from the torn-down peer.
   */
  async function reestablish(reason: string): Promise<void> {
    if (closed || recovering) return;
    recovering = true;
    setStatus("connecting");
    // Drop the old peer + its subscriptions before standing up a new one.
    for (const off of unsubs.splice(0)) {
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
    control = bulk = null;
    peer = null;
    pinVerified = false;
    // A fresh pipe must not reassemble against the dead pipe's leftovers: drop any
    // half-decoded bulk stream frames and half-reassembled control fragments.
    bulkDecoder.reset();
    controlCodec.reset();
    const delay = Math.min(1000 * 2 ** reconnectAttempt + Math.random() * 500, 30_000);
    reconnectAttempt++;
    await new Promise((r) => setTimeout(r, delay));
    recovering = false;
    if (closed) return;
    console.warn(`${log} re-establishing pipe (attempt ${reconnectAttempt}, after: ${reason})`);
    try {
      await establishPeer();
    } catch (error) {
      onPipeDown(`re-establish failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  function startKeepalive(): void {
    stopKeepalive();
    keepaliveTimer = setInterval(() => {
      if (!control || control.readyState !== "open") return;
      if (Date.now() - lastPongAt > KEEPALIVE_TIMEOUT_MS) {
        onPipeDown("keepalive timeout");
        return;
      }
      try {
        writeControlFrame({ t: SESSION_PING, ts: Date.now() });
      } catch {
        /* pipe gone */
      }
    }, KEEPALIVE_INTERVAL_MS);
    (keepaliveTimer as { unref?: () => void }).unref?.();
  }

  function stopKeepalive(): void {
    if (keepaliveTimer) {
      clearInterval(keepaliveTimer);
      keepaliveTimer = null;
    }
  }

  async function hardClose(): Promise<void> {
    closed = true;
    // Settle any pending connect promise (initial OR re-armed during recovery) so
    // an awaiting connect()/ready() rejects rather than hanging on a closed pipe.
    rejectConnect?.(errorWithCode("Transport closed", PIPE_CLOSED_CODE));
    stopKeepalive();
    for (const off of unsubs.splice(0)) {
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
    try {
      signaling?.close();
    } catch {
      /* ignore */
    }
    setStatus("disconnected");
  }

  // -- stream multiplex ----------------------------------------------------

  function allocateStream(): number {
    const id = nextStreamId;
    nextStreamId = (nextStreamId % 0x7fffffff) + 1;
    return id;
  }

  function beginStream(
    sid: string,
    envelope: RpcEnvelope,
    signal?: AbortSignal | null
  ): ReadableStream<Uint8Array> {
    const streamId = allocateStream();
    const body = inboundMux.acquire(streamId);
    // Send the stream-open control frame; the response body rides the bulk channel.
    writeControlFrame({ t: SESSION_STREAM_OPEN, sid, streamId, envelope });
    if (signal) {
      const onAbort = (): void => {
        try {
          writeControlFrame({ t: SESSION_STREAM_CANCEL, sid, streamId });
        } catch {
          /* pipe gone */
        }
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
    return body;
  }

  function openStream(
    sid: string,
    envelope: RpcEnvelope,
    signal?: AbortSignal | null
  ): Promise<Response> {
    return decodeFramedResponseToStreaming(beginStream(sid, envelope, signal), "", signal);
  }

  function openStreamReadable(
    sid: string,
    envelope: RpcEnvelope,
    signal?: AbortSignal | null
  ): Promise<DecodedFramedStream> {
    return decodeFramedStream(beginStream(sid, envelope, signal), "", signal);
  }

  // -- session implementation ----------------------------------------------

  class SessionImpl implements WebRtcSession {
    readonly sid: string;
    private readonly messageListeners = new Set<(envelope: RpcEnvelope) => void>();
    private resolvedCallerId: string | undefined;
    private lastServerBootId: string | undefined;
    private hasOpenedBefore = false;
    private openResolve: (() => void) | null = null;
    private openReject: ((error: unknown) => void) | null = null;
    private openPromise: Promise<void> | null = null;
    private sessionClosed = false;

    constructor(private readonly opts: WebRtcSessionOptions) {
      this.sid = opts.sid ?? opts.connectionId ?? `s-${Math.abs(hashString(JSON.stringify(opts.connectionId ?? opts.clientLabel ?? Math.random())))}`;
    }

    callerId(): string | undefined {
      return this.resolvedCallerId;
    }

    async reopen(): Promise<void> {
      if (this.sessionClosed || closed) return;
      // Assign openPromise SYNCHRONOUSLY — before the (possibly async) getToken —
      // so a caller's ready() actually waits for the session to authenticate.
      // ready() resolves immediately when openPromise is unset; with an async
      // token provider (mobile's one-shot panel grant) the old order let ready()
      // resolve BEFORE SESSION_OPEN was even sent, so the caller sent RPC on an
      // unopened session and the server (no shim yet) silently dropped it.
      this.openPromise = new Promise<void>((resolve, reject) => {
        this.openResolve = resolve;
        this.openReject = reject;
      });
      try {
        const token = await this.opts.getToken();
        writeControlFrame({
          t: SESSION_OPEN,
          sid: this.sid,
          token,
          connectionId: this.opts.connectionId,
          clientSessionId: this.opts.clientSessionId,
          clientLabel: this.opts.clientLabel,
          clientPlatform: this.opts.clientPlatform,
        });
      } catch (err) {
        // getToken failed (e.g. grant fetch rejected) — fail ready() loudly
        // instead of leaving it hung on a promise that never settles.
        this.openReject?.(err instanceof Error ? err : new Error(String(err)));
      }
      return this.openPromise;
    }

    onOpenResult(frame: SessionOpenResultFrame): void {
      if (!frame.success) {
        const error = errorWithCode(frame.error ?? "Session auth failed", "SESSION_AUTH_FAILED");
        this.openReject?.(error);
        if (frame.terminal) this.sessionClosed = true;
        return;
      }
      this.resolvedCallerId = frame.callerId;
      // A freshly paired device's credential rides back on the first open-result
      // (the server keeps only its hash). Hand it to the client to persist before
      // resolving ready(), so a reconnect can authenticate with the refresh secret.
      if (frame.deviceCredential) this.opts.onPaired?.(frame.deviceCredential);
      // cold-recover vs resubscribe (parity with wsClient.ts:146-153): server
      // restart (bootId change) OR a dirty session ⇒ cold-recover.
      if (this.hasOpenedBefore) {
        const bootChanged =
          this.lastServerBootId !== undefined &&
          frame.serverBootId !== undefined &&
          this.lastServerBootId !== frame.serverBootId;
        const kind: RecoveryKind = frame.sessionDirty || bootChanged ? "cold-recover" : "resubscribe";
        this.opts.onRecovery?.(kind);
      }
      this.lastServerBootId = frame.serverBootId;
      this.hasOpenedBefore = true;
      this.openResolve?.();
    }

    onServerClosed(code: number | undefined, reason: string | undefined, terminal: boolean): void {
      if (terminal) this.sessionClosed = true;
      this.failPending(errorWithCode(`Session closed: ${reason ?? code ?? ""}`, PIPE_CLOSED_CODE));
    }

    onPipeDown(reason: string): void {
      this.failPending(errorWithCode(`WebRTC pipe down: ${reason}`, PIPE_CLOSED_CODE));
    }

    private failPending(error: Error): void {
      this.openReject?.(error);
      this.openReject = null;
      this.openResolve = null;
      this.openPromise = null;
    }

    deliverEnvelope(envelope: RpcEnvelope): void {
      for (const listener of this.messageListeners) {
        try {
          listener(envelope);
        } catch (error) {
          console.warn(`${log} session ${this.sid} message listener threw`, error);
        }
      }
    }

    deliverServerEvent(frame: SessionEventFrame): void {
      // Synthesize a server-originated event envelope (parity with wsClient.ts:163-179).
      const serverCaller: AuthenticatedCaller = { callerId: "main", callerKind: "server" };
      const envelope: RpcEnvelope = {
        from: "main",
        target: this.resolvedCallerId ?? this.sid,
        delivery: { caller: serverCaller },
        provenance: [serverCaller],
        message: { type: "event", event: frame.event, payload: frame.payload, fromId: "main" },
      };
      this.deliverEnvelope(envelope);
    }

    deliverRoutedResponseError(frame: SessionRoutedResponseErrorFrame): void {
      // Turn an undeliverable routed request into a REJECTING response so the
      // pending call settles (fail-loud, parity with wsClient.ts:180-203).
      const serverCaller: AuthenticatedCaller = { callerId: "main", callerKind: "server" };
      const envelope: RpcEnvelope = {
        from: "main",
        target: this.resolvedCallerId ?? this.sid,
        delivery: { caller: serverCaller },
        provenance: [serverCaller],
        message: {
          type: "response",
          requestId: frame.requestId,
          error: frame.error,
          errorCode: frame.errorCode,
        },
      };
      this.deliverEnvelope(envelope);
    }

    // -- EnvelopeRpcTransport surface --------------------------------------

    async send(envelope: RpcEnvelope): Promise<void> {
      if (this.sessionClosed) throw errorWithCode("Session is closed", "SESSION_AUTH_FAILED");
      if (status !== "connected") throw errorWithCode("Not connected to server", PIPE_CLOSED_CODE);
      // target 'main'/'server' → rpc frame; otherwise caller-to-caller route.
      const frame: SessionControlFrame =
        envelope.target === "main" || envelope.target === "server"
          ? { t: SESSION_RPC, sid: this.sid, envelope }
          : { t: SESSION_ROUTE, sid: this.sid, envelope };
      writeControlFrame(frame);
    }

    onMessage(handler: (envelope: RpcEnvelope) => void): () => void {
      this.messageListeners.add(handler);
      return () => this.messageListeners.delete(handler);
    }

    status(): RpcConnectionStatus {
      return status;
    }

    isClosed(): boolean {
      return this.sessionClosed === true;
    }

    async ready(): Promise<void> {
      await transport.connect();
      if (this.openPromise) await this.openPromise;
    }

    onStatusChange(handler: (status: RpcConnectionStatus) => void): () => void {
      return transport.onStatusChange(handler);
    }

    async stream(envelope: RpcEnvelope, signal?: AbortSignal | null): Promise<Response> {
      if (status !== "connected") throw errorWithCode("Not connected to server", PIPE_CLOSED_CODE);
      const message = envelope.message as RpcStreamRequest;
      if (message.type !== "stream-request") {
        throw new Error(`stream() requires a stream-request envelope, got ${message.type}`);
      }
      return openStream(this.sid, envelope, signal);
    }

    async streamReadable(
      envelope: RpcEnvelope,
      signal?: AbortSignal | null
    ): Promise<DecodedFramedStream> {
      if (status !== "connected") throw errorWithCode("Not connected to server", PIPE_CLOSED_CODE);
      const message = envelope.message as RpcStreamRequest;
      if (message.type !== "stream-request") {
        throw new Error(`streamReadable() requires a stream-request envelope, got ${message.type}`);
      }
      return openStreamReadable(this.sid, envelope, signal);
    }

    close(): void {
      this.sessionClosed = true;
      sessions.delete(this.sid);
      try {
        writeControlFrame({ t: SESSION_CLOSE, sid: this.sid });
      } catch {
        /* pipe gone */
      }
    }
  }

  const transport: WebRtcTransport = {
    async connect(): Promise<void> {
      if (closed) throw errorWithCode("Transport closed", PIPE_CLOSED_CODE);
      if (status === "connected") return;
      if (connectPromise) return connectPromise;
      connectPromise = new Promise<void>((resolve, reject) => {
        resolveConnect = () => {
          if (connectTimer) clearTimeout(connectTimer);
          connectTimer = null;
          resolve();
        };
        rejectConnect = (error) => {
          if (connectTimer) clearTimeout(connectTimer);
          connectTimer = null;
          connectPromise = null;
          reject(error);
        };
      });
      // Bound the initial connect: an unreachable peer never reaches "connected",
      // so neither resolveConnect nor rejectConnect fires (the reestablish loop
      // retries forever without settling this promise) and connect() would hang.
      // The caller closes the transport on rejection, stopping the retry loop.
      const connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
      connectTimer = setTimeout(() => {
        rejectConnect?.(
          errorWithCode(
            `WebRTC connect timed out after ${connectTimeoutMs}ms (peer unreachable)`,
            PIPE_CLOSED_CODE
          )
        );
      }, connectTimeoutMs);
      try {
        await establishPeer();
      } catch (error) {
        // Setup (provider/signaling/ICE) threw before the peer wired its own
        // failure callbacks. Reject + clear the connect promise (rejectConnect
        // nulls connectPromise) so a later connect() retries cleanly instead of
        // awaiting this poisoned, never-settling one.
        rejectConnect?.(error instanceof Error ? error : new Error(String(error)));
        throw error;
      }
      return connectPromise;
    },
    ready(): Promise<void> {
      return transport.connect();
    },
    status(): RpcConnectionStatus {
      return status;
    },
    onStatusChange(handler: (status: RpcConnectionStatus) => void): () => void {
      statusListeners.add(handler);
      return () => statusListeners.delete(handler);
    },
    openSession(opts: WebRtcSessionOptions): WebRtcSession {
      const session = new SessionImpl(opts);
      sessions.set(session.sid, session);
      // If the pipe is already up, open immediately; otherwise reopen() runs on connect.
      if (status === "connected") reopenSession(session);
      return session;
    },
    candidateType(): RtcCandidateType | null {
      return peer?.selectedCandidateType() ?? null;
    },
    close(): Promise<void> {
      return hardClose();
    },
  };

  return transport;
}

function hashString(input: string): number {
  let h = 0;
  for (let i = 0; i < input.length; i++) {
    h = (Math.imul(31, h) + input.charCodeAt(i)) | 0;
  }
  return h;
}
