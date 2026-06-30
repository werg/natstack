/**
 * SignalingRoom DO tests — prove the dumb two-peer relay with in-memory fakes
 * for the Cloudflare Hibernation API (`acceptWebSocket`/`getWebSockets`/
 * `getTags`), `WebSocketPair`, and `Response` (Node's undici `Response` throws
 * on status 101, so it is stubbed).
 *
 * Proven here: two peers exchange offer/answer + candidates; a third joiner is
 * refused; ice-servers serves the STUN baseline and FAILS LOUD (502) when TURN
 * is provisioned but minting breaks; a dropped peer frees its slot for rejoin.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SignalingRoom, type SignalingRoomEnv } from "./room";

// --- Hibernation-API fakes --------------------------------------------------

class FakeWS {
  sent: string[] = [];
  accepted = false;
  closed = false;
  closeCode?: number;
  accept(): void {
    this.accepted = true;
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(code?: number, _reason?: string): void {
    this.closed = true;
    this.closeCode = code;
  }
  last<T = { t: string; [k: string]: unknown }>(): T | undefined {
    const s = this.sent[this.sent.length - 1];
    return s === undefined ? undefined : (JSON.parse(s) as T);
  }
}

/** Every server-side socket the DO mints, in creation order. */
let createdServers: FakeWS[] = [];

class FakeWebSocketPair {
  0: FakeWS;
  1: FakeWS;
  constructor() {
    this[0] = new FakeWS(); // client end (returned in the 101 response)
    this[1] = new FakeWS(); // server end (the DO keeps this)
    createdServers.push(this[1]);
  }
}

class FakeResponse {
  status: number;
  webSocket?: unknown;
  headers: Headers;
  private readonly bodyText: string;
  constructor(
    body: unknown,
    init?: { status?: number; headers?: HeadersInit; webSocket?: unknown },
  ) {
    this.status = init?.status ?? 200;
    this.webSocket = init?.webSocket;
    this.headers = new Headers(init?.headers ?? {});
    this.bodyText = typeof body === "string" ? body : "";
  }
  async json(): Promise<unknown> {
    return JSON.parse(this.bodyText);
  }
  async text(): Promise<string> {
    return this.bodyText;
  }
}

/**
 * In-memory stand-in for `DurableObjectStorage` — only the `get`/`put`/`delete`
 * single-key surface the room uses for its pre-join frame buffer. Values are
 * cloned in/out so a stored array cannot be mutated by reference, matching the
 * structured-clone semantics of real DO storage.
 */
class FakeStorage {
  private readonly map = new Map<string, unknown>();
  async get<T>(key: string): Promise<T | undefined> {
    const value = this.map.get(key);
    return value === undefined ? undefined : (structuredClone(value) as T);
  }
  async put<T>(keyOrEntries: string | Record<string, T>, value?: T): Promise<void> {
    // Mirror the real DO overloads: put(key, value) and the batched put(entries).
    if (typeof keyOrEntries === "string") {
      this.map.set(keyOrEntries, structuredClone(value));
    } else {
      for (const [k, v] of Object.entries(keyOrEntries)) this.map.set(k, structuredClone(v));
    }
  }
  async delete(keys: string | string[]): Promise<boolean | number> {
    if (Array.isArray(keys)) {
      let n = 0;
      for (const k of keys) if (this.map.delete(k)) n++;
      return n;
    }
    return this.map.delete(keys);
  }
  async list<T>(options?: { prefix?: string }): Promise<Map<string, T>> {
    const prefix = options?.prefix ?? "";
    const out = new Map<string, T>();
    // Real DO storage.list returns keys in UTF-8 lexicographic order.
    for (const key of [...this.map.keys()].sort()) {
      if (key.startsWith(prefix)) out.set(key, structuredClone(this.map.get(key)) as T);
    }
    return out;
  }
}

class FakeState {
  private entries: Array<{ ws: FakeWS; tags: string[] }> = [];
  readonly storage = new FakeStorage();
  acceptWebSocket(ws: FakeWS, tags: string[]): void {
    this.entries.push({ ws, tags });
  }
  getWebSockets(): FakeWS[] {
    return this.entries.map((e) => e.ws);
  }
  getTags(ws: FakeWS): string[] {
    return this.entries.find((e) => e.ws === ws)?.tags ?? [];
  }
  /** Mirror the runtime dropping a closed socket from the roster. */
  remove(ws: FakeWS): void {
    this.entries = this.entries.filter((e) => e.ws !== ws);
  }
}

function makeRoom(env: SignalingRoomEnv = { ENVIRONMENT: "test" }): {
  room: SignalingRoom;
  state: FakeState;
} {
  const state = new FakeState();
  const room = new SignalingRoom(state as unknown as DurableObjectState, env);
  return { room, state };
}

// The DO's hibernation handlers take the runtime `WebSocket`; our FakeWS stands
// in for it (only `send`/`accept`/`close` are exercised). Both handlers are
// async now (storage-backed buffer); the relay/notify sends still run
// synchronously before the first await, so callers that do not need the buffer
// path can ignore the returned promise.
const deliver = (room: SignalingRoom, ws: FakeWS, data: string): Promise<void> =>
  room.webSocketMessage(ws as unknown as WebSocket, data);
const drop = (room: SignalingRoom, ws: FakeWS, code: number): Promise<void> =>
  room.webSocketClose(ws as unknown as WebSocket, code, "", false);

function upgradeRequest(roomId = "r1"): Request {
  return {
    url: `https://sig.test/room/${roomId}`,
    method: "GET",
    headers: new Headers({ Upgrade: "websocket" }),
  } as unknown as Request;
}

function iceRequest(roomId = "r1"): Request {
  return {
    url: `https://sig.test/room/${roomId}/ice-servers`,
    method: "GET",
    headers: new Headers(),
  } as unknown as Request;
}

const offer = JSON.stringify({ t: "description", desc: { type: "offer", sdp: "OFFER-SDP" } });
const answer = JSON.stringify({ t: "description", desc: { type: "answer", sdp: "ANSWER-SDP" } });
const candidate = JSON.stringify({ t: "candidate", cand: { candidate: "candidate:1 udp", sdpMid: "0" } });

beforeEach(() => {
  createdServers = [];
  vi.stubGlobal("WebSocketPair", FakeWebSocketPair);
  vi.stubGlobal("Response", FakeResponse);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("SignalingRoom", () => {
  it("relays an offer/answer and candidates between exactly two peers", async () => {
    const { room } = makeRoom();

    // Peer A joins (slot a), then peer B joins (slot b).
    await room.fetch(upgradeRequest());
    await room.fetch(upgradeRequest());
    const [peerA, peerB] = createdServers;
    expect(peerA).toBeDefined();
    expect(peerB).toBeDefined();

    // B's arrival notifies the already-present A.
    expect(peerA!.last()).toMatchObject({ t: "peer-joined", peers: 2 });

    // A → offer → relayed verbatim to B (and NOT echoed back to A).
    deliver(room, peerA!, offer);
    expect(peerB!.sent).toContain(offer);
    expect(peerA!.sent).not.toContain(offer);

    // B → answer → relayed to A.
    deliver(room, peerB!, answer);
    expect(peerA!.sent).toContain(answer);

    // Candidates flow both ways.
    deliver(room, peerA!, candidate);
    expect(peerB!.sent).toContain(candidate);
    deliver(room, peerB!, candidate);
    expect(peerA!.sent).toContain(candidate);
  });

  it("buffers an offer + candidates sent before the second peer joins, then flushes them in order", async () => {
    const { room } = makeRoom();

    // Only the offerer (peer A) is in the room — the answerer is still scanning
    // the pairing QR and has not joined yet.
    await room.fetch(upgradeRequest());
    const [peerA] = createdServers;
    expect(peerA).toBeDefined();

    // A eagerly trickles its offer and two candidates into the still-empty room.
    // With no counterpart present these are BUFFERED (not dropped for want of a
    // relay target) and are never echoed back to the lone sender.
    const candidate2 = JSON.stringify({
      t: "candidate",
      cand: { candidate: "candidate:2 udp", sdpMid: "0" },
    });
    await deliver(room, peerA!, offer);
    await deliver(room, peerA!, candidate);
    await deliver(room, peerA!, candidate2);
    expect(peerA!.sent).toEqual([]); // nothing relayed back to itself

    // The answerer (peer B) joins. The buffered frames flush onto B's socket in
    // the exact order A sent them — and nothing else leaks onto it.
    await room.fetch(upgradeRequest());
    const peerB = createdServers[1]!;
    expect(peerB).toBeDefined();
    expect(peerB.sent).toEqual([offer, candidate, candidate2]);

    // The flush targets only the joiner; A still just gets the peer-joined event.
    expect(peerA!.last()).toMatchObject({ t: "peer-joined", peers: 2 });

    // Live relay resumes normally now that both peers are present.
    await deliver(room, peerB, answer);
    expect(peerA!.sent).toContain(answer);
  });

  it("bounds the pre-join buffer — a flood past the cap is dropped LOUDLY, not grown (negative test)", async () => {
    const { room } = makeRoom();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    // Only peer A is present; it floods candidates far past the cap while alone.
    await room.fetch(upgradeRequest());
    const [peerA] = createdServers;
    const FLOOD = 200;
    const candAt = (i: number): string =>
      JSON.stringify({ t: "candidate", cand: { candidate: `candidate:${i} udp`, sdpMid: "0" } });
    for (let i = 0; i < FLOOD; i++) await deliver(room, peerA!, candAt(i));

    // The overflow was dropped LOUDLY rather than silently swallowed.
    expect(warn).toHaveBeenCalled();

    // Peer B joins: it receives a bounded backlog (never the whole flood),
    // and the frames it does get are the in-order EARLIEST prefix — so the
    // offer and first candidates, the ones that matter, always survive.
    await room.fetch(upgradeRequest());
    const peerB = createdServers[1]!;
    expect(peerB.sent.length).toBeGreaterThan(0);
    expect(peerB.sent.length).toBeLessThan(FLOOD);
    peerB.sent.forEach((frame, i) => expect(frame).toBe(candAt(i)));
  });

  it("refuses a third joiner (room holds exactly two) — negative test", async () => {
    const { room, state } = makeRoom();

    await room.fetch(upgradeRequest());
    await room.fetch(upgradeRequest());
    await room.fetch(upgradeRequest()); // the third

    const third = createdServers[2]!;
    expect(third.accepted).toBe(true); // accepted only to deliver the refusal
    expect(third.last()).toMatchObject({ t: "room-full" });
    expect(third.closed).toBe(true);
    expect(third.closeCode).toBe(1013);
    // The third socket never entered the hibernation roster.
    expect(state.getWebSockets()).toHaveLength(2);
  });

  it("never relays a frame it does not understand (stays a dumb SDP/ICE pipe)", async () => {
    const { room } = makeRoom();
    await room.fetch(upgradeRequest());
    await room.fetch(upgradeRequest());
    const [peerA, peerB] = createdServers;
    const before = peerB!.sent.length;

    deliver(room, peerA!, JSON.stringify({ t: "evict-peer" }));
    deliver(room, peerA!, "not even json");

    expect(peerB!.sent.length).toBe(before);
  });

  it("frees a dropped peer's slot so it can rejoin for ICE-restart", async () => {
    const { room, state } = makeRoom();
    await room.fetch(upgradeRequest());
    await room.fetch(upgradeRequest());
    const [peerA, peerB] = createdServers;

    // Peer A's signaling socket drops.
    drop(room, peerA!, 1006);
    expect(peerB!.last()).toMatchObject({ t: "peer-left", peers: 1 });
    state.remove(peerA!); // runtime drops the closed socket from the roster

    // The room persists; a rejoin succeeds (room is no longer full).
    await room.fetch(upgradeRequest());
    expect(state.getWebSockets()).toHaveLength(2);
    const rejoined = createdServers[2]!;
    expect(rejoined.closed).toBe(false); // accepted, not refused
  });

  it("serves the free STUN baseline when TURN is not provisioned", async () => {
    const { room } = makeRoom({ ENVIRONMENT: "test" });
    const res = await room.fetch(iceRequest());
    expect(res.status).toBe(200);
    expect(res.headers.get("x-signaling-turn")).toBe("stun-only");
    const body = (await res.json()) as { iceServers: Array<{ urls: string }> };
    expect(body.iceServers).toEqual([{ urls: "stun:stun.cloudflare.com:3478" }]);
  });

  it("FAILS LOUD (502) when TURN is provisioned but minting breaks — negative test", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 500,
        statusText: "Server Error",
        text: async () => "upstream down",
      })),
    );
    const { room } = makeRoom({
      ENVIRONMENT: "test",
      TURN_KEY_ID: "key-1",
      TURN_KEY_API_TOKEN: "secret-1",
    });
    const res = await room.fetch(iceRequest());
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("mint failed");
  });

  it("rejects a non-websocket request to the room path", async () => {
    const { room } = makeRoom();
    const res = await room.fetch({
      url: "https://sig.test/room/r1",
      method: "GET",
      headers: new Headers(),
    } as unknown as Request);
    expect(res.status).toBe(426);
  });
});
