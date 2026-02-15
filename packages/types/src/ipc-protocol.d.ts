/**
 * IPC Protocol Types - Message types for host <-> agent communication.
 *
 * Type guards (isHostToAgentMessage, isAgentToHostMessage) live in @workspace/core.
 */
export interface AgentInitConfig {
    agentId: string;
    channel: string;
    handle: string;
    config: Record<string, unknown>;
    pubsubUrl: string;
    pubsubToken: string;
}
export type HostToAgentMessage = {
    type: "init";
    config: AgentInitConfig;
} | {
    type: "shutdown";
} | {
    type: "state-response";
    state: unknown | null;
};
export type AgentToHostMessage = {
    type: "ready";
} | {
    type: "state-request";
} | {
    type: "state-update";
    state: unknown;
} | {
    type: "state-save";
    state: unknown;
} | {
    type: "shutdown-complete";
} | {
    type: "error";
    error: string;
    stack?: string;
} | {
    type: "log";
    level: "debug" | "info" | "warn" | "error";
    message: string;
    stack?: string;
};
//# sourceMappingURL=ipc-protocol.d.ts.map