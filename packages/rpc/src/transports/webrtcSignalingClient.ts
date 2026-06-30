/**
 * Signaling client — the peer side of the `apps/signaling` Durable Object
 * (workstream B). It implements the transport-facing `SignalingClient` contract
 * (`webrtcSignaling.ts`) over a WebSocket to a UUID room, plus one HTTP GET for
 * per-session TURN/STUN credentials.
 *
 * Two surfaces, one job each (no redundancy):
 *   - **WebSocket** (`WebSocketImpl`) — blind-relays our SDP/ICE to the peer and
 *     delivers the peer's back, plus room lifecycle (`peer-joined`/`peer-left`/
 *     `room-full`). The room PERSISTS, so the same socket carries ICE-restart.
 *   - **HTTP GET** (`fetchImpl`) — `fetchIceServers()` pulls the room's
 *     per-session ICE config. A request/response cred fetch maps onto an HTTP
 *     GET and fails loud on a non-200 (no racy push waiter on the relay socket).
 *
 * Both the WebSocket constructor and fetch are INJECTABLE so this runs unchanged
 * on Node (server, `ws`/built-in `WebSocket`), browser, and React Native, and is
 * fully unit-testable with an in-memory fake fabric (`webrtcSignalingClient.test.ts`).
 */

import type { RtcIceCandidate, RtcIceServer, RtcSessionDescription } from "./webrtcPeer.js";
import type { SignalingClient } from "./webrtcSignaling.js";

// --- Signaling wire protocol -------------------------------------------------
// These mirror `apps/signaling/src/protocol.ts` field-for-field. They are
// duplicated here (not imported) ON PURPOSE: `apps/signaling` is a standalone
// Cloudflare Worker with its own build boundary and is NOT a dependency of this
// foundational package. The wire contract IS the JSON shape; both ends declare
// it locally. Any change here MUST be mirrored in the room's protocol.ts.

interface DescriptionMessage {
  t: "description";
  desc: RtcSessionDescription;
}
interface CandidateMessage {
  t: "candidate";
  cand: RtcIceCandidate;
}
interface PeerLifecycleMessage {
  t: "peer-joined" | "peer-left";
  peers: number;
}
interface RoomFullMessage {
  t: "room-full";
}
type SignalingServerMessage =
  | DescriptionMessage
  | CandidateMessage
  | PeerLifecycleMessage
  | RoomFullMessage;

interface IceServersResponse {
  iceServers: RtcIceServer[];
}

/** Minimal WHATWG `WebSocket` surface used here (browser/RN/Node all expose it). */
export interface WebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "open", handler: () => void): void;
  addEventListener(type: "close", handler: (ev: { code?: number; reason?: string }) => void): void;
  addEventListener(type: "error", handler: (ev: unknown) => void): void;
  addEventListener(type: "message", handler: (ev: { data: unknown }) => void): void;
}

export interface WebSocketCtor {
  new (url: string): WebSocketLike;
}

export interface SignalingClientOptions {
  /** Rendezvous room id (the unguessable UUID from the pairing link `room=`). */
  room: string;
  /** Signaling endpoint base from the pairing link `sig=` (http(s) or ws(s)). */
  sig: string;
  /** Injected `fetch` (defaults to `globalThis.fetch`). Used by `fetchIceServers()`. */
  fetchImpl?: typeof fetch;
  /** Injected WebSocket constructor (defaults to `globalThis.WebSocket`). */
  WebSocketImpl?: WebSocketCtor;
  /** Log prefix for diagnostics. */
  logPrefix?: string;
}

const READY_STATE_OPEN = 1;

/** Apply the `/room/:roomId{suffix}` path to the `sig` base — shared by both builders. */
function roomUrl(sig: string, room: string, suffix: string): URL {
  const url = new URL(sig);
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/room/${encodeURIComponent(room)}${suffix}`;
  return url;
}

/** Build the `ws(s)://…/room/:roomId` URL from the `sig` endpoint base. */
function toRoomWsUrl(sig: string, room: string): string {
  const url = roomUrl(sig, room, "");
  if (url.protocol === "http:") url.protocol = "ws:";
  else if (url.protocol === "https:") url.protocol = "wss:";
  else if (url.protocol !== "ws:" && url.protocol !== "wss:") {
    throw new Error(`Unsupported signaling scheme: ${url.protocol} (expected http(s)/ws(s))`);
  }
  return url.toString();
}

/** Build the `http(s)://…/room/:roomId/ice-servers` URL from the `sig` base. */
function toIceServersHttpUrl(sig: string, room: string): string {
  const url = roomUrl(sig, room, "/ice-servers");
  if (url.protocol === "ws:") url.protocol = "http:";
  else if (url.protocol === "wss:") url.protocol = "https:";
  else if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Unsupported signaling scheme: ${url.protocol} (expected http(s)/ws(s))`);
  }
  return url.toString();
}

function decodeMessageData(data: unknown): string | null {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  if (ArrayBuffer.isView(data)) {
    return new TextDecoder().decode(data as ArrayBufferView as Uint8Array);
  }
  return null;
}

export function createSignalingClient(options: SignalingClientOptions): SignalingClient {
  const { room, sig } = options;
  const log = options.logPrefix ?? "[signaling-client]";
  const WebSocketImpl = options.WebSocketImpl ?? (globalThis as { WebSocket?: WebSocketCtor }).WebSocket;
  if (!WebSocketImpl) {
    throw new Error("No WebSocket implementation available (pass WebSocketImpl)");
  }
  const fetchImpl = options.fetchImpl ?? (globalThis as { fetch?: typeof fetch }).fetch;

  const wsUrl = toRoomWsUrl(sig, room);
  const iceUrl = toIceServersHttpUrl(sig, room);

  const descriptionHandlers = new Set<(desc: RtcSessionDescription) => void>();
  const candidateHandlers = new Set<(candidate: RtcIceCandidate) => void>();
  const closedHandlers = new Set<(reason?: string) => void>();
  // Frames that land before the transport has registered a handler are buffered
  // and flushed on first subscription (the offerer's answer can arrive while the
  // transport is still awaiting `provider.create()`). This is an ordering buffer,
  // not a failure backstop.
  const pendingDescriptions: RtcSessionDescription[] = [];
  const pendingCandidates: RtcIceCandidate[] = [];

  let closed = false;
  let closeReason: string | undefined;

  const ws = new WebSocketImpl(wsUrl);

  let resolveOpen!: () => void;
  let rejectOpen!: (error: unknown) => void;
  const openPromise = new Promise<void>((resolve, reject) => {
    resolveOpen = resolve;
    rejectOpen = reject;
  });
  // `openPromise` is only awaited by an actual send. Mark it handled so a client
  // that closes (or only calls `fetchIceServers`) without ever sending does not
  // surface an unhandled rejection — a real `await openPromise` still rejects.
  void openPromise.catch(() => {});
  let opened = false;

  ws.addEventListener("open", () => {
    opened = true;
    resolveOpen();
  });

  ws.addEventListener("error", (ev) => {
    console.warn(`${log} websocket error`, ev);
    if (!opened) rejectOpen(new Error("Signaling websocket failed before open"));
  });

  ws.addEventListener("close", (ev) => {
    const reason = closeReason ?? ev?.reason ?? `code ${ev?.code ?? "?"}`;
    if (!opened) rejectOpen(new Error(`Signaling websocket closed before open: ${reason}`));
    fireClosed(reason);
  });

  ws.addEventListener("message", (ev) => {
    const text = decodeMessageData(ev.data);
    if (text === null) {
      console.warn(`${log} dropping non-text frame`);
      return;
    }
    let message: SignalingServerMessage;
    try {
      message = JSON.parse(text) as SignalingServerMessage;
    } catch (error) {
      console.warn(`${log} dropping malformed frame`, error);
      return;
    }
    switch (message.t) {
      case "description":
        emitDescription((message as DescriptionMessage).desc);
        return;
      case "candidate":
        emitCandidate((message as CandidateMessage).cand);
        return;
      case "room-full":
        // A third peer was refused — fail loud: surface as a room close so the
        // transport stops trying (a fourth attempt would also be refused).
        closeReason = "room-full";
        try {
          ws.close(1000, "room-full");
        } catch {
          /* already closing */
        }
        fireClosed("room-full");
        return;
      case "peer-joined":
      case "peer-left":
        // Lifecycle hints — the transport drives offer/answer itself; nothing to do.
        return;
      default:
        console.warn(`${log} unknown frame`, message);
        return;
    }
  });

  function emitDescription(desc: RtcSessionDescription): void {
    if (descriptionHandlers.size === 0) {
      pendingDescriptions.push(desc);
      return;
    }
    for (const handler of descriptionHandlers) {
      try {
        handler(desc);
      } catch (error) {
        console.warn(`${log} description handler threw`, error);
      }
    }
  }

  function emitCandidate(candidate: RtcIceCandidate): void {
    if (candidateHandlers.size === 0) {
      pendingCandidates.push(candidate);
      return;
    }
    for (const handler of candidateHandlers) {
      try {
        handler(candidate);
      } catch (error) {
        console.warn(`${log} candidate handler threw`, error);
      }
    }
  }

  function fireClosed(reason?: string): void {
    if (closed) return;
    closed = true;
    for (const handler of closedHandlers) {
      try {
        handler(reason);
      } catch (error) {
        console.warn(`${log} closed handler threw`, error);
      }
    }
  }

  async function sendFrame(frame: DescriptionMessage | CandidateMessage): Promise<void> {
    if (closed) throw new Error("Signaling room is closed");
    if (!opened) await openPromise;
    if (ws.readyState !== READY_STATE_OPEN) {
      throw new Error("Signaling websocket is not open");
    }
    ws.send(JSON.stringify(frame));
  }

  return {
    async sendDescription(desc: RtcSessionDescription): Promise<void> {
      await sendFrame({ t: "description", desc });
    },

    async sendCandidate(candidate: RtcIceCandidate): Promise<void> {
      await sendFrame({ t: "candidate", cand: candidate });
    },

    onDescription(handler: (desc: RtcSessionDescription) => void): () => void {
      descriptionHandlers.add(handler);
      if (pendingDescriptions.length > 0) {
        for (const desc of pendingDescriptions.splice(0)) handler(desc);
      }
      return () => descriptionHandlers.delete(handler);
    },

    onCandidate(handler: (candidate: RtcIceCandidate) => void): () => void {
      candidateHandlers.add(handler);
      if (pendingCandidates.length > 0) {
        for (const candidate of pendingCandidates.splice(0)) handler(candidate);
      }
      return () => candidateHandlers.delete(handler);
    },

    async fetchIceServers(): Promise<RtcIceServer[]> {
      if (!fetchImpl) {
        throw new Error("No fetch implementation available (pass fetchImpl)");
      }
      const res = await fetchImpl(iceUrl, { method: "GET", headers: { accept: "application/json" } });
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        throw new Error(`Signaling ice-servers ${res.status}: ${detail}`.trim());
      }
      const body = (await res.json()) as IceServersResponse;
      if (!body || !Array.isArray(body.iceServers)) {
        throw new Error("Signaling ice-servers response missing iceServers[]");
      }
      return body.iceServers;
    },

    onClosed(handler: (reason?: string) => void): () => void {
      closedHandlers.add(handler);
      if (closed) handler(closeReason);
      return () => closedHandlers.delete(handler);
    },

    close(): void {
      closeReason = closeReason ?? "client-closed";
      try {
        ws.close(1000, "client-closed");
      } catch {
        /* already closing */
      }
      fireClosed(closeReason);
    },
  };
}
