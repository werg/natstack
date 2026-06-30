/**
 * Server-side per-logical-session transport multiplexer — the load-bearing
 * server refactor (plan §1, "the biggest under-counted piece"). Today the
 * `ws:auth → ws:auth-result` handshake and the per-connection server→client
 * bridge are bound to ONE WebSocket and are global-per-connection
 * (`rpcServer.handleAuth` rpcServer.ts:678; `createWsServerTransport`
 * wsServerTransport.ts:58). Under one WebRTC pipe, N panels multiplex, so every
 * one of those responsibilities becomes **per logical session**:
 *
 *  - each session runs its OWN `SessionNegotiation` handshake (redeems its own
 *    one-time grant, passes its own lease gate) — per-panel principal identity
 *    is preserved, never collapsed into the pipe owner;
 *  - each session gets its own server→client bridge transport with
 *    **independent close-time failure synthesis** (`CONNECTION_LOST`): one panel
 *    dropping fails only ITS in-flight server→client calls and never tears down
 *    the pipe or sibling sessions;
 *  - a full pipe loss (ICE down) fans the failure to EVERY session.
 *
 * It is transport-neutral: it takes injected control/bulk channel writers and an
 * inbound feed, so it drops onto the WebRTC pipe's answerer side (or any future
 * channel) and is unit-tested against an in-memory channel pair. Identity stays
 * in the envelope's immutable `delivery.caller`/`provenance`; this module never
 * rewrites `delivery.caller` on relayed frames, and stamps `from:"main"` /
 * server identity only on frames it originates.
 */

import type {
  AuthenticatedCaller,
  CallerKind,
  EnvelopeRpcTransport,
  RpcEnvelope,
  RpcMessage,
} from "../types.js";
import {
  type HeadFramePayload,
  type EndFramePayload,
  type ErrorFramePayload,
  encodeStreamDataFrameV2,
  encodeStreamEndFrameV2,
  encodeStreamErrorFrameV2,
  encodeStreamHeadFrameV2,
} from "../protocol/streamCodec.js";
import {
  SESSION_CLOSED,
  SESSION_EVENT,
  SESSION_ROUTED,
  SESSION_ROUTED_RESPONSE_ERROR,
  SESSION_RPC,
  SESSION_SERVER_RESPONDER,
  type SessionControlFrame,
  type SessionNegotiator,
  decodeControlFrame,
  encodeControlFrame,
  openResultFor,
} from "../protocol/sessionNegotiation.js";

export const SESSION_CONNECTION_LOST_CODE = "CONNECTION_LOST" as const;

function connectionLostError(sid: string): Error {
  const e = new Error(`Logical session ${sid} connection lost`) as Error & { code?: string };
  e.code = SESSION_CONNECTION_LOST_CODE;
  return e;
}

/**
 * One authenticated logical session. It IS the per-session server→client bridge
 * transport (an `EnvelopeRpcTransport` a `createRpcClient` wraps) AND exposes the
 * server-origin push helpers (events, routed frames, bulk streams).
 */
export interface ServerSession extends EnvelopeRpcTransport {
  readonly sid: string;
  readonly callerId: string;
  readonly callerKind: CallerKind | "unknown";
  readonly connectionId: string | undefined;
  /** Deliver a caller-to-caller routed frame to this session's client. */
  sendRouted(envelope: RpcEnvelope): void;
  /** Push a direct server→client event (synthesized server-caller envelope client-side). */
  sendEvent(event: string, payload: unknown): void;
  /** Surface an undeliverable routed request so the client's pending call rejects (fail loud). */
  sendRoutedResponseError(targetId: string, requestId: string, error: string, errorCode?: string): void;
  /** Bulk channel writers (the body of a client `stream-open`). */
  writeStreamHead(streamId: number, payload: HeadFramePayload): void;
  writeStreamData(streamId: number, bytes: Uint8Array): void;
  writeStreamEnd(streamId: number, payload: EndFramePayload): void;
  writeStreamError(streamId: number, payload: ErrorFramePayload): void;
  /** Terminate the session (lease revoke/retire). `terminal` ⇒ client must not reopen. */
  close(code?: number, reason?: string, terminal?: boolean): void;
}

export interface ServerSessionDispatch {
  /** A client→server RPC request/event addressed to the server principal ('main'). */
  onRpc(session: ServerSession, envelope: RpcEnvelope): void | Promise<void>;
  /** A caller-to-caller route frame (ws:route analog). */
  onRoute?(session: ServerSession, envelope: RpcEnvelope, targetConnectionId?: string): void;
  /** A client-initiated stream; the handler writes the body via session.writeStream*. */
  onStreamOpen?(session: ServerSession, streamId: number, envelope: RpcEnvelope, signal: AbortSignal): void | Promise<void>;
  onStreamCancel?(session: ServerSession, streamId: number): void;
  /** Session authenticated + ready (run inbox replay / event-session registration here). */
  onOpened?(session: ServerSession): void;
  /** Session torn down (markDisconnected / arm reconnect waiter here). */
  onClosed?(session: ServerSession, reason: string): void;
}

export interface ServerSessionMultiplexerOptions {
  negotiator: SessionNegotiator;
  serverBootId: string;
  /** Write a control-channel frame to the client (already-serialized bytes). */
  writeControl(data: Uint8Array): void;
  /** Write a bulk-channel frame to the client. */
  writeBulk(data: Uint8Array): void;
  dispatch: ServerSessionDispatch;
  logPrefix?: string;
}

export interface ServerSessionMultiplexer {
  /** Feed an inbound control-channel message (one serialized frame). */
  handleControlData(data: Uint8Array): void;
  getSession(sid: string): ServerSession | undefined;
  sessions(): ServerSession[];
  /** Pipe loss (ICE down): fail every session's in-flight calls + fire onClosed. */
  closeAll(reason: string): void;
}

export function createServerSessionMultiplexer(
  options: ServerSessionMultiplexerOptions,
): ServerSessionMultiplexer {
  const { negotiator, serverBootId, writeControl, writeBulk, dispatch } = options;
  const log = options.logPrefix ?? "[server-session]";
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const sessions = new Map<string, SessionImpl>();
  const streamAborts = new Map<string, AbortController>();

  function writeFrame(frame: SessionControlFrame): void {
    writeControl(encoder.encode(encodeControlFrame(frame)));
  }

  class SessionImpl implements ServerSession {
    readonly callerKind: CallerKind | "unknown";
    private readonly listeners = new Set<(envelope: RpcEnvelope) => void>();
    private readonly inFlight = new Set<string>();
    private closed = false;

    constructor(
      readonly sid: string,
      readonly callerId: string,
      readonly connectionId: string | undefined,
      callerKind: CallerKind | "unknown",
    ) {
      this.callerKind = callerKind;
    }

    // -- EnvelopeRpcTransport (server→client bridge) -----------------------

    async send(envelope: RpcEnvelope): Promise<void> {
      if (this.closed) throw connectionLostError(this.sid);
      const message = envelope.message;
      // Track outbound server→client requests so we can fail them on close.
      if (message.type === "request" || message.type === "stream-request") {
        this.inFlight.add(message.requestId);
      }
      writeFrame({ t: SESSION_RPC, sid: this.sid, envelope });
    }

    onMessage(handler: (envelope: RpcEnvelope) => void): () => void {
      this.listeners.add(handler);
      return () => this.listeners.delete(handler);
    }

    status(): "connected" | "connecting" | "disconnected" {
      return this.closed ? "disconnected" : "connected";
    }

    /** Inbound from the client: a response to a server→client bridge call. */
    deliverBridgeResponse(envelope: RpcEnvelope): void {
      const message = envelope.message;
      if (message.type === "response") this.inFlight.delete(message.requestId);
      for (const listener of this.listeners) {
        try {
          listener(envelope);
        } catch (error) {
          console.warn(`${log} ${this.sid} bridge listener threw`, error);
        }
      }
    }

    /** Close-time failure synthesis — reject every in-flight server→client call. */
    failInFlight(): void {
      for (const requestId of this.inFlight) {
        const envelope: RpcEnvelope = {
          from: this.callerId,
          target: "main",
          delivery: { caller: this.callerAsCaller() },
          provenance: [this.callerAsCaller()],
          message: {
            type: "response",
            requestId,
            error: `Logical session ${this.sid} connection lost`,
            errorCode: SESSION_CONNECTION_LOST_CODE,
          } as RpcMessage,
        };
        for (const listener of this.listeners) {
          try {
            listener(envelope);
          } catch {
            /* ignore */
          }
        }
      }
      this.inFlight.clear();
    }

    private callerAsCaller(): AuthenticatedCaller {
      return { callerId: this.callerId, callerKind: this.callerKind };
    }

    // -- server-origin push -----------------------------------------------

    sendRouted(envelope: RpcEnvelope): void {
      if (this.closed) return;
      writeFrame({ t: SESSION_ROUTED, sid: this.sid, envelope });
    }

    sendEvent(event: string, payload: unknown): void {
      if (this.closed) return;
      writeFrame({ t: SESSION_EVENT, sid: this.sid, event, payload });
    }

    sendRoutedResponseError(targetId: string, requestId: string, error: string, errorCode?: string): void {
      if (this.closed) return;
      writeFrame({ t: SESSION_ROUTED_RESPONSE_ERROR, sid: this.sid, targetId, requestId, error, errorCode });
    }

    writeStreamHead(streamId: number, payload: HeadFramePayload): void {
      writeBulk(encodeStreamHeadFrameV2(streamId, payload));
    }
    writeStreamData(streamId: number, bytes: Uint8Array): void {
      writeBulk(encodeStreamDataFrameV2(streamId, bytes));
    }
    writeStreamEnd(streamId: number, payload: EndFramePayload): void {
      writeBulk(encodeStreamEndFrameV2(streamId, payload));
    }
    writeStreamError(streamId: number, payload: ErrorFramePayload): void {
      writeBulk(encodeStreamErrorFrameV2(streamId, payload));
    }

    close(code?: number, reason?: string, terminal?: boolean): void {
      if (this.closed) return;
      this.closed = true;
      // Fail in-flight server→client calls FIRST (independent of siblings).
      this.failInFlight();
      sessions.delete(this.sid);
      // Abort any of this session's in-flight inbound streams.
      for (const key of [...streamAborts.keys()]) {
        if (key.startsWith(`${this.sid} `)) {
          streamAborts.get(key)?.abort();
          streamAborts.delete(key);
        }
      }
      writeFrame({ t: SESSION_CLOSED, sid: this.sid, code, reason, terminal: terminal ?? false });
      dispatch.onClosed?.(this, reason ?? "closed");
    }

    /** Mark closed WITHOUT writing a frame (pipe already gone). */
    closeSilently(reason: string): void {
      if (this.closed) return;
      this.closed = true;
      this.failInFlight();
      sessions.delete(this.sid);
      dispatch.onClosed?.(this, reason);
    }
  }

  async function handleOpen(frame: Extract<SessionControlFrame, { t: "open" }>): Promise<void> {
    const outcome = await negotiator.authenticate(frame);
    writeFrame(openResultFor(frame.sid, outcome, serverBootId));
    if (!outcome.ok) return;
    const session = new SessionImpl(
      frame.sid,
      outcome.callerId ?? frame.sid,
      outcome.connectionId ?? frame.connectionId,
      outcome.callerKind ?? "unknown",
    );
    // Replace any existing session on the same sid (reconnect/eviction).
    sessions.get(frame.sid)?.closeSilently("replaced");
    sessions.set(frame.sid, session);
    dispatch.onOpened?.(session);
  }

  return {
    handleControlData(data: Uint8Array): void {
      let frame: SessionControlFrame;
      try {
        frame = decodeControlFrame(decoder.decode(data));
      } catch (error) {
        console.warn(`${log} dropping malformed control frame`, error);
        return;
      }
      switch (frame.t) {
        case "open":
          void handleOpen(frame);
          return;
        case "ping":
          writeFrame({ t: "pong", ts: frame.ts });
          return;
        case "pong":
          return;
        case "close":
          sessions.get(frame.sid)?.close(frame.code, frame.reason);
          return;
        case "rpc": {
          const session = sessions.get(frame.sid);
          if (!session) return;
          // A response → retire a server→client bridge call; otherwise a request.
          if (frame.envelope.message.type === "response") session.deliverBridgeResponse(frame.envelope);
          else void dispatch.onRpc(session, frame.envelope);
          return;
        }
        case "route": {
          const session = sessions.get(frame.sid);
          if (session) dispatch.onRoute?.(session, frame.envelope, frame.targetConnectionId);
          return;
        }
        case "stream-open": {
          const session = sessions.get(frame.sid);
          if (!session) return;
          const controller = new AbortController();
          streamAborts.set(`${frame.sid} ${frame.streamId}`, controller);
          void Promise.resolve(dispatch.onStreamOpen?.(session, frame.streamId, frame.envelope, controller.signal)).finally(
            () => streamAborts.delete(`${frame.sid} ${frame.streamId}`),
          );
          return;
        }
        case "stream-cancel": {
          const session = sessions.get(frame.sid);
          const key = `${frame.sid} ${frame.streamId}`;
          streamAborts.get(key)?.abort();
          streamAborts.delete(key);
          if (session) dispatch.onStreamCancel?.(session, frame.streamId);
          return;
        }
        default:
          // open-result/closed/routed/event/*-error are client-bound; server ignores.
          return;
      }
    },
    getSession(sid: string): ServerSession | undefined {
      return sessions.get(sid);
    },
    sessions(): ServerSession[] {
      return [...sessions.values()];
    },
    closeAll(reason: string): void {
      for (const controller of streamAborts.values()) controller.abort();
      streamAborts.clear();
      for (const session of [...sessions.values()]) {
        (session as SessionImpl).closeSilently(reason);
      }
    },
  };
}

// Re-export the server identity for callers stamping server-origin frames.
export { SESSION_SERVER_RESPONDER };
