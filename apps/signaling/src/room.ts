/**
 * SignalingRoom — a UUID-addressed rendezvous Durable Object that blind-relays
 * SDP/ICE between exactly two peers (plan §2).
 *
 * It is deliberately DUMB: it never parses SDP, never validates candidates, and
 * holds no security state. Security lives in the QR DTLS-fingerprint pin checked
 * by the transport (`webrtcClient.ts`), not here. A signaling box that swapped a
 * fingerprint would simply be detected and rejected by the pinned peer.
 *
 * The room PERSISTS for the connection's lifetime via the WebSocket Hibernation
 * API (`acceptWebSocket`/`webSocketMessage`/`webSocketClose`): it costs no
 * compute while idle but keeps the two sockets alive so it can carry an
 * ICE-restart, not just the first connect. All roster state is derived from
 * `getWebSockets()` + tags, so nothing is lost across hibernation and nothing
 * sensitive is persisted.
 *
 * Relaying is JOIN-ORDER INDEPENDENT. The offerer typically reaches the room
 * before the answerer has finished scanning the pairing QR, so if a peer sends
 * its offer/candidates while the other slot is still empty those frames are
 * BUFFERED (in DO storage, so the buffer also survives a hibernation during the
 * scan gap) and FLUSHED — in order — the instant the second peer joins, rather
 * than dropped for want of a relay target. The buffer is ephemeral: it is
 * bounded (`MAX_BUFFERED_FRAMES`; excess is dropped loudly, never grown) and
 * cleared when the room empties, so a (re)used room never replays a dead
 * session's offer. The frames stay opaque — the room buffers bytes, it does not
 * parse SDP.
 *
 * The two peers are told apart by a `peer:a` / `peer:b` tag. Relaying does not
 * need the tag (there are only two sockets, so "the peer" is simply the other
 * one) but the tag gives a deterministic slot and lets a dropped peer rejoin the
 * SAME slot to drive ICE-restart.
 */

import { RELAYED_TYPES, type SignalingServerMessage } from "./protocol";
import { mintIceServers, type TurnEnv } from "./turn";

const SLOT_A = "peer:a";
const SLOT_B = "peer:b";
/** RFC 6455 1013 "Try Again Later" — the room is at capacity. */
const CLOSE_TRY_AGAIN_LATER = 1013;
/**
 * DO-storage key holding the ordered frames a peer sent before its counterpart
 * joined. Flushed to the second joiner, then deleted; also wiped when the room
 * empties so it is never replayed into a later occupancy.
 */
// One storage key PER buffered frame (not one growing array): an append is O(1)
// and a single large SDP offer can't push the whole buffer past the 128 KiB
// per-value storage cap. The zero-padded seq orders the keys lexicographically.
const PENDING_FRAME_PREFIX = "pending-frame:";
const PENDING_SEQ_KEY = "pending-seq";
/**
 * Hard cap on pre-join buffered frames. An offer plus a session's worth of
 * trickled ICE candidates fits comfortably; beyond this the room is being
 * flooded, so excess is dropped LOUDLY rather than letting storage grow without
 * bound.
 */
const MAX_BUFFERED_FRAMES = 64;

export interface SignalingRoomEnv extends TurnEnv {
  ENVIRONMENT?: string;
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function send(ws: WebSocket, message: SignalingServerMessage): void {
  try {
    ws.send(JSON.stringify(message));
  } catch {
    // The socket is gone; the close handler will reconcile the roster.
  }
}

export class SignalingRoom implements DurableObject {
  constructor(
    private readonly state: DurableObjectState,
    private readonly env: SignalingRoomEnv,
  ) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const segments = url.pathname.split("/").filter(Boolean);

    // Expect /room/:roomId  or  /room/:roomId/ice-servers
    if (segments[0] !== "room" || !segments[1]) {
      return jsonResponse({ error: "not found" }, 404);
    }

    if (segments[2] === "ice-servers") {
      if (request.method !== "GET") {
        return jsonResponse({ error: "method not allowed" }, 405);
      }
      try {
        const { iceServers, turn } = await mintIceServers(this.env);
        return new Response(JSON.stringify({ iceServers }), {
          status: 200,
          headers: {
            "content-type": "application/json; charset=utf-8",
            "cache-control": "no-store",
            // Announce the STUN-only baseline so a missing TURN backstop is
            // visible (plan: "every surviving fallback announces itself").
            "x-signaling-turn": turn ? "minted" : "stun-only",
          },
        });
      } catch (error) {
        // Fail loud: TURN is provisioned but minting broke. The peer's
        // `fetchIceServers()` sees a non-200 and rejects.
        return jsonResponse({ error: `ice-servers: ${String(error)}` }, 502);
      }
    }

    const upgrade = request.headers.get("Upgrade");
    if (!upgrade || upgrade.toLowerCase() !== "websocket") {
      return jsonResponse({ error: "expected websocket upgrade" }, 426);
    }
    return this.handleJoin();
  }

  private async handleJoin(): Promise<Response> {
    const sockets = this.state.getWebSockets();
    const { 0: client, 1: server } = new WebSocketPair();

    if (sockets.length >= 2) {
      // Reject the third joiner. Accept the socket the plain way (NOT
      // hibernatable) only to deliver the refusal and close it — it never
      // enters the roster.
      server.accept();
      send(server, { t: "room-full" });
      server.close(CLOSE_TRY_AGAIN_LATER, "room full");
      return new Response(null, { status: 101, webSocket: client });
    }

    const taken = new Set(sockets.flatMap((ws) => this.state.getTags(ws)));
    const slot = taken.has(SLOT_A) ? SLOT_B : SLOT_A;
    this.state.acceptWebSocket(server, [slot]);

    // Tell the peer(s) already present that the room is now occupied by another
    // peer, so the answerer knows to expect an offer.
    const peers = sockets.length + 1;
    for (const other of sockets) {
      send(other, { t: "peer-joined", peers });
    }

    // This join completes the pair: deliver anything the first peer sent while
    // it was alone, in order, before any live frame can reach the new joiner.
    if (sockets.length === 1) {
      await this.flushPendingTo(server);
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const text = typeof message === "string" ? message : new TextDecoder().decode(message);
    let type: unknown;
    try {
      type = (JSON.parse(text) as { t?: unknown }).t;
    } catch {
      console.warn("[signaling] dropping non-JSON frame");
      return;
    }
    if (typeof type !== "string" || !RELAYED_TYPES.has(type)) {
      console.warn(`[signaling] dropping unrelayable frame t=${String(type)}`);
      return;
    }
    // Blind relay: forward the original bytes verbatim to the other peer. We
    // parsed only the top-level `t` to route; the SDP/ICE payload is never read.
    const others = this.state.getWebSockets().filter((other) => other !== ws);
    if (others.length === 0) {
      // No counterpart yet (the answerer is still arriving). Hold the frame so
      // it is delivered on join instead of dropped — the connection no longer
      // depends on who reaches the room first.
      await this.bufferFrame(text);
      return;
    }
    for (const other of others) other.send(text);
  }

  async webSocketClose(
    ws: WebSocket,
    code: number,
    reason: string,
    _wasClean: boolean,
  ): Promise<void> {
    try {
      ws.close(code, reason);
    } catch {
      // Already closing.
    }
    // The room is NOT destroyed — the slot is freed for a rejoin (ICE-restart).
    const others = this.state.getWebSockets().filter((w) => w !== ws);
    for (const other of others) {
      send(other, { t: "peer-left", peers: others.length });
    }
    if (others.length === 0) {
      // The room is now empty. Drop any frames a solo peer left buffered (an
      // offerer that gave up before the answerer arrived) so they are never
      // replayed into a later occupancy of this room id.
      await this.clearPendingFrames();
    }
  }

  webSocketError(ws: WebSocket, error: unknown): void {
    console.warn("[signaling] websocket error", error);
    try {
      ws.close(1011, "internal error");
    } catch {
      // Already closing.
    }
  }

  /**
   * Append a frame to the ordered pre-join buffer. Bounded: once the cap is hit
   * the frame is dropped with a loud warning rather than growing storage without
   * limit (the offer and early candidates — all that is needed to connect —
   * arrive first and are well within the cap).
   */
  private async bufferFrame(text: string): Promise<void> {
    const seq = (await this.state.storage.get<number>(PENDING_SEQ_KEY)) ?? 0;
    if (seq >= MAX_BUFFERED_FRAMES) {
      console.warn(
        `[signaling] pre-join buffer full (cap ${MAX_BUFFERED_FRAMES}); dropping frame until the second peer joins`,
      );
      return;
    }
    // One batched put: the frame and the advanced sequence counter commit together
    // (atomic — no torn state where the frame is stored but the counter didn't move).
    await this.state.storage.put({
      [PENDING_FRAME_PREFIX + String(seq).padStart(6, "0")]: text,
      [PENDING_SEQ_KEY]: seq + 1,
    });
  }

  /** Delete every buffered frame and the sequence counter. */
  private async clearPendingFrames(): Promise<void> {
    const keys = [...(await this.state.storage.list({ prefix: PENDING_FRAME_PREFIX })).keys()];
    if (keys.length > 0) await this.state.storage.delete(keys);
    await this.state.storage.delete(PENDING_SEQ_KEY);
  }

  /**
   * Deliver the buffered frames to the freshly joined second peer, in the order
   * they were sent, then clear the buffer. The sends run as a synchronous burst
   * so the backlog lands before any live relay; the delete follows so a crash
   * mid-flush re-delivers (duplicate offer/candidate is harmless) rather than
   * losing the offer.
   */
  private async flushPendingTo(ws: WebSocket): Promise<void> {
    // list() returns keys in lexicographic order; the zero-padded seq makes that
    // numeric, so send order == arrival order.
    const pending = await this.state.storage.list<string>({ prefix: PENDING_FRAME_PREFIX });
    if (pending.size === 0) return;
    for (const frame of pending.values()) ws.send(frame);
    await this.clearPendingFrames();
  }
}
