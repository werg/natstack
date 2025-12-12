/**
 * WorkerManager - Singleton manager for isolated workers.
 *
 * Manages a single utility process that hosts multiple vm sandboxes.
 * Handles worker lifecycle, RPC routing, and resource cleanup.
 *
 * Uses the unified ServiceCallRequest/Response pattern for all service calls.
 */

import { utilityProcess, type UtilityProcess } from "electron";
import * as path from "path";
import * as crypto from "crypto";
import { createScopedFs } from "@natstack/scoped-fs";
import { getActiveWorkspace, getWorkerScopePath } from "./paths.js";
import { TOOL_EXECUTION_TIMEOUT_MS, DEFAULT_WORKER_MEMORY_LIMIT_MB } from "../shared/constants.js";
import type {
  WorkerState,
  UtilityMessage,
  UtilityWorkerCreateRequest,
  UtilityWorkerCreateResponse,
  UtilityWorkerTerminateRequest,
  UtilityRpcForward,
  ServiceCallRequest,
  ServiceCallResponse,
  ServicePushEvent,
  ServiceInvokeRequest,
  ServiceInvokeResponse,
} from "./workerTypes.js";
import type { WorkerCreateOptions, WorkerInfo } from "../shared/ipc/types.js";
import type { RpcMessage, ServiceHandler } from "@natstack/rpc";

// Default options for workers
const DEFAULTS = {
  memoryLimitMB: DEFAULT_WORKER_MEMORY_LIMIT_MB,
  env: {} as Record<string, string>,
} as const;

/**
 * Singleton WorkerManager instance.
 */
let instance: WorkerManager | null = null;

/**
 * Get the singleton WorkerManager instance.
 */
export function getWorkerManager(): WorkerManager {
  if (!instance) {
    instance = new WorkerManager();
  }
  return instance;
}

/**
 * Callback for RPC messages that need to be routed to panels.
 */
export type RpcToPanelCallback = (panelId: string, fromId: string, message: RpcMessage) => void;

export class WorkerManager {
  /** The utility process hosting vm sandboxes */
  private utilityProc: UtilityProcess | null = null;

  /** Active workers keyed by worker ID (without prefix) */
  private workers = new Map<string, WorkerState>();

  /** Scoped filesystem instances per worker (keyed by workerId) */
  private scopedFsInstances = new Map<string, ReturnType<typeof createScopedFs>>();

  /** Callback to route RPC messages to panels */
  private rpcToPanelCallback: RpcToPanelCallback | null = null;

  /** Callback to notify about worker console logs */
  private consoleLogCallback: ((workerId: string, level: string, message: string) => void) | null =
    null;

  /** Service handlers registered by service name */
  private serviceHandlers = new Map<string, ServiceHandler>();

  /** Pending service invoke requests waiting for responses */
  private pendingInvokes = new Map<
    string,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
    }
  >();

  // Utility process is started lazily on first worker creation

  /**
   * Set the callback for routing RPC messages to panels.
   */
  setRpcToPanelCallback(callback: RpcToPanelCallback): void {
    this.rpcToPanelCallback = callback;
  }

  /**
   * Set the callback for worker console log notifications.
   */
  setConsoleLogCallback(
    callback: (workerId: string, level: string, message: string) => void
  ): void {
    this.consoleLogCallback = callback;
  }

  /**
   * Register a service handler.
   * @param service - Service name (e.g., "fs", "network", "bridge", "ai")
   * @param handler - Handler function for service calls
   */
  registerService(service: string, handler: ServiceHandler): void {
    this.serviceHandlers.set(service, handler);
  }

  /**
   * Start the utility process if not already running.
   */
  private async ensureUtilityProcess(): Promise<void> {
    if (this.utilityProc) {
      return;
    }

    const utilityEntryPath = path.join(__dirname, "utilityProcess.cjs");

    this.utilityProc = utilityProcess.fork(utilityEntryPath, [], {
      serviceName: "natstack-worker-host",
      stdio: "pipe",
    });

    this.utilityProc.on("message", (message: UtilityMessage) => {
      this.handleUtilityMessage(message);
    });

    this.utilityProc.on("exit", (code) => {
      console.error(`[WorkerManager] Utility process exited with code ${code}`);
      this.utilityProc = null;
      // Mark all workers as errored
      for (const worker of this.workers.values()) {
        worker.buildState = "error";
        worker.error = "Utility process crashed";
      }
    });

    // Wait for utility process to be ready
    const proc = this.utilityProc;
    await new Promise<void>((resolve) => {
      const handler = (message: UtilityMessage) => {
        if ((message as { type: string }).type === "ready") {
          proc.off("message", handler);
          resolve();
        }
      };
      proc.on("message", handler);
    });
  }

  /**
   * Handle messages from the utility process.
   */
  private handleUtilityMessage(message: UtilityMessage): void {
    switch (message.type) {
      case "worker:created":
        this.handleWorkerCreated(message);
        break;
      case "worker:terminated":
        this.handleWorkerTerminated(message);
        break;
      case "rpc:forward":
        this.handleRpcForward(message);
        break;
      case "service:call":
        void this.handleServiceCall(message);
        break;
      case "service:invoke-response":
        this.handleServiceInvokeResponse(message);
        break;
      case "console:log":
        this.handleConsoleLog(message);
        break;
      case "worker:error":
        this.handleWorkerError(message);
        break;
    }
  }

  /**
   * Handle service invoke response from worker.
   */
  private handleServiceInvokeResponse(response: ServiceInvokeResponse): void {
    const pending = this.pendingInvokes.get(response.requestId);
    if (!pending) return;

    this.pendingInvokes.delete(response.requestId);

    if (response.error) {
      pending.reject(new Error(response.error));
    } else {
      pending.resolve(response.result);
    }
  }

  /**
   * Handle unified service call from worker.
   */
  private async handleServiceCall(request: ServiceCallRequest): Promise<void> {
    const { workerId, requestId, service, method, args } = request;

    // Check for built-in services first
    if (service === "fs") {
      await this.handleFsServiceCall(workerId, requestId, method, args);
      return;
    }

    if (service === "network") {
      await this.handleNetworkServiceCall(workerId, requestId, method, args);
      return;
    }

    // Look up registered service handler
    const handler = this.serviceHandlers.get(service);
    if (!handler) {
      const response: ServiceCallResponse = {
        type: "service:response",
        requestId,
        error: `Unknown service: ${service}`,
      };
      this.utilityProc?.postMessage(response);
      return;
    }

    try {
      const result = await handler(workerId, method, args);
      const response: ServiceCallResponse = {
        type: "service:response",
        requestId,
        result,
      };
      this.utilityProc?.postMessage(response);
    } catch (error) {
      const response: ServiceCallResponse = {
        type: "service:response",
        requestId,
        error: error instanceof Error ? error.message : String(error),
      };
      this.utilityProc?.postMessage(response);
    }
  }

  /**
   * Handle filesystem service calls (built-in).
   */
  private async handleFsServiceCall(
    workerId: string,
    requestId: string,
    method: string,
    args: unknown[]
  ): Promise<void> {
    const scopedFs = this.scopedFsInstances.get(workerId);
    if (!scopedFs) {
      const response: ServiceCallResponse = {
        type: "service:response",
        requestId,
        error: `Worker ${workerId} not found or has no scoped filesystem`,
      };
      this.utilityProc?.postMessage(response);
      return;
    }

    try {
      let result: unknown;

      switch (method) {
        case "readFile": {
          const [filePath, encoding] = args as [string, BufferEncoding | null];
          if (encoding) {
            // Text mode: return string with specified encoding
            result = await scopedFs.promises.readFile(filePath, { encoding });
          } else {
            // Binary mode: return base64-encoded string
            const buffer = await scopedFs.promises.readFile(filePath);
            result = buffer.toString("base64");
          }
          break;
        }
        case "writeFile": {
          const [filePath, data, mode] = args as [string, string, "utf-8" | "base64"];
          if (mode === "base64") {
            // Binary mode: decode base64 to buffer
            const buffer = Buffer.from(data, "base64");
            await scopedFs.promises.writeFile(filePath, buffer);
          } else {
            // Text mode: write string directly
            await scopedFs.promises.writeFile(filePath, data, { encoding: "utf-8" });
          }
          result = undefined;
          break;
        }
        case "readdir": {
          const [dirPath] = args as [string];
          result = await scopedFs.promises.readdir(dirPath);
          break;
        }
        case "stat": {
          const [filePath] = args as [string];
          const stats = await scopedFs.promises.stat(filePath);
          result = {
            isFile: stats.isFile(),
            isDirectory: stats.isDirectory(),
            size: stats.size,
            mtime: stats.mtime.toISOString(),
            ctime: stats.ctime.toISOString(),
          };
          break;
        }
        case "mkdir": {
          const [dirPath, options] = args as [string, { recursive?: boolean } | undefined];
          await scopedFs.promises.mkdir(dirPath, options);
          result = undefined;
          break;
        }
        case "rm": {
          const [filePath, options] = args as [
            string,
            { recursive?: boolean; force?: boolean } | undefined,
          ];
          await scopedFs.promises.rm(filePath, options);
          result = undefined;
          break;
        }
        case "exists": {
          const [filePath] = args as [string];
          try {
            await scopedFs.promises.access(filePath);
            result = true;
          } catch {
            result = false;
          }
          break;
        }
        case "unlink": {
          const [filePath] = args as [string];
          await scopedFs.promises.unlink(filePath);
          result = undefined;
          break;
        }
        default:
          throw new Error(`Unknown fs method: ${method}`);
      }

      const response: ServiceCallResponse = {
        type: "service:response",
        requestId,
        result,
      };
      this.utilityProc?.postMessage(response);
    } catch (error) {
      const response: ServiceCallResponse = {
        type: "service:response",
        requestId,
        error: error instanceof Error ? error.message : String(error),
      };
      this.utilityProc?.postMessage(response);
    }
  }

  /**
   * Handle network service calls (built-in).
   * Workers have full network access.
   */
  private async handleNetworkServiceCall(
    _workerId: string,
    requestId: string,
    method: string,
    args: unknown[]
  ): Promise<void> {
    if (method !== "fetch") {
      const response: ServiceCallResponse = {
        type: "service:response",
        requestId,
        error: `Unknown network method: ${method}`,
      };
      this.utilityProc?.postMessage(response);
      return;
    }

    const [url, options] = args as [
      string,
      { method?: string; headers?: Record<string, string>; body?: string } | undefined,
    ];

    try {
      const fetchResponse = await fetch(url, {
        method: options?.method || "GET",
        headers: options?.headers,
        body: options?.body,
      });

      const body = await fetchResponse.text();
      const headers: Record<string, string> = {};
      fetchResponse.headers.forEach((value, key) => {
        headers[key] = value;
      });

      const response: ServiceCallResponse = {
        type: "service:response",
        requestId,
        result: {
          status: fetchResponse.status,
          statusText: fetchResponse.statusText,
          headers,
          body,
        },
      };
      this.utilityProc?.postMessage(response);
    } catch (error) {
      const response: ServiceCallResponse = {
        type: "service:response",
        requestId,
        error: error instanceof Error ? error.message : String(error),
      };
      this.utilityProc?.postMessage(response);
    }
  }

  /**
   * Handle worker creation response.
   */
  private handleWorkerCreated(message: UtilityWorkerCreateResponse): void {
    const worker = this.workers.get(message.workerId);
    if (!worker) return;

    if (message.success) {
      worker.buildState = "ready";
    } else {
      worker.buildState = "error";
      worker.error = message.error;
    }
  }

  /** Pending termination promises waiting for confirmation from utility process */
  private pendingTerminations = new Map<
    string,
    { resolve: () => void; reject: (error: Error) => void }
  >();

  /**
   * Handle worker termination response.
   */
  private handleWorkerTerminated(message: {
    workerId: string;
    success: boolean;
    error?: string;
  }): void {
    // Resolve any pending termination promise
    const pending = this.pendingTerminations.get(message.workerId);
    if (pending) {
      this.pendingTerminations.delete(message.workerId);
      if (message.success) {
        pending.resolve();
      } else {
        pending.reject(new Error(message.error ?? "Worker termination failed"));
      }
    }

    // Clean up local state after confirmation
    this.workers.delete(message.workerId);
    this.scopedFsInstances.delete(message.workerId);
  }

  /**
   * Handle RPC message forwarding from workers.
   * The target type is determined by checking if the ID exists in our worker map.
   */
  private handleRpcForward(message: UtilityRpcForward): void {
    const { fromId, toId, message: rpcMessage } = message;

    // Check if target is another worker we manage
    if (this.workers.has(toId)) {
      // Forward to utility process for inter-worker communication
      this.utilityProc?.postMessage(message);
      return;
    }

    // Otherwise, assume it's a panel and use the callback
    if (this.rpcToPanelCallback) {
      this.rpcToPanelCallback(toId, fromId, rpcMessage as RpcMessage);
      return;
    }

    console.warn(`[WorkerManager] Cannot route RPC to: ${toId}`);
  }

  /**
   * Handle console log from worker.
   */
  private handleConsoleLog(message: { workerId: string; level: string; args: unknown[] }): void {
    const prefix = `[Worker:${message.workerId}]`;
    const logFn = console[message.level as "log"] || console.log;
    logFn(prefix, ...message.args);

    // Notify via callback (format args as a string message)
    if (this.consoleLogCallback) {
      const msgStr = message.args
        .map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg)))
        .join(" ");
      this.consoleLogCallback(message.workerId, message.level, msgStr);
    }
  }

  /**
   * Handle worker error notification.
   */
  private handleWorkerError(message: { workerId: string; error: string; fatal: boolean }): void {
    const worker = this.workers.get(message.workerId);
    if (!worker) return;

    worker.error = message.error;
    if (message.fatal) {
      worker.buildState = "error";
    }

    console.error(`[WorkerManager] Worker ${message.workerId} error:`, message.error);
  }

  /**
   * Send a push event to a worker.
   */
  sendPush(workerId: string, service: string, event: string, payload: unknown): void {
    const message: ServicePushEvent = {
      type: "service:push",
      workerId,
      service,
      event,
      payload,
    };
    this.utilityProc?.postMessage(message);
  }

  /**
   * Invoke a service method on a worker and wait for the result (bidirectional RPC).
   * This is like sendPush but expects a response.
   */
  async serviceInvoke(
    workerId: string,
    service: string,
    method: string,
    args: unknown[],
    timeoutMs: number = TOOL_EXECUTION_TIMEOUT_MS
  ): Promise<unknown> {
    const requestId = crypto.randomUUID();

    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.pendingInvokes.delete(requestId);
        reject(new Error(`Service invoke ${service}.${method} timed out`));
      }, timeoutMs);

      this.pendingInvokes.set(requestId, {
        resolve: (value: unknown) => {
          clearTimeout(timeoutId);
          resolve(value);
        },
        reject: (error: Error) => {
          clearTimeout(timeoutId);
          reject(error);
        },
      });

      const message: ServiceInvokeRequest = {
        type: "service:invoke",
        requestId,
        workerId,
        service,
        method,
        args,
      };
      this.utilityProc?.postMessage(message);
    });
  }

  /**
   * Create a new worker from a workspace path.
   * @param parentPanelId - ID of the parent panel
   * @param workerPath - Workspace-relative path to the worker
   * @param options - Worker creation options
   * @param treeNodeId - Optional ID to use (from PanelManager tree). If not provided, generates UUID.
   */
  async createWorker(
    parentPanelId: string,
    workerPath: string,
    options: WorkerCreateOptions,
    treeNodeId?: string
  ): Promise<WorkerInfo> {
    const workspace = getActiveWorkspace();
    if (!workspace) {
      throw new Error("WorkerManager requires an active workspace");
    }

    await this.ensureUtilityProcess();

    // Use provided tree node ID or generate one
    const workerId = treeNodeId ?? crypto.randomUUID();

    // Merge options with defaults
    const mergedOptions: WorkerCreateOptions = {
      ...DEFAULTS,
      ...options,
    };

    // Create worker state
    const worker: WorkerState = {
      id: workerId,
      parentPanelId,
      workerPath,
      buildState: "building",
      options: mergedOptions,
      createdAt: Date.now(),
    };

    this.workers.set(workerId, worker);

    // Create scoped filesystem for this worker using auto-generated path
    // Path: <central-config>/worker-scopes/<workspace-id>/<escaped-worker-id>/
    // Singleton workers get deterministic IDs, so they'll reuse the same scope path
    const scopePath = getWorkerScopePath(workspace.config.id, workerId);
    try {
      const scopedFs = createScopedFs({ root: scopePath });
      this.scopedFsInstances.set(workerId, scopedFs);
    } catch (error) {
      worker.buildState = "error";
      worker.error = `Failed to create scoped filesystem: ${error instanceof Error ? error.message : String(error)}`;
      return {
        workerId,
        buildState: worker.buildState,
        error: worker.error,
      };
    }

    // TODO: Build the worker bundle using RuntimeBuilder
    // For now, return immediately and mark as building
    // The actual build will be implemented in Phase 5

    return {
      workerId,
      buildState: worker.buildState,
    };
  }

  /**
   * Send a built worker bundle to the utility process.
   */
  async sendWorkerBundle(workerId: string, bundle: string): Promise<void> {
    const worker = this.workers.get(workerId);
    if (!worker) {
      throw new Error(`Worker ${workerId} not found`);
    }

    const request: UtilityWorkerCreateRequest = {
      type: "worker:create",
      workerId,
      bundle,
      options: {
        memoryLimitMB: worker.options.memoryLimitMB ?? DEFAULTS.memoryLimitMB,
        env: worker.options.env ?? DEFAULTS.env,
      },
    };

    this.utilityProc?.postMessage(request);
  }

  /**
   * Terminate a worker.
   * Waits for the utility process to confirm termination before cleaning up local state.
   */
  terminateWorker(workerId: string): void {
    const worker = this.workers.get(workerId);
    if (!worker) {
      return; // Worker already terminated or doesn't exist
    }

    // If utility process is gone, just clean up locally
    if (!this.utilityProc) {
      this.workers.delete(workerId);
      this.scopedFsInstances.delete(workerId);
      return;
    }

    const request: UtilityWorkerTerminateRequest = {
      type: "worker:terminate",
      workerId,
    };

    this.utilityProc.postMessage(request);

    // State cleanup happens in handleWorkerTerminated when we get confirmation
  }

  /**
   * Get worker info.
   */
  getWorkerInfo(workerId: string): WorkerInfo | null {
    const worker = this.workers.get(workerId);
    if (!worker) {
      return null;
    }

    return {
      workerId: worker.id,
      buildState: worker.buildState,
      error: worker.error,
    };
  }

  /**
   * Route an RPC message from a panel to a worker.
   */
  routeRpcToWorker(fromId: string, toId: string, message: RpcMessage): void {
    const forward: UtilityRpcForward = {
      type: "rpc:forward",
      fromId,
      toId,
      message,
    };

    this.utilityProc?.postMessage(forward);
  }

  /**
   * Get all workers created by a specific panel.
   */
  getWorkersForPanel(panelId: string): WorkerInfo[] {
    const workers: WorkerInfo[] = [];
    for (const worker of this.workers.values()) {
      if (worker.parentPanelId === panelId) {
        workers.push({
          workerId: worker.id,
          buildState: worker.buildState,
          error: worker.error,
        });
      }
    }
    return workers;
  }

  /**
   * Terminate all workers created by a specific panel.
   */
  terminateWorkersForPanel(panelId: string): void {
    for (const worker of this.workers.values()) {
      if (worker.parentPanelId === panelId) {
        this.terminateWorker(worker.id);
      }
    }
  }

  /**
   * Shutdown the worker manager and terminate all workers.
   */
  shutdown(): void {
    // Terminate all workers
    for (const workerId of this.workers.keys()) {
      this.terminateWorker(workerId);
    }

    // Kill utility process
    if (this.utilityProc) {
      this.utilityProc.kill();
      this.utilityProc = null;
    }

    instance = null;
  }
}
