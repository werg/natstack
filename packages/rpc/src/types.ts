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
 * Methods that can be exposed by an RPC endpoint.
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
  /** Timeout for RPC calls in milliseconds (default: 30000) */
  callTimeoutMs?: number;
  /** Timeout for AI-related calls (default: 300000) */
  aiCallTimeoutMs?: number;
}

/**
 * RPC bridge interface exposed to user code.
 */
export interface RpcBridge {
  readonly selfId: string;
  expose(methods: ExposedMethods): void;
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

/**
 * Parse an endpoint ID to determine its type.
 */
export function parseEndpointId(id: string): { type: "panel" | "worker"; id: string } {
  if (id.startsWith("panel:")) {
    return { type: "panel", id: id.slice(6) };
  }
  if (id.startsWith("worker:")) {
    return { type: "worker", id: id.slice(7) };
  }
  // Legacy: treat unprefixed IDs as panels for backwards compatibility
  return { type: "panel", id };
}

export function panelId(id: string): string {
  return `panel:${id}`;
}

export function workerId(id: string): string {
  return `worker:${id}`;
}

// =============================================================================
// Service RPC (Worker <-> Main Process)
// =============================================================================

export interface ServiceCallRequest {
  type: "service:call";
  requestId: string;
  workerId: string;
  service: string;
  method: string;
  args: unknown[];
}

export interface ServiceCallResponse {
  type: "service:response";
  requestId: string;
  result?: unknown;
  error?: string;
}

export interface ServicePushEvent {
  type: "service:push";
  workerId: string;
  service: string;
  event: string;
  payload: unknown;
}

export interface ServiceInvokeRequest {
  type: "service:invoke";
  requestId: string;
  workerId: string;
  service: string;
  method: string;
  args: unknown[];
}

export interface ServiceInvokeResponse {
  type: "service:invoke-response";
  requestId: string;
  workerId: string;
  result?: unknown;
  error?: string;
}

export type ServiceHandler = (
  workerId: string,
  method: string,
  args: unknown[]
) => Promise<unknown> | unknown;

