/**
 * Worker environment types for workerd bindings.
 *
 * Workers receive these as the `env` parameter in their fetch handler.
 * NatStack injects the RPC bindings; user workers add their own.
 */

export interface WorkerEnv {
  /** Auth token for RPC authentication */
  RPC_AUTH_TOKEN: string;
  /** Worker instance name (e.g., "hello") */
  WORKER_ID: string;
  /** Context ID for storage partition */
  CONTEXT_ID: string;
  /** HTTP base URL for RPC server (e.g., "http://127.0.0.1:8080") */
  SERVER_URL: string;
  /** Per-instance auth token attached to outbound fetches for egress proxy attribution */
  PROXY_AUTH_TOKEN: string;
  /** Parent panel/worker ID for parent handle */
  PARENT_ID?: string;
  /** Initial state args (parsed object from JSON binding, if provided at instance creation) */
  STATE_ARGS?: Record<string, unknown>;
  /** User-defined bindings */
  [key: string]: unknown;
}

/**
 * workerd ExecutionContext — provided as the third argument to fetch handlers.
 */
export interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

// Re-export harness types used by DO workers
export type { ParticipantDescriptor } from "@natstack/harness";
