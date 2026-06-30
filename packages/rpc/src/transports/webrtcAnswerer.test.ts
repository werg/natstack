import { describe, expect, it } from "vitest";
import { createWebRtcAnswererPipe } from "./webrtcAnswerer.js";
import type {
  PeerConnectionProvider,
  RtcConnectionState,
  RtcDataChannelLike,
  RtcPeerConnectionLike,
  RtcSessionDescription,
} from "./webrtcPeer.js";
import type { SignalingClient } from "./webrtcSignaling.js";
import { frameControlMessage, createControlDefragmenter } from "./controlFraming.js";

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

class FakeChannel implements RtcDataChannelLike {
  readyState: "connecting" | "open" | "closing" | "closed" = "open";
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  maxMessageSize = 256 * 1024;
  sent: Uint8Array[] = [];
  private msg = new Set<(d: Uint8Array) => void>();
  constructor(readonly label: string) {}
  send(data: Uint8Array): void {
    this.sent.push(data.slice());
  }
  deliver(data: Uint8Array): void {
    for (const h of this.msg) h(data);
  }
  close(): void {
    this.readyState = "closed";
  }
  onOpen(h: () => void): () => void {
    queueMicrotask(h);
    return () => {};
  }
  onClose(): () => void {
    return () => {};
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
  channels = new Map<number, FakeChannel>();
  certFile?: string;
  private stateH = new Set<(s: RtcConnectionState) => void>();
  private localDescH = new Set<(d: RtcSessionDescription) => void>();
  remoteSet = false;
  createDataChannel(label: string, init?: { id?: number }): RtcDataChannelLike {
    const ch = new FakeChannel(label);
    this.channels.set(init?.id ?? 0, ch);
    return ch;
  }
  async createOffer(): Promise<RtcSessionDescription> {
    return { type: "offer", sdp: "offer" };
  }
  async createAnswer(): Promise<RtcSessionDescription> {
    return { type: "answer", sdp: "answer" };
  }
  async setLocalDescription(desc?: RtcSessionDescription): Promise<void> {
    if (desc) for (const h of this.localDescH) h(desc);
  }
  async setRemoteDescription(): Promise<void> {
    this.remoteSet = true;
  }
  async addRemoteCandidate(): Promise<void> {}
  restartIce(): void {}
  remoteFingerprint(): string | null {
    return "client-fp";
  }
  selectedCandidateType(): "host" {
    return "host";
  }
  fire(s: RtcConnectionState): void {
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
  close(): void {}
}

class FakeSignaling implements SignalingClient {
  descH = new Set<(d: RtcSessionDescription) => void>();
  closedH = new Set<(reason?: string) => void>();
  sentAnswers: RtcSessionDescription[] = [];
  async sendDescription(desc: RtcSessionDescription): Promise<void> {
    this.sentAnswers.push(desc);
  }
  async sendCandidate(): Promise<void> {}
  onDescription(h: (d: RtcSessionDescription) => void): () => void {
    this.descH.add(h);
    return () => this.descH.delete(h);
  }
  onCandidate(): () => void {
    return () => {};
  }
  onClosed(h: (reason?: string) => void): () => void {
    this.closedH.add(h);
    return () => this.closedH.delete(h);
  }
  close(): void {}
  /** Simulate the offerer's offer arriving. */
  deliverOffer(): void {
    for (const h of this.descH) h({ type: "offer", sdp: "offer" });
  }
  emitClosed(reason?: string): void {
    for (const h of this.closedH) h(reason);
  }
}

describe("WebRTC answerer pipe", () => {
  it("answers the offer, opens, and exposes the control/bulk channels", async () => {
    const peer = new FakePeer();
    const provider: PeerConnectionProvider = { create: () => peer };
    const signaling = new FakeSignaling();
    const pipe = createWebRtcAnswererPipe({
      provider,
      signaling,
      pairing: { iceServers: [], certificatePemFile: "/server.pem", keyPemFile: "/server.key" },
    });

    const connecting = pipe.connect();
    // Offerer's offer arrives → answerer sets remote + sends an answer.
    await tick();
    signaling.deliverOffer();
    await tick();
    expect(peer.remoteSet).toBe(true);
    expect(signaling.sentAnswers.map((a) => a.type)).toContain("answer");

    // ICE connects → pipe ready.
    peer.fire("connected");
    await connecting;
    expect(pipe.status()).toBe("connected");
    expect(peer.channels.get(0)?.bufferedAmountLowThreshold).toBe(16 * 1024);

    // Inbound control frames reach the registered handler (after defragmentation).
    const got: Uint8Array[] = [];
    pipe.onControl((d) => got.push(d));
    for (const part of frameControlMessage(new Uint8Array([1, 2, 3]), 16 * 1024, 1)) {
      peer.channels.get(0)!.deliver(part);
    }
    expect([...got[0]!]).toEqual([1, 2, 3]);

    // writeControl frames the payload (1-byte whole-frame tag); writeBulk hits the
    // bulk channel unframed (it chunks instead). Defrag the control bytes to recover.
    pipe.writeControl(new Uint8Array([9]));
    pipe.writeBulk(new Uint8Array([7, 7]));
    await new Promise((r) => setTimeout(r, 0));
    const recvDefrag = createControlDefragmenter();
    expect([...recvDefrag.accept(peer.channels.get(0)!.sent.at(-1)!)!]).toEqual([9]);
    expect([...peer.channels.get(1)!.sent.at(-1)!]).toEqual([7, 7]);

    await pipe.close();
  });

  it("chunks a large bulk write under maxMessageSize", async () => {
    const peer = new FakePeer();
    const pipe = createWebRtcAnswererPipe({
      provider: { create: () => peer },
      signaling: new FakeSignaling(),
      pairing: { iceServers: [] },
      chunkSize: 4,
    });
    const connecting = pipe.connect();
    await tick();
    peer.fire("connected");
    await connecting;
    pipe.writeBulk(new Uint8Array([1, 2, 3, 4, 5, 6, 7]));
    await new Promise((r) => setTimeout(r, 0));
    const bulkSends = peer.channels.get(1)!.sent;
    expect(bulkSends.length).toBe(2); // 4 + 3
    expect([...bulkSends[0]!]).toEqual([1, 2, 3, 4]);
    expect([...bulkSends[1]!]).toEqual([5, 6, 7]);
    await pipe.close();
  });

  it("notifies down handlers when the established pipe disconnects", async () => {
    const peer = new FakePeer();
    const pipe = createWebRtcAnswererPipe({
      provider: { create: () => peer },
      signaling: new FakeSignaling(),
      pairing: { iceServers: [] },
    });
    const downs: string[] = [];
    pipe.onDown((reason) => downs.push(reason));

    const connecting = pipe.connect();
    await tick();
    peer.fire("connected");
    await connecting;

    peer.fire("disconnected");
    expect(pipe.status()).toBe("disconnected");
    expect(downs).toEqual(["ICE disconnected"]);
    await pipe.close();
  });

  it("rejoins signaling after the room closes without dropping a healthy pipe", async () => {
    const peers: FakePeer[] = [];
    const signals: FakeSignaling[] = [];
    const pipe = createWebRtcAnswererPipe({
      provider: {
        create: () => {
          const peer = new FakePeer();
          peers.push(peer);
          return peer;
        },
      },
      createSignaling: () => {
        const signaling = new FakeSignaling();
        signals.push(signaling);
        return signaling;
      },
      pairing: { iceServers: [] },
    });
    const downs: string[] = [];
    pipe.onDown((reason) => downs.push(reason));

    const connecting = pipe.connect();
    await tick();
    signals[0]!.deliverOffer();
    await tick();
    peers[0]!.fire("connected");
    await connecting;

    signals[0]!.emitClosed("room websocket dropped");
    await tick();
    expect(pipe.status()).toBe("connected");
    expect(signals).toHaveLength(2);
    expect(downs).toEqual([]);

    signals[1]!.deliverOffer();
    await tick();
    expect(peers).toHaveLength(2);
    expect(peers[1]!.remoteSet).toBe(true);
    expect(signals[1]!.sentAnswers.map((a) => a.type)).toContain("answer");
    expect(downs).toEqual(["re-pairing offer"]);

    await pipe.close();
  });
});
