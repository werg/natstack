/**
 * Shared RPC types for panel/worker communication.
 *
 * This package is the single source of truth for the message protocol and
 * the in-process RPC bridge API (createRpcBridge).
 */

/**
 * RPC request message sent between endpoints.
 */
export interface RpcRequest {
  type: "request";
  requestId: string;
  fromId: string;
  method: string;
  args: unknown[];
}

/**
 * RPC response message (success case).
 */
export interface RpcResponseSuccess {
  type: "response";
  requestId: string;
  result: unknown;
}

/**
 * RPC response message (error case).
 */
export interface RpcResponseError {
  type: "response";
  requestId: string;
  error: string;
  /** Original error code (e.g. "ENOENT", "EACCES") preserved across the RPC boundary */
  errorCode?: string;
  /** Original stack, when available. Intended for diagnostics, not control flow. */
  errorStack?: string;
}

/**
 * Union type for RPC responses.
 */
export type RpcResponse = RpcResponseSuccess | RpcResponseError;

/**
 * RPC event message for one-way notifications.
 */
export interface RpcEvent {
  type: "event";
  fromId: string;
  event: string;
  payload: unknown;
}

/**
 * Streaming RPC request. Initiates a long-lived call whose response
 * body is delivered as a sequence of `RpcStreamFrameMessage` frames
 * (HEAD → DATA* → END | ERROR), tagged by `requestId`. The bridge
 * assembles those frames into a `ReadableStream<Uint8Array>` body for
 * the `Response` returned by `streamCall`.
 */
export interface RpcStreamRequest {
  type: "stream-request";
  requestId: string;
  fromId: string;
  method: string;
  args: unknown[];
}

/**
 * One frame of a streaming RPC response. `frameType` is one of the
 * codes from `@natstack/shared/credentials/streamFraming`
 * (0x01 HEAD, 0x02 DATA, 0x03 END, 0x04 ERROR). DATA payloads are
 * base64-encoded so binary content survives JSON-over-WS / IPC
 * transport. HEAD/END/ERROR payloads are JSON strings.
 *
 * Many transports (Electron IPC, WebSocket) JSON-serialize messages,
 * so DATA frames can't carry raw bytes; base64 is the lowest-common-
 * denominator encoding. The HTTP `/rpc/stream` endpoint uses the same
 * frame codec but on a binary stream (no base64 there).
 */
export interface RpcStreamFrameMessage {
  type: "stream-frame";
  requestId: string;
  fromId: string;
  frameType: number;
  payload: string;
}

/**
 * Cancel an in-flight streaming RPC. Sent by the caller side when
 * the consumer of the streaming response cancels (e.g. by
 * `response.body.cancel()` or via an `AbortSignal`). The server side
 * uses this to abort the upstream fetch so it stops pulling bytes
 * from a corpse.
 */
export interface RpcStreamCancel {
  type: "stream-cancel";
  requestId: string;
  fromId: string;
}

/**
 * Union type for all RPC messages.
 */
export type RpcMessage =
  | RpcRequest
  | RpcResponse
  | RpcEvent
  | RpcStreamRequest
  | RpcStreamFrameMessage
  | RpcStreamCancel;

/**
 * Internal type for method storage.
 * Use exposeMethod() for type-safe method registration.
 */
export type ExposedMethods = Record<string, (...args: unknown[]) => unknown | Promise<unknown>>;

/**
 * Event listener callback type.
 */
export type RpcEventListener = (fromId: string, payload: unknown) => void;

/**
 * Transport abstraction for sending and receiving RPC messages.
 */
export interface RpcTransport {
  /**
   * Send a message to a target endpoint.
   */
  send(targetId: string, message: RpcMessage): Promise<void>;

  /**
   * Register a handler for incoming messages from a specific source.
   * Returns an unsubscribe function.
   */
  onMessage(sourceId: string, handler: (message: RpcMessage) => void): () => void;

  /**
   * Register a handler for messages from any source.
   * Returns an unsubscribe function.
   */
  onAnyMessage(handler: (sourceId: string, message: RpcMessage) => void): () => void;
}

export interface RpcBridgeConfig {
  /** The canonical runtime ID of this endpoint. */
  selfId: string;
  /** The transport implementation */
  transport: RpcTransport;
  /**
   * Idle timeout for in-flight streaming calls. If no frame arrives
   * within this window the stream is errored and the bookkeeping
   * entry removed — prevents leaks from peers that go silent without
   * sending END or ERROR. Defaults to 90s. Use a smaller value in
   * tests if you want to assert timeout behavior quickly.
   */
  streamIdleTimeoutMs?: number;
}

/**
 * RPC bridge interface exposed to user code.
 */
export interface RpcBridge {
  readonly selfId: string;

  /**
   * Expose a method with full type safety.
   *
   * @example
   * bridge.exposeMethod("notes.create", (title: string) => {
   *   return notes.create(title);
   * });
   */
  exposeMethod<TArgs extends unknown[], TReturn>(
    method: string,
    handler: (...args: TArgs) => TReturn | Promise<TReturn>
  ): void;

  /**
   * Expose multiple methods at once from a methods object.
   *
   * @example
   * rpc.expose({
   *   async search(query: string) { return results; },
   *   async getThread(id: string) { return thread; },
   * });
   */
  expose(methods: Record<string, (...args: any[]) => any>): void;

  /**
   * Expose a streaming method handler. The handler receives the call
   * args and a `sink` callback; it emits one HEAD frame, zero or
   * more DATA frames, and exactly one END frame (or an ERROR frame
   * on failure). The bridge serializes each frame and forwards it to
   * the caller as a `stream-frame` message tagged with the matching
   * `requestId`.
   *
   * The `abortSignal` fires when the caller cancels their end of the
   * stream (consumer calls `response.body.cancel()` or aborts via
   * AbortController). Handlers should propagate this to whatever
   * upstream resource they're pulling from.
   */
  exposeStreamingMethod(
    method: string,
    handler: StreamingMethodHandler,
  ): void;

  call<T = unknown>(
    targetId: string,
    method: string,
    args: unknown[],
    options?: RpcCallOptions,
  ): Promise<T>;
  /**
   * Streaming call. Returns a `Response` whose body is a real
   * `ReadableStream<Uint8Array>`. See `RpcCaller.streamCall` for the
   * contract — `RpcBridge` extends `RpcCaller` so this is required
   * on every bridge implementation. Transports without protocol-
   * level streaming wrap their buffered response in a synthetic
   * stream; the caller's API surface is identical either way.
   */
  streamCall(
    targetId: string,
    method: string,
    args: unknown[],
    options?: { signal?: AbortSignal },
  ): Promise<Response>;
  emit(targetId: string, event: string, payload: unknown): Promise<void>;
  onEvent(event: string, listener: RpcEventListener): () => void;
}

/**
 * Internal RPC bridge interface (for transport delivery).
 */
export interface RpcBridgeInternal extends RpcBridge {
  _handleMessage(sourceId: string, message: RpcMessage): void;
}

export type CallerKind =
  | "shell"
  | "shell-remote"
  | "panel"
  | "worker"
  | "do"
  | "extension"
  | "server"
  | "harness";

/**
 * Frame yielded by a streaming method handler. Mirrors the wire frame
 * format defined in `@natstack/shared/credentials/streamFraming` but
 * uses runtime types (Uint8Array for DATA, structured objects for
 * HEAD/END/ERROR) — the bridge serializes them when sending across
 * the wire.
 */
export type StreamingMethodFrame =
  | {
      kind: "head";
      status: number;
      statusText: string;
      headerPairs: Array<[string, string]>;
      finalUrl: string;
    }
  | { kind: "chunk"; bytes: Uint8Array }
  | { kind: "end"; bytesIn: number }
  | { kind: "error"; status: number; message: string; code?: string };

export type StreamingMethodHandler = (
  args: unknown[],
  sink: (frame: StreamingMethodFrame) => Promise<void> | void,
  abortSignal: AbortSignal,
) => Promise<void>;

export interface RpcCallOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface RpcCaller {
  call<T = unknown>(
    targetId: string,
    method: string,
    args: unknown[],
    options?: RpcCallOptions,
  ): Promise<T>;
  /**
   * Streaming call. Returns a `Response` whose body is a real
   * `ReadableStream<Uint8Array>` — the upstream's response bytes,
   * delivered chunk-by-chunk over whichever transport this caller
   * uses. Transports that can't physically stream wrap a buffered
   * response in a synthetic stream so the API surface is uniform
   * across all bridges (no callers need to duck-type capability).
   *
   * Only `credentials.proxyFetch` is currently routed through this
   * path; other methods continue to use `call` for their JSON
   * request/response shape.
   */
  streamCall(
    targetId: string,
    method: string,
    args: unknown[],
    options?: { signal?: AbortSignal },
  ): Promise<Response>;
}

// =============================================================================
// Electron-Local Service Names — routing exceptions
// =============================================================================

/**
 * Services that are owned by Electron main instead of the NatStack server.
 *
 * Unknown service names intentionally default to the server path. This keeps
 * userland and workerd-backed services callable without touching a central RPC
 * routing list every time a new server service is introduced.
 */
export const ELECTRON_LOCAL_SERVICE_NAMES = [
  "adblock",
  "app",
  "browser",
  "browser-session-sync",
  "events",
  "menu",
  "panel",
  "remoteCred",
  "settings",
  "view",
] as const;

export type ElectronLocalServiceName = (typeof ELECTRON_LOCAL_SERVICE_NAMES)[number];

// =============================================================================
// IPC Envelope Types
// =============================================================================

/**
 * Message envelope for RPC over IPC.
 * Wraps RPC messages with source/target routing information.
 */
export interface ParentPortEnvelope {
  targetId: string;
  sourceId?: string;
  message: RpcMessage;
}

/**
 * Type guard for ParentPortEnvelope.
 */
export function isParentPortEnvelope(msg: unknown): msg is ParentPortEnvelope {
  if (typeof msg !== "object" || msg === null) return false;
  const envelope = msg as Record<string, unknown>;
  return (
    typeof envelope["targetId"] === "string" &&
    "message" in envelope &&
    typeof envelope["message"] === "object" &&
    envelope["message"] !== null
  );
}
