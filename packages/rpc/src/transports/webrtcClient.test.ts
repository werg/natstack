import { describe, expect, it } from "vitest";
import type { RpcEnvelope } from "../types.js";
import {
  encodeStreamDataFrameV2,
  encodeStreamEndFrameV2,
  encodeStreamHeadFrameV2,
} from "../protocol/streamCodec.js";
import {
  decodeControlFrame,
  encodeControlFrame,
  type SessionControlFrame,
} from "../protocol/sessionNegotiation.js";
import { FINGERPRINT_MISMATCH_CODE, createWebRtcTransport } from "./webrtcClient.js";
import type {
  PeerConnectionProvider,
  RtcCandidateType,
  RtcConnectionState,
  RtcDataChannelLike,
  RtcPeerConnectionLike,
  RtcSessionDescription,
} from "./webrtcPeer.js";
import type { SignalingClient } from "./webrtcSignaling.js";
import { frameControlMessage, createControlDefragmenter } from "./controlFraming.js";

// --- In-memory WebRTC fabric (no native module) ---------------------------

class FakeChannel implements RtcDataChannelLike {
  readyState: "connecting" | "open" | "closing" | "closed" = "open";
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  maxMessageSize = 256 * 1024;
  peer: FakeChannel | null = null;
  private msg = new Set<(d: Uint8Array) => void>();
  private close_ = new Set<() => void>();
  constructor(readonly label: string) {}
  send(data: Uint8Array): void {
    const copy = data.slice();
    queueMicrotask(() => {
      for (const h of this.peer?.msg ?? []) h(copy);
    });
  }
  close(): void {
    if (this.readyState === "closed") return;
    this.readyState = "closed";
    for (const h of this.close_) h();
  }
  onOpen(h: () => void): () => void {
    if (this.readyState === "open") queueMicrotask(h);
    return () => {};
  }
  onClose(h: () => void): () => void {
    this.close_.add(h);
    return () => this.close_.delete(h);
  }
  onError(): () => void {
    return () => {};
  }
  onMessage(h: (d: Uint8Array) => void): () => void {
    this.msg.add(h);
    return () => this.msg.delete(h);
  }
  onBufferedAmountLow(h: () => void): () => void {
    queueMicrotask(h);
    return () => {};
  }
}

class FakePeer implements RtcPeerConnectionLike {
  connectionState: RtcConnectionState = "new";
  partner: FakePeer | null = null;
  localFp: string;
  private channels = new Map<number, FakeChannel>();
  private stateH = new Set<(s: RtcConnectionState) => void>();
  private localDescH = new Set<(d: RtcSessionDescription) => void>();
  private remoteSet = false;
  constructor(localFp: string, private readonly fabric: FakeFabric, private readonly side: "A" | "B") {
    this.localFp = localFp;
  }
  createDataChannel(label: string, init?: { id?: number }): RtcDataChannelLike {
    const id = init?.id ?? 0;
    return this.fabric.joinChannel(this.side, id, label);
  }
  registerChannel(id: number, ch: FakeChannel): void {
    this.channels.set(id, ch);
  }
  channel(id: number): FakeChannel | undefined {
    return this.channels.get(id);
  }
  async createOffer(): Promise<RtcSessionDescription> {
    return { type: "offer", sdp: `${this.side}-offer` };
  }
  async createAnswer(): Promise<RtcSessionDescription> {
    return { type: "answer", sdp: `${this.side}-answer` };
  }
  async setLocalDescription(desc?: RtcSessionDescription): Promise<void> {
    if (desc) for (const h of this.localDescH) h(desc);
  }
  async setRemoteDescription(): Promise<void> {
    this.remoteSet = true;
    this.fabric.maybeConnect();
  }
  async addRemoteCandidate(): Promise<void> {}
  restartIce(): void {}
  remoteFingerprint(): string | null {
    return this.connectionState === "connected" ? this.partner?.localFp ?? null : null;
  }
  selectedCandidateType(): RtcCandidateType | null {
    return "host";
  }
  isRemoteSet(): boolean {
    return this.remoteSet;
  }
  fireState(s: RtcConnectionState): void {
    this.connectionState = s;
    for (const h of this.stateH) h(s);
  }
  onConnectionStateChange(h: (s: RtcConnectionState) => void): () => void {
    this.stateH.add(h);
    return () => this.stateH.delete(h);
  }
  onLocalDescription(h: (d: RtcSessionDescription) => void): () => void {
    this.localDescH.add(h);
    return () => this.localDescH.delete(h);
  }
  onLocalCandidate(): () => void {
    return () => {};
  }
  onDataChannel(): () => void {
    return () => {};
  }
  close(): void {
    this.fireState("closed");
  }
}

class FakeSignaling implements SignalingClient {
  partner: FakeSignaling | null = null;
  private descH = new Set<(d: RtcSessionDescription) => void>();
  private candH = new Set<(c: { candidate: string }) => void>();
  private closedH = new Set<(r?: string) => void>();
  async sendDescription(desc: RtcSessionDescription): Promise<void> {
    queueMicrotask(() => {
      for (const h of this.partner?.descH ?? []) h(desc);
    });
  }
  async sendCandidate(): Promise<void> {}
  onDescription(h: (d: RtcSessionDescription) => void): () => void {
    this.descH.add(h);
    return () => this.descH.delete(h);
  }
  onCandidate(h: (c: { candidate: string }) => void): () => void {
    this.candH.add(h);
    return () => this.candH.delete(h);
  }
  onClosed(h: (r?: string) => void): () => void {
    this.closedH.add(h);
    return () => this.closedH.delete(h);
  }
  close(): void {
    for (const h of this.closedH) h("closed");
  }
}

class FakeFabric {
  peerA: FakePeer;
  peerB: FakePeer;
  sigA = new FakeSignaling();
  sigB = new FakeSignaling();
  private pairs = new Map<number, { A?: FakeChannel; B?: FakeChannel }>();
  constructor(fpA: string, fpB: string) {
    this.peerA = new FakePeer(fpA, this, "A");
    this.peerB = new FakePeer(fpB, this, "B");
    this.peerA.partner = this.peerB;
    this.peerB.partner = this.peerA;
    this.sigA.partner = this.sigB;
    this.sigB.partner = this.sigA;
  }
  joinChannel(side: "A" | "B", id: number, label: string): FakeChannel {
    let pair = this.pairs.get(id);
    if (!pair) {
      pair = {};
      this.pairs.set(id, pair);
    }
    const ch = new FakeChannel(label);
    pair[side] = ch;
    const other = side === "A" ? pair.B : pair.A;
    if (other) {
      ch.peer = other;
      other.peer = ch;
    }
    (side === "A" ? this.peerA : this.peerB).registerChannel(id, ch);
    return ch;
  }
  maybeConnect(): void {
    if (this.peerA.isRemoteSet() && this.peerB.isRemoteSet() && this.peerA.connectionState !== "connected") {
      this.peerA.fireState("connected");
      this.peerB.fireState("connected");
    }
  }
  providerFor(side: "A" | "B"): PeerConnectionProvider {
    return { create: () => (side === "A" ? this.peerA : this.peerB) };
  }
}

/** A minimal hand-rolled "server" answerer on peer B's control/bulk channels. */
function startFakeServer(
  fabric: FakeFabric,
  opts: {
    serverBootId?: string;
    sessionDirty?: boolean;
    deviceCredential?: { deviceId: string; refreshToken: string };
    onRpc?: (frame: SessionControlFrame & { t: "rpc" }) => SessionControlFrame | null;
    onStreamOpen?: (frame: SessionControlFrame & { t: "stream-open" }, bulk: RtcDataChannelLike) => void;
  } = {},
): { control: RtcDataChannelLike } {
  // Answer the signaling handshake.
  fabric.sigB.onDescription((desc) => {
    if (desc.type === "offer") {
      void fabric.peerB.setRemoteDescription().then(async () => {
        const ans = await fabric.peerB.createAnswer();
        await fabric.peerB.setLocalDescription(ans);
      });
    }
  });
  fabric.peerB.onLocalDescription((d) => void fabric.sigB.sendDescription(d));
  // Negotiated channels (must match the offerer's ids 0/1).
  const control = fabric.peerB.createDataChannel("control", { id: 0 } as never);
  const bulk = fabric.peerB.createDataChannel("bulk", { id: 1 } as never);
  // Mirror the real answerer: fragment large frames on send, reassemble on receive.
  const defrag = createControlDefragmenter();
  let controlSeq = 0;
  const send = (f: SessionControlFrame): void => {
    const bytes = new TextEncoder().encode(encodeControlFrame(f));
    const max = Math.min(16 * 1024, control.maxMessageSize || 16 * 1024);
    controlSeq = (controlSeq + 1) >>> 0;
    for (const part of frameControlMessage(bytes, max, controlSeq)) control.send(part);
  };
  control.onMessage((data) => {
    const full = defrag.accept(data);
    if (!full) return;
    const frame = decodeControlFrame(new TextDecoder().decode(full));
    if (frame.t === "open") {
      send({
        t: "open-result",
        sid: frame.sid,
        success: true,
        callerId: frame.connectionId ? `panel:${frame.connectionId}` : "shell:host",
        callerKind: "panel",
        connectionId: frame.connectionId,
        serverBootId: opts.serverBootId ?? "boot-1",
        sessionDirty: opts.sessionDirty ?? false,
        deviceCredential: opts.deviceCredential,
      });
    } else if (frame.t === "ping") {
      send({ t: "pong", ts: frame.ts });
    } else if (frame.t === "rpc") {
      const reply = opts.onRpc?.(frame as SessionControlFrame & { t: "rpc" });
      if (reply) send(reply);
    } else if (frame.t === "stream-open") {
      opts.onStreamOpen?.(frame as SessionControlFrame & { t: "stream-open" }, bulk);
    }
  });
  return { control };
}

function requestEnvelope(method: string, requestId: string): RpcEnvelope {
  return {
    from: "panel:c1",
    target: "main",
    delivery: { caller: { callerId: "panel:c1", callerKind: "panel" } },
    provenance: [{ callerId: "panel:c1", callerKind: "panel" }],
    message: { type: "request", requestId, fromId: "panel:c1", method, args: [] },
  };
}

const PAIR = { room: "room-uuid", fingerprint: "AA:BB:CC" };

describe("WebRTC transport — pin + session multiplex", () => {
  it("connects when the observed DTLS fingerprint matches the pin", async () => {
    const fabric = new FakeFabric("FP-A", "AA:BB:CC");
    startFakeServer(fabric);
    const transport = createWebRtcTransport({
      provider: fabric.providerFor("A"),
      createSignaling: () => fabric.sigA,
      pairing: PAIR,
    });
    await transport.connect();
    expect(transport.status()).toBe("connected");
    expect(fabric.peerA.channel(0)?.bufferedAmountLowThreshold).toBe(16 * 1024);
    await transport.close();
  });

  it("re-arms connect() after a drop so connect()/ready() during recovery awaits the new pipe", async () => {
    const fabric = new FakeFabric("FP-A", "AA:BB:CC");
    startFakeServer(fabric);
    const transport = createWebRtcTransport({
      provider: fabric.providerFor("A"),
      createSignaling: () => fabric.sigA,
      pairing: PAIR,
    });
    await transport.connect();
    expect(transport.status()).toBe("connected");

    // Drop the live pipe → onPipeDown re-arms connectPromise + enters recovery backoff.
    fabric.peerA.fireState("failed");
    expect(transport.status()).not.toBe("connected");

    // connect() during recovery must be PENDING — not the stale resolved promise
    // from the first connect (the bug: it returned resolved while the pipe was down).
    const reconnecting = transport.connect();
    const pendingMarker = Symbol("pending");
    const raced = await Promise.race([
      reconnecting.then(() => "resolved"),
      Promise.resolve(pendingMarker),
    ]);
    expect(raced).toBe(pendingMarker);

    await transport.close(); // stops the reestablish loop + rejects the re-armed promise
    await reconnecting.catch(() => undefined);
  });

  it("FAILS CLOSED when the signaling box swaps the fingerprint (negative test)", async () => {
    const fabric = new FakeFabric("FP-A", "EVIL-FP"); // server presents a different cert
    startFakeServer(fabric);
    const transport = createWebRtcTransport({
      provider: fabric.providerFor("A"),
      createSignaling: () => fabric.sigA,
      pairing: PAIR, // pinned AA:BB:CC
    });
    await expect(transport.connect()).rejects.toMatchObject({ code: FINGERPRINT_MISMATCH_CODE });
    expect(transport.status()).not.toBe("connected");
  });

  it("opens a logical session, redeeming its own grant, and resolves callerId", async () => {
    const fabric = new FakeFabric("FP-A", "AA:BB:CC");
    startFakeServer(fabric);
    const transport = createWebRtcTransport({ provider: fabric.providerFor("A"), createSignaling: () => fabric.sigA, pairing: PAIR });
    await transport.connect();
    let tokenCalls = 0;
    const session = transport.openSession({
      connectionId: "c1",
      callerKind: "panel",
      getToken: () => {
        tokenCalls++;
        return "grant-1";
      },
    });
    await session.ready!();
    expect(session.callerId()).toBe("panel:c1");
    expect(tokenCalls).toBe(1); // grant is fetched fresh per open (one-shot grants)
    await transport.close();
  });

  it("fires onPaired with the device credential delivered on the open-result", async () => {
    const fabric = new FakeFabric("FP-A", "AA:BB:CC");
    startFakeServer(fabric, { deviceCredential: { deviceId: "dev_42", refreshToken: "rt-secret" } });
    const transport = createWebRtcTransport({ provider: fabric.providerFor("A"), createSignaling: () => fabric.sigA, pairing: PAIR });
    await transport.connect();
    const paired: Array<{ deviceId: string; refreshToken: string }> = [];
    const session = transport.openSession({
      connectionId: "c1",
      callerKind: "shell",
      getToken: () => "pairing-code", // a fresh device presents the QR code
      onPaired: (cred) => paired.push(cred),
    });
    await session.ready!();
    expect(paired).toEqual([{ deviceId: "dev_42", refreshToken: "rt-secret" }]);
    await transport.close();
  });

  it("send() ships an rpc frame and onMessage() delivers the response", async () => {
    const fabric = new FakeFabric("FP-A", "AA:BB:CC");
    startFakeServer(fabric, {
      onRpc: (frame) => {
        const req = frame.envelope.message as { requestId: string };
        return {
          t: "rpc",
          sid: frame.sid,
          envelope: {
            from: "main",
            target: "panel:c1",
            delivery: { caller: { callerId: "main", callerKind: "server" } },
            provenance: [{ callerId: "main", callerKind: "server" }],
            message: { type: "response", requestId: req.requestId, result: { ok: true } },
          },
        };
      },
    });
    const transport = createWebRtcTransport({ provider: fabric.providerFor("A"), createSignaling: () => fabric.sigA, pairing: PAIR });
    await transport.connect();
    const session = transport.openSession({ connectionId: "c1", getToken: () => "g" });
    await session.ready!();
    const received: RpcEnvelope[] = [];
    session.onMessage((e) => received.push(e));
    await session.send(requestEnvelope("fs.read", "req-1"));
    await new Promise((r) => setTimeout(r, 10));
    expect(received).toHaveLength(1);
    expect((received[0]!.message as { result: unknown }).result).toEqual({ ok: true });
    await transport.close();
  });

  it("stream() rebuilds a Response from bulk-channel v2 frames", async () => {
    const fabric = new FakeFabric("FP-A", "AA:BB:CC");
    startFakeServer(fabric, {
      onStreamOpen: (frame, bulk) => {
        const sid = frame.streamId;
        bulk.send(encodeStreamHeadFrameV2(sid, { status: 200, statusText: "OK", headerPairs: [["content-type", "text/plain"]], finalUrl: "https://x/y" }));
        bulk.send(encodeStreamDataFrameV2(sid, new TextEncoder().encode("streamed-")));
        bulk.send(encodeStreamDataFrameV2(sid, new TextEncoder().encode("bytes")));
        bulk.send(encodeStreamEndFrameV2(sid, { bytesIn: 14 }));
      },
    });
    const transport = createWebRtcTransport({ provider: fabric.providerFor("A"), createSignaling: () => fabric.sigA, pairing: PAIR });
    await transport.connect();
    const session = transport.openSession({ connectionId: "c1", getToken: () => "g" });
    await session.ready!();
    const env: RpcEnvelope = {
      from: "panel:c1",
      target: "main",
      delivery: { caller: { callerId: "panel:c1", callerKind: "panel" } },
      provenance: [{ callerId: "panel:c1", callerKind: "panel" }],
      message: { type: "stream-request", requestId: "s1", fromId: "panel:c1", method: "credentials.proxyFetch", args: ["https://x/y"] },
    };
    const resp = await session.stream!(env);
    expect(resp.status).toBe(200);
    expect(resp.headers.get("content-type")).toBe("text/plain");
    expect(await resp.text()).toBe("streamed-bytes");
    await transport.close();
  });

  it("rejects send() before connect (fail loud, never silent hang)", async () => {
    const fabric = new FakeFabric("FP-A", "AA:BB:CC");
    startFakeServer(fabric);
    const transport = createWebRtcTransport({ provider: fabric.providerFor("A"), createSignaling: () => fabric.sigA, pairing: PAIR });
    const session = transport.openSession({ connectionId: "c1", getToken: () => "g" });
    await expect(session.send(requestEnvelope("fs.read", "r"))).rejects.toThrow(/Not connected/);
    await transport.close();
  });

  it("reports the selected ICE candidate type (relay alarm hook)", async () => {
    const fabric = new FakeFabric("FP-A", "AA:BB:CC");
    startFakeServer(fabric);
    const seen: Array<RtcCandidateType | null> = [];
    const transport = createWebRtcTransport({
      provider: fabric.providerFor("A"),
      createSignaling: () => fabric.sigA,
      pairing: PAIR,
      onCandidateType: (t) => seen.push(t),
    });
    await transport.connect();
    expect(seen).toContain("host");
    await transport.close();
  });
});
