import { createRpcBridge, type RpcBridge, type RpcTransport } from "@natstack/rpc";
import { createRoutingBridge } from "../shared/routingBridge.js";
import { createDbClient } from "@workspace/core";
import { createChildManager } from "../shared/children.js";
import {
  noopParent,
  type PanelContract,
  type CreateChildOptions,
  type ChildCreationResult,
  type EndpointInfo,
  type EnsureLoadedResult,
  type GitConfig,
  type PubSubConfig,
  type WorkspaceTree,
  type BranchInfo,
  type CommitInfo,
  type Rpc,
} from "../core/index.js";
import { createParentHandle, createParentHandleFromContract } from "../shared/handles.js";
import type { ParentHandle, ParentHandleFromContract } from "../core/index.js";
import type { BootstrapResult, RuntimeFs, ThemeAppearance } from "../types.js";
import { _initStateArgsBridge } from "../panel/stateArgs.js";

export interface RuntimeDeps {
  selfId: string;
  createTransport: () => RpcTransport;
  createServerTransport?: () => RpcTransport | null;
  id: string;
  contextId: string;
  parentId: string | null;
  initialTheme: ThemeAppearance;
  fs: RuntimeFs;
  setupGlobals?: () => void;
  gitConfig?: GitConfig | null;
  pubsubConfig?: PubSubConfig | null;
  /** Promise that resolves when bootstrap completes (or null if no bootstrap needed) */
  bootstrapPromise?: Promise<BootstrapResult | null> | null;
}

export function createRuntime(deps: RuntimeDeps) {
  deps.setupGlobals?.();

  const electronTransport = deps.createTransport();
  const electronBridge = createRpcBridge({ selfId: deps.selfId, transport: electronTransport });

  // Create server bridge if available (may not exist in chooser mode)
  let rpc: RpcBridge = electronBridge;
  if (deps.createServerTransport) {
    const serverTransport = deps.createServerTransport();
    if (serverTransport) {
      const serverBridge = createRpcBridge({
        selfId: deps.selfId,
        transport: serverTransport,
        callTimeoutMs: 30000,
        aiCallTimeoutMs: 300000,
      });
      rpc = createRoutingBridge(electronBridge, serverBridge);
    }
  }

  const fs = deps.fs;

  const callMain = <T>(method: string, ...args: unknown[]) => rpc.call<T>("main", method, ...args);

  // Initialize the stateArgs bridge for setStateArgs() function
  _initStateArgsBridge((updates) => callMain<Record<string, unknown>>("bridge.setStateArgs", updates));

  const bridge = {
    async createChild(
      source: string,
      options?: Omit<CreateChildOptions, "eventSchemas">,
      stateArgs?: Record<string, unknown>
    ): Promise<ChildCreationResult> {
      return callMain<ChildCreationResult>("bridge.createChild", source, options, stateArgs);
    },

    async createBrowserChild(url: string): Promise<ChildCreationResult> {
      return callMain<ChildCreationResult>("bridge.createBrowserChild", url);
    },

    async closeChild(childId: string): Promise<void> {
      await callMain<void>("bridge.closeChild", childId);
    },

    // Unified history navigation methods
    async goBack(childId: string): Promise<void> {
      await callMain<void>("bridge.goBack", childId);
    },
    async goForward(childId: string): Promise<void> {
      await callMain<void>("bridge.goForward", childId);
    },
    async navigatePanel(childId: string, source: string, targetType: string): Promise<void> {
      await callMain<void>("bridge.navigatePanel", childId, source, targetType);
    },

    browser: {
      async getCdpEndpoint(browserId: string): Promise<string> {
        return callMain<string>("browser.getCdpEndpoint", browserId);
      },
      async navigate(browserId: string, url: string): Promise<void> {
        await callMain<void>("browser.navigate", browserId, url);
      },
      async goBack(browserId: string): Promise<void> {
        await callMain<void>("browser.goBack", browserId);
      },
      async goForward(browserId: string): Promise<void> {
        await callMain<void>("browser.goForward", browserId);
      },
      async reload(browserId: string): Promise<void> {
        await callMain<void>("browser.reload", browserId);
      },
      async stop(browserId: string): Promise<void> {
        await callMain<void>("browser.stop", browserId);
      },
    },
  };

  const db = createDbClient(rpc);
  const childManager = createChildManager({ rpc, bridge });

  const parentHandleOrNull = deps.parentId ? createParentHandle({ rpc, parentId: deps.parentId }) : null;
  const parent: ParentHandle = parentHandleOrNull ?? noopParent;

  const getParent = <
    T extends Rpc.ExposedMethods = Rpc.ExposedMethods,
    E extends Rpc.RpcEventMap = Rpc.RpcEventMap,
    EmitE extends Rpc.RpcEventMap = Rpc.RpcEventMap
  >(): ParentHandle<T, E, EmitE> | null => {
    return parentHandleOrNull as ParentHandle<T, E, EmitE> | null;
  };

  const getParentWithContract = <C extends PanelContract>(contract: C): ParentHandleFromContract<C> | null => {
    return createParentHandleFromContract(getParent(), contract);
  };

  let currentTheme: ThemeAppearance = deps.initialTheme;
  const themeListeners = new Set<(theme: ThemeAppearance) => void>();

  const parseThemeAppearance = (payload: unknown): ThemeAppearance | null => {
    const appearance =
      typeof payload === "string"
        ? payload
        : typeof (payload as { theme?: unknown } | null)?.theme === "string"
          ? ((payload as { theme: ThemeAppearance }).theme)
          : null;
    if (appearance === "light" || appearance === "dark") return appearance;
    return null;
  };

  const onThemeEvent = (_fromId: string, payload: unknown) => {
    const theme = parseThemeAppearance(payload);
    if (!theme) return;
    currentTheme = theme;
    for (const listener of themeListeners) listener(currentTheme);
  };

  const themeUnsubscribers = [rpc.onEvent("runtime:theme", onThemeEvent)];

  const focusUnsubscribers: Array<() => void> = [];

  const onFocus = (callback: () => void) => {
    const unsub = rpc.onEvent("runtime:focus", () => callback());
    focusUnsubscribers.push(unsub);
    return () => {
      unsub();
      const idx = focusUnsubscribers.indexOf(unsub);
      if (idx !== -1) focusUnsubscribers.splice(idx, 1);
    };
  };

  const destroy = () => {
    childManager.destroy();
    for (const unsub of themeUnsubscribers) unsub();
    for (const unsub of focusUnsubscribers) unsub();
    focusUnsubscribers.length = 0;
    themeListeners.clear();
  };

  const onChildCreationError = (
    callback: (error: { url: string; error: string }) => void
  ): (() => void) => {
    return rpc.onEvent("runtime:child-creation-error", (fromId, payload) => {
      if (fromId !== "main") return;
      const data = payload as { url?: unknown; error?: unknown } | null;
      if (!data || typeof data.url !== "string" || typeof data.error !== "string") return;
      callback({ url: data.url, error: data.error });
    });
  };

  const onConnectionError = (
    callback: (error: { code: number; reason: string; source?: "electron" | "server" }) => void
  ): (() => void) => {
    return rpc.onEvent("runtime:connection-error", (fromId, payload) => {
      if (fromId !== "main") return;
      const data = payload as { code?: unknown; reason?: unknown; source?: unknown } | null;
      if (!data || typeof data.code !== "number" || typeof data.reason !== "string") return;
      callback({
        code: data.code,
        reason: data.reason,
        source: data.source === "electron" || data.source === "server" ? data.source : undefined,
      });
    });
  };

  return {
    id: deps.id,
    parentId: deps.parentId,

    rpc,
    db,
    fs,

    parent,
    getParent,
    getParentWithContract,

    createChild: childManager.createChild,
    createBrowserChild: childManager.createBrowserChild,
    createChildWithContract: childManager.createChildWithContract,
    children: childManager.children,
    getChild: childManager.getChild,
    onChildAdded: childManager.onChildAdded,
    onChildRemoved: childManager.onChildRemoved,
    onChildCreationError,
    onConnectionError,

    getInfo: () => callMain<EndpointInfo>("bridge.getInfo"),
    closeSelf: () => callMain<void>("bridge.closeSelf"),
    unloadSelf: () => callMain<void>("bridge.unloadSelf"),
    forceRepaint: () => callMain<boolean>("bridge.forceRepaint"),
    ensurePanelLoaded: (panelId: string) => callMain<EnsureLoadedResult>("bridge.ensurePanelLoaded", panelId),
    getWorkspaceTree: () => callMain<WorkspaceTree>("bridge.getWorkspaceTree"),
    listBranches: (repoPath: string) => callMain<BranchInfo[]>("bridge.listBranches", repoPath),
    listCommits: (repoPath: string, ref?: string, limit?: number) =>
      callMain<CommitInfo[]>("bridge.listCommits", repoPath, ref, limit),

    getTheme: () => currentTheme,
    onThemeChange: (callback: (theme: ThemeAppearance) => void) => {
      callback(currentTheme);
      themeListeners.add(callback);
      return () => { themeListeners.delete(callback); };
    },

    onFocus,

    exposeMethod: rpc.exposeMethod.bind(rpc),

    gitConfig: deps.gitConfig ?? null,
    pubsubConfig: deps.pubsubConfig ?? null,
    /** Context ID for storage partition (format: {mode}_{type}_{identifier}) */
    contextId: deps.contextId,
    /** Promise that resolves when bootstrap completes. Resolves to null if no bootstrap needed. */
    bootstrapPromise: deps.bootstrapPromise ?? Promise.resolve(null),
  };
}

export type Runtime = ReturnType<typeof createRuntime>;
