/**
 * Worker environment types for workerd bindings.
 *
 * Workers receive these as the `env` parameter in their fetch handler.
 * NatStack injects the RPC bindings; user workers add their own.
 */

export interface WorkerEnv {
  /** Worker instance name (e.g., "hello") */
  WORKER_ID: string;
  /** Context ID for storage partition */
  CONTEXT_ID: string;
  /** HTTP base URL for gateway server (e.g., "http://127.0.0.1:8080") */
  GATEWAY_URL: string;
  /** Workspace source path for this worker, injected by NatStack. */
  WORKER_SOURCE?: string;
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
