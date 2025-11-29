/**
 * Utility Process Entry Point
 *
 * This file runs in an Electron utility process (Node.js environment).
 * It manages multiple vm contexts, each running a worker bundle in a sandbox.
 *
 * Communication with main process happens via process.parentPort (MessagePort).
 * Service calls use the unified ServiceCallRequest/Response pattern.
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
} from "../main/workerTypes.js";

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

/** Pending service requests waiting for responses */
const pendingRequests = new Map<
  string,
  {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
  }
>();

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
 * Handle RPC message forwarding (panel <-> worker communication).
 */
function handleRpcForward(message: UtilityRpcForward): void {
  const { toId, message: rpcMessage } = message;

  // Look up worker directly by ID (panel tree ID format)
  const state = workers.get(toId);
  if (!state) {
    return;
  }

  // Call the RPC handler in the context
  deliverRpcMessage(state, message.fromId, rpcMessage);
}

/**
 * Handle unified service response from main process.
 */
function handleServiceResponse(response: ServiceCallResponse): void {
  const pending = pendingRequests.get(response.requestId);
  if (!pending) return;

  pendingRequests.delete(response.requestId);

  if (response.error) {
    pending.reject(new Error(response.error));
  } else {
    pending.resolve(response.result);
  }
}

/**
 * Handle push event from main process.
 * Routes events to the appropriate worker context based on service and event type.
 */
function handleServicePush(message: ServicePushEvent): void {
  const state = workers.get(message.workerId);
  if (!state) return;

  deliverPushEvent(state, message.service, message.event, message.payload);
}

/**
 * Deliver a push event to a worker context.
 */
function deliverPushEvent(
  state: WorkerState,
  service: string,
  event: string,
  payload: unknown
): void {
  try {
    const handler = state.context["__servicePush"];
    if (typeof handler === "function") {
      handler(service, event, payload);
    }
  } catch (error) {
    console.error(`[UtilityProcess] Error delivering push event to ${state.workerId}:`, error);
  }
}

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

    // Unified service call mechanism
    __serviceCall: serviceCall,

    // RPC bridge
    __rpcSend: rpcSend,
    __rpcReceive: null, // Set by worker runtime

    // Push event handler (set by worker runtime)
    __servicePush: null,

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
