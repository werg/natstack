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
import type { RpcEvent, RpcMessage, RpcRequest, RpcResponse } from "@natstack/rpc";
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
  unsafe?: boolean | string;
}

/** Active worker contexts keyed by worker ID */
const workers = new Map<string, WorkerState>();

/** Pending RPC requests to main (rpc.call("main", ...)) */
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
    if (options.unsafe) {
      // Unsafe worker: run directly in utility process with full Node.js access
      await handleUnsafeWorkerCreate(workerId, bundle, options);
    } else {
      // Safe worker: run in sandboxed vm.Context
      await handleSafeWorkerCreate(workerId, bundle, options);
    }

    // Send success response
    const response: UtilityWorkerCreateResponse = {
      type: "worker:created",
      workerId,
      success: true,
    };
    parentPort.postMessage(response);
  } catch (error) {
    console.error(`[UtilityProcess] Worker ${workerId} creation failed:`, error);
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
 * Create a safe (sandboxed) worker using vm.Context.
 */
async function handleSafeWorkerCreate(
  workerId: string,
  bundle: string,
  options: UtilityWorkerCreateRequest["options"]
): Promise<void> {
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
    unsafe: false,
  });

  // Compile and run the worker bundle
  const script = new vm.Script(bundle, {
    filename: `worker:${workerId}/bundle.js`,
  });

  script.runInContext(context);
}

/**
 * Create an unsafe worker with full Node.js API access.
 * Uses vm.createContext like safe workers, but with Node.js globals included.
 * This allows globalThis assignments to work correctly while giving full access.
 */
async function handleUnsafeWorkerCreate(
  workerId: string,
  bundle: string,
  options: UtilityWorkerCreateRequest["options"]
): Promise<void> {
  // Create sandbox with full Node.js access (unlike safe workers)
  const sandbox = createUnsafeSandbox(workerId, options);

  // Create the VM context - this makes globalThis point to our sandbox
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
    unsafe: options.unsafe,
  });

  // Compile and run the worker bundle (same as safe workers)
  const script = new vm.Script(bundle, {
    filename: `worker:${workerId}/bundle.js`,
  });

  script.runInContext(context);
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
  const { requestId } = response;

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
    ...("error" in response ? { error: response.error } : { result: response.result }),
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
 * Handle service response from main process.
 * Converts to RPC response and delivers to the requesting worker.
 */
function handleServiceResponse(response: ServiceCallResponse): void {
  const rpcPending = pendingRpcToMain.get(response.requestId);
  if (!rpcPending) return;

  pendingRpcToMain.delete(response.requestId);

  const state = workers.get(rpcPending.workerId);
  if (!state) return;

  const rpcResponse: RpcResponse = response.error
    ? {
        type: "response",
        requestId: response.requestId,
        error: response.error,
      }
    : {
        type: "response",
        requestId: response.requestId,
        result: response.result,
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
    theme?: "light" | "dark";
    parentId?: string | null;
    gitConfig?: unknown;
    pubsubConfig?: { serverUrl: string; token: string } | null;
    scopePath: string;
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

  const sandbox: Record<string, unknown> = {
    // Console proxy
    console: consoleProxy,

    // Also expose individual console methods for the worker runtime shim
    __consoleLog: createLogMethod("log"),
    __consoleError: createLogMethod("error"),
    __consoleWarn: createLogMethod("warn"),
    __consoleInfo: createLogMethod("info"),

    // Unified NatStack globals
    __natstackId: workerId,
    __natstackKind: "worker" as const,
    __natstackParentId: options.parentId ?? null,
    __natstackInitialTheme: options.theme ?? "light",
    __natstackGitConfig: options.gitConfig ?? null,
    __natstackPubSubConfig: options.pubsubConfig ?? null,
    __natstackEnv: options.env,
    // __natstackFsRoot is defined below as immutable

    // RPC bridge - the unified communication mechanism
    __rpcSend: rpcSend,
    __rpcReceive: null, // Set by worker runtime (rpc.ts)

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

    // WebSocket (available in Node 22+, needed for @natstack/pubsub)
    WebSocket,

    // Text encoding (safe)
    TextEncoder,
    TextDecoder,

    // Crypto (safe subset)
    crypto: {
      randomUUID: () => crypto.randomUUID(),
      getRandomValues: <T extends ArrayBufferView>(array: T): T => crypto.getRandomValues(array),
    },

    // Base64 helpers (used by runtime IPC serialization)
    atob,
    btoa,

    // Buffer - needed by isomorphic-git and its dependencies (safe-buffer, sha.js)
    Buffer,

    // Fetch API (available in Node 22+)
    fetch,
    Headers,
    Request,
    Response,
    FormData,

    // Binary data types (commonly used by modern libraries)
    Blob,
    File,

    // Streams API (many modern libraries use these for data processing)
    ReadableStream,
    WritableStream,
    TransformStream,

    // Cancellation API (needed by async libraries, AI SDKs, etc.)
    AbortController,
    AbortSignal,

    // Utility APIs
    performance,
    structuredClone,

    // Custom process object with only injected env (not the real process)
    // This provides process.env for libraries that expect it, without exposing
    // the utility process's real environment or other process APIs
    process: Object.freeze({
      env: Object.freeze({ ...options.env }),
    }),
  };

  // Make __natstackFsRoot immutable to prevent sandbox escape
  // Worker code cannot reassign this to access files outside the scope
  Object.defineProperty(sandbox, "__natstackFsRoot", {
    value: options.scopePath,
    writable: false,
    configurable: false,
    enumerable: true,
  });

  return sandbox;
}

/**
 * Create a custom process object for workers.
 * Provides full process API with merged env vars (real env + injected overrides).
 */
function createWorkerProcess(env: Record<string, string>): NodeJS.Process {
  // Merge real process.env with injected env, preferring injected values
  const mergedEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") {
      mergedEnv[key] = value;
    }
  }
  for (const [key, value] of Object.entries(env)) {
    mergedEnv[key] = value;
  }

  // Create a frozen copy of the merged env
  const frozenEnv = Object.freeze(mergedEnv);

  // Create a process-like object that proxies to the real process
  // but overrides env with the merged view
  return new Proxy(process, {
    get(target, prop) {
      if (prop === "env") {
        return frozenEnv;
      }
      const value = target[prop as keyof typeof target];
      // Bind functions to the real process
      if (typeof value === "function") {
        return value.bind(target);
      }
      return value;
    },
    set(_target, prop, _value) {
      if (prop === "env") {
        // Prevent modification of env
        return false;
      }
      // Allow other properties to be set on the real process
      return Reflect.set(process, prop, _value);
    },
  });
}

/**
 * Create a sandbox for an unsafe worker with full Node.js API access.
 * Includes everything from createSandbox plus require, process, etc.
 * Note: import.meta.url is polyfilled at build time via esbuild define.
 */
function createUnsafeSandbox(
  workerId: string,
  options: {
    env: Record<string, string>;
    theme?: "light" | "dark";
    parentId?: string | null;
    gitConfig?: unknown;
    pubsubConfig?: { serverUrl: string; token: string } | null;
    scopePath: string;
  }
): Record<string, unknown> {
  // Start with the safe sandbox (all standard globals + natstack globals)
  const baseSandbox = createSandbox(workerId, options);

  // Create custom process with only injected env
  const workerProcess = createWorkerProcess(options.env);

  // Add Node.js globals (the key difference from safe workers)
  const unsafeSandbox: Record<string, unknown> = {
    ...baseSandbox,

    // Node.js globals (Buffer already in sandbox)
    global: globalThis,
    // Custom process with merged env (real env + injected overrides)
    process: workerProcess,

    // Node.js module system
    require: require,
    module: module,
    exports: exports,

    // Web APIs available in Node.js (needed by Claude Agent SDK and other libraries)
    AbortController: globalThis.AbortController,
    AbortSignal: globalThis.AbortSignal,
    fetch: globalThis.fetch,
    Headers: globalThis.Headers,
    Request: globalThis.Request,
    Response: globalThis.Response,
    FormData: globalThis.FormData,
    Blob: globalThis.Blob,
    File: globalThis.File,
    URL: globalThis.URL,
    URLSearchParams: globalThis.URLSearchParams,
    ReadableStream: globalThis.ReadableStream,
    WritableStream: globalThis.WritableStream,
    TransformStream: globalThis.TransformStream,
    TextEncoder: globalThis.TextEncoder,
    TextDecoder: globalThis.TextDecoder,
    btoa: globalThis.btoa,
    atob: globalThis.atob,
    crypto: globalThis.crypto,
    performance: globalThis.performance,
    structuredClone: globalThis.structuredClone,
  };

  // Re-define __natstackFsRoot as immutable (spread doesn't preserve property descriptors)
  Object.defineProperty(unsafeSandbox, "__natstackFsRoot", {
    value: options.scopePath,
    writable: false,
    configurable: false,
    enumerable: true,
  });

  return unsafeSandbox;
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
