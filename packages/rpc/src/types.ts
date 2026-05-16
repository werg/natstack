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
  event: string;
  payload: unknown;
}

/**
 * Union type for all RPC messages.
 */
export type RpcMessage = RpcRequest | RpcResponse | RpcEvent;

/**
 * Authenticated context attached by the receiving transport.
 *
 * This is the only caller identity exposed to RPC receivers. It is derived
 * from the transport/source envelope, not from caller-controlled message data.
 */
export interface RpcCallerContext {
  sourceId: string;
}

export type RpcAccessPolicy = (ctx: RpcCallerContext) => boolean | Promise<boolean>;
export type RpcMethodHandler<TArgs extends unknown[] = unknown[], TReturn = unknown> = (
  ctx: RpcCallerContext,
  ...args: TArgs
) => TReturn | Promise<TReturn>;

export interface RpcMethodDefinition<
  TArgs extends unknown[] = unknown[],
  TReturn = unknown,
> {
  access: RpcAccessPolicy;
  handler: RpcMethodHandler<TArgs, TReturn>;
}

/**
 * Internal type for method storage.
 * Use exposeMethod() for type-safe method registration.
 */
export type ExposedMethods = Record<string, RpcMethodDefinition>;

/**
 * Event listener callback type.
 */
export type RpcEventListener = (sourceId: string, payload: unknown) => void;

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
   * bridge.exposeMethod("notes.create", allowAllCallers, (_ctx, title: string) => {
   *   return notes.create(title);
   * });
   */
  exposeMethod<TArgs extends unknown[], TReturn>(
    method: string,
    access: RpcAccessPolicy,
    handler: RpcMethodHandler<TArgs, TReturn>
  ): void;

  /**
   * Expose multiple methods at once from a methods object.
   *
   * @example
   * rpc.expose({
   *   search: { access: allowAllCallers, async handler(_ctx, query: string) { return results; } },
   *   getThread: { access: allowAllCallers, async handler(_ctx, id: string) { return thread; } },
   * });
   */
  expose(methods: Record<string, RpcMethodDefinition<any[], any>>): void;

  call<T = unknown>(targetId: string, method: string, ...args: unknown[]): Promise<T>;
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
