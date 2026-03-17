/**
 * Worker environment types for workerd bindings.
 *
 * Workers receive these as the `env` parameter in their fetch handler.
 * NatStack injects the RPC bindings; user workers add their own.
 */
export interface WorkerEnv {
    /** WebSocket endpoint for RPC connection */
    RPC_WS_URL: string;
    /** Auth token for ws:auth handshake */
    RPC_AUTH_TOKEN: string;
    /** Worker instance name (e.g., "hello") */
    WORKER_ID: string;
    /** Context ID for storage partition */
    CONTEXT_ID: string;
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
export type { ParticipantDescriptor, MethodAdvertisement } from "@natstack/harness";
//# sourceMappingURL=types.d.ts.map