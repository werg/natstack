/**
 * Real-native WebRTC end-to-end test. Wires TWO actual `node-datachannel` peers
 * (via createNodeDatachannelProvider) through an in-process signaling relay, and
 * runs the full transport + protocol stack over REAL DTLS:
 *
 *   createWebRtcTransport (offerer)  ⇄  createWebRtcAnswererPipe (answerer)
 *                                        + createServerSessionMultiplexer
 *
 * It proves, against the live native module: ICE/DTLS connect, the fingerprint
 * pin (accept on match, FAIL CLOSED on mismatch), the session handshake, an RPC
 * round-trip, and a bulk stream. This is the bedrock the wrangler-dev harness
 * builds on (it only swaps the in-process signaling for the real signaling DO).
 *
 * Gated behind NATSTACK_RUN_WEBRTC_E2E=1 (opens real UDP sockets + loads the
 * native binary), like the other integration tests.
 *
 *   NATSTACK_RUN_WEBRTC_E2E=1 npx vitest run tests/webrtc-native.e2e.test.ts
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { RpcEnvelope } from "@natstack/rpc";
import { createWebRtcTransport, FINGERPRINT_MISMATCH_CODE } from "@natstack/rpc/transports/webrtcClient";
import { createWebRtcAnswererPipe } from "@natstack/rpc/transports/webrtcAnswerer";
import { createServerSessionMultiplexer } from "@natstack/rpc/transports/serverSessionTransport";
import type { RtcIceCandidate, RtcSessionDescription } from "@natstack/rpc/transports/webrtcPeer";
import type { SignalingClient } from "@natstack/rpc/transports/webrtcSignaling";
import { createNodeDatachannelProvider } from "../src/main/webrtc/nodeDatachannelPeer.js";
import { ensurePersistentCert } from "../src/main/webrtc/cert.js";

const RUN = process.env["NATSTACK_RUN_WEBRTC_E2E"] === "1";

/** In-process signaling relay: each peer's send reaches the other's handlers. */
function signalingPair(): { offerer: SignalingClient; answerer: SignalingClient } {
  const onDesc = { a: new Set<(d: RtcSessionDescription) => void>(), b: new Set<(d: RtcSessionDescription) => void>() };
  const onCand = { a: new Set<(c: RtcIceCandidate) => void>(), b: new Set<(c: RtcIceCandidate) => void>() };
  // Buffer pre-subscription frames (mirrors the real DO's join-order buffer).
  const buf = { a: [] as Array<["d" | "c", unknown]>, b: [] as Array<["d" | "c", unknown]> };
  const flush = (side: "a" | "b"): void => {
    for (const [t, x] of buf[side].splice(0)) {
      if (t === "d") for (const h of onDesc[side]) h(x as RtcSessionDescription);
      else for (const h of onCand[side]) h(x as RtcIceCandidate);
    }
  };
  const make = (self: "a" | "b", peer: "a" | "b"): SignalingClient => ({
    async sendDescription(d) {
      queueMicrotask(() => {
        if (onDesc[peer].size === 0) buf[peer].push(["d", d]);
        else for (const h of onDesc[peer]) h(d);
      });
    },
    async sendCandidate(c) {
      queueMicrotask(() => {
        if (onDesc[peer].size === 0) buf[peer].push(["c", c]);
        else for (const h of onCand[peer]) h(c);
      });
    },
    onDescription(h) {
      onDesc[self].add(h);
      queueMicrotask(() => flush(self));
      return () => onDesc[self].delete(h);
    },
    onCandidate(h) {
      onCand[self].add(h);
      return () => onCand[self].delete(h);
    },
    onClosed() {
      return () => {};
    },
    close() {},
  });
  return { offerer: make("a", "b"), answerer: make("b", "a") };
}

interface Harness {
  client: ReturnType<typeof createWebRtcTransport>;
  pipe: ReturnType<typeof createWebRtcAnswererPipe>;
  close: () => Promise<void>;
}

async function connect(opts: { pinnedFp: string; certFile: string; keyFile: string }): Promise<Harness> {
  const sig = signalingPair();
  const serverProvider = createNodeDatachannelProvider({ peerName: "server" });
  const clientProvider = createNodeDatachannelProvider({ peerName: "client" });

  const pipe = createWebRtcAnswererPipe({
    provider: serverProvider,
    signaling: sig.answerer,
    pairing: { iceServers: [], certificatePemFile: opts.certFile, keyPemFile: opts.keyFile },
  });

  // Minimal server: accept any token as a shell principal; echo rpc; stream bulk.
  const mux = createServerSessionMultiplexer({
    serverBootId: "boot-e2e",
    negotiator: {
      authenticate: (frame) => ({
        ok: true,
        callerId: "shell:e2e",
        callerKind: "shell",
        connectionId: frame.connectionId,
        sessionDirty: false,
      }),
    },
    writeControl: (d) => pipe.writeControl(d),
    writeBulk: (d) => pipe.writeBulk(d),
    dispatch: {
      onRpc: (session, envelope) => {
        const msg = envelope.message as { type: string; requestId: string; method: string };
        if (msg.type === "request") {
          session.send({
            from: "main",
            target: session.callerId,
            delivery: { caller: { callerId: "main", callerKind: "server" } },
            provenance: [{ callerId: "main", callerKind: "server" }],
            message: { type: "response", requestId: msg.requestId, result: { pong: true, method: msg.method } },
          });
        }
      },
      onStreamOpen: (session, streamId) => {
        session.writeStreamHead(streamId, { status: 200, statusText: "OK", headerPairs: [["content-type", "text/plain"]], finalUrl: "rtc://x" });
        session.writeStreamData(streamId, new TextEncoder().encode("real-"));
        session.writeStreamData(streamId, new TextEncoder().encode("dtls-bytes"));
        session.writeStreamEnd(streamId, { bytesIn: 14 });
      },
    },
  });
  pipe.onControl((d) => mux.handleControlData(d));

  const client = createWebRtcTransport({
    provider: clientProvider,
    createSignaling: () => sig.offerer,
    pairing: { room: "e2e-room", fingerprint: opts.pinnedFp, sig: "inproc", iceServers: [] },
    role: "offerer",
  });

  // Start the answerer first so it is subscribed before the offer arrives (the
  // in-process buffer also covers any residual race).
  const answering = pipe.connect();
  await new Promise((r) => setTimeout(r, 50));
  const connecting = client.connect();
  await Promise.all([answering, connecting]);

  return {
    client,
    pipe,
    close: async () => {
      await client.close();
      await pipe.close();
    },
  };
}

describe.runIf(RUN)("WebRTC real-native end-to-end (node-datachannel)", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "natstack-rtc-e2e-"));
  const cert = ensurePersistentCert({
    certificatePemFile: path.join(tmp, "server.pem"),
    keyPemFile: path.join(tmp, "server.key"),
  });
  const harnesses: Harness[] = [];

  afterAll(async () => {
    for (const h of harnesses) await h.close().catch(() => {});
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("establishes real DTLS, pins the server fingerprint, and round-trips RPC", async () => {
    const h = await connect({ pinnedFp: cert.fingerprint, certFile: cert.certificatePemFile, keyFile: cert.keyPemFile });
    harnesses.push(h);
    expect(h.client.status()).toBe("connected");
    // The selected candidate type is observable (host on loopback).
    expect(["host", "srflx", "prflx", "relay", null]).toContain(h.client.candidateType());

    const session = h.client.openSession({ connectionId: "cli-1", callerKind: "shell", getToken: () => "shell-token" });
    await session.ready!();
    expect(session.callerId()).toBe("shell:e2e");

    const received: RpcEnvelope[] = [];
    session.onMessage((e) => received.push(e));
    await session.send({
      from: "shell:e2e",
      target: "main",
      delivery: { caller: { callerId: "shell:e2e", callerKind: "shell" } },
      provenance: [{ callerId: "shell:e2e", callerKind: "shell" }],
      message: { type: "request", requestId: "r1", fromId: "shell:e2e", method: "healthz", args: [] },
    });
    await waitFor(() => received.length > 0);
    expect((received[0]!.message as { result: { pong: boolean; method: string } }).result).toEqual({ pong: true, method: "healthz" });
  }, 20_000);

  it("streams a bulk body over the real bulk DataChannel", async () => {
    const h = harnesses[0]!;
    const session = h.client.openSession({ connectionId: "cli-2", callerKind: "shell", getToken: () => "t" });
    await session.ready!();
    const resp = await session.stream!({
      from: "shell:e2e",
      target: "main",
      delivery: { caller: { callerId: "shell:e2e", callerKind: "shell" } },
      provenance: [{ callerId: "shell:e2e", callerKind: "shell" }],
      message: { type: "stream-request", requestId: "s1", fromId: "shell:e2e", method: "credentials.proxyFetch", args: ["rtc://x"] },
    });
    expect(resp.status).toBe(200);
    expect(await resp.text()).toBe("real-dtls-bytes");
  }, 20_000);

  it("FAILS CLOSED when the pinned fingerprint does not match the server cert (negative)", async () => {
    const wrongFp = "00".repeat(32);
    await expect(
      connect({ pinnedFp: wrongFp, certFile: cert.certificatePemFile, keyFile: cert.keyPemFile }),
    ).rejects.toMatchObject({ code: FINGERPRINT_MISMATCH_CODE });
  }, 20_000);
});

async function waitFor(pred: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}
