/**
 * RPC bridge for workers.
 *
 * This module provides the RPC API for workers to communicate with
 * panels and other workers. It uses the __rpcSend function injected
 * by the utility process and sets up __rpcReceive for incoming messages.
 */

import type {
  WorkerRpc,
  ExposedMethods,
  RpcRequest,
  RpcResponse,
  RpcEvent,
  RpcMessage,
} from "./types.js";

// Declare globals injected by utility process
declare const __workerId: string;
declare const __rpcSend: (targetId: string, message: unknown) => void;
declare function __rpcReceive(fromId: string, message: unknown): void;

// Timeout for RPC calls (30 seconds)
const RPC_TIMEOUT_MS = 30000;

// Methods exposed by this worker
let exposedMethods: ExposedMethods = {};

// Pending requests waiting for responses
const pendingRequests = new Map<
  string,
  {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timeout: ReturnType<typeof setTimeout>;
  }
>();

// Event listeners keyed by event name
const eventListeners = new Map<string, Set<(fromId: string, payload: unknown) => void>>();

/**
 * Generate a unique request ID.
 */
function generateRequestId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/**
 * Handle incoming RPC messages.
 * This is called by the utility process via __rpcReceive.
 */
function handleIncomingMessage(fromId: string, message: RpcMessage): void {
  switch (message.type) {
    case "request":
      void handleRequest(fromId, message);
      break;
    case "response":
      handleResponse(message);
      break;
    case "event":
      handleEvent(fromId, message);
      break;
  }
}

/**
 * Handle incoming RPC request.
 */
async function handleRequest(fromId: string, request: RpcRequest): Promise<void> {
  const { requestId, method, args } = request;

  const handler = exposedMethods[method];
  if (!handler) {
    const response: RpcResponse = {
      type: "response",
      requestId,
      error: `Method "${method}" is not exposed by this worker`,
    };
    __rpcSend(fromId, response);
    return;
  }

  try {
    const result = await Promise.resolve(handler(...args));
    const response: RpcResponse = {
      type: "response",
      requestId,
      result,
    };
    __rpcSend(fromId, response);
  } catch (error) {
    const response: RpcResponse = {
      type: "response",
      requestId,
      error: error instanceof Error ? error.message : String(error),
    };
    __rpcSend(fromId, response);
  }
}

/**
 * Handle incoming RPC response.
 */
function handleResponse(response: RpcResponse): void {
  const pending = pendingRequests.get(response.requestId);
  if (!pending) {
    return; // Response for unknown/timed-out request
  }

  pendingRequests.delete(response.requestId);
  clearTimeout(pending.timeout);

  if (response.error) {
    pending.reject(new Error(response.error));
  } else {
    pending.resolve(response.result);
  }
}

/**
 * Handle incoming RPC event.
 */
function handleEvent(fromId: string, event: RpcEvent): void {
  const listeners = eventListeners.get(event.event);
  if (!listeners) {
    return;
  }

  for (const listener of listeners) {
    try {
      listener(fromId, event.payload);
    } catch (error) {
      console.error(`Error in RPC event listener for "${event.event}":`, error);
    }
  }
}

/**
 * RPC bridge API for workers.
 */
export const rpc: WorkerRpc = {
  expose(methods: ExposedMethods): void {
    exposedMethods = { ...exposedMethods, ...methods };
  },

  async call<T = unknown>(targetId: string, method: string, ...args: unknown[]): Promise<T> {
    const requestId = generateRequestId();

    const request: RpcRequest = {
      type: "request",
      requestId,
      fromId: `worker:${__workerId}`,
      method,
      args,
    };

    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        pendingRequests.delete(requestId);
        reject(new Error(`RPC call to ${targetId}.${method} timed out`));
      }, RPC_TIMEOUT_MS);

      pendingRequests.set(requestId, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timeout,
      });

      __rpcSend(targetId, request);
    });
  },

  emit(targetId: string, event: string, payload: unknown): void {
    const message: RpcEvent = {
      type: "event",
      fromId: `worker:${__workerId}`,
      event,
      payload,
    };
    __rpcSend(targetId, message);
  },

  onEvent(event: string, listener: (fromId: string, payload: unknown) => void): () => void {
    let listeners = eventListeners.get(event);
    if (!listeners) {
      listeners = new Set();
      eventListeners.set(event, listeners);
    }
    listeners.add(listener);

    return () => {
      listeners!.delete(listener);
      if (listeners!.size === 0) {
        eventListeners.delete(event);
      }
    };
  },
};

// Set up the global __rpcReceive handler
// This is called by the utility process when messages arrive
(globalThis as { __rpcReceive?: typeof handleIncomingMessage }).__rpcReceive = handleIncomingMessage;
