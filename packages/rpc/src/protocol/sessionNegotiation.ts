/**
 * `sessionNegotiation` — the transport-neutral handshake + control-frame
 * protocol that lets **N logically-authenticated sessions multiplex over one
 * pipe** (the WebRTC control DataChannel). It generalizes the WebSocket RPC
 * protocol (`ws:auth`/`ws:auth-result`/`ws:rpc`/`ws:route`/`ws:routed`/
 * `ws:event` in `wsProtocol.ts`) by tagging every frame with a `sid`
 * (session id) and lifting the auth handshake out of the socket.
 *
 * Today the `ws:auth → ws:auth-result` handshake is bound to one WebSocket and
 * establishes ONE principal per socket (rpcServer.ts:678). Under one WebRTC
 * pipe each panel is still its own principal (`panel:<historyEntryKey>`), so the
 * handshake must run **once per logical session** over the shared channel: each
 * `open` frame redeems that panel's own one-time connection grant and passes its
 * own runtime-lease gate, exactly as a dedicated socket does today.
 *
 * ### Channel split (see plan §1)
 * - **control channel** (reliable/ordered): these JSON `SessionControlFrame`s —
 *   handshake, RPC envelopes, events, routing, stream initiation/cancel,
 *   keepalive.
 * - **bulk channel** (reliable/ordered): binary `streamCodec` v2 frames
 *   (`[streamId:4][type:1][len:4][payload]`) carrying proxyFetch/asset bytes.
 *   A `stream-open` control frame allocates the `streamId`; the body rides the
 *   bulk channel keyed by it.
 *
 * Identity stays in the envelope's immutable `delivery.caller`/`provenance`; the
 * session binds the authenticated principal at `open` time and the channel never
 * rewrites `delivery.caller` on relayed frames.
 */

import type { AuthenticatedCaller, CallerKind, RpcEnvelope } from "../types.js";
import type { ClientPlatform } from "./wsProtocol.js";

export const SESSION_PROTOCOL_VERSION = 1 as const;

/** Error code stamped when a logical session drops with calls in flight. */
export const SESSION_CONNECTION_LOST_CODE = "CONNECTION_LOST" as const;

// ---------------------------------------------------------------------------
// Frame tags
// ---------------------------------------------------------------------------

export const SESSION_OPEN = "open" as const;
export const SESSION_OPEN_RESULT = "open-result" as const;
export const SESSION_CLOSE = "close" as const; // client→server: tear down this session
export const SESSION_CLOSED = "closed" as const; // server→client: session terminated (lease revoke, etc.)
export const SESSION_RPC = "rpc" as const; // request/response/event to or from the server principal ('main')
export const SESSION_ROUTE = "route" as const; // caller-to-caller request/response/event (ws:route)
export const SESSION_ROUTED = "routed" as const; // delivered caller-to-caller frame (ws:routed)
export const SESSION_EVENT = "event" as const; // server→client direct event (ws:event)
export const SESSION_ROUTED_RESPONSE_ERROR = "routed-response-error" as const;
export const SESSION_ROUTED_EVENT_ERROR = "routed-event-error" as const;
export const SESSION_STREAM_OPEN = "stream-open" as const; // begin a bulk stream (envelope.message is a stream-request)
export const SESSION_STREAM_CANCEL = "stream-cancel" as const; // cancel a bulk stream
export const SESSION_PING = "ping" as const; // pipe-level keepalive (no sid)
export const SESSION_PONG = "pong" as const;

// ---------------------------------------------------------------------------
// Frame shapes
// ---------------------------------------------------------------------------

/** First frame of a logical session — the per-session analog of `ws:auth`. */
export interface SessionOpenFrame {
  t: typeof SESSION_OPEN;
  sid: string;
  /** Per-principal one-time connection grant token (or a bearer for non-panels). */
  token: string;
  /** Host-chosen connection id — the lease key the gate matches (panelRuntimeCoordinator). */
  connectionId?: string;
  clientSessionId?: string;
  clientLabel?: string;
  clientPlatform?: ClientPlatform;
}

/** Result of a session open — the per-session analog of `ws:auth-result`. */
export interface SessionOpenResultFrame {
  t: typeof SESSION_OPEN_RESULT;
  sid: string;
  success: boolean;
  callerId?: string;
  callerKind?: CallerKind;
  connectionId?: string;
  /** Server identity — a change across reconnect means cold-recover (vs resubscribe). */
  serverBootId?: string;
  /** True when the server lost this session's inbox/state ⇒ cold-recover. */
  sessionDirty?: boolean;
  /**
   * Present only when this session authenticated by redeeming a one-time pairing
   * code: the freshly issued device credential to persist for reconnects.
   */
  deviceCredential?: { deviceId: string; refreshToken: string };
  error?: string;
  /** Terminal close codes (4090 lease denied, 4001 revoked, …) — do NOT reconnect this session. */
  terminal?: boolean;
}

export interface SessionCloseFrame {
  t: typeof SESSION_CLOSE;
  sid: string;
  code?: number;
  reason?: string;
}

export interface SessionClosedFrame {
  t: typeof SESSION_CLOSED;
  sid: string;
  code?: number;
  reason?: string;
  /** Terminal (lease revoked/denied/entity retired) — the session must not auto-reopen. */
  terminal?: boolean;
}

export interface SessionRpcFrame {
  t: typeof SESSION_RPC;
  sid: string;
  envelope: RpcEnvelope;
}

export interface SessionRouteFrame {
  t: typeof SESSION_ROUTE;
  sid: string;
  envelope: RpcEnvelope;
  targetConnectionId?: string;
}

export interface SessionRoutedFrame {
  t: typeof SESSION_ROUTED;
  sid: string;
  envelope: RpcEnvelope;
}

export interface SessionEventFrame {
  t: typeof SESSION_EVENT;
  sid: string;
  event: string;
  payload: unknown;
}

export interface SessionRoutedResponseErrorFrame {
  t: typeof SESSION_ROUTED_RESPONSE_ERROR;
  sid: string;
  targetId: string;
  requestId: string;
  error: string;
  errorCode?: string;
}

export interface SessionRoutedEventErrorFrame {
  t: typeof SESSION_ROUTED_EVENT_ERROR;
  sid: string;
  targetId: string;
  event: string;
  error: string;
  errorCode?: string;
}

export interface SessionStreamOpenFrame {
  t: typeof SESSION_STREAM_OPEN;
  sid: string;
  /** Bulk-channel stream id the response body will be tagged with. */
  streamId: number;
  /** envelope.message is an `RpcStreamRequest`. */
  envelope: RpcEnvelope;
}

export interface SessionStreamCancelFrame {
  t: typeof SESSION_STREAM_CANCEL;
  sid: string;
  streamId: number;
}

export interface SessionPingFrame {
  t: typeof SESSION_PING;
  ts: number;
}

export interface SessionPongFrame {
  t: typeof SESSION_PONG;
  ts: number;
}

export type SessionControlFrame =
  | SessionOpenFrame
  | SessionOpenResultFrame
  | SessionCloseFrame
  | SessionClosedFrame
  | SessionRpcFrame
  | SessionRouteFrame
  | SessionRoutedFrame
  | SessionEventFrame
  | SessionRoutedResponseErrorFrame
  | SessionRoutedEventErrorFrame
  | SessionStreamOpenFrame
  | SessionStreamCancelFrame
  | SessionPingFrame
  | SessionPongFrame;

// ---------------------------------------------------------------------------
// Codec — JSON over the control channel. Decode THROWS on malformed input so a
// corrupt/foreign frame fails loud at the transport boundary rather than being
// silently dropped (fail-loud rule). The transport catches and surfaces it.
// ---------------------------------------------------------------------------

export function encodeControlFrame(frame: SessionControlFrame): string {
  return JSON.stringify(frame);
}

const FRAME_TAGS = new Set<string>([
  SESSION_OPEN,
  SESSION_OPEN_RESULT,
  SESSION_CLOSE,
  SESSION_CLOSED,
  SESSION_RPC,
  SESSION_ROUTE,
  SESSION_ROUTED,
  SESSION_EVENT,
  SESSION_ROUTED_RESPONSE_ERROR,
  SESSION_ROUTED_EVENT_ERROR,
  SESSION_STREAM_OPEN,
  SESSION_STREAM_CANCEL,
  SESSION_PING,
  SESSION_PONG,
]);

export function decodeControlFrame(data: string): SessionControlFrame {
  const parsed = JSON.parse(data) as unknown;
  if (!parsed || typeof parsed !== "object" || typeof (parsed as { t?: unknown }).t !== "string") {
    throw new Error("Malformed session control frame: missing tag");
  }
  const tag = (parsed as { t: string }).t;
  if (!FRAME_TAGS.has(tag)) {
    throw new Error(`Unknown session control frame tag: ${tag}`);
  }
  // Session-scoped frames must carry a sid; ping/pong are pipe-level.
  if (tag !== SESSION_PING && tag !== SESSION_PONG && typeof (parsed as { sid?: unknown }).sid !== "string") {
    throw new Error(`Session control frame '${tag}' missing sid`);
  }
  return parsed as SessionControlFrame;
}

// ---------------------------------------------------------------------------
// Type guards (cheap, for the demux switch)
// ---------------------------------------------------------------------------

export const isSessionOpen = (f: SessionControlFrame): f is SessionOpenFrame => f.t === SESSION_OPEN;
export const isSessionOpenResult = (f: SessionControlFrame): f is SessionOpenResultFrame => f.t === SESSION_OPEN_RESULT;
export const isSessionClose = (f: SessionControlFrame): f is SessionCloseFrame => f.t === SESSION_CLOSE;
export const isSessionClosed = (f: SessionControlFrame): f is SessionClosedFrame => f.t === SESSION_CLOSED;
export const isSessionRpc = (f: SessionControlFrame): f is SessionRpcFrame => f.t === SESSION_RPC;
export const isSessionRoute = (f: SessionControlFrame): f is SessionRouteFrame => f.t === SESSION_ROUTE;
export const isSessionRouted = (f: SessionControlFrame): f is SessionRoutedFrame => f.t === SESSION_ROUTED;
export const isSessionEvent = (f: SessionControlFrame): f is SessionEventFrame => f.t === SESSION_EVENT;
export const isSessionStreamOpen = (f: SessionControlFrame): f is SessionStreamOpenFrame => f.t === SESSION_STREAM_OPEN;
export const isSessionStreamCancel = (f: SessionControlFrame): f is SessionStreamCancelFrame => f.t === SESSION_STREAM_CANCEL;
export const isSessionPing = (f: SessionControlFrame): f is SessionPingFrame => f.t === SESSION_PING;
export const isSessionPong = (f: SessionControlFrame): f is SessionPongFrame => f.t === SESSION_PONG;

// ---------------------------------------------------------------------------
// Server-side negotiation contract — the responsibilities the per-logical-session
// server transport runs on each `open`, lifted verbatim from rpcServer.handleAuth
// (rpcServer.ts:678-853) but made per-session instead of per-socket.
// ---------------------------------------------------------------------------

/** Outcome of authenticating one `open` frame against grants + the lease gate. */
export interface SessionAuthOutcome {
  ok: boolean;
  callerId?: string;
  callerKind?: CallerKind;
  connectionId?: string;
  sessionDirty?: boolean;
  error?: string;
  /** When true the client must NOT auto-reopen (lease denied/admin token/etc.). */
  terminal?: boolean;
}

/**
 * The seam every host (server-side per-session transport) implements to run the
 * handshake. Mirrors the ordered steps of `handleAuth`:
 *  1. reject admin tokens (terminal)
 *  2. redeem the one-time connection grant → principalId/callerKind (else bearer)
 *  3. resolve connectionId (frame-supplied or minted)
 *  4. panel lease gate (`authorizePanelConnection`) — terminal 4090 on deny
 *  5. `SessionRegistry.markConnected` → sessionDirty
 * Steps 6+ (inbox replay, event-session registration, bridge wiring) are run by
 * the caller once `authenticate` returns ok, using `callerId`/`connectionId`.
 */
export interface SessionNegotiator {
  authenticate(frame: SessionOpenFrame): Promise<SessionAuthOutcome> | SessionAuthOutcome;
}

/** Build the `open-result` reply for an auth outcome + server boot id. */
export function openResultFor(
  sid: string,
  outcome: SessionAuthOutcome,
  serverBootId: string,
): SessionOpenResultFrame {
  if (!outcome.ok) {
    return {
      t: SESSION_OPEN_RESULT,
      sid,
      success: false,
      error: outcome.error ?? "Session auth failed",
      terminal: outcome.terminal ?? false,
    };
  }
  return {
    t: SESSION_OPEN_RESULT,
    sid,
    success: true,
    callerId: outcome.callerId,
    callerKind: outcome.callerKind,
    connectionId: outcome.connectionId,
    serverBootId,
    sessionDirty: outcome.sessionDirty ?? false,
  };
}

/** Identity the server stamps on frames it originates (mirrors SERVER_RESPONDER). */
export const SESSION_SERVER_RESPONDER: AuthenticatedCaller = {
  callerId: "main",
  callerKind: "server",
};
