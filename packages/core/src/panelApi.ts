/**
 * Panel API for NatStack panels.
 *
 * This module provides the browser-side API for panels to interact with
 * the NatStack framework, including child management, RPC, theme, and git.
 */

import type { ComponentType, ReactNode } from "react";
import typia from "typia";
import * as Rpc from "./types.js";
import type {
  CreateChildOptions as SharedCreateChildOptions,
  GitConfig as SharedGitConfig,
  RpcHandleOptions,
} from "./index.js";

// Re-export shared types for backwards compatibility
export type CreateChildOptions = SharedCreateChildOptions;
export type GitConfig = SharedGitConfig;
export type PanelRpcHandleOptions = RpcHandleOptions;

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

interface PanelBridge {
  panelId: string;
  /**
   * Create a child panel from a workspace-relative path.
   * The main process handles git checkout (if version specified) and build.
   * Returns the panel ID immediately; build happens asynchronously.
   */
  createChild(
    childPath: string,
    options?: CreateChildOptions
  ): Promise<string>;
  removeChild(childId: string): Promise<void>;
  /**
   * Git operations
   */
  git: {
    getConfig(): Promise<GitConfig>;
  };
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

bridge.onThemeChange((appearance) => {
  currentTheme = { appearance };
  for (const listener of themeListeners) {
    listener(currentTheme);
  }
});

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
  getId(): string {
    return bridge.panelId;
  },

  /**
   * Create a child panel from a workspace-relative path.
   * The main process handles git checkout (if version specified) and build.
   * Returns the panel ID immediately; build happens asynchronously.
   *
   * @param childPath - Workspace-relative path to the panel (e.g., "panels/my-panel")
   * @param options - Optional env vars and version specifiers (branch, commit, tag)
   * @returns Panel ID that can be used for communication
   */
  async createChild(childPath: string, options?: CreateChildOptions): AsyncResult<string> {
    return bridge.createChild(childPath, options);
  },

  async removeChild(childId: string): AsyncResult<void> {
    return bridge.removeChild(childId);
  },

  async setTitle(title: string): AsyncResult<void> {
    return bridge.setTitle(title);
  },

  async close(): AsyncResult<void> {
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
  // Panel-to-Panel RPC
  // ===========================================================================

  /**
   * Expose methods that can be called by parent or child panels.
   *
   * @example
   * ```ts
   * // Child panel exposes its API
   * panelAPI.rpc.expose({
   *   async loadFile(path: string) {
   *     // Load file logic
   *   },
   *   async getContent() {
   *     return editorContent;
   *   }
   * });
   * ```
   */
  rpc: {
    /**
     * Expose methods that can be called by parent or child panels.
     */
    expose<T extends Rpc.ExposedMethods>(methods: T): void {
      bridge.rpc.expose(methods);
    },

    /**
     * Get a typed handle to communicate with another panel.
     * The panel must be a direct parent or child.
     *
     * @example
     * ```ts
     * // Define types
     * interface EditorApi {
     *   getContent(): Promise<string>;
     *   setContent(text: string): Promise<void>;
     * }
     *
     * interface EditorEvents extends Rpc.RpcEventMap {
     *   "content-changed": { text: string };
     *   "saved": { path: string };
     * }
     *
     * // Parent panel calls child
     * const childHandle = panelAPI.rpc.getHandle<EditorApi, EditorEvents>(childPanelId);
     * const content = await childHandle.call.getContent();
     *
     * // Listen to typed events
     * childHandle.on("content-changed", (payload) => {
     *   console.log(payload.text); // Fully typed!
     * });
     * ```
     */
    getHandle<
      T extends Rpc.ExposedMethods = Rpc.ExposedMethods,
      E extends Rpc.RpcEventMap = Rpc.RpcEventMap
    >(targetPanelId: string, options?: PanelRpcHandleOptions): Rpc.PanelRpcHandle<T, E> {
      // Create a proxy that allows typed method calls
      const callProxy = new Proxy({} as Rpc.PanelRpcHandle<T>["call"], {
        get(_target, prop: string) {
          return async (...args: unknown[]) => {
            return bridge.rpc.call(targetPanelId, prop, ...args);
          };
        },
      });

      const eventListeners = new Map<string, Set<(payload: any) => void>>();
      const validateEvents = options?.validateEvents ?? false;
      const eventValidators = new Map<string, (payload: any) => void>();

      const getValidator = validateEvents
        ? <EventName extends Extract<keyof E, string>>(event: EventName) => {
            if (!eventValidators.has(event)) {
              let assertPayload: (payload: any) => void;
              try {
                assertPayload = typia.createAssert<E[EventName]>();
              } catch (error) {
                console.warn(
                  `[Panel RPC] Falling back to unvalidated events for "${event}":`,
                  error
                );
                assertPayload = () => {};
              }
              eventValidators.set(event, assertPayload as (payload: any) => void);
            }
            return eventValidators.get(event) as (payload: E[EventName]) => void;
          }
        : null;

      // Create the handle with proper overload support
      const handle: Rpc.PanelRpcHandle<T, E> = {
        panelId: targetPanelId,
        call: callProxy,
        on(event: string, handler: (payload: any) => void): () => void {
          // Track local listeners for this handle
          const listeners = eventListeners.get(event) ?? new Set();
          listeners.add(handler);
          eventListeners.set(event, listeners);

          // Subscribe to RPC events, filtering by source panel
          const unsubscribe = bridge.rpc.onEvent(event, (fromPanelId, payload) => {
            if (fromPanelId === targetPanelId) {
              try {
                if (getValidator) {
                  const assertPayload = getValidator(event as Extract<keyof E, string>);
                  assertPayload(payload as unknown as E[Extract<keyof E, string>]);
                }
              } catch (error) {
                console.error(
                  `[Panel RPC] Event payload validation failed for "${event}" from ${fromPanelId}:`,
                  error
                );
                return;
              }
              handler(payload);
            }
          });

          return () => {
            listeners.delete(handler);
            if (listeners.size === 0) {
              eventListeners.delete(event);
            }
            unsubscribe();
          };
        },
      };

      return handle;
    },

    /**
     * Alias for getHandle to retain existing call sites without schema validation.
     */
    getTypedHandle<
      T extends Rpc.ExposedMethods = Rpc.ExposedMethods,
      E extends Rpc.RpcEventMap = Rpc.RpcEventMap
    >(targetPanelId: string): Rpc.PanelRpcHandle<T, E> {
      return panelAPI.rpc.getHandle<T, E>(targetPanelId);
    },

    /**
     * Convenience helper: get a handle with typia-backed event validation enabled.
     * Useful during development to surface schema drift between panels.
     */
    getValidatedHandle<
      T extends Rpc.ExposedMethods = Rpc.ExposedMethods,
      E extends Rpc.RpcEventMap = Rpc.RpcEventMap
    >(targetPanelId: string): Rpc.PanelRpcHandle<T, E> {
      return panelAPI.rpc.getHandle<T, E>(targetPanelId, { validateEvents: true });
    },

    /**
     * Emit an event to a specific panel (must be parent or direct child).
     *
     * @example
     * ```ts
     * // Child notifies parent of a change
     * panelAPI.rpc.emit(parentPanelId, "contentChanged", { path: "/foo.txt" });
     * ```
     */
    async emit(targetPanelId: string, event: string, payload: unknown): Promise<void> {
      await bridge.rpc.emit(targetPanelId, event, payload);
    },

    /**
     * Subscribe to events from any panel (filtered by event name).
     * Use handle.on() for events from a specific panel.
     *
     * @example
     * ```ts
     * panelAPI.rpc.onEvent("contentChanged", (fromPanelId, payload) => {
     *   console.log(`Panel ${fromPanelId} changed:`, payload);
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
