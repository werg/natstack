/**
 * Complete type definitions for @natstack/runtime.
 *
 * These definitions provide accurate types for the type checker, enabling
 * proper IntelliSense and error checking for panel/worker code.
 */

import { FS_INTERFACES } from "./shared-types.js";

// Build the runtime types using the shared fs interfaces
export const NATSTACK_RUNTIME_TYPES = `
declare module "@natstack/runtime" {
  import type { z, ZodType } from "zod";

  // ============================================================================
  // Core Identifiers
  // ============================================================================

  /** Unique identifier for this panel/worker */
  export const id: string;

  /** Storage partition identifier (determines OPFS/SQLite isolation) */
  export const contextId: string;

  /** Parent panel ID, null if this is the root shell */
  export const parentId: string | null;

  // ============================================================================
  // RPC Bridge
  // ============================================================================

  /** IPC bridge for cross-process communication */
  export const rpc: RpcBridge;

  interface RpcBridge {
    call<T = unknown>(targetId: string, method: string, ...args: unknown[]): Promise<T>;
    on(event: string, handler: (...args: unknown[]) => void): () => void;
    off(event: string, handler: (...args: unknown[]) => void): void;
  }

  // ============================================================================
  // Filesystem (shared interfaces from shared-types.ts)
  // ============================================================================
${FS_INTERFACES}

  /** Async filesystem (Node.js in unsafe mode, ZenFS/OPFS in safe mode) */
  export const fs: RuntimeFs;

  /** Promise that resolves when async filesystem is ready */
  export const fsReady: Promise<void>;

  // ============================================================================
  // Database
  // ============================================================================

  interface DbRunResult {
    changes: number;
    lastInsertRowid: number | bigint;
  }

  interface Database {
    query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
    run(sql: string, params?: unknown[]): Promise<DbRunResult>;
    get<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T | null>;
    exec(sql: string): Promise<void>;
    close(): Promise<void>;
  }

  /** SQLite database access */
  export const db: {
    open(name: string, readOnly?: boolean): Promise<Database>;
  };

  // ============================================================================
  // Parent/Child Communication
  // ============================================================================

  type AnyFunction = (...args: any[]) => any;
  type ExposedMethods = Record<string, AnyFunction>;
  type RpcEventMap = Record<string, any>;

  type TypedCallProxy<T extends ExposedMethods> = {
    [K in keyof T]: T[K] extends (...args: infer A) => infer R
      ? (...args: A) => Promise<Awaited<R>>
      : never;
  };

  interface ParentHandle<
    T extends ExposedMethods = ExposedMethods,
    E extends RpcEventMap = RpcEventMap,
    EmitE extends RpcEventMap = RpcEventMap
  > {
    id: string;
    call: TypedCallProxy<T>;
    emit<EventName extends keyof EmitE>(event: EventName, payload: EmitE[EventName]): Promise<void>;
    emit(event: string, payload: unknown): Promise<void>;
    onEvent<EventName extends keyof E>(event: EventName, listener: (payload: E[EventName]) => void): () => void;
    onEvent(event: string, listener: (payload: unknown) => void): () => void;
  }

  interface ChildHandle<
    T extends ExposedMethods = ExposedMethods,
    E extends RpcEventMap = RpcEventMap,
    EmitE extends RpcEventMap = RpcEventMap
  > {
    id: string;
    type: "app" | "worker" | "browser";
    name: string;
    title: string;
    source: string;
    call: TypedCallProxy<T>;
    emit<EventName extends keyof EmitE>(event: EventName, payload: EmitE[EventName]): Promise<void>;
    emit(event: string, payload: unknown): Promise<void>;
    onEvent<EventName extends keyof E>(event: EventName, listener: (payload: E[EventName]) => void): () => void;
    onEvent(event: string, listener: (payload: unknown) => void): () => void;
    onEvents(listeners: Partial<{ [K in keyof E]: (payload: E[K]) => void }>): () => void;
    getCdpEndpoint(): Promise<string>;
    // Navigation methods (navigate/reload/stop are browser-only)
    navigate(url: string): Promise<void>;
    goBack(): Promise<void>;
    goForward(): Promise<void>;
    reload(): Promise<void>;
    stop(): Promise<void>;
  }

  interface EphemeralChildHandle<
    T extends ExposedMethods = ExposedMethods,
    E extends RpcEventMap = RpcEventMap,
    EmitE extends RpcEventMap = RpcEventMap
  > extends ChildHandle<T, E, EmitE> {
    close(): Promise<void>;
  }

  /** Handle to the parent panel */
  export const parent: ParentHandle;

  /** Get parent handle with specific types */
  export function getParent<
    T extends ExposedMethods = ExposedMethods,
    E extends RpcEventMap = RpcEventMap,
    EmitE extends RpcEventMap = RpcEventMap
  >(): ParentHandle<T, E, EmitE> | null;

  /** No-op parent handle for null-safe usage */
  export const noopParent: ParentHandle;

  /** Map of all active child panels/workers */
  export const children: ReadonlyMap<string, ChildHandle>;

  /** Get a specific child by name */
  export function getChild<
    T extends ExposedMethods = ExposedMethods,
    E extends RpcEventMap = RpcEventMap
  >(name: string): ChildHandle<T, E> | undefined;

  interface RepoArgSpec {
    type: "string";
    default?: string;
    description?: string;
  }

  type EventSchemaMap = Record<string, ZodType>;

  interface CreateChildOptions {
    name?: string;
    env?: Record<string, string>;
    gitRef?: string;
    repoArgs?: Record<string, RepoArgSpec>;
    unsafe?: boolean | string;
    sourcemap?: boolean;
    eventSchemas?: EventSchemaMap;
    contextId?: string;
    newContext?: boolean;
    ephemeral?: boolean;
  }

  /** Create a new child panel/worker */
  export function createChild<
    T extends ExposedMethods = ExposedMethods,
    E extends RpcEventMap = RpcEventMap,
    EmitE extends RpcEventMap = RpcEventMap
  >(source: string, options?: CreateChildOptions): Promise<ChildHandle<T, E, EmitE>>;

  /** Create a browser child panel */
  export function createBrowserChild<
    T extends ExposedMethods = ExposedMethods,
    E extends RpcEventMap = RpcEventMap,
    EmitE extends RpcEventMap = RpcEventMap
  >(url: string): Promise<ChildHandle<T, E, EmitE>>;

  /** Listen for child addition */
  export function onChildAdded(callback: (name: string, handle: ChildHandle) => void): () => void;

  /** Listen for child removal */
  export function onChildRemoved(callback: (name: string) => void): () => void;

  // ============================================================================
  // Expose Methods
  // ============================================================================

  /** Expose RPC methods to parent/children */
  export function expose<T extends ExposedMethods>(methods: T): void;

  // ============================================================================
  // Panel Info & Theme
  // ============================================================================

  type ThemeAppearance = "light" | "dark";

  interface EndpointInfo {
    panelId: string;
    partition: string;
    contextId: string;
  }

  /** Set the panel title */
  export function setTitle(title: string): Promise<void>;

  /** Get panel information */
  export function getInfo(): Promise<EndpointInfo>;

  /** Get current theme */
  export function getTheme(): ThemeAppearance;

  /** Listen for theme changes */
  export function onThemeChange(callback: (theme: ThemeAppearance) => void): () => void;

  /** Listen for focus events */
  export function onFocus(callback: () => void): () => void;

  /** Listen for child creation errors */
  export function onChildCreationError(callback: (error: { url: string; error: string }) => void): () => void;

  // ============================================================================
  // Git Configuration
  // ============================================================================

  interface GitConfig {
    serverUrl: string;
    token: string;
    sourceRepo: string;
    branch?: string;
    commit?: string;
    tag?: string;
    resolvedRepoArgs: Record<string, RepoArgSpec>;
  }

  /** Git configuration for this panel/worker */
  export const gitConfig: GitConfig | null;

  // ============================================================================
  // PubSub Configuration
  // ============================================================================

  interface PubSubConfig {
    serverUrl: string;
    token: string;
  }

  /** WebSocket PubSub configuration */
  export const pubsubConfig: PubSubConfig | null;

  // ============================================================================
  // Bootstrap
  // ============================================================================

  interface BootstrapResult {
    success: boolean;
  }

  /** Promise that resolves when bootstrap completes */
  export const bootstrapPromise: Promise<BootstrapResult | null>;

  // ============================================================================
  // Utilities
  // ============================================================================

  /** Encode data to base64 */
  export function encodeBase64(data: string | Uint8Array): string;

  /** Decode base64 to bytes */
  export function decodeBase64(encoded: string): Uint8Array;

  /** Re-export of Zod library */
  export { z } from "zod";

  // ============================================================================
  // Context Utilities
  // ============================================================================

  type ContextMode = "safe" | "unsafe";
  type ContextType = "auto" | "named";

  interface ParsedContextId {
    mode: ContextMode;
    type: ContextType;
    identifier: string;
  }

  export function parseContextId(contextId: string): ParsedContextId | null;
  export function isValidContextId(contextId: string): boolean;
  export function isSafeContext(contextId: string): boolean;
  export function isUnsafeContext(contextId: string): boolean;
  export function isAutoContext(contextId: string): boolean;
  export function isNamedContext(contextId: string): boolean;

  // ============================================================================
  // Form Schema Utilities
  // ============================================================================

  type PrimitiveFieldValue = string | number | boolean;
  type FieldValue = PrimitiveFieldValue | string[];
  type FieldType = "string" | "number" | "boolean" | "select" | "slider" | "segmented" | "toggle" | "readonly" | "code" | "buttonGroup" | "multiSelect" | "diff";
  type ConditionOperator = "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "in";

  interface FieldCondition {
    field: string;
    operator: ConditionOperator;
    value: PrimitiveFieldValue | PrimitiveFieldValue[];
  }

  interface FieldOption {
    value: string;
    label: string;
    description?: string;
  }

  interface FieldWarning {
    when: PrimitiveFieldValue | PrimitiveFieldValue[];
    message: string;
    severity?: "info" | "warning" | "danger";
  }

  interface FieldDefinition {
    key: string;
    label: string;
    description?: string;
    type: FieldType;
    required?: boolean;
    default?: FieldValue;
    options?: FieldOption[];
    conditions?: { visible?: FieldCondition; enabled?: FieldCondition };
    warnings?: FieldWarning[];
    group?: string;
  }

  export function evaluateCondition(value: unknown, condition: FieldCondition): boolean;
  export function isFieldVisible(field: FieldDefinition, values: Record<string, FieldValue>): boolean;
  export function isFieldEnabled(field: FieldDefinition, values: Record<string, FieldValue>): boolean;
  export function getFieldWarning(field: FieldDefinition, value: FieldValue): FieldWarning | null;
  export function groupFields(fields: FieldDefinition[]): Map<string, FieldDefinition[]>;
  export function getFieldDefaults(fields: FieldDefinition[]): Record<string, FieldValue>;

  // ============================================================================
  // Contract System
  // ============================================================================

  type InferEventMap<T extends EventSchemaMap> = {
    [K in keyof T]: T[K] extends ZodType<infer U> ? U : never;
  };

  interface ContractSide<Methods extends ExposedMethods, Emits extends EventSchemaMap> {
    methods?: Methods;
    emits?: Emits;
  }

  interface PanelContract<
    ChildMethods extends ExposedMethods,
    ChildEmits extends EventSchemaMap,
    ParentMethods extends ExposedMethods,
    ParentEmits extends EventSchemaMap
  > {
    source: string;
    child?: ContractSide<ChildMethods, ChildEmits>;
    parent?: ContractSide<ParentMethods, ParentEmits>;
  }

  /** Define a panel contract for typed parent/child communication */
  export function defineContract<
    ChildMethods extends ExposedMethods = {},
    ChildEmits extends EventSchemaMap = {},
    ParentMethods extends ExposedMethods = {},
    ParentEmits extends EventSchemaMap = {}
  >(contract: PanelContract<ChildMethods, ChildEmits, ParentMethods, ParentEmits>): PanelContract<ChildMethods, ChildEmits, ParentMethods, ParentEmits>;

  /** Get parent handle typed by contract */
  export function getParentWithContract<C extends PanelContract<any, any, any, any>>(
    contract: C
  ): ParentHandle | null;

  /** Create child typed by contract */
  export function createChildWithContract<C extends PanelContract<any, any, any, any>>(
    contract: C,
    options?: { name?: string; env?: Record<string, string> }
  ): Promise<ChildHandle>;

  // ============================================================================
  // Navigation Link Builders
  // ============================================================================

  type NsAction = "navigate" | "child";
  type AboutPage = "about" | "help" | "keyboard-shortcuts" | "model-provider-config";

  interface BuildNsLinkOptions {
    action?: NsAction;
    gitRef?: string;
    context?: string;
    repoArgs?: Record<string, RepoArgSpec | string | { repo: string; ref: string }>;
    ephemeral?: boolean;
  }

  /** Build ns:// URLs for panel navigation */
  export function buildNsLink(source: string, options?: BuildNsLinkOptions): string;

  /** Build ns-about:// URLs for shell pages */
  export function buildAboutLink(page: AboutPage): string;

  /** Build ns-focus:// URLs for focusing panels */
  export function buildFocusLink(panelId: string): string;

  // ============================================================================
  // RPC Namespace Types
  // ============================================================================

  export namespace Rpc {
    type SchemaType = "string" | "number" | "boolean" | "object" | "array" | "any" | "void";

    interface MethodSchema {
      params: SchemaType[];
      returns: SchemaType;
    }

    interface PanelRpcSchema {
      methods: Record<string, MethodSchema>;
      events?: string[];
    }

    interface PanelRpcRequest {
      type: "request";
      id: string;
      method: string;
      args: unknown[];
    }

    interface PanelRpcResponse {
      type: "response";
      id: string;
      result?: unknown;
      error?: string;
    }

    interface PanelRpcEvent {
      type: "event";
      event: string;
      payload: unknown;
    }

    type PanelRpcMessage = PanelRpcRequest | PanelRpcResponse | PanelRpcEvent;
  }
}
`;
