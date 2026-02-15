/**
 * Agent Types - Core type definitions for agent manifests and instances.
 */
import type { FieldDefinition } from "./form-schema.js";
export interface MethodAdvertisement {
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
    returns?: Record<string, unknown>;
    streaming?: boolean;
    timeout?: number;
}
export interface RequiredMethodSpec {
    name?: string;
    pattern?: string;
    description?: string;
    required: boolean;
}
export interface AgentManifest {
    id: string;
    name: string;
    version: string;
    title?: string;
    description?: string;
    tags?: string[];
    channels?: string[];
    proposedHandle?: string;
    singleton?: boolean;
    parameters?: FieldDefinition[];
    providesMethods?: MethodAdvertisement[];
    requiresMethods?: RequiredMethodSpec[];
    capabilities?: string[];
    permissions?: string[];
}
export interface AgentState {
    [key: string]: unknown;
}
export interface AgentInstanceInfo {
    id: string;
    agentId: string;
    channel: string;
    handle: string;
    startedAt: number;
}
export type JsonValue = string | number | boolean | null | JsonValue[] | {
    [key: string]: JsonValue;
};
export interface GlobalAgentSettings {
    defaultProjectLocation: "external" | "browser";
    defaultAutonomy: 0 | 1 | 2;
}
export type AgentSettings = Record<string, JsonValue>;
//# sourceMappingURL=agent-types.d.ts.map