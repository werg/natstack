/**
 * Core type definitions for NatStack runtime
 * Shared types for panels and workers
 */

import type { ZodType } from "zod";
import type * as Rpc from "./rpc.js";

// Re-export RepoArgSpec from @natstack/git (canonical source for git-related types)
import type { RepoArgSpec } from "@natstack/git";
export type { RepoArgSpec };

// =============================================================================
// Event Schema Types (zod-based validation)
// =============================================================================

/**
 * A map of event names to their zod schemas.
 * Used for runtime validation of event payloads.
 *
 * @example
 * ```ts
 * import { z, type EventSchemaMap } from "@natstack/runtime";
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
 * import { z, type InferEventMap } from "@natstack/runtime";
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

// =============================================================================
// Child Spec Types (spec-based API for createChild)
// =============================================================================

/**
 * Base fields shared by all child spec types.
 * Extended by AppChildSpec, WorkerChildSpec, and BrowserChildSpec.
 */
interface ChildSpecBase {
  /** Optional name for this child (becomes part of the panel ID). If omitted, a random ID is generated. */
  name?: string;
  /** Environment variables to pass to the child */
  env?: Record<string, string>;
  /** Source: workspace-relative path for app/worker, URL for browser */
  source: string;
  /**
   * Optional zod schemas for validating event payloads from this child.
   * When provided, incoming events are validated before being passed to listeners.
   * Invalid payloads will log an error and not trigger the listener.
   *
   * @example
   * ```ts
   * import { z } from "@natstack/runtime";
   *
   * const child = await panel.createChild({
   *   type: "app",
   *   source: "panels/editor",
   *   eventSchemas: {
   *     "saved": z.object({ path: z.string() }),
   *     "error": z.object({ message: z.string() }),
   *   },
   * });
   * ```
   */
  eventSchemas?: EventSchemaMap;
}

/**
 * Common fields shared by all child spec types.
 * Used as a type constraint for generic child handling.
 * This is the intersection of all child spec types' common fields.
 */
export interface ChildSpecCommon extends ChildSpecBase {
  /** Child type discriminator */
  type: "app" | "worker" | "browser";
}

/**
 * Git-related fields for app and worker specs.
 */
interface GitVersionFields {
  /** Branch name to track */
  branch?: string;
  /** Specific commit hash to pin to */
  commit?: string;
  /** Tag to pin to */
  tag?: string;
}

/**
 * Spec for creating an app panel child.
 * Name is optional - if omitted, a random ID is generated.
 * Singleton panels (singletonState: true in manifest) cannot have a name override.
 */
export interface AppChildSpec extends ChildSpecBase, GitVersionFields {
  type: "app";
  /** Emit inline sourcemaps (default: true). Set to false to omit sourcemaps. */
  sourcemap?: boolean;
  /**
   * Repo arguments required by the target panel's manifest.
   * Keys must match the `repoArgs` array in the manifest.
   *
   * @example
   * ```ts
   * repoArgs: {
   *   history: "repos/history#main",           // shorthand
   *   components: { repo: "repos/ui", ref: "v1.0.0" }  // object
   * }
   * ```
   */
  repoArgs?: Record<string, RepoArgSpec>;
}

/**
 * Spec for creating a worker child.
 * Name is optional - if omitted, a random ID is generated.
 */
export interface WorkerChildSpec extends ChildSpecBase, GitVersionFields {
  type: "worker";
  /** Memory limit in MB (default: 1024) */
  memoryLimitMB?: number;
  /**
   * Run worker with full Node.js API access instead of sandboxed vm.Context.
   * Unsafe workers can use require(), process, child_process, etc.
   * Note: `import "fs"` still uses the scoped filesystem via the build-time shim.
   */
  unsafe?: boolean;
  /**
   * Repo arguments required by the target worker's manifest.
   * Keys must match the `repoArgs` array in the manifest.
   */
  repoArgs?: Record<string, RepoArgSpec>;
}

/**
 * Spec for creating a browser panel child.
 * Name is optional - if omitted, a random ID is generated.
 */
export interface BrowserChildSpec extends ChildSpecBase {
  type: "browser";
  /** Optional title (defaults to URL hostname) */
  title?: string;
}

/**
 * Union type for createChild spec parameter.
 */
export type ChildSpec = AppChildSpec | WorkerChildSpec | BrowserChildSpec;

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
  /** Optional branch override */
  branch?: string;
  /** Optional commit pin */
  commit?: string;
  /** Optional tag pin */
  tag?: string;
  /** Resolved repo args (name -> spec) provided by parent at createChild time */
  resolvedRepoArgs: Record<string, RepoArgSpec>;
}

/**
 * PubSub configuration for a panel or worker.
 */
export interface PubSubConfig {
  /** WebSocket server URL (e.g., ws://127.0.0.1:49452) */
  serverUrl: string;
  /** Bearer token for authentication */
  token: string;
}

/**
 * Information about a panel or worker.
 */
export interface EndpointInfo {
  /** The endpoint's unique ID */
  panelId: string;
  /** Storage partition name (for isolated storage) */
  partition: string;
}

// =============================================================================
// ChildHandle Types (unified handle for child management)
// =============================================================================

/**
 * Proxy type for typed RPC calls.
 * Transforms ExposedMethods into callable async functions.
 */
export type TypedCallProxy<T extends Rpc.ExposedMethods> = {
  [K in keyof T]: T[K] extends (...args: infer A) => infer R
    ? (...args: A) => Promise<Awaited<R>>
    : never;
};

/**
 * Unified handle for interacting with any child (app, worker, browser).
 *
 * @typeParam T - RPC methods exposed by the child (inferred or explicit)
 * @typeParam E - RPC event map for events from child (what parent receives)
 * @typeParam EmitE - RPC event map for events to child (what parent sends)
 */
export interface ChildHandle<
  T extends Rpc.ExposedMethods = Rpc.ExposedMethods,
  E extends Rpc.RpcEventMap = Rpc.RpcEventMap,
  EmitE extends Rpc.RpcEventMap = Rpc.RpcEventMap
> {
  /** Unique child ID (used internally for IPC) */
  readonly id: string;

  /** Child type discriminator */
  readonly type: "app" | "worker" | "browser";

  /** Name provided at creation (unique within parent) */
  readonly name: string;

  /** Display title */
  readonly title: string;

  /** Source: panel path for app/worker, URL for browser */
  readonly source: string;

  // === Lifecycle ===

  /** Remove this child from parent */
  close(): Promise<void>;

  // === RPC ===

  /**
   * Typed RPC call proxy. Methods are inferred from T.
   * @example handle.call.doSomething(arg1, arg2)
   */
  readonly call: TypedCallProxy<T>;

  /**
   * Emit a typed event to this child.
   * @example handle.emit("theme-changed", { theme: "dark" })
   */
  emit<EventName extends Extract<keyof EmitE, string>>(
    event: EventName,
    payload: EmitE[EventName]
  ): Promise<void>;

  /**
   * Emit an event to this child (untyped fallback).
   * @example handle.emit("dataUpdated", { items: [...] })
   */
  emit(event: string, payload: unknown): Promise<void>;

  /**
   * Listen for events from this child (typed if event map provided).
   * @returns Unsubscribe function
   */
  onEvent<EventName extends Extract<keyof E, string>>(
    event: EventName,
    listener: (payload: E[EventName]) => void
  ): () => void;

  /**
   * Listen for events from this child (untyped fallback).
   * @returns Unsubscribe function
   */
  onEvent(event: string, listener: (payload: unknown) => void): () => void;

  /**
   * Listen for multiple events from this child.
   * Returns a single cleanup function that unsubscribes all listeners.
   */
  onEvents(listeners: Partial<{ [EventName in Extract<keyof E, string>]: (payload: E[EventName]) => void }>): () => void;
  onEvents(listeners: Record<string, (payload: unknown) => void>): () => void;

  // === Automation ===

  /**
   * Get CDP WebSocket endpoint for Playwright automation.
   * Available for app and browser children (not workers).
   */
  getCdpEndpoint(): Promise<string>;

  // === Browser-specific (only meaningful for type: "browser") ===

  /** Navigate to URL (browser only) */
  navigate(url: string): Promise<void>;

  /** Go back in history (browser only) */
  goBack(): Promise<void>;

  /** Go forward in history (browser only) */
  goForward(): Promise<void>;

  /** Reload page (browser only) */
  reload(): Promise<void>;

  /** Stop loading (browser only) */
  stop(): Promise<void>;
}

/**
 * Callback for child lifecycle events.
 */
export type ChildAddedCallback<T extends Rpc.ExposedMethods = Rpc.ExposedMethods> = (
  name: string,
  handle: ChildHandle<T>
) => void;

export type ChildRemovedCallback = (name: string, childId: string) => void;

// =============================================================================
// ParentHandle Types (for child→parent communication)
// =============================================================================

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
export interface ParentHandle<
  T extends Rpc.ExposedMethods = Rpc.ExposedMethods,
  E extends Rpc.RpcEventMap = Rpc.RpcEventMap,
  EmitE extends Rpc.RpcEventMap = Rpc.RpcEventMap
> {
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
  emit<EventName extends Extract<keyof EmitE, string>>(
    event: EventName,
    payload: EmitE[EventName]
  ): Promise<void>;

  /**
   * Emit an event to the parent (untyped fallback).
   * @example parent.emit("status", { ready: true })
   */
  emit(event: string, payload: unknown): Promise<void>;

  /**
   * Listen for events from the parent (typed if event map provided).
   * @returns Unsubscribe function
   */
  onEvent<EventName extends Extract<keyof E, string>>(
    event: EventName,
    listener: (payload: E[EventName]) => void
  ): () => void;

  /**
   * Listen for events from the parent (untyped fallback).
   * @returns Unsubscribe function
   */
  onEvent(event: string, listener: (payload: unknown) => void): () => void;
}

// =============================================================================
// Panel Contract Types (unified parent-child interface definition)
// =============================================================================

/**
 * Definition for one side of the parent-child relationship.
 * Specifies what methods are exposed and what events are emitted.
 */
export interface ContractSide<
  Methods extends Rpc.ExposedMethods = Rpc.ExposedMethods,
  Emits extends EventSchemaMap = EventSchemaMap
> {
  /** RPC methods exposed by this side (use interface for typing, phantom at runtime) */
  readonly methods?: Methods;
  /** Events emitted by this side (zod schemas for validation) */
  readonly emits?: Emits;
}

/**
 * A contract defining the interface between parent and child panels.
 * Both parent and child import this same contract object.
 *
 * - Parent uses it with `panel.createChild(contract, options)` to get a typed ChildHandle
 * - Child uses it with `panel.getParent(contract)` to get a typed ParentHandle
 *
 * @typeParam ChildMethods - RPC methods the child exposes
 * @typeParam ChildEmits - Events the child emits (parent receives)
 * @typeParam ParentMethods - RPC methods the parent exposes
 * @typeParam ParentEmits - Events the parent emits (child receives)
 *
 * @example
 * ```ts
 * import { z, defineContract } from "@natstack/runtime";
 *
 * // Define interfaces for RPC methods
 * interface EditorMethods {
 *   openFile(path: string): Promise<void>;
 *   save(): Promise<void>;
 * }
 *
 * // Create the contract
 * export const editorContract = defineContract({
 *   source: "panels/editor",
 *   child: {
 *     methods: {} as EditorMethods,
 *     emits: {
 *       "saved": z.object({ path: z.string() }),
 *       "dirty": z.object({ isDirty: z.boolean() }),
 *     },
 *   },
 *   parent: {
 *     emits: {
 *       "theme-changed": z.object({ theme: z.enum(["light", "dark"]) }),
 *     },
 *   },
 * });
 * ```
 */
export interface PanelContract<
  ChildMethods extends Rpc.ExposedMethods = Rpc.ExposedMethods,
  ChildEmits extends EventSchemaMap = EventSchemaMap,
  ParentMethods extends Rpc.ExposedMethods = Rpc.ExposedMethods,
  ParentEmits extends EventSchemaMap = EventSchemaMap
> {
  /** Workspace-relative path to the child panel source */
  readonly source: string;

  /** Child's side of the contract */
  readonly child?: ContractSide<ChildMethods, ChildEmits>;

  /** Parent's side of the contract */
  readonly parent?: ContractSide<ParentMethods, ParentEmits>;

  /** Internal marker for type inference */
  readonly __brand?: "PanelContract";
}

/**
 * Extract the ChildHandle type from a contract.
 * Used internally by createChild when given a contract.
 */
export type ChildHandleFromContract<C extends PanelContract> =
  C extends PanelContract<infer ChildMethods, infer ChildEmits, infer _ParentMethods, infer ParentEmits>
    ? ChildHandle<ChildMethods, InferEventMap<ChildEmits>, InferEventMap<ParentEmits>>
    : never;

/**
 * Extract the ParentHandle type from a contract.
 * Used internally by getParent when given a contract.
 */
export type ParentHandleFromContract<C extends PanelContract> =
  C extends PanelContract<infer _ChildMethods, infer ChildEmits, infer ParentMethods, infer ParentEmits>
    ? ParentHandle<ParentMethods, InferEventMap<ParentEmits>, InferEventMap<ChildEmits>>
    : never;
