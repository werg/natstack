/**
 * Signaling client tests — drive `createSignalingClient` against an in-memory
 * fake WebSocket fabric (a stand-in for the `apps/signaling` DO) and a fake
 * fetch. Proven: two peers exchange offer/answer + candidates; ice-servers are
 * pulled over HTTP and fail loud on a non-200; a third joiner is refused; frames
 * that arrive before a handler is registered are buffered and flushed.
 */

import { describe, expect, it, vi } from "vitest";

import type { RtcIceCandidate, RtcSessionDescription } from "./webrtcPeer.js";
import {
  createSignalingClient,
  type WebSocketCtor,
  type WebSocketLike,
} from "./webrtcSignalingClient.js";

// --- In-memory signaling fabric (stands in for the SignalingRoom DO) --------

class FakeSignalingHub {
  private rooms = new Map<string, FakeClientWS[]>();
  join(ws: FakeClientWS): void {
    const list = this.rooms.get(ws.roomKey) ?? [];
    if (list.length >= 2) {
      // Refuse the third joiner, exactly like the DO.
      queueMicrotask(() => {
        ws.fireOpen();
        ws.deliver(JSON.stringify({ t: "room-full" }));
        ws.fireClose(1013, "room full");
      });
      return;
    }
    list.push(ws);
    this.rooms.set(ws.roomKey, list);
    const peers = list.length;
    queueMicrotask(() => {
      ws.fireOpen();
      for (const other of list) {
        if (other !== ws) other.deliver(JSON.stringify({ t: "peer-joined", peers }));
      }
    });
  }
  relay(from: FakeClientWS, data: string): void {
    for (const ws of this.rooms.get(from.roomKey) ?? []) {
      if (ws !== from) ws.deliver(data);
    }
  }
  leave(ws: FakeClientWS): void {
    const list = this.rooms.get(ws.roomKey);
    if (list) this.rooms.set(ws.roomKey, list.filter((w) => w !== ws));
  }
}

class FakeClientWS implements WebSocketLike {
  readyState = 0;
  readonly roomKey: string;
  private readonly listeners = new Map<string, Set<(ev: unknown) => void>>();
  constructor(url: string, private readonly hub: FakeSignalingHub) {
    this.roomKey = new URL(url).pathname;
    hub.join(this);
  }
  send(data: string): void {
    this.hub.relay(this, data);
  }
  close(): void {
    if (this.readyState === 3) return;
    this.hub.leave(this);
    this.fireClose(1000, "client-closed");
  }
  addEventListener(type: string, handler: (ev: never) => void): void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(handler as (ev: unknown) => void);
  }
  fireOpen(): void {
    this.readyState = 1;
    this.emit("open", {});
  }
  deliver(data: string): void {
    this.emit("message", { data });
  }
  fireClose(code: number, reason: string): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit("close", { code, reason });
  }
  private emit(type: string, ev: unknown): void {
    for (const handler of this.listeners.get(type) ?? []) handler(ev);
  }
}

function wsCtorFor(hub: FakeSignalingHub): WebSocketCtor {
  return class extends FakeClientWS {
    constructor(url: string) {
      super(url, hub);
    }
  } as unknown as WebSocketCtor;
}

function okIceFetch(iceServers: unknown): typeof fetch {
  return vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ iceServers }),
    text: async () => JSON.stringify({ iceServers }),
  })) as unknown as typeof fetch;
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe("createSignalingClient", () => {
  it("relays offer/answer and candidates between two peers", async () => {
    const hub = new FakeSignalingHub();
    const WS = wsCtorFor(hub);
    const opts = { room: "r1", sig: "https://sig.test", WebSocketImpl: WS, fetchImpl: okIceFetch([]) };
    const a = createSignalingClient(opts);
    const b = createSignalingClient(opts);

    const aDescs: RtcSessionDescription[] = [];
    const bDescs: RtcSessionDescription[] = [];
    const aCands: RtcIceCandidate[] = [];
    const bCands: RtcIceCandidate[] = [];
    a.onDescription((d) => aDescs.push(d));
    b.onDescription((d) => bDescs.push(d));
    a.onCandidate((c) => aCands.push(c));
    b.onCandidate((c) => bCands.push(c));

    await a.sendDescription({ type: "offer", sdp: "OFFER" });
    await flush();
    expect(bDescs).toEqual([{ type: "offer", sdp: "OFFER" }]);
    expect(aDescs).toEqual([]); // never echoed back to the sender

    await b.sendDescription({ type: "answer", sdp: "ANSWER" });
    await flush();
    expect(aDescs).toEqual([{ type: "answer", sdp: "ANSWER" }]);

    await a.sendCandidate({ candidate: "cand-a", sdpMid: "0" });
    await b.sendCandidate({ candidate: "cand-b", sdpMid: "0" });
    await flush();
    expect(bCands).toEqual([{ candidate: "cand-a", sdpMid: "0" }]);
    expect(aCands).toEqual([{ candidate: "cand-b", sdpMid: "0" }]);

    a.close();
    b.close();
  });

  it("buffers inbound frames that arrive before a handler is registered", async () => {
    const hub = new FakeSignalingHub();
    const WS = wsCtorFor(hub);
    const opts = { room: "r1", sig: "https://sig.test", WebSocketImpl: WS, fetchImpl: okIceFetch([]) };
    const a = createSignalingClient(opts);
    const b = createSignalingClient(opts);

    // B sends before A has subscribed — the frame must not be lost.
    await b.sendDescription({ type: "offer", sdp: "EARLY" });
    await flush();

    const received: RtcSessionDescription[] = [];
    a.onDescription((d) => received.push(d));
    expect(received).toEqual([{ type: "offer", sdp: "EARLY" }]);
  });

  it("fetches per-session ice servers over HTTP from the room", async () => {
    const hub = new FakeSignalingHub();
    const iceServers = [
      { urls: ["stun:stun.cloudflare.com:3478", "turn:turn.cloudflare.com:3478?transport=tcp"], username: "u", credential: "c" },
    ];
    const fetchImpl = okIceFetch(iceServers);
    const client = createSignalingClient({ room: "r1", sig: "https://sig.test", WebSocketImpl: wsCtorFor(hub), fetchImpl });

    const servers = await client.fetchIceServers!();
    expect(servers).toEqual(iceServers);
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://sig.test/room/r1/ice-servers",
      expect.objectContaining({ method: "GET" }),
    );
    client.close();
  });

  it("fails loud when ice-servers returns a non-200 — negative test", async () => {
    const hub = new FakeSignalingHub();
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 502,
      text: async () => "turn mint failed",
      json: async () => ({}),
    })) as unknown as typeof fetch;
    const client = createSignalingClient({ room: "r1", sig: "https://sig.test", WebSocketImpl: wsCtorFor(hub), fetchImpl });

    await expect(client.fetchIceServers!()).rejects.toThrow(/502/);
    client.close();
  });

  it("surfaces a room-full refusal as a close (third peer) — negative test", async () => {
    const hub = new FakeSignalingHub();
    const WS = wsCtorFor(hub);
    const opts = { room: "r1", sig: "https://sig.test", WebSocketImpl: WS, fetchImpl: okIceFetch([]) };
    createSignalingClient(opts);
    createSignalingClient(opts);
    const third = createSignalingClient(opts);

    let closedReason: string | undefined;
    let closedCalls = 0;
    third.onClosed((reason) => {
      closedReason = reason;
      closedCalls++;
    });
    await flush();
    expect(closedReason).toBe("room-full");
    expect(closedCalls).toBe(1);
  });

  it("derives ws/wss and http/https endpoints from the sig scheme", async () => {
    const hub = new FakeSignalingHub();
    let observedUrl = "";
    const WS = class extends FakeClientWS {
      constructor(url: string) {
        observedUrl = url;
        super(url, hub);
      }
    } as unknown as WebSocketCtor;
    const fetchImpl = okIceFetch([]);
    const client = createSignalingClient({ room: "abc-123", sig: "https://sig.test/base", WebSocketImpl: WS, fetchImpl });

    expect(observedUrl).toBe("wss://sig.test/base/room/abc-123");
    await client.fetchIceServers!();
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://sig.test/base/room/abc-123/ice-servers",
      expect.objectContaining({ method: "GET" }),
    );
    client.close();
  });

  it("close() fires onClosed exactly once", async () => {
    const hub = new FakeSignalingHub();
    const client = createSignalingClient({ room: "r1", sig: "https://sig.test", WebSocketImpl: wsCtorFor(hub), fetchImpl: okIceFetch([]) });
    let calls = 0;
    let reason: string | undefined;
    client.onClosed((r) => {
      calls++;
      reason = r;
    });
    client.close();
    await flush();
    expect(calls).toBe(1);
    expect(reason).toBe("client-closed");
  });
});
