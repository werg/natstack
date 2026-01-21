/**
 * @natstack/runtime - Unified runtime for NatStack panels, workers, and shell.
 *
 * This module detects the environment and provides the appropriate exports:
 * - Shell: Creates RPC bridge from shell transport globals
 * - Panel/Worker: Use the natstack-panel export condition instead
 *
 * For panels and workers, use the conditional export:
 * import { rpc } from "@natstack/runtime"; // Uses natstack-panel condition
 */

import { createRpcBridge, type RpcBridge, type RpcTransport, type RpcMessage } from "@natstack/rpc";
import { encodeBase64 as encodeBase64Impl, decodeBase64 as decodeBase64Impl } from "./shared/base64.js";
import { createDbClient, type Database } from "./shared/db.js";
import * as formSchema from "./shared/form-schema.js";
import * as contextUtils from "./core/context.js";
import {
  buildNsLink as buildNsLinkImpl,
  buildAboutLink as buildAboutLinkImpl,
  buildFocusLink as buildFocusLinkImpl,
} from "./core/nsLinks.js";
import { z as zImpl } from "./core/zod.js";
import { defineContract as defineContractImpl, noopParent as noopParentImpl } from "./core/defineContract.js";
import * as RpcNamespace from "./core/rpc.js";

// Re-export types
export type {
  RuntimeFs,
  FileStats,
  MkdirOptions,
  RmOptions,
  ThemeAppearance,
  BootstrapResult,
} from "./types.js";

export type { Database } from "./shared/db.js";

export type {
  CreateChildOptions,
  ChildCreationResult,
  ChildSpec,
  AppChildSpec,
  WorkerChildSpec,
  BrowserChildSpec,
  GitConfig,
  EndpointInfo,
  EventSchemaMap,
  InferEventMap,
  ChildHandle,
  ChildHandleFromContract,
  ParentHandle,
  PanelContract,
  ParentHandleFromContract,
  TypedCallProxy,
  BuildNsLinkOptions,
  NsAction,
  AboutPage,
  ContextMode,
  ContextType,
  ParsedContextId,
  EnvArgSchema,
  WorkspaceNode,
  WorkspaceTree,
  BranchInfo,
  CommitInfo,
} from "./core/index.js";

export type { Runtime } from "./setup/createRuntime.js";

// Form schema types
export type {
  PrimitiveFieldValue,
  FieldValue,
  FieldType,
  ConditionOperator,
  FieldCondition,
  FieldOption,
  SliderNotch,
  FieldWarning,
  FieldDefinition,
  FormSchema,
} from "./shared/form-schema.js";

// =============================================================================
// Shell Transport Detection and RPC Bridge Creation
// =============================================================================

// Type for the shell transport bridge from preload
type ShellTransportBridge = {
  send: (targetId: string, message: unknown) => Promise<void>;
  onMessage: (handler: (fromId: string, message: unknown) => void) => () => void;
};

// Access globals
const g = globalThis as unknown as {
  __natstackTransport?: ShellTransportBridge;
  __natstackKind?: "panel" | "worker" | "shell";
  __natstackId?: string;
  __natstackContextId?: string;
};

// Create RPC bridge for shell environment
function createShellRpcBridge(): RpcBridge | null {
  if (g.__natstackKind !== "shell" || !g.__natstackTransport) {
    return null;
  }

  const shellTransport = g.__natstackTransport;

  // Adapt shell transport to RpcTransport interface
  const transport: RpcTransport = {
    send: shellTransport.send,
    onMessage: (_sourceId: string, handler: (message: RpcMessage) => void) => {
      return shellTransport.onMessage((fromId, message) => {
        if (fromId === "main") {
          handler(message as RpcMessage);
        }
      });
    },
    onAnyMessage: (handler: (sourceId: string, message: RpcMessage) => void) => {
      return shellTransport.onMessage((fromId, message) => {
        handler(fromId, message as RpcMessage);
      });
    },
  };

  return createRpcBridge({
    selfId: g.__natstackId || "shell",
    transport,
    callTimeoutMs: 30000,
    aiCallTimeoutMs: 300000,
  });
}

// Initialize RPC bridge for shell
const shellRpc = createShellRpcBridge();

// =============================================================================
// Exports - Actual values for shell, declarations for panel/worker
// =============================================================================

// RPC bridge - actual value for shell, throws clear error if used outside shell
const rpcStub = new Proxy({} as RpcBridge, {
  get(_target, prop) {
    if (prop === "then") return undefined; // Allow Promise detection
    throw new Error(
      `rpc.${String(prop)} is not available. ` +
      `If you're in a panel/worker, use the "natstack-panel" export condition. ` +
      `If you're in shell, ensure __natstackKind is set to "shell".`
    );
  },
});
export const rpc: RpcBridge = shellRpc ?? rpcStub;

// ID and context info
export const id: string = g.__natstackId ?? "";
export const contextId: string = g.__natstackContextId ?? "";
export const parentId: string | null = null; // Shell has no parent

// Utility exports - these work in any environment
export const encodeBase64 = encodeBase64Impl;
export const decodeBase64 = decodeBase64Impl;
export const z = zImpl;
export const defineContract = defineContractImpl;
export const noopParent = noopParentImpl;
// Navigation link builders
export const buildNsLink = buildNsLinkImpl;
export const buildAboutLink = buildAboutLinkImpl;
export const buildFocusLink = buildFocusLinkImpl;

// Form schema utilities
export const evaluateCondition = formSchema.evaluateCondition;
export const isFieldVisible = formSchema.isFieldVisible;
export const isFieldEnabled = formSchema.isFieldEnabled;
export const getFieldWarning = formSchema.getFieldWarning;
export const groupFields = formSchema.groupFields;
export const getFieldDefaults = formSchema.getFieldDefaults;

// Context utilities
export const parseContextId = contextUtils.parseContextId;
export const isValidContextId = contextUtils.isValidContextId;
export const isSafeContext = contextUtils.isSafeContext;
export const isUnsafeContext = contextUtils.isUnsafeContext;
export const isAutoContext = contextUtils.isAutoContext;
export const isNamedContext = contextUtils.isNamedContext;

// Rpc namespace export
export const Rpc = RpcNamespace;
export namespace Rpc {
  export type PanelRpcRequest = RpcNamespace.PanelRpcRequest;
  export type PanelRpcResponse = RpcNamespace.PanelRpcResponse;
  export type PanelRpcEvent = RpcNamespace.PanelRpcEvent;
  export type PanelRpcMessage = RpcNamespace.PanelRpcMessage;
  export type SchemaType = RpcNamespace.SchemaType;
  export type MethodSchema = RpcNamespace.MethodSchema;
  export type PanelRpcSchema = RpcNamespace.PanelRpcSchema;
  export type PanelRpcIpcApi = RpcNamespace.PanelRpcIpcApi;
  export type AnyFunction = RpcNamespace.AnyFunction;
  export type ExposedMethods = RpcNamespace.ExposedMethods;
  export type RpcEventMap = RpcNamespace.RpcEventMap;
  export type PanelRpcHandle<
    T extends RpcNamespace.ExposedMethods = RpcNamespace.ExposedMethods,
    E extends RpcNamespace.RpcEventMap = RpcNamespace.RpcEventMap
  > = RpcNamespace.PanelRpcHandle<T, E>;
}

// =============================================================================
// Panel/Worker-only exports (stubs for shell - these need panel runtime)
// =============================================================================

// These are only functional in panel/worker environments (use natstack-panel condition)
// In shell, they throw errors if called

const notInShell = (name: string) => () => {
  throw new Error(`${name} is only available in panel/worker environments, not in shell`);
};

// Create db client for shell using the shell RPC bridge
export const db: { open(name: string, readOnly?: boolean): Promise<Database> } = shellRpc
  ? createDbClient(shellRpc)
  : { open: notInShell("db.open") as () => Promise<Database> };

// fs is only available in panels/workers via natstack-panel condition
export const fs = new Proxy({} as import("./types.js").RuntimeFs, {
  get(_target, prop) {
    throw new Error(
      `fs.${String(prop)} is only available in panel/worker environments. ` +
      `Use the "natstack-panel" export condition.`
    );
  },
});

export const parent = noopParentImpl as import("./core/index.js").ParentHandle;

export const getParent = notInShell("getParent") as <
  T extends import("./core/index.js").Rpc.ExposedMethods = import("./core/index.js").Rpc.ExposedMethods,
  E extends import("./core/index.js").Rpc.RpcEventMap = import("./core/index.js").Rpc.RpcEventMap,
  EmitE extends import("./core/index.js").Rpc.RpcEventMap = import("./core/index.js").Rpc.RpcEventMap
>() => import("./core/index.js").ParentHandle<T, E, EmitE> | null;

export const getParentWithContract = notInShell("getParentWithContract") as <
  C extends import("./core/index.js").PanelContract
>(
  contract: C
) => import("./core/index.js").ParentHandleFromContract<C> | null;

export const createChild = notInShell("createChild") as <
  T extends import("./core/index.js").Rpc.ExposedMethods = import("./core/index.js").Rpc.ExposedMethods,
  E extends import("./core/index.js").Rpc.RpcEventMap = import("./core/index.js").Rpc.RpcEventMap,
  EmitE extends import("./core/index.js").Rpc.RpcEventMap = import("./core/index.js").Rpc.RpcEventMap
>(
  source: string,
  options?: import("./core/index.js").CreateChildOptions
) => Promise<import("./core/index.js").ChildHandle<T, E, EmitE>>;

export const createBrowserChild = notInShell("createBrowserChild") as <
  T extends import("./core/index.js").Rpc.ExposedMethods = import("./core/index.js").Rpc.ExposedMethods,
  E extends import("./core/index.js").Rpc.RpcEventMap = import("./core/index.js").Rpc.RpcEventMap,
  EmitE extends import("./core/index.js").Rpc.RpcEventMap = import("./core/index.js").Rpc.RpcEventMap
>(url: string) => Promise<import("./core/index.js").ChildHandle<T, E, EmitE>>;

export const createChildWithContract = notInShell("createChildWithContract") as <
  C extends import("./core/index.js").PanelContract
>(
  contract: C,
  options?: { name?: string; env?: Record<string, string> }
) => Promise<import("./core/index.js").ChildHandleFromContract<C>>;

export const children = new Map() as ReadonlyMap<string, import("./core/index.js").ChildHandle>;

export const getChild = notInShell("getChild") as <
  T extends import("./core/index.js").Rpc.ExposedMethods = import("./core/index.js").Rpc.ExposedMethods,
  E extends import("./core/index.js").Rpc.RpcEventMap = import("./core/index.js").Rpc.RpcEventMap
>(name: string) => import("./core/index.js").ChildHandle<T, E> | undefined;

export const onChildAdded = notInShell("onChildAdded") as (
  callback: (name: string, handle: import("./core/index.js").ChildHandle) => void
) => () => void;

export const onChildRemoved = notInShell("onChildRemoved") as (
  callback: (name: string) => void
) => () => void;

export const setTitle = notInShell("setTitle") as (title: string) => Promise<void>;
export const getInfo = notInShell("getInfo") as () => Promise<import("./core/index.js").EndpointInfo>;
export const closeSelf = notInShell("closeSelf") as () => Promise<void>;
export const isEphemeral: boolean = false;
export const getWorkspaceTree = shellRpc
  ? () => shellRpc.call<import("./core/index.js").WorkspaceTree>("main", "bridge.getWorkspaceTree")
  : (notInShell("getWorkspaceTree") as () => Promise<import("./core/index.js").WorkspaceTree>);
export const listBranches = shellRpc
  ? (repoPath: string) => shellRpc.call<import("./core/index.js").BranchInfo[]>("main", "bridge.listBranches", repoPath)
  : (notInShell("listBranches") as (repoPath: string) => Promise<import("./core/index.js").BranchInfo[]>);
export const listCommits = shellRpc
  ? (repoPath: string, ref?: string, limit?: number) =>
      shellRpc.call<import("./core/index.js").CommitInfo[]>("main", "bridge.listCommits", repoPath, ref, limit)
  : (notInShell("listCommits") as (repoPath: string, ref?: string, limit?: number) => Promise<import("./core/index.js").CommitInfo[]>);

export const getTheme = (() => "light") as () => import("./types.js").ThemeAppearance;
export const onThemeChange = notInShell("onThemeChange") as (
  callback: (theme: import("./types.js").ThemeAppearance) => void
) => () => void;

export const onFocus = notInShell("onFocus") as (callback: () => void) => () => void;

export const onChildCreationError = notInShell("onChildCreationError") as (
  callback: (error: { url: string; error: string }) => void
) => () => void;

export const expose = shellRpc?.expose.bind(shellRpc) ?? notInShell("expose") as <
  T extends import("./core/index.js").Rpc.ExposedMethods
>(methods: T) => void;

export const gitConfig = null as import("./core/index.js").GitConfig | null;
export const bootstrapPromise = Promise.resolve(null) as Promise<import("./types.js").BootstrapResult | null>;
