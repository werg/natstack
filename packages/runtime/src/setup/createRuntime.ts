import { createRpcBridge, type RpcTransport } from "@natstack/rpc";
import { createDbClient } from "../shared/db.js";
import { createChildManager } from "../shared/children.js";
import {
  noopParent,
  type PanelContract,
  type CreateChildOptions,
  type ChildCreationResult,
  type EndpointInfo,
  type GitConfig,
  type PubSubConfig,
  type Rpc,
} from "../core/index.js";
import { createParentHandle, createParentHandleFromContract } from "../shared/handles.js";
import type { ParentHandle, ParentHandleFromContract } from "../core/index.js";
import type { BootstrapResult, RuntimeFs, ThemeAppearance } from "../types.js";

export interface RuntimeDeps {
  selfId: string;
  createTransport: () => RpcTransport;
  id: string;
  sessionId: string;
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

  const transport = deps.createTransport();
  const rpc = createRpcBridge({ selfId: deps.selfId, transport });

  const fs = deps.fs;

  const callMain = <T>(method: string, ...args: unknown[]) => rpc.call<T>("main", method, ...args);

  const bridge = {
    async createChild(
      source: string,
      options?: Omit<CreateChildOptions, "eventSchemas">
    ): Promise<ChildCreationResult> {
      return callMain<ChildCreationResult>("bridge.createChild", source, options);
    },

    async createBrowserChild(url: string): Promise<ChildCreationResult> {
      return callMain<ChildCreationResult>("bridge.createBrowserChild", url);
    },

    async closeChild(childId: string): Promise<void> {
      await callMain<void>("bridge.closeChild", childId);
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

    setTitle: (title: string) => callMain<void>("bridge.setTitle", title),
    getInfo: () => callMain<EndpointInfo>("bridge.getInfo"),

    getTheme: () => currentTheme,
    onThemeChange: (callback: (theme: ThemeAppearance) => void) => {
      callback(currentTheme);
      themeListeners.add(callback);
      return () => themeListeners.delete(callback);
    },

    onFocus,

    expose: rpc.expose.bind(rpc),

    gitConfig: deps.gitConfig ?? null,
    pubsubConfig: deps.pubsubConfig ?? null,
    /** Session ID for storage partition (format: {mode}_{type}_{identifier}) */
    sessionId: deps.sessionId,
    /** Promise that resolves when bootstrap completes. Resolves to null if no bootstrap needed. */
    bootstrapPromise: deps.bootstrapPromise ?? Promise.resolve(null),
  };
}

export type Runtime = ReturnType<typeof createRuntime>;
