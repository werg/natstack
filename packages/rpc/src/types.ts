/**
 * Shared RPC types for panel/worker communication.
 *
 * This package is the single source of truth for the message protocol and
 * the unified RPC client API (createRpcClient).
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
  /**
   * Set only by extension callers, echoing an opaque host-issued token from
   * the inbound extension invocation frame. The server resolves attribution
   * from its active-invocation table; callers never supply identity directly.
   */
  parentInvocationToken?: string;
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
 * the `Response` returned by `stream`.
 */
export interface RpcStreamRequest {
  type: "stream-request";
  requestId: string;
  fromId: string;
  method: string;
  args: unknown[];
  /** See `RpcRequest.parentInvocationToken`. */
  parentInvocationToken?: string;
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
   *
   * `callerKind` is the gateway-verified kind of the source when the transport
   * can supply it (optional/additive — paths that don't stamp it omit it, and
   * the bridge surfaces `"unknown"`). Pairs with the trusted `sourceId`.
   * Returns an unsubscribe function.
   */
  onAnyMessage(
    handler: (sourceId: string, message: RpcMessage, callerKind?: CallerKind) => void
  ): () => void;
}

/**
 * The authenticated identity of an INBOUND caller — i.e. "who called me".
 *
 * This is the single, canonical inbound-caller shape across every layer:
 * - the unified client passes it to `expose` handlers;
 * - `DurableObjectBase.caller` returns it (sourced from signed headers);
 * - the server's `VerifiedCaller.caller` exposes it (a thin view over its
 *   richer capability/code identity).
 *
 * `callerId`/`callerKind` are gateway-verified (the principal the server
 * authenticated and stamped onto routed messages), NOT the self-reported
 * `RpcRequest.fromId`. `callerKind` is `"unknown"` on delivery paths where the
 * kind isn't carried (local dispatch, or transports that don't stamp it);
 * authorization code should treat `"unknown"` as least-privileged.
 *
 * Distinct from `RpcCaller`, which is the OUTBOUND interface ("a thing you can
 * make calls through").
 */
export interface AuthenticatedCaller {
  callerId: string;
  callerKind: CallerKind | "unknown";
  /**
   * Stable visible panel slot for panel callers whose runtime `callerId` is a
   * per-navigation entity. Only the trusted server/bridge stamps this field.
   */
  callerPanelId?: string;
}

export type CallerKind =
  | "shell"
  | "shell-remote"
  | "panel"
  | "app"
  | "worker"
  | "do"
  | "extension"
  | "server"
  | "harness";

/**
 * Frame yielded by a streaming method handler. Mirrors the wire frame
 * format defined in `@natstack/rpc/protocol/streamCodec` but
 * uses runtime types (Uint8Array for DATA, structured objects for
 * HEAD/END/ERROR) — the client serializes them when sending across
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
  idempotencyKey?: string;
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
  stream(
    targetId: string,
    method: string,
    args: unknown[],
    options?: { signal?: AbortSignal; idempotencyKey?: string },
  ): Promise<Response>;
}

export interface RpcEnvelope {
  from: string;
  target: string;
  delivery: {
    caller: AuthenticatedCaller;
    idempotencyKey?: string;
  };
  provenance: AuthenticatedCaller[];
  message: RpcMessage;
}

export interface EnvelopeRpcTransport {
  send(envelope: RpcEnvelope): Promise<void>;
  onMessage(handler: (envelope: RpcEnvelope) => void): () => void;
  status?: () => RpcConnectionStatus;
  ready?: () => Promise<void>;
  onStatusChange?: (handler: (status: RpcConnectionStatus) => void) => () => void;
}

export type RpcConnectionStatus = "connected" | "connecting" | "disconnected";

export interface RpcRequestContext {
  caller: AuthenticatedCaller;
  origin: AuthenticatedCaller;
  method: string;
  args: unknown[];
  signal: AbortSignal;
  rpc: RpcClient;
}

export interface RpcEventContext {
  caller: AuthenticatedCaller;
  origin: AuthenticatedCaller;
  event: string;
  payload: unknown;
}

export type RpcContextHandler<TArgs extends unknown[] = unknown[], TReturn = unknown> = (
  request: RpcRequestContext & { args: TArgs },
) => TReturn | Promise<TReturn>;

export type RpcContextMethods = Record<string, RpcContextHandler<any, any>>;

export type RpcContextStreamingHandler = (
  request: RpcRequestContext,
  sink: (frame: StreamingMethodFrame) => Promise<void> | void,
) => Promise<void>;

export type MethodMap = Record<string, (...args: any[]) => any>;
export type EventMap = Record<string, any>;

export type TypedCallProxy<TMethods extends MethodMap> = {
  [K in keyof TMethods & string]: (
    ...args: Parameters<TMethods[K]>
  ) => Promise<Awaited<ReturnType<TMethods[K]>>>;
};

export interface RpcPeer<
  TMethods extends MethodMap = MethodMap,
  TEvents extends EventMap = EventMap,
  TEmitEvents extends EventMap = TEvents,
> {
  readonly id: string;
  readonly call: TypedCallProxy<TMethods>;
  on<K extends keyof TEvents & string>(
    event: K,
    listener: (event: RpcEventContext & { payload: TEvents[K] }) => void,
  ): () => void;
  emit<K extends keyof TEmitEvents & string>(event: K, payload: TEmitEvents[K]): Promise<void>;
  withContract<C extends RpcContract, Role extends keyof C & string>(
    contract: C,
    role: Role,
  ): RpcPeer<
    C[Role] extends { methods: infer M extends MethodMap } ? M : MethodMap,
    C[Role] extends { events: infer E extends EventMap } ? E : EventMap,
    C[Role] extends { emits: infer EE extends EventMap } ? EE : EventMap
  >;
}

export type RpcContract = Record<
  string,
  {
    methods?: MethodMap;
    events?: EventMap;
    emits?: EventMap;
  }
>;

export interface TopologyAdapter {
  parent?(): Promise<string | null> | string | null;
  children?(): Promise<string[]> | string[];
  root?(): Promise<string | null> | string | null;
  siblings?(): Promise<string[]> | string[];
}

export interface AutomationAdapter<TAutomation = unknown> {
  automation(targetId: string): TAutomation;
}

export interface RpcClientConfig {
  selfId: string;
  transport: EnvelopeRpcTransport;
  streamIdleTimeoutMs?: number;
  callerKind?: CallerKind | "unknown";
  provenance?: AuthenticatedCaller[];
  topology?: TopologyAdapter;
  automation?: AutomationAdapter;
}

export interface RpcTree {
  root<TMethods extends MethodMap = MethodMap, TEvents extends EventMap = EventMap>(): Promise<
    RpcPeer<TMethods, TEvents> | null
  >;
  self<TMethods extends MethodMap = MethodMap, TEvents extends EventMap = EventMap>(): RpcPeer<
    TMethods,
    TEvents
  >;
  siblings<TMethods extends MethodMap = MethodMap, TEvents extends EventMap = EventMap>(): Promise<
    Array<RpcPeer<TMethods, TEvents>>
  >;
}

export interface RpcClient {
  readonly selfId: string;
  expose<TArgs extends unknown[], TReturn>(
    method: string,
    handler: RpcContextHandler<TArgs, TReturn>,
  ): void;
  exposeAll(methods: RpcContextMethods): void;
  exposeStreaming(method: string, handler: RpcContextStreamingHandler): void;
  call<T = unknown>(
    targetId: string,
    method: string,
    args: unknown[],
    options?: RpcCallOptions,
  ): Promise<T>;
  stream(
    targetId: string,
    method: string,
    args: unknown[],
    options?: { signal?: AbortSignal; idempotencyKey?: string },
  ): Promise<Response>;
  emit(targetId: string, event: string, payload: unknown, options?: RpcCallOptions): Promise<void>;
  on(event: string, listener: (event: RpcEventContext) => void): () => void;
  peer<
    TMethods extends MethodMap = MethodMap,
    TEvents extends EventMap = EventMap,
    TEmitEvents extends EventMap = TEvents,
  >(
    targetId: string,
  ): RpcPeer<TMethods, TEvents, TEmitEvents>;
  status(): RpcConnectionStatus;
  ready(): Promise<void>;
  onStatusChange(handler: (status: RpcConnectionStatus) => void): () => void;
  parent<
    TMethods extends MethodMap = MethodMap,
    TEvents extends EventMap = EventMap,
  >(): Promise<RpcPeer<TMethods, TEvents> | null>;
  children<
    TMethods extends MethodMap = MethodMap,
    TEvents extends EventMap = EventMap,
  >(): Promise<Array<RpcPeer<TMethods, TEvents>>>;
  readonly tree: RpcTree;
  automation<TAutomation = unknown>(targetId: string): TAutomation;
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
  "browser-session-sync",
  "events",
  "menu",
  "notification",
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
