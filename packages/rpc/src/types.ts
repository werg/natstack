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
 * Union type for all RPC messages.
 */
export type RpcMessage = RpcRequest | RpcResponse | RpcEvent;

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
  /** The ID of this endpoint (e.g., "panel:abc" or "worker:xyz") */
  selfId: string;
  /** The transport implementation */
  transport: RpcTransport;
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

  call<T = unknown>(targetId: string, method: string, ...args: unknown[]): Promise<T>;
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

export type CallerKind = "shell" | "panel" | "worker" | "server" | "harness";

export interface RpcCaller {
  call<T = unknown>(targetId: string, method: string, ...args: unknown[]): Promise<T>;
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
