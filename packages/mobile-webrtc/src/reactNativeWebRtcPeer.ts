/**
 * Native WebRTC peer adapter — `react-native-webrtc` implementing the
 * platform-agnostic `PeerConnectionProvider` contract (plan workstream C). This
 * is the **mobile** sibling of the desktop/server adapter
 * (`src/main/webrtc/nodeDatachannelPeer.ts`): both wrap a native WebRTC stack
 * into the same `RtcPeerConnectionLike`/`RtcDataChannelLike` shape that the
 * transport (`@natstack/rpc/transports/webrtcClient`) codes against, so the
 * transport carries no native dependency and stays unit-testable with fakes.
 *
 * Three impedance mismatches are handled at this boundary:
 *
 *  1. **Event style.** `react-native-webrtc` is standard WHATWG — a WHATWG
 *     `EventTarget` (`addEventListener('icecandidate', …)`) with auto-negotiation.
 *     The contract is the node-datachannel-flavored callback-registration style
 *     (`onLocalDescription(cb) => unsubscribe`, many listeners). Each native
 *     event is registered ONCE and dispatched through a {@link Fanout} so many
 *     contract listeners compose and each gets an unsubscribe.
 *
 *  2. **Negotiation shape.** Unlike node-datachannel (which fuses offer/answer
 *     *creation* with `setLocalDescription` and emits the SDP asynchronously via
 *     `onLocalDescription`), react-native-webrtc does standard negotiation:
 *     `createOffer()` returns the real `{type, sdp}` and `setLocalDescription`
 *     applies it. We are the **offerer**, so after `setLocalDescription` resolves
 *     we read the finalized `pc.localDescription` and emit it through
 *     `onLocalDescription` — exactly what the transport waits on (it calls
 *     `createOffer` → `setLocalDescription`, then relies on the
 *     `onLocalDescription` callback to ship the SDP through signaling).
 *
 *  3. **No `remoteFingerprint()`.** react-native-webrtc exposes no DTLS
 *     fingerprint accessor. The pinned value is the `a=fingerprint:sha-256 …`
 *     line of the REMOTE SDP (`pc.remoteDescription.sdp`). We parse it and return
 *     the uppercase colon-hex form the QR pin uses (matches `normalizeFingerprint`
 *     in `@natstack/shared/connect`). Null until the remote description is set, so
 *     the transport fails closed — it never completes an unpinned pipe.
 *
 * The native surface is described by the local `NativeRtc*` interfaces below
 * (mirroring how the node adapter declares its own `NativePeerConnection`),
 * rather than leaning on `react-native-webrtc`'s shipped `event-target-shim`
 * typings, which do not surface `addEventListener` to consumers.
 */

import { RTCIceCandidate, RTCPeerConnection } from "react-native-webrtc";
import type {
  PeerConnectionProvider,
  RtcCandidateType,
  RtcConnectionState,
  RtcDataChannelInit,
  RtcDataChannelLike,
  RtcDataChannelState,
  RtcIceCandidate,
  RtcIceServer,
  RtcPeerConfig,
  RtcPeerConnectionLike,
  RtcSessionDescription,
} from "@natstack/rpc/transports/webrtcPeer";
import { parseSdpFingerprint } from "@natstack/rpc/transports/webrtcPeer";

/**
 * SCTP max message size honored by the bulk channel. react-native-webrtc (like
 * libdatachannel) does not surface a `maxMessageSize` accessor, so we report the
 * standard 256 KB SCTP cap; the transport chunks at `min(chunkSize, this)`, so a
 * value at-or-above its conservative chunk size keeps writes within one message.
 */
const SCTP_MAX_MESSAGE_SIZE = 262144;

// ===========================================================================
// Minimal native surface — only what this adapter touches, typed locally so the
// wrapper does not depend on react-native-webrtc's event-target-shim typings.
// ===========================================================================

interface NativeSessionDescription {
  type: string | null;
  sdp: string;
}

interface NativeIceCandidate {
  candidate: string;
  sdpMid?: string | null;
  sdpMLineIndex?: number | null;
}

interface NativeMessageEvent {
  data: string | ArrayBuffer;
}

interface NativeIceCandidateEvent {
  candidate: NativeIceCandidate | null;
}

interface NativeRtcDataChannel {
  readonly label: string;
  readonly readyState: string;
  readonly bufferedAmount: number;
  binaryType: string;
  bufferedAmountLowThreshold: number;
  send(data: string | ArrayBuffer | ArrayBufferView): void;
  close(): void;
  addEventListener(type: "open" | "close" | "closing" | "error" | "bufferedamountlow", listener: () => void): void;
  addEventListener(type: "message", listener: (event: NativeMessageEvent) => void): void;
}

interface NativeRtcPeerConnection {
  readonly connectionState: string;
  readonly iceConnectionState: string;
  readonly localDescription: NativeSessionDescription | null;
  readonly remoteDescription: NativeSessionDescription | null;
  createDataChannel(
    label: string,
    init?: { ordered?: boolean; negotiated?: boolean; id?: number },
  ): NativeRtcDataChannel;
  createOffer(): Promise<{ type?: string; sdp?: string }>;
  createAnswer(): Promise<{ type?: string; sdp?: string }>;
  setLocalDescription(desc?: NativeSessionDescription): Promise<void>;
  setRemoteDescription(desc: NativeSessionDescription): Promise<void>;
  addIceCandidate(candidate: unknown): Promise<void>;
  restartIce(): void;
  close(): void;
  addEventListener(type: "connectionstatechange" | "iceconnectionstatechange", listener: () => void): void;
  addEventListener(type: "icecandidate", listener: (event: NativeIceCandidateEvent) => void): void;
  addEventListener(type: "datachannel", listener: (event: { channel: NativeRtcDataChannel }) => void): void;
}

export interface ReactNativeWebRtcProviderOptions {
  /** Log prefix for listener-fault diagnostics (defaults to `[rn-webrtc]`). */
  logPrefix?: string;
}

/**
 * Create the `react-native-webrtc`-backed provider. The client side only ever
 * pins the SERVER's fingerprint, so it presents an ephemeral DTLS cert and never
 * needs `localFingerprint` — the optional provider method is omitted.
 */
export function createReactNativeWebRtcProvider(
  options: ReactNativeWebRtcProviderOptions = {},
): PeerConnectionProvider {
  const log = options.logPrefix ?? "[rn-webrtc]";
  return {
    create(config: RtcPeerConfig): RtcPeerConnectionLike {
      const pc = new RTCPeerConnection({
        iceServers: config.iceServers.map(toNativeIceServer),
        iceTransportPolicy: config.iceTransportPolicy,
        // react-native-webrtc gathers ICE candidates incrementally (trickle) and
        // surfaces them via the 'icecandidate' event, which the transport relays.
      }) as unknown as NativeRtcPeerConnection;
      return new WrappedPeerConnection(pc, log);
    },
  };
}

// ===========================================================================
// Pure helpers — no native dependency.
// ===========================================================================

/**
 * Multi-listener fan-out over a single underlying native handler. The contract
 * exposes `onX(handler) => unsubscribe` with many listeners; we register one
 * native `addEventListener` per event that emits here, and let contract-level
 * listeners subscribe/unsubscribe independently. A throwing listener is isolated
 * so it cannot starve the others or break the native callback.
 */
export class Fanout<Args extends unknown[]> {
  private readonly handlers = new Set<(...args: Args) => void>();

  constructor(private readonly log = "[rn-webrtc]") {}

  add(handler: (...args: Args) => void): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  emit(...args: Args): void {
    // Snapshot so a handler that unsubscribes during dispatch is well-defined.
    for (const handler of [...this.handlers]) {
      try {
        handler(...args);
      } catch (error) {
        console.warn(`${this.log} data/peer listener threw`, error);
      }
    }
  }
}

/** Map the contract's WHATWG-shaped ICE server to react-native-webrtc's form. */
function toNativeIceServer(server: RtcIceServer): {
  urls: string | string[];
  username?: string;
  credential?: string;
} {
  return {
    urls: server.urls,
    username: server.username,
    credential: server.credential,
  };
}

/** react-native-webrtc connection states already match the contract; normalize
 * defensively so an unexpected value fails loud as 'failed' rather than leaking. */
export function normalizeConnectionState(raw: string): RtcConnectionState {
  switch (raw) {
    case "new":
      return "new";
    case "connecting":
      return "connecting";
    case "connected":
      return "connected";
    case "disconnected":
      return "disconnected";
    case "failed":
      return "failed";
    case "closed":
      return "closed";
    default:
      console.warn(`[rn-webrtc] unknown connection state '${raw}' → treating as 'failed'`);
      return "failed";
  }
}

// `parseSdpFingerprint` (the fail-closed pin parse) is imported from the shared
// webrtcPeer.ts above — no per-platform copy, so the pin parse can't drift.

// ===========================================================================
// Wrappers — map react-native-webrtc's WHATWG surface onto the contract.
// ===========================================================================

class WrappedDataChannel implements RtcDataChannelLike {
  readonly label: string;
  private readonly openFanout: Fanout<[]>;
  private readonly closeFanout: Fanout<[]>;
  private readonly errorFanout: Fanout<[Error]>;
  private readonly messageFanout: Fanout<[Uint8Array]>;
  private readonly lowFanout: Fanout<[]>;

  constructor(
    private readonly dc: NativeRtcDataChannel,
    log: string,
  ) {
    this.label = dc.label;
    this.openFanout = new Fanout(log);
    this.closeFanout = new Fanout(log);
    this.errorFanout = new Fanout(log);
    this.messageFanout = new Fanout(log);
    this.lowFanout = new Fanout(log);
    // Deliver binary as ArrayBuffer (react-native-webrtc only supports this mode).
    this.dc.binaryType = "arraybuffer";
    // Register exactly one native handler per event; fan out to N listeners.
    this.dc.addEventListener("open", () => this.openFanout.emit());
    this.dc.addEventListener("close", () => this.closeFanout.emit());
    this.dc.addEventListener("error", () =>
      this.errorFanout.emit(new Error(`data channel '${this.label}' error`)),
    );
    this.dc.addEventListener("message", (event) => {
      const data = event.data;
      if (data instanceof ArrayBuffer) {
        // Copy into a fresh view — the contract delivers the raw bytes.
        this.messageFanout.emit(new Uint8Array(data));
      } else if (typeof data === "string") {
        // Control frames ride as binary, but tolerate a text frame defensively.
        this.messageFanout.emit(new TextEncoder().encode(data));
      }
    });
    this.dc.addEventListener("bufferedamountlow", () => this.lowFanout.emit());
  }

  get readyState(): RtcDataChannelState {
    return this.dc.readyState as RtcDataChannelState;
  }

  get bufferedAmount(): number {
    return this.dc.bufferedAmount;
  }

  get bufferedAmountLowThreshold(): number {
    return this.dc.bufferedAmountLowThreshold;
  }

  set bufferedAmountLowThreshold(value: number) {
    this.dc.bufferedAmountLowThreshold = value;
  }

  get maxMessageSize(): number {
    return SCTP_MAX_MESSAGE_SIZE;
  }

  send(data: Uint8Array): void {
    // react-native-webrtc's send(ArrayBufferView) re-slices with byteOffset +
    // byteLength, so the transport's `bytes.subarray(...)` views are sent exactly.
    this.dc.send(data);
  }

  close(): void {
    this.dc.close();
  }

  onOpen(handler: () => void): () => void {
    return this.openFanout.add(handler);
  }

  onClose(handler: () => void): () => void {
    return this.closeFanout.add(handler);
  }

  onError(handler: (error: Error) => void): () => void {
    return this.errorFanout.add(handler);
  }

  onMessage(handler: (data: Uint8Array) => void): () => void {
    return this.messageFanout.add(handler);
  }

  onBufferedAmountLow(handler: () => void): () => void {
    return this.lowFanout.add(handler);
  }
}

export class WrappedPeerConnection implements RtcPeerConnectionLike {
  private readonly stateFanout: Fanout<[RtcConnectionState]>;
  private readonly localDescFanout: Fanout<[RtcSessionDescription]>;
  private readonly localCandFanout: Fanout<[RtcIceCandidate]>;
  private readonly dataChannelFanout: Fanout<[RtcDataChannelLike]>;
  // The SDP last passed to setRemoteDescription — cached so remoteFingerprint()
  // can read the a=fingerprint line back the instant sRD resolves, without
  // depending on the timing of the native remoteDescription accessor.
  private remoteSdp: string | null = null;

  constructor(
    private readonly pc: NativeRtcPeerConnection,
    private readonly log: string,
  ) {
    this.stateFanout = new Fanout(log);
    this.localDescFanout = new Fanout(log);
    this.localCandFanout = new Fanout(log);
    this.dataChannelFanout = new Fanout(log);

    const emitState = (): void =>
      this.stateFanout.emit(normalizeConnectionState(this.pc.connectionState));
    // `connectionState` is the authoritative aggregate (ICE + DTLS); re-read it on
    // both the aggregate and the ICE event so a transition surfaces promptly.
    this.pc.addEventListener("connectionstatechange", emitState);
    this.pc.addEventListener("iceconnectionstatechange", () => {
      // ICE 'failed' means the pipe is down even if the aggregate lags; surface it
      // explicitly so the transport's recovery fires (fail-loud).
      if (this.pc.iceConnectionState === "failed") this.stateFanout.emit("failed");
      else emitState();
    });
    this.pc.addEventListener("icecandidate", (event) => {
      const candidate = event.candidate;
      // A null candidate (or empty string) is the end-of-candidates marker — the
      // node adapter trickles real candidates only; match that.
      if (!candidate || !candidate.candidate) return;
      this.localCandFanout.emit({
        candidate: candidate.candidate,
        sdpMid: candidate.sdpMid ?? null,
        sdpMLineIndex: candidate.sdpMLineIndex ?? null,
      });
    });
    // Answerer-side / non-negotiated channels — unused on the offerer path (which
    // pre-negotiates control+bulk by id), but wired for contract completeness.
    this.pc.addEventListener("datachannel", (event) => {
      this.dataChannelFanout.emit(new WrappedDataChannel(event.channel, this.log));
    });
  }

  createDataChannel(label: string, init?: RtcDataChannelInit): RtcDataChannelLike {
    const dc = this.pc.createDataChannel(label, {
      ordered: init?.ordered ?? true,
      negotiated: init?.negotiated ?? false,
      id: init?.id,
    });
    return new WrappedDataChannel(dc, this.log);
  }

  async createOffer(): Promise<RtcSessionDescription> {
    const offer = await this.pc.createOffer();
    return { type: "offer", sdp: offer.sdp ?? "" };
  }

  async createAnswer(): Promise<RtcSessionDescription> {
    const answer = await this.pc.createAnswer();
    return { type: "answer", sdp: answer.sdp ?? "" };
  }

  async setLocalDescription(desc?: RtcSessionDescription): Promise<void> {
    await this.pc.setLocalDescription(desc ? { type: desc.type, sdp: desc.sdp } : undefined);
    // Standard negotiation: the local SDP is final on `pc.localDescription` once
    // sLD resolves. Emit it so the transport ships it through signaling — the
    // transport never reads our return value; it waits on onLocalDescription.
    const local = this.pc.localDescription;
    const sdp = local?.sdp ?? desc?.sdp;
    const type = local?.type ?? desc?.type;
    if (sdp && type) {
      this.localDescFanout.emit({ type: type === "answer" ? "answer" : "offer", sdp });
    }
  }

  async setRemoteDescription(desc: RtcSessionDescription): Promise<void> {
    // Cache before handing to the native peer so remoteFingerprint() can read the
    // a=fingerprint line back regardless of native accessor timing.
    this.remoteSdp = desc.sdp;
    await this.pc.setRemoteDescription({ type: desc.type, sdp: desc.sdp });
  }

  async addRemoteCandidate(candidate: RtcIceCandidate): Promise<void> {
    await this.pc.addIceCandidate(
      new RTCIceCandidate({
        candidate: candidate.candidate,
        sdpMid: candidate.sdpMid ?? null,
        sdpMLineIndex: candidate.sdpMLineIndex ?? null,
      }),
    );
  }

  restartIce(): void {
    // react-native-webrtc supports a native ICE restart; the transport prefers a
    // full peer re-establish for recovery, but the contract requires this entry.
    this.pc.restartIce();
  }

  remoteFingerprint(): string | null {
    // The DTLS SHA-256 the QR pins is the a=fingerprint:sha-256 line of the remote
    // SDP. Sound because by the time DTLS is 'connected' the native stack has
    // verified the live cert matches that line, so the parsed value still detects
    // a signaling-MITM cert swap against the pin. Null (no remote description yet)
    // makes the transport wait — it never completes an unpinned pipe (fail-closed).
    const sdp = this.remoteSdp ?? this.pc.remoteDescription?.sdp ?? null;
    return sdp ? parseSdpFingerprint(sdp) : null;
  }

  selectedCandidateType(): RtcCandidateType | null {
    // react-native-webrtc exposes only async getStats(); there is no synchronous
    // selected-candidate-pair accessor. Honestly report 'unknown' (null) rather
    // than guess — the transport uses this only for relay-vs-P2P observability.
    return null;
  }

  get connectionState(): RtcConnectionState {
    return normalizeConnectionState(this.pc.connectionState);
  }

  onConnectionStateChange(handler: (state: RtcConnectionState) => void): () => void {
    return this.stateFanout.add(handler);
  }

  onLocalDescription(handler: (desc: RtcSessionDescription) => void): () => void {
    return this.localDescFanout.add(handler);
  }

  onLocalCandidate(handler: (candidate: RtcIceCandidate) => void): () => void {
    return this.localCandFanout.add(handler);
  }

  onDataChannel(handler: (channel: RtcDataChannelLike) => void): () => void {
    return this.dataChannelFanout.add(handler);
  }

  close(): void {
    this.pc.close();
  }
}
