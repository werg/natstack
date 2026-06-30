/**
 * `SessionWebSocketShim` — the adapter that lets the WebRTC pipe reuse the
 * ENTIRE battle-tested per-connection server machinery (rpcServer's
 * `handleConnection`/`handleAuth`/`handleMessage`/`handleClose` + the
 * `createWsServerTransport` bridge with its close-time `CONNECTION_LOST`
 * synthesis) per **logical session**, with zero changes to that machinery.
 *
 * Each logical panel/shell session over the pipe gets one shim that quacks like
 * the `ws` object rpcServer expects. Inbound `SessionControlFrame`s are
 * translated into the `ws:*` client messages rpcServer parses; the `ws:*` server
 * messages rpcServer emits via `ws.send()` are translated back into
 * `SessionControlFrame`s on the control channel — EXCEPT streaming DATA, which is
 * re-encoded as binary `streamCodec` v2 frames on the BULK channel (so the wire
 * is binary, dropping the base64 tax even though the in-process server still
 * frames base64). One shim per session ⇒ per-session bridge ⇒ independent
 * close-time failure synthesis for free.
 *
 * This keeps exactly one server RPC implementation (the fail-loud rule): the
 * WebRTC answerer is a translation layer, not a parallel server.
 */

import { FRAME_DATA, encodeStreamFrameV2 } from "@natstack/rpc/protocol/streamCodec";
import { isTerminalCloseCode } from "@natstack/rpc/protocol/closeCodes";
import {
  encodeControlFrame,
  SESSION_CLOSED,
  SESSION_EVENT,
  SESSION_OPEN_RESULT,
  SESSION_ROUTED,
  SESSION_ROUTED_EVENT_ERROR,
  SESSION_ROUTED_RESPONSE_ERROR,
  SESSION_RPC,
  type SessionControlFrame,
} from "@natstack/rpc/protocol/sessionNegotiation";
import type { CallerKind } from "@natstack/shared/serviceDispatcher";
import type { WsClientMessage, WsServerMessage } from "@natstack/shared/ws/protocol";

/** The two SCTP channels of one WebRTC pipe (answerer side). */
export interface PipeChannels {
  /** Write a serialized control frame to the client. May resolve once this frame's
   * fragments have drained, letting a per-session caller meter its un-drained bytes. */
  writeControl(data: Uint8Array): Promise<void> | void;
  /** Write a binary bulk frame to the client. */
  writeBulk(data: Uint8Array): void;
  /** Whole-pipe control-channel buffered amount (shared across sessions). */
  controlBufferedAmount?(): number;
}

/** Shared stream-id ⇄ requestId maps so server stream-frames hit the right bulk id. */
export interface StreamIdMaps {
  idByRequest: Map<string, number>;
  requestByStream: Map<number, string>;
}

const WS_OPEN = 1;
const WS_CLOSED = 3;
const encoder = new TextEncoder();

type WsHandler = (...args: unknown[]) => void;

/**
 * Implements just the subset of the `ws` WebSocket surface that rpcServer uses:
 * on/off/once("message"|"close"), send, close, terminate, readyState,
 * bufferedAmount. Cast to `WebSocket` at the call site.
 */
export class SessionWebSocketShim {
  // WebSocket readyState constants as INSTANCE properties. `wsServerTransport`
  // guards on `ws.readyState !== ws.OPEN`; without `ws.OPEN` defined here it is
  // `undefined`, so a live session always compares unequal and reads as closed —
  // server→panel and panel↔panel RPC then reject CONNECTION_LOST over a healthy
  // pipe. Mirror the standard WebSocket constant values.
  readonly CONNECTING = 0;
  readonly OPEN = WS_OPEN;
  readonly CLOSING = 2;
  readonly CLOSED = WS_CLOSED;
  private state = WS_OPEN;
  private readonly messageHandlers = new Set<WsHandler>();
  private readonly closeHandlers = new Set<WsHandler>();
  // Per-shim stream id maps: a stream belongs to its session, so dropping the shim
  // (session close / re-open) GC's its entries with it — no leak even if a panel
  // navigates away mid-stream before END/ERROR. A pipe-shared map would instead
  // grow unbounded over a long-lived pipe with churny panels.
  private readonly streams: StreamIdMaps = {
    idByRequest: new Map(),
    requestByStream: new Map(),
  };
  /** Control bytes this session has enqueued that have not yet drained (per-session
   * backpressure metric for sendToWs). */
  private pendingControlBytes = 0;

  constructor(
    private readonly sid: string,
    private readonly pipe: PipeChannels,
    private readonly onClosed: (sid: string) => void
  ) {}

  get readyState(): number {
    return this.state;
  }

  /** This session's OWN un-drained control bytes — not the shared pipe buffer, so
   * sendToWs throttles the flooding session, never a healthy co-tenant. */
  get bufferedAmount(): number {
    return this.pendingControlBytes;
  }

  on(event: string, handler: WsHandler): this {
    if (event === "message") this.messageHandlers.add(handler);
    else if (event === "close") this.closeHandlers.add(handler);
    return this;
  }

  once(event: string, handler: WsHandler): this {
    return this.on(event, handler);
  }

  off(event: string, handler: WsHandler): this {
    if (event === "message") this.messageHandlers.delete(handler);
    else if (event === "close") this.closeHandlers.delete(handler);
    return this;
  }

  removeListener(event: string, handler: WsHandler): this {
    return this.off(event, handler);
  }

  /** rpcServer → client: translate the ws:* message to control/bulk frames. */
  send(data: string): void {
    if (this.state !== WS_OPEN) return;
    let msg: WsServerMessage;
    try {
      msg = JSON.parse(data) as WsServerMessage;
    } catch {
      return;
    }
    this.translateOutbound(msg);
  }

  close(code?: number, reason?: string): void {
    if (this.state === WS_CLOSED) return;
    // Server-initiated close (lease revoke/retire, auth fail) → terminate the
    // session on the client. Terminal codes mean "do not auto-reopen" — the set
    // is shared with the WS transport (see closeCodes.ts) so both classify alike.
    const terminal = code !== undefined && isTerminalCloseCode(code);
    this.writeFrame({ t: SESSION_CLOSED, sid: this.sid, code, reason, terminal });
    this.fireClosed(code, reason);
  }

  terminate(): void {
    this.close(1006, "terminated");
  }

  // --- driven by the pipe demux (rpcServer.attachWebRtcPipe) ---------------

  /** Feed an inbound ws:* client message (built from a SessionControlFrame). */
  deliverInbound(msg: WsClientMessage): void {
    if (this.state !== WS_OPEN) return;
    const buf = Buffer.from(JSON.stringify(msg));
    for (const handler of [...this.messageHandlers]) handler(buf);
  }

  /** The client closed this session (or the pipe dropped) — run handleClose. */
  remoteClosed(code?: number, reason?: string): void {
    this.fireClosed(code, reason);
  }

  /** Record a client-allocated stream id (from stream-open) so outbound stream
   * DATA frames can be re-keyed onto the bulk channel. */
  registerStream(requestId: string, streamId: number): void {
    this.streams.idByRequest.set(requestId, streamId);
    this.streams.requestByStream.set(streamId, requestId);
  }

  /** Client cancelled a stream (stream-cancel): reap the maps + deliver the cancel
   * inward so the server stops producing. */
  cancelStream(streamId: number): void {
    const requestId = this.streams.requestByStream.get(streamId);
    this.streams.requestByStream.delete(streamId);
    if (requestId === undefined) return;
    this.streams.idByRequest.delete(requestId);
    this.deliverInbound({
      type: "ws:rpc",
      envelope: {
        from: "",
        target: "main",
        delivery: { caller: { callerId: "", callerKind: "unknown" } },
        provenance: [],
        message: { type: "stream-cancel", requestId, fromId: "" },
      },
    });
  }

  private fireClosed(code?: number, reason?: string): void {
    if (this.state === WS_CLOSED) return;
    this.state = WS_CLOSED;
    const reasonBuf = Buffer.from(reason ?? "");
    for (const handler of [...this.closeHandlers]) handler(code ?? 1006, reasonBuf);
    this.onClosed(this.sid);
  }

  private writeFrame(frame: SessionControlFrame): void {
    const bytes = encoder.encode(encodeControlFrame(frame));
    // Meter this session's un-drained control bytes: writeControl resolves once
    // these have drained off the control channel, so bufferedAmount reflects THIS
    // session's backlog (not the shared pipe buffer). A test pipe whose writeControl
    // returns void settles immediately.
    this.pendingControlBytes += bytes.byteLength;
    const drained = this.pipe.writeControl(bytes);
    if (drained && typeof (drained as Promise<void>).then === "function") {
      void (drained as Promise<void>).finally(() => {
        this.pendingControlBytes -= bytes.byteLength;
      });
    } else {
      this.pendingControlBytes -= bytes.byteLength;
    }
  }

  private translateOutbound(msg: WsServerMessage): void {
    switch (msg.type) {
      case "ws:auth-result": {
        if (msg.success) {
          this.writeFrame({
            t: SESSION_OPEN_RESULT,
            sid: this.sid,
            success: true,
            callerId: msg.callerId,
            callerKind: msg.callerKind as CallerKind | undefined,
            connectionId: msg.connectionId,
            serverBootId: msg.serverBootId,
            sessionDirty: msg.sessionDirty,
            deviceCredential: msg.deviceCredential,
          });
        } else {
          // An auth failure is terminal for this session (invalid grant / lease
          // denied); the host re-mints a grant and opens a fresh session if needed.
          this.writeFrame({
            t: SESSION_OPEN_RESULT,
            sid: this.sid,
            success: false,
            error: msg.error,
            terminal: true,
          });
        }
        return;
      }
      case "ws:routed":
        this.writeFrame({ t: SESSION_ROUTED, sid: this.sid, envelope: msg.envelope });
        return;
      case "ws:event":
        this.writeFrame({
          t: SESSION_EVENT,
          sid: this.sid,
          event: msg.event,
          payload: msg.payload,
        });
        return;
      case "ws:rpc":
        this.translateRpc(msg.envelope);
        return;
      case "ws:routed-response-error":
        this.writeFrame({
          t: SESSION_ROUTED_RESPONSE_ERROR,
          sid: this.sid,
          targetId: msg.targetId,
          requestId: msg.requestId,
          error: msg.error,
          errorCode: msg.errorCode,
        });
        return;
      case "ws:routed-event-error":
        this.writeFrame({
          t: SESSION_ROUTED_EVENT_ERROR,
          sid: this.sid,
          targetId: msg.targetId,
          event: msg.event,
          error: msg.error,
          errorCode: msg.errorCode,
        });
        return;
      default:
        return;
    }
  }

  /**
   * A ws:rpc envelope is either a normal RPC frame (request/response/event from
   * the server→client bridge) → control 'rpc' frame; OR a streaming `stream-frame`
   * → re-encode onto the BULK channel as a binary v2 frame keyed by the streamId
   * the client allocated in its `stream-open`.
   */
  private translateRpc(envelope: RpcEnvelopeLike): void {
    const message = envelope.message as {
      type: string;
      requestId?: string;
      frameType?: number;
      payload?: string;
    };
    if (message.type === "stream-frame" && typeof message.requestId === "string") {
      const streamId = this.streams.idByRequest.get(message.requestId);
      if (streamId === undefined) return; // client cancelled / unknown stream
      const frameType = (message.frameType ?? FRAME_DATA) as 0x01 | 0x02 | 0x03 | 0x04;
      const payload = message.payload ?? "";
      // DATA is base64 over the in-process frame; everything else is JSON text.
      const bytes =
        frameType === FRAME_DATA
          ? new Uint8Array(Buffer.from(payload, "base64"))
          : encoder.encode(payload);
      this.pipe.writeBulk(encodeStreamFrameV2(streamId, frameType, bytes));
      if (frameType === 0x03 /* END */ || frameType === 0x04 /* ERROR */) {
        this.streams.idByRequest.delete(message.requestId);
        this.streams.requestByStream.delete(streamId);
      }
      return;
    }
    this.writeFrame({ t: SESSION_RPC, sid: this.sid, envelope: envelope as never });
  }
}

interface RpcEnvelopeLike {
  message: unknown;
}
