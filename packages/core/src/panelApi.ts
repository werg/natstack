/**
 * Panel API for NatStack panels.
 *
 * This module provides the browser-side API for panels to interact with
 * the NatStack framework, including child management, RPC, theme, and git.
 */

import type { ComponentType, ReactNode } from "react";
import * as Rpc from "./types.js";
import type {
  ChildSpec as SharedChildSpec,
  AppChildSpec as SharedAppChildSpec,
  WorkerChildSpec as SharedWorkerChildSpec,
  BrowserChildSpec as SharedBrowserChildSpec,
  GitConfig as SharedGitConfig,
  ChildHandle,
  TypedCallProxy,
  ChildAddedCallback,
  ChildRemovedCallback,
  ParentHandle,
  EventSchemaMap,
  PanelContract,
  ChildHandleFromContract,
  ParentHandleFromContract,
  InferEventMap,
} from "./index.js";

// Re-export shared types
export type ChildSpec = SharedChildSpec;
export type AppChildSpec = SharedAppChildSpec;
export type WorkerChildSpec = SharedWorkerChildSpec;
export type BrowserChildSpec = SharedBrowserChildSpec;
export type GitConfig = SharedGitConfig;

/**
 * Result of panel bootstrap (cloning source + repoArgs into OPFS).
 * This is populated automatically by the framework for panels with repoArgs.
 */
export interface BootstrapResult {
  /** Whether bootstrap completed successfully */
  success: boolean;
  /** Error message if bootstrap failed */
  error?: string;
  /** Path to panel source in OPFS (e.g., "/src") */
  sourcePath: string;
  /** Commit SHA of the panel source */
  sourceCommit?: string;
  /** Map of repo arg name to local OPFS path (e.g., { history: "/args/history" }) */
  argPaths: Record<string, string>;
  /** Map of repo arg name to commit SHA */
  argCommits: Record<string, string>;
  /** Actions taken during bootstrap */
  actions: {
    source: "cloned" | "pulled" | "unchanged" | "error";
    args: Record<string, "cloned" | "updated" | "unchanged" | "error">;
  };
}

type PanelBridgeEvent = "child-removed" | "focus";

type PanelThemeAppearance = "light" | "dark";

export interface PanelTheme {
  appearance: PanelThemeAppearance;
}

interface PanelRpcBridge {
  expose(methods: Rpc.ExposedMethods): void;
  call(targetPanelId: string, method: string, ...args: unknown[]): Promise<unknown>;
  emit(targetPanelId: string, event: string, payload: unknown): Promise<void>;
  onEvent(event: string, listener: (fromPanelId: string, payload: unknown) => void): () => void;
}

interface PanelBrowserBridge {
  getCdpEndpoint(browserId: string): Promise<string>;
  navigate(browserId: string, url: string): Promise<void>;
  goBack(browserId: string): Promise<void>;
  goForward(browserId: string): Promise<void>;
  reload(browserId: string): Promise<void>;
  stop(browserId: string): Promise<void>;
}

interface PanelBridge {
  panelId: string;
  /** Parent panel ID (from env.PARENT_ID), null if root panel */
  parentId: string | null;
  /**
   * Create a child panel, worker, or browser from a spec.
   * The main process handles git checkout and build for app/worker types.
   * Returns the panel ID immediately; build happens asynchronously.
   */
  createChild(spec: ChildSpec): Promise<string>;
  removeChild(childId: string): Promise<void>;
  /**
   * Git operations
   */
  git: {
    getConfig(): Promise<GitConfig>;
  };
  /**
   * Browser panel operations
   */
  browser: PanelBrowserBridge;
  setTitle(title: string): Promise<void>;
  close(): Promise<void>;
  getEnv(): Promise<Record<string, string>>;
  getInfo(): Promise<{ panelId: string; partition: string }>;
  // Event handling
  on(event: PanelBridgeEvent, listener: (payload?: unknown) => void): () => void;
  getTheme(): PanelThemeAppearance;
  onThemeChange(listener: (theme: PanelThemeAppearance) => void): () => void;
  // Panel-to-panel RPC
  rpc: PanelRpcBridge;
}

declare global {
  interface Window {
    __natstackPanelBridge?: PanelBridge;
    /** Bootstrap result populated by panelRuntime before panel loads */
    __natstackBootstrapResult?: BootstrapResult;
    /** Bootstrap error message if bootstrap failed */
    __natstackBootstrapError?: string;
  }
}

const getBridge = (): PanelBridge => {
  const bridge = window.__natstackPanelBridge;
  if (!bridge) {
    throw new Error("NatStack panel bridge is not available");
  }
  return bridge;
};

type AsyncResult<T> = Promise<T>;

const bridge = getBridge();

let currentTheme: PanelTheme = { appearance: bridge.getTheme() };
const themeListeners = new Set<(theme: PanelTheme) => void>();

// =============================================================================
// ChildHandle Implementation
// =============================================================================

// Module-level state for child tracking
const childHandles = new Map<string, ChildHandle>();
const childAddedListeners = new Set<ChildAddedCallback>();
const childRemovedListeners = new Set<ChildRemovedCallback>();
// Track cleanup functions per child ID for automatic cleanup on removal
const childCleanupFunctions = new Map<string, Array<() => void>>();

// Listen for child removal events to clean up handles
bridge.on("child-removed", (childId) => {
  if (typeof childId === "string") {
    // Clean up event listeners for this child
    const cleanups = childCleanupFunctions.get(childId);
    if (cleanups) {
      for (const cleanup of cleanups) {
        try {
          cleanup();
        } catch (error) {
          console.error("[ChildHandle] Error in cleanup:", error);
        }
      }
      childCleanupFunctions.delete(childId);
    }

    // Find by ID and remove from handles map
    for (const [name, handle] of childHandles) {
      if (handle.id === childId) {
        childHandles.delete(name);
        // Notify listeners
        for (const listener of childRemovedListeners) {
          try {
            listener(name, childId);
          } catch (error) {
            console.error("[ChildHandle] Error in child-removed listener:", error);
          }
        }
        break;
      }
    }
  }
});

/**
 * Factory function to create a ChildHandle for a child.
 */
function createChildHandle<
  T extends Rpc.ExposedMethods = Rpc.ExposedMethods,
  E extends Rpc.RpcEventMap = Rpc.RpcEventMap,
  EmitE extends Rpc.RpcEventMap = Rpc.RpcEventMap
>(
  id: string,
  type: "app" | "worker" | "browser",
  name: string,
  title: string,
  source: string,
  eventSchemas?: EventSchemaMap
): ChildHandle<T, E, EmitE> {
  // Per-handle event listeners (for cleanup on close)
  const eventUnsubscribers: Array<() => void> = [];

  // Register with module-level cleanup map for automatic cleanup on child-removed
  childCleanupFunctions.set(id, eventUnsubscribers);

  // Create typed call proxy using Proxy
  const callProxy = new Proxy({} as TypedCallProxy<T>, {
    get(_target, method: string) {
      return async (...args: unknown[]) => {
        return bridge.rpc.call(id, method, ...args);
      };
    },
  });

  const handle: ChildHandle<T, E, EmitE> = {
    id,
    type,
    name,
    title,
    source,

    async close() {
      // Unsubscribe all event listeners for this handle
      for (const unsubscribe of eventUnsubscribers) {
        unsubscribe();
      }
      eventUnsubscribers.length = 0;
      // Remove from module-level cleanup map
      childCleanupFunctions.delete(id);
      await bridge.removeChild(id);
    },

    call: callProxy,

    async emit(event: string, payload: unknown) {
      await bridge.rpc.emit(id, event, payload);
    },

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    onEvent(event: string, listener: (payload: any) => void): () => void {
      // Subscribe to bridge events, filtering by source panel ID
      const unsubscribe = bridge.rpc.onEvent(event, (fromPanelId, payload) => {
        if (fromPanelId === id) {
          // Validate payload if schema exists for this event
          const schema = eventSchemas?.[event];
          if (schema) {
            const result = schema.safeParse(payload);
            if (!result.success) {
              console.error(
                `[ChildHandle] Event "${event}" from ${name} failed validation:`,
                result.error.format()
              );
              return; // Skip listener if validation fails
            }
            listener(result.data);
          } else {
            listener(payload);
          }
        }
      });
      eventUnsubscribers.push(unsubscribe);

      // Return an unsubscribe function that also removes from our tracking array
      return () => {
        unsubscribe();
        const idx = eventUnsubscribers.indexOf(unsubscribe);
        if (idx !== -1) {
          eventUnsubscribers.splice(idx, 1);
        }
      };
    },

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    onEvents(listeners: Record<string, ((payload: any) => void) | undefined>): () => void {
      const unsubs: Array<() => void> = [];
      for (const [event, listener] of Object.entries(listeners)) {
        if (typeof listener !== "function") continue;
        unsubs.push(this.onEvent(event, listener));
      }
      return () => {
        for (const unsub of unsubs) {
          unsub();
        }
      };
    },

    async getCdpEndpoint() {
      return bridge.browser.getCdpEndpoint(id);
    },

    // Browser-specific methods
    async navigate(url) {
      if (type !== "browser") {
        throw new Error("navigate() is only available for browser children");
      }
      await bridge.browser.navigate(id, url);
    },

    async goBack() {
      if (type !== "browser") {
        throw new Error("goBack() is only available for browser children");
      }
      await bridge.browser.goBack(id);
    },

    async goForward() {
      if (type !== "browser") {
        throw new Error("goForward() is only available for browser children");
      }
      await bridge.browser.goForward(id);
    },

    async reload() {
      if (type !== "browser") {
        throw new Error("reload() is only available for browser children");
      }
      await bridge.browser.reload(id);
    },

    async stop() {
      if (type !== "browser") {
        throw new Error("stop() is only available for browser children");
      }
      await bridge.browser.stop(id);
    },
  };

  return handle;
}

bridge.onThemeChange((appearance) => {
  currentTheme = { appearance };
  for (const listener of themeListeners) {
    listener(currentTheme);
  }
});

// =============================================================================
// ParentHandle Implementation
// =============================================================================

/**
 * Factory function to create a ParentHandle for parent communication.
 * Returns null if this panel has no parent (is root).
 */
function createParentHandle<
  T extends Rpc.ExposedMethods = Rpc.ExposedMethods,
  E extends Rpc.RpcEventMap = Rpc.RpcEventMap,
  EmitE extends Rpc.RpcEventMap = Rpc.RpcEventMap
>(): ParentHandle<T, E, EmitE> | null {
  const parentId = bridge.parentId;
  if (!parentId) return null;

  // Create typed call proxy using Proxy
  const callProxy = new Proxy({} as TypedCallProxy<T>, {
    get(_target, method: string) {
      return async (...args: unknown[]) => {
        return bridge.rpc.call(parentId, method, ...args);
      };
    },
  });

  const handle: ParentHandle<T, E, EmitE> = {
    id: parentId,

    call: callProxy,

    async emit(event: string, payload: unknown) {
      await bridge.rpc.emit(parentId, event, payload);
    },

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    onEvent(event: string, listener: (payload: any) => void): () => void {
      // Subscribe to bridge events, filtering by source panel ID (parent)
      const unsubscribe = bridge.rpc.onEvent(event, (fromPanelId, payload) => {
        if (fromPanelId === parentId) {
          listener(payload);
        }
      });
      return unsubscribe;
    },
  };

  return handle;
}

// Lazy-initialized parent handle (cached)
let cachedParentHandle: ParentHandle | null | undefined;

// Log OPFS quota on initialization (run once when module loads)
if (typeof window !== 'undefined') {
  void (async () => {
    try {
      const { logQuotaInfo } = await import("./opfsQuota.js");
      await logQuotaInfo();
    } catch (err) {
      // Silently fail if quota API not available
    }
  })();
}

const panelAPI = {
  // ===========================================================================
  // Identity
  // ===========================================================================

  /**
   * This panel's unique ID.
   */
  get id(): string {
    return bridge.panelId;
  },

  /**
   * Get a typed handle for communicating with the parent panel.
   * Returns null if this panel has no parent (is root).
   *
   * @typeParam T - RPC methods the parent exposes (what the child can call)
   * @typeParam E - RPC event map for events from parent (what the child listens to)
   * @typeParam EmitE - RPC event map for events to parent (what the child emits)
   *
   * @example
   * ```ts
   * // For full type safety, prefer getParentWithContract():
   * import { myContract } from "./contract.js";
   * const parent = panel.getParentWithContract(myContract);
   *
   * // Or use direct type parameters:
   * interface MyEmitEvents { saved: { path: string } }
   * const parent = panel.getParent<{}, {}, MyEmitEvents>();
   * if (parent) {
   *   // Typed emit - payload is type-checked!
   *   parent.emit("saved", { path: "/foo.txt" });
   * }
   * ```
   */
  getParent<
    T extends Rpc.ExposedMethods = Rpc.ExposedMethods,
    E extends Rpc.RpcEventMap = Rpc.RpcEventMap,
    EmitE extends Rpc.RpcEventMap = Rpc.RpcEventMap
  >(): ParentHandle<T, E, EmitE> | null {
    if (cachedParentHandle === undefined) {
      cachedParentHandle = createParentHandle();
    }
    return cachedParentHandle as ParentHandle<T, E, EmitE> | null;
  },

  /**
   * Get a typed parent handle using a contract for full type safety.
   * The contract defines both the child's and parent's interface.
   *
   * @param contract - Panel contract defining the interface
   * @returns Typed ParentHandle derived from the contract (flipped perspective)
   *
   * @example
   * ```ts
   * import { myContract } from "./contract.js";
   *
   * const parent = panel.getParentWithContract(myContract);
   * if (parent) {
   *   // Fully typed from contract:
   *   await parent.call.notifyReady();        // parent methods
   *   parent.onEvent("theme-changed", ...);   // parent events
   *   parent.emit("saved", { path: "..." });  // child events (what we emit)
   * }
   * ```
   */
  getParentWithContract<C extends PanelContract>(
    _contract: C
  ): ParentHandleFromContract<C> | null {
    if (cachedParentHandle === undefined) {
      cachedParentHandle = createParentHandle();
    }
    return cachedParentHandle as ParentHandleFromContract<C> | null;
  },

  /**
   * Create a child panel, worker, or browser from a spec.
   * Returns a ChildHandle for unified interaction with the child.
   *
   * @typeParam T - RPC methods the child exposes (for typed calls)
   * @typeParam E - RPC event map for typed events
   * @param spec - Child specification with type discriminator
   * @returns ChildHandle with RPC, lifecycle, and automation methods
   *
   * @example
   * ```ts
   * // Create an app panel with typed RPC
   * interface EditorApi {
   *   openFile(path: string): Promise<void>;
   *   getContent(): Promise<string>;
   * }
   * const editor = await panel.createChild<EditorApi>({
   *   type: 'app',
   *   name: 'editor',
   *   source: 'panels/editor',
   * });
   * await editor.call.openFile('/foo.txt');
   * const content = await editor.call.getContent();
   * await editor.close();
   *
   * // Create a browser with navigation
   * const browser = await panel.createChild({
   *   type: 'browser',
   *   name: 'scraper',
   *   source: 'https://example.com',
   * });
   * await browser.navigate('https://other.com');
   * const cdp = await browser.getCdpEndpoint();
   *
   * // Query existing children
   * const existing = panel.getChild<EditorApi>('editor');
   * console.log([...panel.children.keys()]);
   * ```
   */
  async createChild<
    T extends Rpc.ExposedMethods = Rpc.ExposedMethods,
    E extends Rpc.RpcEventMap = Rpc.RpcEventMap,
    EmitE extends Rpc.RpcEventMap = Rpc.RpcEventMap
  >(spec: ChildSpec): AsyncResult<ChildHandle<T, E, EmitE>> {
    // Extract eventSchemas before passing to bridge (Zod schemas can't be structured-cloned)
    const { eventSchemas, ...bridgeSpec } = spec;
    const childId = await bridge.createChild(bridgeSpec as ChildSpec);

    // Determine type
    const type = spec.type;

    // Name: use provided or derive from ID (main process generates if not provided)
    const name = spec.name ?? childId.split("/").pop() ?? childId;

    // Title: explicit for browser, or derive from name
    const title = (spec.type === "browser" && spec.title) ? spec.title : name;

    const handle = createChildHandle<T, E, EmitE>(childId, type, name, title, spec.source, eventSchemas);

    // Track by name
    childHandles.set(name, handle as ChildHandle);

    // Notify listeners
    for (const listener of childAddedListeners) {
      try {
        (listener as ChildAddedCallback<T>)(name, handle);
      } catch (error) {
        console.error("[ChildHandle] Error in child-added listener:", error);
      }
    }

    return handle;
  },

  /**
   * Create a child panel using a contract for full type safety.
   * The contract defines both the child's and parent's interface.
   *
   * @param contract - Panel contract defining the interface
   * @param options - Optional overrides (name, env, type for worker)
   * @returns Typed ChildHandle derived from the contract
   *
   * @example
   * ```ts
   * import { editorContract } from "../editor/contract.js";
   *
   * const editor = await panel.createChildWithContract(editorContract, {
   *   name: "my-editor",
   * });
   *
   * // Fully typed from contract:
   * await editor.call.openFile("/foo.txt");  // child methods
   * editor.onEvent("saved", (p) => { ... }); // child events
   * editor.emit("theme-changed", { ... });   // parent events
   * ```
   */
  async createChildWithContract<C extends PanelContract>(
    contract: C,
    options?: {
      name?: string;
      env?: Record<string, string>;
      type?: "app" | "worker";
    }
  ): AsyncResult<ChildHandleFromContract<C>> {
    // Build the spec from contract + options
    const spec: ChildSpec = {
      type: options?.type ?? "app",
      source: contract.source,
      name: options?.name,
      env: options?.env,
      eventSchemas: contract.child?.emits,
    };

    // Extract types from contract for the handle
    type ChildMethods = C extends PanelContract<infer M, infer _CE, infer _PM, infer _PE> ? M : Rpc.ExposedMethods;
    type ChildEmits = C extends PanelContract<infer _CM, infer CE, infer _PM, infer _PE> ? InferEventMap<CE> : Rpc.RpcEventMap;
    type ParentEmits = C extends PanelContract<infer _CM, infer _CE, infer _PM, infer PE> ? InferEventMap<PE> : Rpc.RpcEventMap;

    // Delegate to createChild with proper types
    const handle = await this.createChild<ChildMethods, ChildEmits, ParentEmits>(spec);

    return handle as ChildHandleFromContract<C>;
  },

  // ===========================================================================
  // Child Query API
  // ===========================================================================

  /**
   * Get all children as a readonly Map.
   * Keys are child names, values are ChildHandles.
   */
  get children(): ReadonlyMap<string, ChildHandle> {
    return childHandles;
  },

  /**
   * Get a child by name (if it exists).
   *
   * @typeParam T - RPC methods the child exposes
   * @typeParam E - RPC event map for typed events
   * @param name - The child's name (as provided in createChild spec)
   * @returns ChildHandle or undefined if not found
   */
  getChild<
    T extends Rpc.ExposedMethods = Rpc.ExposedMethods,
    E extends Rpc.RpcEventMap = Rpc.RpcEventMap
  >(name: string): ChildHandle<T, E> | undefined {
    return childHandles.get(name) as ChildHandle<T, E> | undefined;
  },

  /**
   * Subscribe to child added events.
   * Called when a child is created via createChild().
   * @returns Unsubscribe function
   */
  onChildAdded(callback: ChildAddedCallback): () => void {
    childAddedListeners.add(callback);
    return () => {
      childAddedListeners.delete(callback);
    };
  },

  async setTitle(title: string): AsyncResult<void> {
    return bridge.setTitle(title);
  },

  async close(): AsyncResult<void> {
    // Clean up all child handles before closing
    for (const [, handle] of childHandles) {
      try {
        // Unsubscribe event listeners
        const cleanups = childCleanupFunctions.get(handle.id);
        if (cleanups) {
          for (const cleanup of cleanups) {
            cleanup();
          }
        }
      } catch {
        // Ignore cleanup errors during close
      }
    }
    childHandles.clear();
    childCleanupFunctions.clear();
    childAddedListeners.clear();
    childRemovedListeners.clear();

    return bridge.close();
  },

  onChildRemoved(callback: (childId: string) => void): () => void {
    return bridge.on("child-removed", (payload) => {
      if (typeof payload === "string") {
        callback(payload);
      }
    });
  },

  onFocus(callback: () => void): () => void {
    return bridge.on("focus", () => callback());
  },

  getTheme(): PanelTheme {
    return currentTheme;
  },

  onThemeChange(callback: (theme: PanelTheme) => void): () => void {
    callback(currentTheme);
    themeListeners.add(callback);
    return () => {
      themeListeners.delete(callback);
    };
  },

  async getEnv(): AsyncResult<Record<string, string>> {
    return bridge.getEnv();
  },

  async getInfo(): AsyncResult<{ panelId: string; partition: string }> {
    return bridge.getInfo();
  },

  async getPartition(): AsyncResult<string> {
    const info = await bridge.getInfo();
    return info.partition;
  },

  async getPanelId(): AsyncResult<string> {
    const info = await bridge.getInfo();
    return info.panelId;
  },

  // ===========================================================================
  // Git Operations
  // ===========================================================================

  git: {
    /**
     * Get git configuration for this panel.
     * Use with @natstack/git to clone/pull repos into OPFS.
     */
    async getConfig(): AsyncResult<GitConfig> {
      return bridge.git.getConfig();
    },
  },

  // ===========================================================================
  // Bootstrap Result
  // ===========================================================================

  /**
   * Bootstrap result for panels with repoArgs.
   *
   * For panels that declare `repoArgs` in their manifest, the framework
   * automatically clones those repos into OPFS before the panel loads.
   * This property provides access to the paths where repos were cloned.
   *
   * @example
   * ```ts
   * // In package.json: "natstack": { "repoArgs": ["history"] }
   * // Parent passes: repoArgs: { history: "state/notebook-chats" }
   *
   * // Access the cloned repo path:
   * const historyPath = panel.bootstrap?.argPaths.history;
   * // historyPath = "/args/history" (OPFS path where repo was cloned)
   * ```
   *
   * Returns null if:
   * - Panel has no repoArgs declared
   * - Bootstrap hasn't run yet (shouldn't happen - runs before panel loads)
   * - Bootstrap failed (check panel.bootstrapError for details)
   */
  get bootstrap(): BootstrapResult | null {
    return window.__natstackBootstrapResult ?? null;
  },

  /**
   * Bootstrap error message if bootstrap failed.
   * Check this if panel.bootstrap is null but you expected repoArgs.
   */
  get bootstrapError(): string | null {
    return window.__natstackBootstrapError ?? null;
  },

  // ===========================================================================
  // Panel-to-Panel RPC
  // ===========================================================================

  /**
   * RPC namespace for exposing methods and listening to global events.
   *
   * For child communication, use `createChild()` which returns a ChildHandle.
   * For parent communication, use `getParent()` which returns a ParentHandle.
   */
  rpc: {
    /**
     * Expose methods that can be called by parent or child panels.
     *
     * @example
     * ```ts
     * panel.rpc.expose({
     *   async loadFile(path: string) {
     *     // Load file logic
     *   },
     *   async getContent() {
     *     return editorContent;
     *   }
     * });
     * ```
     */
    expose<T extends Rpc.ExposedMethods>(methods: T): void {
      bridge.rpc.expose(methods);
    },

    /**
     * Subscribe to events from any panel (filtered by event name).
     * Useful for broadcast events where the sender is unknown.
     *
     * For events from a specific child, use `childHandle.onEvent()`.
     * For events from the parent, use `parentHandle.onEvent()`.
     *
     * @example
     * ```ts
     * panel.rpc.onEvent("statusUpdate", (fromPanelId, payload) => {
     *   console.log(`Panel ${fromPanelId} sent:`, payload);
     * });
     * ```
     */
    onEvent(event: string, listener: (fromPanelId: string, payload: unknown) => void): () => void {
      return bridge.rpc.onEvent(event, listener);
    },
  },
};

export type PanelAPI = typeof panelAPI;

export default panelAPI;

// Re-export types for panel developers
export type { Rpc };

type ReactNamespace = typeof import("react");
type RadixThemeComponent = ComponentType<{
  appearance: PanelThemeAppearance;
  children?: ReactNode;
}>;

export function createRadixThemeProvider(
  ReactLib: ReactNamespace,
  ThemeComponent: RadixThemeComponent
) {
  return function NatstackRadixThemeProvider({ children }: { children?: ReactNode }): ReactNode {
    const [theme, setTheme] = ReactLib.useState<PanelTheme>(panelAPI.getTheme());

    ReactLib.useEffect(() => {
      let mounted = true;
      const unsubscribe = panelAPI.onThemeChange((nextTheme) => {
        if (mounted) {
          setTheme(nextTheme);
        }
      });
      return () => {
        mounted = false;
        unsubscribe();
      };
    }, []);

    return ReactLib.createElement(ThemeComponent, { appearance: theme.appearance }, children);
  };
}
