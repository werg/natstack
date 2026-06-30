import { describe, expect, it } from "vitest";
import type { RpcEnvelope } from "../types.js";
import {
  type SessionControlFrame,
  type SessionOpenFrame,
  decodeControlFrame,
  encodeControlFrame,
} from "../protocol/sessionNegotiation.js";
import { StreamFrameDecoderV2 } from "../protocol/streamCodec.js";
import {
  SESSION_CONNECTION_LOST_CODE,
  type ServerSessionDispatch,
  createServerSessionMultiplexer,
} from "./serverSessionTransport.js";

function harness(dispatch: Partial<ServerSessionDispatch> = {}, opts: { deny?: boolean; terminal?: boolean } = {}) {
  const controlOut: SessionControlFrame[] = [];
  const bulkOut: Array<{ streamId: number; type: number }> = [];
  const bulkDecoder = new StreamFrameDecoderV2((streamId, type) => {
    bulkOut.push({ streamId, type });
  });
  const mux = createServerSessionMultiplexer({
    serverBootId: "boot-1",
    negotiator: {
      authenticate: (frame) =>
        opts.deny
          ? { ok: false, error: "Panel runtime is leased by Desktop", terminal: opts.terminal ?? true }
          : { ok: true, callerId: `panel:${frame.connectionId}`, callerKind: "panel", connectionId: frame.connectionId, sessionDirty: false },
    },
    writeControl: (data) => controlOut.push(decodeControlFrame(new TextDecoder().decode(data))),
    writeBulk: (data) => void bulkDecoder.push(data),
    dispatch: {
      onRpc: dispatch.onRpc ?? (() => {}),
      onStreamOpen: dispatch.onStreamOpen,
      onOpened: dispatch.onOpened,
      onClosed: dispatch.onClosed,
    },
  });
  const feed = (frame: SessionControlFrame): void => mux.handleControlData(new TextEncoder().encode(encodeControlFrame(frame)));
  // open() runs an async handshake (authenticate may redeem grants async); await the tick.
  const open = async (sid: string, connectionId: string): Promise<void> => {
    feed({ t: "open", sid, token: "grant", connectionId } as SessionOpenFrame);
    await new Promise((r) => setTimeout(r, 0));
  };
  return { mux, controlOut, bulkOut, feed, open };
}

const req = (requestId: string): RpcEnvelope => ({
  from: "panel:c1",
  target: "main",
  delivery: { caller: { callerId: "panel:c1", callerKind: "panel" } },
  provenance: [{ callerId: "panel:c1", callerKind: "panel" }],
  message: { type: "request", requestId, fromId: "panel:c1", method: "fs.read", args: [] },
});

describe("server session multiplexer", () => {
  it("authenticates an open frame and replies open-result with the bootId", async () => {
    let opened: string | undefined;
    const h = harness({ onOpened: (s) => (opened = s.callerId) });
    await h.open("s1", "c1");
    const result = h.controlOut[0]!;
    expect(result.t).toBe("open-result");
    if (result.t === "open-result") {
      expect(result.success).toBe(true);
      expect(result.callerId).toBe("panel:c1");
      expect(result.serverBootId).toBe("boot-1");
    }
    expect(opened).toBe("panel:c1");
    expect(h.mux.getSession("s1")?.callerKind).toBe("panel");
  });

  it("replies a TERMINAL failure when the lease gate denies (not retried)", async () => {
    const h = harness({}, { deny: true, terminal: true });
    await h.open("s1", "c1");
    const result = h.controlOut[0]!;
    expect(result.t).toBe("open-result");
    if (result.t === "open-result") {
      expect(result.success).toBe(false);
      expect(result.terminal).toBe(true);
      expect(result.error).toMatch(/leased by/);
    }
    expect(h.mux.getSession("s1")).toBeUndefined();
  });

  it("preserves per-panel principal identity across multiplexed sessions", async () => {
    const h = harness();
    await h.open("s1", "c1");
    await h.open("s2", "c2");
    expect(h.mux.getSession("s1")?.callerId).toBe("panel:c1");
    expect(h.mux.getSession("s2")?.callerId).toBe("panel:c2");
    // Two distinct principals over one channel -- the pipe never collapses them.
    expect(h.mux.sessions()).toHaveLength(2);
  });

  it("routes a client→server rpc request to the dispatch", async () => {
    const seen: RpcEnvelope[] = [];
    const h = harness({
      onRpc: (_s, e) => {
        seen.push(e);
      },
    });
    await h.open("s1", "c1");
    h.feed({ t: "rpc", sid: "s1", envelope: req("r1") });
    expect(seen).toHaveLength(1);
    expect((seen[0]!.message as { requestId: string }).requestId).toBe("r1");
  });

  it("dispatches a stream-open and writes the body over the bulk channel", async () => {
    const h = harness({
      onStreamOpen: (session, streamId) => {
        session.writeStreamHead(streamId, { status: 200, statusText: "OK", headerPairs: [], finalUrl: "x" });
        session.writeStreamData(streamId, new Uint8Array([1, 2, 3]));
        session.writeStreamEnd(streamId, { bytesIn: 3 });
      },
    });
    await h.open("s1", "c1");
    h.feed({ t: "stream-open", sid: "s1", streamId: 99, envelope: { ...req("s1"), message: { type: "stream-request", requestId: "s1", fromId: "panel:c1", method: "credentials.proxyFetch", args: [] } } });
    await new Promise((r) => setTimeout(r, 5));
    expect(h.bulkOut.map((f) => f.streamId)).toEqual([99, 99, 99]);
  });

  it("answers ping with pong (keepalive)", () => {
    const h = harness();
    h.feed({ t: "ping", ts: 42 });
    expect(h.controlOut[0]).toEqual({ t: "pong", ts: 42 });
  });

  describe("close-time failure synthesis (independent per session)", () => {
    it("rejects in-flight server->client bridge calls on session close", async () => {
      const h = harness();
      await h.open("s1", "c1");
      const session = h.mux.getSession("s1")!;
      const delivered: RpcEnvelope[] = [];
      session.onMessage((e) => delivered.push(e));
      // Server initiates a bridge call to the client (server->client request).
      await session.send({ from: "main", target: "panel:c1", delivery: { caller: { callerId: "main", callerKind: "server" } }, provenance: [], message: { type: "request", requestId: "bridge-1", fromId: "main", method: "panel.ping", args: [] } });
      session.close(4091, "lease revoked");
      const lost = delivered.find((e) => (e.message as { requestId?: string }).requestId === "bridge-1");
      expect((lost!.message as { errorCode?: string }).errorCode).toBe(SESSION_CONNECTION_LOST_CODE);
    });

    it("one session dropping does NOT fail a sibling's in-flight calls or tear down the pipe", async () => {
      const h = harness();
      await h.open("s1", "c1");
      await h.open("s2", "c2");
      const s1 = h.mux.getSession("s1")!;
      const s2 = h.mux.getSession("s2")!;
      const s2delivered: RpcEnvelope[] = [];
      s2.onMessage((e) => s2delivered.push(e));
      await s1.send({ from: "main", target: "panel:c1", delivery: { caller: { callerId: "main", callerKind: "server" } }, provenance: [], message: { type: "request", requestId: "a", fromId: "main", method: "m", args: [] } });
      await s2.send({ from: "main", target: "panel:c2", delivery: { caller: { callerId: "main", callerKind: "server" } }, provenance: [], message: { type: "request", requestId: "b", fromId: "main", method: "m", args: [] } });
      s1.close(); // drop ONLY s1
      // s2 is untouched: still live, no synthesized failure delivered.
      expect(h.mux.getSession("s2")).toBe(s2);
      expect(s2delivered.find((e) => (e.message as { errorCode?: string }).errorCode)).toBeUndefined();
    });

    it("closeAll (pipe loss) fans CONNECTION_LOST to every session", async () => {
      const closed: string[] = [];
      const h = harness({ onClosed: (s) => closed.push(s.callerId) });
      await h.open("s1", "c1");
      await h.open("s2", "c2");
      h.mux.closeAll("ICE failed");
      expect(closed.sort()).toEqual(["panel:c1", "panel:c2"]);
      expect(h.mux.sessions()).toHaveLength(0);
    });
  });
});
