/**
 * Utility Process Entry Point
 *
 * This file runs in an Electron utility process (Node.js environment).
 * It manages multiple vm contexts, each running a worker bundle in a sandbox.
 *
 * Communication with main process happens via process.parentPort (MessagePort).
 *
 * UNIFIED RPC ARCHITECTURE:
 * Workers use a single RPC API for all communication:
 * - rpc.call("main", "service.method", ...args) - calls main process services
 * - rpc.call("panel:xxx", "method", ...args) - calls panel methods
 * - rpc.call("worker:xxx", "method", ...args) - calls other worker methods
 * - rpc.expose({ method: fn }) - exposes methods callable by main/panels/workers
 * - rpc.onEvent("event", handler) - listens for events from any source
 *
 * The utility process intercepts RPC messages to "main" and routes them
 * through the service call mechanism.
 */

import vm from "node:vm";
import type {
  UtilityMessage,
  UtilityWorkerCreateRequest,
  UtilityWorkerCreateResponse,
  UtilityWorkerTerminateRequest,
  UtilityWorkerTerminateResponse,
  UtilityRpcForward,
  UtilityConsoleLog,
  UtilityWorkerError,
  ServiceCallRequest,
  ServiceCallResponse,
  ServicePushEvent,
  ServiceInvokeRequest,
  ServiceInvokeResponse,
} from "../main/workerTypes.js";

/** RPC message types (matching worker-runtime/src/types.ts) */
interface RpcRequest {
  type: "request";
  requestId: string;
  fromId: string;
  method: string;
  args: unknown[];
}

interface RpcResponse {
  type: "response";
  requestId: string;
  result?: unknown;
  error?: string;
}

interface RpcEvent {
  type: "event";
  fromId: string;
  event: string;
  payload: unknown;
}

type RpcMessage = RpcRequest | RpcResponse | RpcEvent;

// Get the parent port for communication with main process
const parentPort = process.parentPort;
if (!parentPort) {
  console.error("[UtilityProcess] No parent port available");
  process.exit(1);
}

// =============================================================================
// Worker Context Management
// =============================================================================

interface WorkerState {
  context: vm.Context;
  workerId: string;
  options: {
    memoryLimitMB: number;
    env: Record<string, string>;
  };
}

/** Active worker contexts keyed by worker ID */
const workers = new Map<string, WorkerState>();

/** Pending service requests waiting for responses (legacy __serviceCall) */
const pendingRequests = new Map<
  string,
  {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
  }
>();

/** Pending RPC requests to main (unified rpc.call("main", ...)) */
const pendingRpcToMain = new Map<string, { workerId: string }>();

// =============================================================================
// Message Handling
// =============================================================================

parentPort.on("message", (event: Electron.MessageEvent) => {
  const message = event.data as UtilityMessage;
  switch (message.type) {
    case "worker:create":
      void handleWorkerCreate(message);
      break;
    case "worker:terminate":
      handleWorkerTerminate(message);
      break;
    case "rpc:forward":
      handleRpcForward(message);
      break;
    case "service:response":
      handleServiceResponse(message);
      break;
    case "service:push":
      handleServicePush(message);
      break;
    case "service:invoke":
      void handleServiceInvoke(message);
      break;
    default:
      console.warn("[UtilityProcess] Unknown message type:", (message as { type: string }).type);
  }
});

/**
 * Handle worker creation request.
 */
async function handleWorkerCreate(request: UtilityWorkerCreateRequest): Promise<void> {
  const { workerId, bundle, options } = request;

  try {
    // Create sandbox with restricted globals
    const sandbox = createSandbox(workerId, options);

    // Create the VM context
    const context = vm.createContext(sandbox, {
      name: `worker:${workerId}`,
    });

    // Set global self-reference after context creation
    context["global"] = context;
    context["globalThis"] = context;

    // Store worker state
    workers.set(workerId, {
      context,
      workerId,
      options,
    });

    // Compile and run the worker bundle
    const script = new vm.Script(bundle, {
      filename: `worker:${workerId}/bundle.js`,
    });

    script.runInContext(context);

    // Send success response
    const response: UtilityWorkerCreateResponse = {
      type: "worker:created",
      workerId,
      success: true,
    };
    parentPort.postMessage(response);
  } catch (error) {
    // Clean up on error
    workers.delete(workerId);

    const response: UtilityWorkerCreateResponse = {
      type: "worker:created",
      workerId,
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
    parentPort.postMessage(response);
  }
}

/**
 * Handle worker termination request.
 */
function handleWorkerTerminate(request: UtilityWorkerTerminateRequest): void {
  const { workerId } = request;

  workers.delete(workerId);

  const response: UtilityWorkerTerminateResponse = {
    type: "worker:terminated",
    workerId,
    success: true,
  };
  parentPort.postMessage(response);
}

/**
 * Handle RPC message forwarding.
 *
 * Routes messages based on target:
 * - "main" target with request: Convert to service:call and send to main process
 * - "main" target with response: Convert to service:invoke-response and send to main
 * - worker ID: Deliver to worker's __rpcReceive
 * - Other targets: Forward to main process for panel routing
 */
function handleRpcForward(message: UtilityRpcForward): void {
  const { fromId, toId, message: rpcMessage } = message;
  const msg = rpcMessage as RpcMessage;

  // Handle messages to "main" specially
  if (toId === "main") {
    if (msg.type === "request") {
      // Worker calling main process service
      handleRpcToMain(fromId, msg);
      return;
    }
    if (msg.type === "response") {
      // Worker responding to main's invoke request
      handleRpcResponseToMain(fromId, msg);
      return;
    }
    // Events to main are not supported (main doesn't listen)
    return;
  }

  // Check if target is a worker we manage
  const state = workers.get(toId);
  if (state) {
    // Deliver to worker's __rpcReceive
    deliverRpcMessage(state, fromId, rpcMessage);
    return;
  }

  // Forward to main process for panel routing (message already in correct format)
  parentPort.postMessage(message);
}

/**
 * Handle RPC response from worker back to main process.
 * Converts to service:invoke-response format.
 */
function handleRpcResponseToMain(workerId: string, response: RpcResponse): void {
  const { requestId, result, error } = response;

  // Check if this is a response to a pending invoke from main
  const pending = pendingInvokeFromMain.get(requestId);
  if (!pending) {
    console.warn(`[UtilityProcess] Received response for unknown invoke: ${requestId}`);
    return;
  }

  pendingInvokeFromMain.delete(requestId);

  // Convert to service:invoke-response and send to main
  const invokeResponse: ServiceInvokeResponse = {
    type: "service:invoke-response",
    requestId,
    workerId,
    result,
    error,
  };
  parentPort.postMessage(invokeResponse);
}

/**
 * Handle RPC request from worker to main process.
 * Converts RPC request to service:call format.
 *
 * Method format: "service.method" (e.g., "fs.readFile", "ai.listRoles")
 */
function handleRpcToMain(workerId: string, request: RpcRequest): void {
  const { requestId, method, args } = request;

  // Parse "service.method" format
  const dotIndex = method.indexOf(".");
  if (dotIndex === -1) {
    // Invalid method format - send error response back to worker
    const state = workers.get(workerId);
    if (state) {
      const errorResponse: RpcResponse = {
        type: "response",
        requestId,
        error: `Invalid method format: "${method}". Expected "service.method" (e.g., "fs.readFile")`,
      };
      deliverRpcMessage(state, "main", errorResponse);
    }
    return;
  }

  const service = method.substring(0, dotIndex);
  const serviceMethod = method.substring(dotIndex + 1);

  // Track this request so we can route the response back
  pendingRpcToMain.set(requestId, { workerId });

  // Convert to service:call format and send to main
  const serviceRequest: ServiceCallRequest = {
    type: "service:call",
    workerId,
    requestId,
    service,
    method: serviceMethod,
    args,
  };
  parentPort.postMessage(serviceRequest);
}

/**
 * Handle unified service response from main process.
 * Converts to RPC response and delivers to the requesting worker.
 */
function handleServiceResponse(response: ServiceCallResponse): void {
  // First check if this is a response to a legacy __serviceCall (for backwards compatibility)
  const pending = pendingRequests.get(response.requestId);
  if (pending) {
    pendingRequests.delete(response.requestId);
    if (response.error) {
      pending.reject(new Error(response.error));
    } else {
      pending.resolve(response.result);
    }
    return;
  }

  // Otherwise, this is a response to an rpc.call("main", ...) request
  // We need to find the worker that made this request and deliver the RPC response
  // The requestId format allows us to extract the workerId
  // For now, we need to track which worker made which request
  // This is handled by the pendingRpcToMain map
  const rpcPending = pendingRpcToMain.get(response.requestId);
  if (!rpcPending) return;

  pendingRpcToMain.delete(response.requestId);

  const state = workers.get(rpcPending.workerId);
  if (!state) return;

  const rpcResponse: RpcResponse = {
    type: "response",
    requestId: response.requestId,
    result: response.result,
    error: response.error,
  };
  deliverRpcMessage(state, "main", rpcResponse);
}

/**
 * Handle push event from main process.
 * Converts to RPC event and delivers to the worker.
 *
 * Event format: "service:event" (e.g., "ai:stream-chunk", "ai:stream-end")
 */
function handleServicePush(message: ServicePushEvent): void {
  const state = workers.get(message.workerId);
  if (!state) return;

  // Convert to RPC event format
  const rpcEvent: RpcEvent = {
    type: "event",
    fromId: "main",
    event: `${message.service}:${message.event}`,
    payload: message.payload,
  };
  deliverRpcMessage(state, "main", rpcEvent);
}

/**
 * Handle service invoke from main process (bidirectional RPC).
 * Converts to RPC request and delivers to worker, then sends response back.
 *
 * This allows main to call methods exposed by workers via rpc.expose().
 * Method format: "service.method" (e.g., "ai.executeTool")
 */
async function handleServiceInvoke(request: ServiceInvokeRequest): Promise<void> {
  const { workerId, requestId, service, method, args } = request;

  const state = workers.get(workerId);
  if (!state) {
    const response: ServiceInvokeResponse = {
      type: "service:invoke-response",
      requestId,
      workerId,
      error: `Worker ${workerId} not found`,
    };
    parentPort.postMessage(response);
    return;
  }

  // Convert to RPC request format
  // The method is "service.method" to match the rpc.expose pattern
  const rpcRequest: RpcRequest = {
    type: "request",
    requestId,
    fromId: "main",
    method: `${service}.${method}`,
    args,
  };

  // Track that we're waiting for a response from this worker
  pendingInvokeFromMain.set(requestId, { workerId });

  // Deliver the RPC request to the worker
  deliverRpcMessage(state, "main", rpcRequest);
}

/** Pending invoke requests from main waiting for worker responses */
const pendingInvokeFromMain = new Map<string, { workerId: string }>();

// =============================================================================
// Sandbox Creation
// =============================================================================

/**
 * Create a sandboxed environment for a worker.
 * Only exposes safe globals - no access to Node.js APIs.
 */
function createSandbox(
  workerId: string,
  options: {
    env: Record<string, string>;
  }
): Record<string, unknown> {
  type LogLevel = "log" | "error" | "warn" | "info" | "debug";

  // Console proxy that forwards to main process
  const createLogMethod = (level: LogLevel) => {
    return (...args: unknown[]) => {
      const message: UtilityConsoleLog = {
        type: "console:log",
        workerId,
        level,
        args,
      };
      parentPort.postMessage(message);
    };
  };

  const consoleProxy = {
    log: createLogMethod("log"),
    error: createLogMethod("error"),
    warn: createLogMethod("warn"),
    info: createLogMethod("info"),
    debug: createLogMethod("debug"),
  };

  // Unified service call function
  const serviceCall = async (
    service: string,
    method: string,
    ...args: unknown[]
  ): Promise<unknown> => {
    const requestId = crypto.randomUUID();

    return new Promise((resolve, reject) => {
      // Timeout based on service type
      // AI operations get 5 minutes, others get 30 seconds
      const timeoutMs = service === "ai" ? 300000 : 30000;
      const timeoutId = setTimeout(() => {
        if (pendingRequests.has(requestId)) {
          pendingRequests.delete(requestId);
          reject(new Error(`Service call ${service}.${method} timed out`));
        }
      }, timeoutMs);

      pendingRequests.set(requestId, {
        resolve: (value: unknown) => {
          clearTimeout(timeoutId);
          resolve(value);
        },
        reject: (error: Error) => {
          clearTimeout(timeoutId);
          reject(error);
        },
      });

      const request: ServiceCallRequest = {
        type: "service:call",
        workerId,
        requestId,
        service,
        method,
        args,
      };
      parentPort.postMessage(request);
    });
  };

  // RPC send function
  const rpcSend = (targetId: string, message: unknown) => {
    const forward: UtilityRpcForward = {
      type: "rpc:forward",
      fromId: workerId,
      toId: targetId,
      message,
    };
    parentPort.postMessage(forward);
  };

  return {
    // Console proxy
    console: consoleProxy,

    // Also expose individual console methods for the worker runtime shim
    __consoleLog: createLogMethod("log"),
    __consoleError: createLogMethod("error"),
    __consoleWarn: createLogMethod("warn"),
    __consoleInfo: createLogMethod("info"),

    // Worker identification
    __workerId: workerId,

    // Environment variables
    __env: options.env,

    // DEPRECATED: Legacy service call mechanism
    // Workers should use rpc.call("main", "service.method", ...args) instead
    // Kept for backwards compatibility during transition
    __serviceCall: serviceCall,

    // RPC bridge - the unified communication mechanism
    __rpcSend: rpcSend,
    __rpcReceive: null, // Set by worker runtime (rpc.ts)

    // DEPRECATED: Legacy push event handler (set by worker runtime)
    // Workers should use rpc.onEvent() instead
    __servicePush: null,

    // DEPRECATED: Legacy service invoke handler (set by worker runtime)
    // Workers should use rpc.expose() instead
    __serviceHandler: null,

    // Standard JS globals that are safe to expose
    Object,
    Array,
    String,
    Number,
    Boolean,
    Date,
    Math,
    JSON,
    RegExp,
    Error,
    TypeError,
    RangeError,
    SyntaxError,
    ReferenceError,
    URIError,
    EvalError,
    Map,
    Set,
    WeakMap,
    WeakSet,
    Promise,
    Symbol,
    Proxy,
    Reflect,
    ArrayBuffer,
    SharedArrayBuffer,
    DataView,
    Int8Array,
    Uint8Array,
    Uint8ClampedArray,
    Int16Array,
    Uint16Array,
    Int32Array,
    Uint32Array,
    Float32Array,
    Float64Array,
    BigInt,
    BigInt64Array,
    BigUint64Array,

    // Timer functions (safe in sandbox)
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    setImmediate,
    clearImmediate,
    queueMicrotask,

    // URL APIs (safe)
    URL,
    URLSearchParams,

    // Text encoding (safe)
    TextEncoder,
    TextDecoder,

    // Crypto (safe subset)
    crypto: {
      randomUUID: () => crypto.randomUUID(),
      getRandomValues: <T extends ArrayBufferView>(array: T): T => crypto.getRandomValues(array),
    },

    // Fetch is provided via service call, not direct access
    // This prevents bypassing network restrictions

    // Explicitly NOT exposed:
    // - require, import (no module loading)
    // - process (no process access)
    // - Buffer (use Uint8Array instead)
    // - fs, path, os, etc. (no Node.js APIs)
    // - fetch (use __serviceCall instead for network)
    // - eval, Function constructor (prevent code injection)
  };
}

/**
 * Deliver an RPC message to a worker context.
 */
function deliverRpcMessage(state: WorkerState, fromId: string, message: unknown): void {
  try {
    const rpcReceive = state.context["__rpcReceive"];
    if (typeof rpcReceive !== "function") {
      console.warn(`[UtilityProcess] Worker ${state.workerId} has no __rpcReceive`);
      return;
    }

    rpcReceive(fromId, message);
  } catch (error) {
    console.error(`[UtilityProcess] Error delivering RPC to ${state.workerId}:`, error);

    // Notify main process of the error
    const errorMessage: UtilityWorkerError = {
      type: "worker:error",
      workerId: state.workerId,
      error: error instanceof Error ? error.message : String(error),
      fatal: false,
    };
    parentPort.postMessage(errorMessage);
  }
}

// =============================================================================
// Startup
// =============================================================================

// Signal that utility process is ready
parentPort.postMessage({ type: "ready" });

// Handle process exit
process.on("exit", () => {
  workers.clear();
});
