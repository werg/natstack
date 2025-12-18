/**
 * Internal types for worker management in the main process.
 * These types are used for communication between main process and utility process.
 *
 * Service calls (fs, bridge, ai, db) use the unified ServiceCallRequest/Response
 * from @natstack/rpc. This file contains worker lifecycle and other utility messages.
 */

import type { WorkerCreateOptions, WorkerBuildState } from "../shared/ipc/types.js";
import type {
  ServiceCallRequest,
  ServiceCallResponse,
  ServicePushEvent,
  ServiceInvokeRequest,
  ServiceInvokeResponse,
} from "@natstack/rpc";

// Re-export service types for convenience
export type {
  ServiceCallRequest,
  ServiceCallResponse,
  ServicePushEvent,
  ServiceInvokeRequest,
  ServiceInvokeResponse,
};

/**
 * PubSub configuration for real-time messaging.
 */
export interface PubSubConfig {
  serverUrl: string;
  token: string;
}

// =============================================================================
// Worker Lifecycle Messages
// =============================================================================

/**
 * Request to create a new worker isolate.
 */
export interface UtilityWorkerCreateRequest {
  type: "worker:create";
  workerId: string;
  /** Built JavaScript bundle to execute */
  bundle: string;
  /** Worker options */
  options: {
    memoryLimitMB: number;
    env: Record<string, string>;
    /** Initial theme appearance */
    theme?: "light" | "dark";
    /** Parent panel ID (if worker was spawned from a panel) */
    parentId?: string | null;
    /** Git configuration for bootstrap */
    gitConfig?: unknown;
    /** PubSub configuration for real-time messaging */
    pubsubConfig?: PubSubConfig | null;
    /**
     * Run worker with full Node.js API access instead of sandboxed vm.Context.
     * - `true`: Unsafe mode with default scoped filesystem
     * - `string`: Unsafe mode with custom filesystem root (e.g., "/" for full access)
     */
    unsafe?: boolean | string;
    /** Absolute path to the scoped filesystem root for this worker */
    scopePath: string;
  };
}

/**
 * Response after worker creation attempt.
 */
export interface UtilityWorkerCreateResponse {
  type: "worker:created";
  workerId: string;
  success: boolean;
  error?: string;
}

/**
 * Request to terminate a worker.
 */
export interface UtilityWorkerTerminateRequest {
  type: "worker:terminate";
  workerId: string;
}

/**
 * Response after worker termination.
 */
export interface UtilityWorkerTerminateResponse {
  type: "worker:terminated";
  workerId: string;
  success: boolean;
  error?: string;
}

// =============================================================================
// Panel-to-Panel/Worker RPC Forwarding
// =============================================================================

/**
 * RPC message forwarding between main and utility process.
 * Used for panel <-> panel and panel <-> worker communication.
 */
export interface UtilityRpcForward {
  type: "rpc:forward";
  fromId: string;
  toId: string;
  message: unknown; // RpcRequest | RpcResponse | RpcEvent
}

// =============================================================================
// Utility Process Notifications
// =============================================================================

/**
 * Console log forwarding from worker to main.
 */
export interface UtilityConsoleLog {
  type: "console:log";
  workerId: string;
  level: "log" | "error" | "warn" | "info" | "debug";
  args: unknown[];
}

/**
 * Worker crashed or timed out notification.
 */
export interface UtilityWorkerError {
  type: "worker:error";
  workerId: string;
  error: string;
  fatal: boolean;
}

// =============================================================================
// Union Type for All Utility Process Messages
// =============================================================================

/**
 * Union type for all utility process messages.
 *
 * Messages use the unified service RPC pattern:
 * - service:call - Request from worker to main for any service (fs, bridge, ai, db)
 * - service:response - Response from main to worker
 * - service:push - Push event from main to worker (streams)
 * - service:invoke - Request from main to worker (bidirectional RPC)
 * - service:invoke-response - Response from worker to main
 *
 * Plus lifecycle and notification messages:
 * - worker:create/created/terminate/terminated - Worker lifecycle
 * - rpc:forward - Panel <-> Worker RPC forwarding
 * - console:log - Console output forwarding
 * - worker:error - Error notifications
 */
export type UtilityMessage =
  // Worker lifecycle
  | UtilityWorkerCreateRequest
  | UtilityWorkerCreateResponse
  | UtilityWorkerTerminateRequest
  | UtilityWorkerTerminateResponse
  // Panel <-> Worker RPC
  | UtilityRpcForward
  // Unified service RPC (worker -> main)
  | ServiceCallRequest
  | ServiceCallResponse
  // Push events (main -> worker, one-way)
  | ServicePushEvent
  // Bidirectional service invoke (main -> worker -> main)
  | ServiceInvokeRequest
  | ServiceInvokeResponse
  // Notifications
  | UtilityConsoleLog
  | UtilityWorkerError;

// =============================================================================
// Internal Worker State
// =============================================================================

/**
 * Internal state for a worker managed by WorkerManager.
 */
export interface WorkerState {
  /** Worker ID (same as tree node ID from PanelManager) */
  id: string;
  /** Panel ID that created this worker */
  parentPanelId: string;
  /** Workspace-relative path to worker source */
  workerPath: string;
  /** Current build/run state */
  buildState: WorkerBuildState;
  /** Error message if failed */
  error?: string;
  /** Creation options */
  options: WorkerCreateOptions;
  /** Timestamp when worker was created */
  createdAt: number;
  /** Absolute path to the scoped filesystem root for this worker */
  scopePath: string;
}

/**
 * Default worker options.
 */
export const DEFAULT_WORKER_OPTIONS = {
  memoryLimitMB: 1024, // 1 GB default
  env: {} as Record<string, string>,
} as const;
