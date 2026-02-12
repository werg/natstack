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
import { createRoutingBridge } from "./shared/routingBridge.js";
import { createDbClient, type DatabaseInterface } from "@natstack/core";
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

export type { DatabaseInterface as Database } from "@natstack/core";

export type {
  CreateChildOptions,
  ChildCreationResult,
  ChildSpec,
  AppChildSpec,
  WorkerChildSpec,
  BrowserChildSpec,
  GitConfig,
  PubSubConfig,
  EndpointInfo,
  EnsureLoadedResult,
  EventSchemaMap,
  InferEventMap,
  ChildHandle,
  RepoArgSpec,
  ChildHandleFromContract,
  ParentHandle,
  PanelContract,
  ParentHandleFromContract,
  TypedCallProxy,
  BuildNsLinkOptions,
  NsAction,
  AboutPage,
  ContextMode,
  ParsedContextId,
  EnvArgSchema,
  WorkspaceNode,
  WorkspaceTree,
  BranchInfo,
  CommitInfo,
} from "./core/index.js";

export type { Runtime } from "./setup/createRuntime.js";

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

  const electronBridge = createRpcBridge({
    selfId: g.__natstackId || "shell",
    transport,
    callTimeoutMs: 30000,
    aiCallTimeoutMs: 300000,
  });

  // Create server bridge if server transport is available
  const serverTransportBridge = (globalThis as unknown as { __natstackServerTransport?: ShellTransportBridge }).__natstackServerTransport;
  if (serverTransportBridge?.send && serverTransportBridge?.onMessage) {
    const serverTransport: RpcTransport = {
      send: serverTransportBridge.send,
      onMessage: (_sourceId: string, handler: (message: RpcMessage) => void) => {
        return serverTransportBridge.onMessage((fromId, message) => {
          if (fromId === "main") handler(message as RpcMessage);
        });
      },
      onAnyMessage: (handler: (sourceId: string, message: RpcMessage) => void) => {
        return serverTransportBridge.onMessage((fromId, message) => {
          handler(fromId, message as RpcMessage);
        });
      },
    };

    const serverBridge = createRpcBridge({
      selfId: g.__natstackId || "shell",
      transport: serverTransport,
      callTimeoutMs: 30000,
      aiCallTimeoutMs: 300000,
    });

    return createRoutingBridge(electronBridge, serverBridge);
  }

  return electronBridge;
}

// Initialize RPC bridge for shell
const shellRpc = createShellRpcBridge();

// Configure dependency injection for shared packages when in shell environment
// These packages use injection to avoid circular dependencies with runtime
if (shellRpc) {
  // Lazy import to avoid loading these modules when not in shell
  import("@natstack/agentic-messaging").then(({ setDbOpen }) => {
    setDbOpen((name, readOnly) => createDbClient(shellRpc).open(name, readOnly));
  });
  import("@natstack/ai").then(({ setRpc }) => {
    setRpc(shellRpc);
  });
}

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
export const z = zImpl;
export const defineContract = defineContractImpl;
export const noopParent = noopParentImpl;
// Navigation link builders
export const buildNsLink = buildNsLinkImpl;
export const buildAboutLink = buildAboutLinkImpl;
export const buildFocusLink = buildFocusLinkImpl;

// Context utilities
export const parseContextId = contextUtils.parseContextId;
export const isValidContextId = contextUtils.isValidContextId;
export const isSafeContext = contextUtils.isSafeContext;
export const isUnsafeContext = contextUtils.isUnsafeContext;
export const getTemplateSpecHash = contextUtils.getTemplateSpecHash;
export const getInstanceId = contextUtils.getInstanceId;

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
export const db: { open(name: string, readOnly?: boolean): Promise<DatabaseInterface> } = shellRpc
  ? createDbClient(shellRpc)
  : { open: notInShell("db.open") as () => Promise<DatabaseInterface> };

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
  options?: import("./core/index.js").CreateChildOptions,
  stateArgs?: Record<string, unknown>
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

// Panel titles are derived from document.title (HTML <title> tag)
// Electron's page-title-updated event propagates this to the persistence layer
export const getInfo = notInShell("getInfo") as () => Promise<import("./core/index.js").EndpointInfo>;
export const closeSelf = notInShell("closeSelf") as () => Promise<void>;
export const unloadSelf = notInShell("unloadSelf") as () => Promise<void>;
export const forceRepaint = notInShell("forceRepaint") as () => Promise<boolean>;
export const ensurePanelLoaded = notInShell("ensurePanelLoaded") as (panelId: string) => Promise<import("./core/index.js").EnsureLoadedResult>;
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

export const onConnectionError = notInShell("onConnectionError") as (
  callback: (error: { code: number; reason: string }) => void
) => () => void;

export const exposeMethod = shellRpc?.exposeMethod.bind(shellRpc) ?? notInShell("exposeMethod") as <
  TArgs extends unknown[],
  TReturn
>(method: string, handler: (...args: TArgs) => TReturn | Promise<TReturn>) => void;

export const gitConfig = null as import("./core/index.js").GitConfig | null;
export const pubsubConfig = null as import("./core/index.js").PubSubConfig | null;
export const bootstrapPromise = Promise.resolve(null) as Promise<import("./types.js").BootstrapResult | null>;

// State args API - only available in panel/worker environments
export const getStateArgs = notInShell("getStateArgs") as <T = Record<string, unknown>>() => T;
export const useStateArgs = notInShell("useStateArgs") as <T = Record<string, unknown>>() => T;
export const setStateArgs = notInShell("setStateArgs") as (updates: Record<string, unknown>) => Promise<Record<string, unknown>>;

// Path utilities - these work in any environment
export { normalizePath, getFileName, resolvePath } from "./shared/pathUtils.js";

// Ad blocking API - only available in panel/worker environments
export type { AdBlockStats, AdBlockApi } from "./panel/adblock.js";
export const adblock = new Proxy({} as import("./panel/adblock.js").AdBlockApi, {
  get(_target, prop) {
    throw new Error(
      `adblock.${String(prop)} is only available in panel/worker environments. ` +
      `Use the "natstack-panel" export condition.`
    );
  },
});

// fsReady - only available in panel/worker environments
// Use a getter that throws on access rather than Promise.reject() to avoid unhandled rejection errors
// when this module is imported but fsReady is not used
const fsReadyError = new Error("fsReady is only available in panel/worker environments");
export const fsReady: Promise<void> = {
  then() { throw fsReadyError; },
  catch() { throw fsReadyError; },
  finally() { throw fsReadyError; },
  [Symbol.toStringTag]: "Promise",
} as Promise<void>;
