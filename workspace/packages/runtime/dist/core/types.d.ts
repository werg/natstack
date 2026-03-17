/**
 * Core type definitions for NatStack runtime
 * Shared types for panels and workers
 */
import type { ZodType } from "zod";
import type * as Rpc from "./rpc.js";
/**
 * A map of event names to their zod schemas.
 * Used for runtime validation of event payloads.
 *
 * @example
 * ```ts
 * import { z, type EventSchemaMap } from "@workspace/runtime";
 *
 * export const myEventSchemas = {
 *   "counter-changed": z.object({ value: z.number(), previousValue: z.number() }),
 *   "reset": z.object({ timestamp: z.string() }),
 * } satisfies EventSchemaMap;
 * ```
 */
export type EventSchemaMap = Record<string, ZodType>;
/**
 * Infer the event map type from an EventSchemaMap.
 * This gives you typed payloads derived from your zod schemas.
 *
 * @example
 * ```ts
 * import { z, type InferEventMap } from "@workspace/runtime";
 *
 * const schemas = {
 *   "saved": z.object({ path: z.string() }),
 * };
 *
 * type MyEvents = InferEventMap<typeof schemas>;
 * // { saved: { path: string } }
 * ```
 */
export type InferEventMap<T extends EventSchemaMap> = {
    [K in keyof T]: T[K] extends ZodType<infer U> ? U : never;
};
/**
 * Git configuration for a panel or worker.
 */
export interface GitConfig {
    /** Git server base URL (e.g., http://localhost:63524) */
    serverUrl: string;
    /** Bearer token for authentication */
    token: string;
    /** This endpoint's source repo path (e.g., "panels/my-panel") */
    sourceRepo: string;
    /** Optional git ref (branch/tag/commit) to check out */
    gitRef?: string;
}
export type { PubSubConfig } from "@natstack/types";
/**
 * Information about a panel or worker.
 */
export interface EndpointInfo {
    /** The endpoint's unique ID */
    panelId: string;
    /** Storage partition name (derived from contextId) */
    partition: string;
    /** Context ID (format: {mode}_{type}_{identifier}) */
    contextId: string;
}
/**
 * Proxy type for typed RPC calls.
 * Transforms ExposedMethods into callable async functions.
 */
export type TypedCallProxy<T extends Rpc.ExposedMethods> = {
    [K in keyof T]: T[K] extends (...args: infer A) => infer R ? (...args: A) => Promise<Awaited<R>> : never;
};
/**
 * Handle for communicating with the parent panel.
 * Available via `panel.getParent()` or `panel.getParentWithContract()` in child panels.
 *
 * @typeParam T - RPC methods exposed by the parent (what the child can call)
 * @typeParam E - RPC event map for events from parent (what the child can listen to)
 * @typeParam EmitE - RPC event map for events to parent (what the child emits)
 *
 * @example
 * ```ts
 * // For full type safety, prefer getParentWithContract():
 * import { myContract } from "./contract.js";
 * const parent = panel.getParentWithContract(myContract);
 * if (parent) {
 *   await parent.emit("saved", { path: "/foo.txt" }); // Typed from contract!
 * }
 *
 * // Or use direct type parameters:
 * interface MyEmitEvents { saved: { path: string } }
 * const parent = panel.getParent<{}, {}, MyEmitEvents>();
 * parent?.emit("saved", { path: "/foo.txt" }); // Typed!
 * ```
 */
export interface ParentHandle<T extends Rpc.ExposedMethods = Rpc.ExposedMethods, E extends Rpc.RpcEventMap = Rpc.RpcEventMap, EmitE extends Rpc.RpcEventMap = Rpc.RpcEventMap> {
    /** Parent panel's unique ID */
    readonly id: string;
    /**
     * Typed RPC call proxy for parent methods.
     * @example parent.call.notifyReady()
     */
    readonly call: TypedCallProxy<T>;
    /**
     * Emit a typed event to the parent.
     * @example parent.emit("saved", { path: "/foo.txt" })
     */
    emit<EventName extends Extract<keyof EmitE, string>>(event: EventName, payload: EmitE[EventName]): Promise<void>;
    /**
     * Emit an event to the parent (untyped fallback).
     * @example parent.emit("status", { ready: true })
     */
    emit(event: string, payload: unknown): Promise<void>;
    /**
     * Listen for events from the parent (typed if event map provided).
     * @returns Unsubscribe function
     */
    onEvent<EventName extends Extract<keyof E, string>>(event: EventName, listener: (payload: E[EventName]) => void): () => void;
    /**
     * Listen for events from the parent (untyped fallback).
     * @returns Unsubscribe function
     */
    onEvent(event: string, listener: (payload: unknown) => void): () => void;
}
/**
 * One side of a panel contract (child or parent).
 */
export interface ContractSide<Methods extends Rpc.ExposedMethods = Rpc.ExposedMethods, Emits extends EventSchemaMap = EventSchemaMap> {
    readonly methods?: Methods;
    readonly emits?: Emits;
}
/**
 * A typed contract between a parent and child panel.
 * Defines RPC methods and events for both sides.
 */
export interface PanelContract<ChildMethods extends Rpc.ExposedMethods = Rpc.ExposedMethods, ChildEmits extends EventSchemaMap = EventSchemaMap, ParentMethods extends Rpc.ExposedMethods = Rpc.ExposedMethods, ParentEmits extends EventSchemaMap = EventSchemaMap> {
    readonly source: string;
    readonly child?: ContractSide<ChildMethods, ChildEmits>;
    readonly parent?: ContractSide<ParentMethods, ParentEmits>;
    readonly __brand?: "PanelContract";
}
/**
 * Extract the ParentHandle type from a contract.
 * Used internally by getParent when given a contract.
 */
export type ParentHandleFromContract<C extends PanelContract> = C extends PanelContract<infer _ChildMethods, infer ChildEmits, infer ParentMethods, infer ParentEmits> ? ParentHandle<ParentMethods, InferEventMap<ParentEmits>, InferEventMap<ChildEmits>> : never;
/**
 * A node in the workspace tree.
 * Folders contain children, git repos are leaves (children = []).
 */
export interface WorkspaceNode {
    /** Directory/repo name */
    name: string;
    /**
     * Relative path from workspace root using forward slashes.
     * Example: "panels/editor"
     */
    path: string;
    /** True if this directory is a git repository root */
    isGitRepo: boolean;
    /**
     * If this is a launchable panel/worker (has natstack config).
     * Note: We intentionally include entries even if some fields are missing
     * (e.g., no title) - better to show them in the UI and let panelBuilder
     * report the real error than to silently hide repos with incomplete configs.
     */
    launchable?: {
        type: "app";
        title: string;
    };
    /**
     * Package metadata if this repo has a package.json with a name.
     */
    packageInfo?: {
        name: string;
        version?: string;
    };
    /**
     * Skill metadata if this repo has a SKILL.md file with YAML frontmatter.
     * Skills are repos that provide instructions/context for agents.
     */
    skillInfo?: {
        name: string;
        description: string;
    };
    /** Child nodes (empty for git repos since they're leaves) */
    children: WorkspaceNode[];
}
/**
 * Complete workspace tree with root-level children.
 */
export interface WorkspaceTree {
    /** Root children (top-level directories) */
    children: WorkspaceNode[];
}
/**
 * Branch info for a git repository.
 */
export interface BranchInfo {
    name: string;
    current: boolean;
    remote?: string;
}
/**
 * Commit info for git log.
 */
export interface CommitInfo {
    oid: string;
    message: string;
    author: {
        name: string;
        timestamp: number;
    };
}
//# sourceMappingURL=types.d.ts.map