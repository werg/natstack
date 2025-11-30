/**
 * Shared RPC types for panel-to-panel and panel-to-worker communication.
 * These types are used by both the panel preload and worker runtime.
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
 * Different implementations handle panel (MessagePort) and worker (IPC) transports.
 */
export interface RpcTransport {
  /**
   * Send a message to a target endpoint.
   * For panels: this gets or establishes a MessagePort connection.
   * For workers: this sends via utility process IPC.
   */
  send(targetId: string, message: RpcMessage): Promise<void>;

  /**
   * Register a handler for incoming messages from a specific source.
   * Returns an unsubscribe function.
   */
  onMessage(sourceId: string, handler: (message: RpcMessage) => void): () => void;

  /**
   * Register a handler for messages from any source.
   * Used for broadcast events. Returns an unsubscribe function.
   */
  onAnyMessage(handler: (sourceId: string, message: RpcMessage) => void): () => void;
}

/**
 * Configuration for creating an RPC bridge.
 */
export interface RpcBridgeConfig {
  /** The ID of this endpoint (e.g., "panel:abc" or "worker:xyz") */
  selfId: string;
  /** The transport implementation */
  transport: RpcTransport;
  /** Timeout for RPC calls in milliseconds (default: 30000) */
  callTimeoutMs?: number;
}

/**
 * RPC bridge interface exposed to user code.
 */
export interface RpcBridge {
  /** The ID of this endpoint */
  readonly selfId: string;

  /**
   * Expose methods that can be called by other endpoints.
   * Can be called multiple times to add more methods.
   */
  expose(methods: ExposedMethods): void;

  /**
   * Call a method on another endpoint.
   * @param targetId - The ID of the target endpoint (e.g., "worker:xyz")
   * @param method - The method name to call
   * @param args - Arguments to pass to the method
   * @returns Promise resolving to the method's return value
   */
  call<T = unknown>(targetId: string, method: string, ...args: unknown[]): Promise<T>;

  /**
   * Emit an event to a specific target endpoint.
   * @param targetId - The ID of the target endpoint
   * @param event - The event name
   * @param payload - The event payload
   */
  emit(targetId: string, event: string, payload: unknown): Promise<void>;

  /**
   * Listen for events from any endpoint.
   * @param event - The event name to listen for
   * @param listener - Callback receiving the source ID and payload
   * @returns Unsubscribe function
   */
  onEvent(event: string, listener: RpcEventListener): () => void;
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

/**
 * Create a panel endpoint ID.
 */
export function panelId(id: string): string {
  return `panel:${id}`;
}

/**
 * Create a worker endpoint ID.
 */
export function workerId(id: string): string {
  return `worker:${id}`;
}

// =============================================================================
// Service RPC (Worker <-> Main Process)
// =============================================================================

/**
 * Service call request from worker to main process.
 * This is a unified message type for all service calls (fs, network, bridge, ai, etc.)
 */
export interface ServiceCallRequest {
  type: "service:call";
  requestId: string;
  workerId: string;
  service: string; // "fs" | "network" | "bridge" | "ai"
  method: string; // Method within the service
  args: unknown[];
}

/**
 * Service call response from main process to worker.
 */
export interface ServiceCallResponse {
  type: "service:response";
  requestId: string;
  result?: unknown;
  error?: string;
}

/**
 * Push event from main process to worker (for streams, etc.)
 */
export interface ServicePushEvent {
  type: "service:push";
  workerId: string;
  service: string;
  event: string; // "stream-chunk" | "stream-end" | etc.
  payload: unknown;
}

/**
 * Service invoke request from main process to worker (bidirectional RPC).
 * This allows main to call methods on workers and get results back.
 */
export interface ServiceInvokeRequest {
  type: "service:invoke";
  requestId: string;
  workerId: string;
  service: string;
  method: string;
  args: unknown[];
}

/**
 * Service invoke response from worker to main process.
 */
export interface ServiceInvokeResponse {
  type: "service:invoke-response";
  requestId: string;
  workerId: string;
  result?: unknown;
  error?: string;
}

/**
 * Union type for all service messages (utility process <-> main process).
 */
export type ServiceMessage =
  | ServiceCallRequest
  | ServiceCallResponse
  | ServicePushEvent
  | ServiceInvokeRequest
  | ServiceInvokeResponse;

/**
 * Service handler function type.
 */
export type ServiceHandler = (
  workerId: string,
  method: string,
  args: unknown[]
) => Promise<unknown>;

/**
 * Push event handler function type (called in worker runtime).
 */
export type PushEventHandler = (event: string, payload: unknown) => void;

/**
 * Service registry for registering service handlers in the main process.
 */
export interface ServiceRegistry {
  /**
   * Register a service handler.
   * @param service - Service name (e.g., "fs", "ai", "bridge")
   * @param handler - Handler function for service calls
   */
  register(service: string, handler: ServiceHandler): void;

  /**
   * Handle a service call and return the result.
   */
  handle(request: ServiceCallRequest): Promise<ServiceCallResponse>;

  /**
   * Send a push event to a worker.
   */
  push(workerId: string, service: string, event: string, payload: unknown): void;
}
