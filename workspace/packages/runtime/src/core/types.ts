/**
 * Core type definitions for NatStack runtime
 * Shared types for panels and workers
 */

import type { ZodType } from "zod";
import type * as Rpc from "./rpc.js";
import type { PanelLifecycleResult } from "@natstack/shared/types";

// =============================================================================
// Event Schema Types (zod-based validation)
// =============================================================================

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
  /**
   * Git server base URL (e.g., http://localhost:63524).
   * Prefer `git.client()` from `@workspace/runtime` for userland git
   * operations; it applies the correct internal/external HTTP routing.
   */
  serverUrl: string;
  /** Additional NatStack gateway URLs that should use the internal bearer token. */
  internalOrigins?: readonly string[];
  /** Bearer token for authentication */
  token: string;
  /** This endpoint's source repo path (e.g., "panels/my-panel") */
  sourceRepo: string;
  /** Optional git ref (branch/tag/commit) to check out */
  gitRef?: string;
}

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

// =============================================================================
// RPC Proxy Types
// =============================================================================

/**
 * Proxy type for typed RPC calls.
 * Transforms ExposedMethods into callable async functions.
 */
export type TypedCallProxy<T extends Record<string, Rpc.AnyFunction>> = {
  [K in keyof T]: T[K] extends (...args: infer A) => infer R
    ? (...args: A) => Promise<Awaited<R>>
    : never;
};

// =============================================================================
// Unified PanelHandle Types
// =============================================================================

export interface CdpEndpoint {
  wsEndpoint: string;
  token?: string;
}

export type PanelConsoleHistoryLevel = "debug" | "info" | "warning" | "error" | "unknown";

export interface PanelConsoleHistoryEntry {
  timestamp: number;
  level: PanelConsoleHistoryLevel;
  message: string;
  line: number;
  sourceId: string;
  url: string;
  /** "lifecycle" marks host-recorded events (crash/unresponsive/did-fail-load). */
  source?: "console" | "lifecycle";
  fields?: Record<string, unknown>;
}

export interface PanelConsoleHistoryOptions {
  limit?: number;
  errorLimit?: number;
  levels?: PanelConsoleHistoryLevel[];
}

export interface PanelConsoleHistoryResult {
  entries: PanelConsoleHistoryEntry[];
  errors: PanelConsoleHistoryEntry[];
  dropped: {
    entries: number;
    errors: number;
  };
  capacity: {
    entries: number;
    errors: number;
  };
}

export interface PanelDiagnosticsResult {
  info: {
    id: string;
    title: string;
    source: string;
    kind: "workspace" | "browser";
    parentId: string | null;
  };
  consoleHistory: PanelConsoleHistoryResult;
}

export interface CdpAutomation {
  /** Explicit lightweight @workspace/cdp-client page. */
  lightweightPage(): Promise<any>;
  /**
   * Historical console messages captured by the Electron host from panel
   * creation time. This is separate from live CDP console events.
   */
  consoleHistory(options?: PanelConsoleHistoryOptions): Promise<PanelConsoleHistoryResult>;
  getCdpEndpoint(): Promise<CdpEndpoint>;
  navigate(url: string): Promise<void>;
  goBack(): Promise<void>;
  goForward(): Promise<void>;
  reload(): Promise<void>;
  stop(): Promise<void>;
  click(selector: string): Promise<void>;
  screenshot(options?: unknown): Promise<unknown>;
}

export type PanelHandleContractRole = "parent" | "child";

/**
 * Unified handle for communicating with any panel-tree member.
 * Parent helpers return this same handle type.
 *
 * @typeParam T - RPC methods exposed by the target (what this caller can call)
 * @typeParam E - RPC event map for events from the target (what this caller can listen to)
 * @typeParam EmitE - RPC event map for events to the target (what this caller emits)
 *
 * @example
 * ```ts
 * // For full type safety, prefer getParentWithContract():
 * import { myContract } from "./contract.js";
 * const parent = getParentWithContract(myContract);
 * if (parent) {
 *   await parent.emit("saved", { path: "/foo.txt" }); // Typed from contract!
 * }
 *
 * // Or use direct type parameters:
 * interface MyEmitEvents { saved: { path: string } }
 * const parent = getParent<{}, {}, MyEmitEvents>();
 * parent?.emit("saved", { path: "/foo.txt" }); // Typed!
 * ```
 */
export interface PanelHandle<
  T extends Record<string, Rpc.AnyFunction> = Rpc.ExposedMethods,
  E extends Rpc.RpcEventMap = Rpc.RpcEventMap,
  EmitE extends Rpc.RpcEventMap = Rpc.RpcEventMap,
> {
  /** Panel's unique slot/runtime target ID. */
  readonly id: string;
  /** Last known title. Bare handles use the id until refresh/list hydrates them. */
  readonly title: string;
  /** Last known source. Browser URLs are exposed without the internal browser: prefix. */
  readonly source: string;
  readonly kind: "workspace" | "browser";
  readonly parentId: string | null;

  /** Current handle metadata. Refresh first when you need the latest host view. */
  getInfo(): Promise<{
    id: string;
    title: string;
    source: string;
    kind: "workspace" | "browser";
    parentId: string | null;
    contextId: string | null;
    runtimeEntityId: string | null;
    effectiveVersion: string | null;
    ref?: string;
    build: {
      effectiveVersion: string | null;
      ref?: string;
    };
  }>;

  /**
   * Typed RPC call proxy for methods the target chose to expose.
   * @example handle.call.notifyReady()
   */
  readonly call: TypedCallProxy<T>;

  /** Chrome DevTools Protocol automation for this panel. */
  readonly cdp: CdpAutomation;

  /**
   * Convenience wrapper for `handle.cdp.click(selector)`.
   * Useful when the handle itself is the target panel being automated.
   */
  click(selector: string): Promise<void>;

  readonly stateArgs: {
    get<TState = Record<string, unknown>>(): Promise<TState>;
    set(updates: Record<string, unknown>): Promise<void>;
  };

  /**
   * Emit a typed event to the target.
   * @example handle.emit("saved", { path: "/foo.txt" })
   */
  emit<EventName extends Extract<keyof EmitE, string>>(
    event: EventName,
    payload: EmitE[EventName]
  ): Promise<void>;

  /**
   * Emit an event to the target panel (untyped fallback).
   * @example handle.emit("status", { ready: true })
   */
  emit(event: string, payload: unknown): Promise<void>;

  /**
   * Listen for events from the target panel (typed if event map provided).
   * @returns Unsubscribe function
   */
  on<EventName extends Extract<keyof E, string>>(
    event: EventName,
    listener: (payload: E[EventName]) => void
  ): () => void;

  /**
   * Listen for events from the target panel (untyped fallback).
   * @returns Unsubscribe function
   */
  on(event: string, listener: (payload: unknown) => void): () => void;

  withContract<C extends PanelContract, Role extends PanelHandleContractRole>(
    contract: C,
    role: Role
  ): PanelHandleFromContract<C, Role>;

  refresh(): Promise<PanelHandle<T, E, EmitE>>;
  children(): Promise<PanelHandle[]>;
  parent(): PanelHandle | null;
  ensureLoaded(): Promise<unknown>;
  isLoaded(): Promise<boolean>;
  reload(): Promise<PanelLifecycleResult>;
  close(): Promise<PanelLifecycleResult>;

  /** Bounded post-mortem diagnostics for this panel target. */
  diagnostics(options?: PanelConsoleHistoryOptions): Promise<PanelDiagnosticsResult>;
  archive(): Promise<void>;
  unload(): Promise<PanelLifecycleResult>;
  movePanel(newParentId: string | null, targetPosition: number): Promise<void>;
  takeOver(): Promise<void>;
  openDevTools(mode?: "detach" | "right" | "bottom"): Promise<void>;
  rebuildPanel(): Promise<PanelLifecycleResult>;
  rebuildAndReload(): Promise<PanelLifecycleResult>;
  updatePanelState(state: Record<string, unknown>): Promise<void>;
  focus(): Promise<unknown>;
  snapshot(): Promise<unknown>;
  tree(): Promise<unknown>;
  state(): Promise<unknown>;
  routes(): Promise<unknown>;
  setMode(mode: "fixture" | "live"): Promise<unknown>;
}

// =============================================================================
// Contract Types (for typed parent↔child communication)
// =============================================================================

/**
 * One side of a panel contract (child or parent).
 */
export interface ContractSide<
  Methods extends Record<string, Rpc.AnyFunction> = Rpc.ExposedMethods,
  Emits extends EventSchemaMap = EventSchemaMap,
> {
  readonly methods?: Methods;
  readonly emits?: Emits;
}

/**
 * A typed contract between a parent and child panel.
 * Defines RPC methods and events for both sides.
 */
export interface PanelContract<
  ChildMethods extends Record<string, Rpc.AnyFunction> = Rpc.ExposedMethods,
  ChildEmits extends EventSchemaMap = EventSchemaMap,
  ParentMethods extends Record<string, Rpc.AnyFunction> = Rpc.ExposedMethods,
  ParentEmits extends EventSchemaMap = EventSchemaMap,
> {
  readonly source: string;
  readonly child?: ContractSide<ChildMethods, ChildEmits>;
  readonly parent?: ContractSide<ParentMethods, ParentEmits>;
  readonly __brand?: "PanelContract";
}

/**
 * Extract a typed PanelHandle from a contract for one side of the relationship.
 */
export type PanelHandleFromContract<C extends PanelContract, Role extends PanelHandleContractRole> =
  C extends PanelContract<
    infer _ChildMethods,
    infer ChildEmits,
    infer ParentMethods,
    infer ParentEmits
  >
    ? Role extends "parent"
      ? PanelHandle<ParentMethods, InferEventMap<ParentEmits>, InferEventMap<ChildEmits>>
      : PanelHandle<_ChildMethods, InferEventMap<ChildEmits>, InferEventMap<ParentEmits>>
    : never;

// =============================================================================
// Workspace Discovery Types (for git repos and launchable panels)
// =============================================================================

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
    hidden?: boolean;
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
  author: { name: string; timestamp: number };
}
