import type { ComponentType, ReactNode } from "react";
import * as Rpc from "../shared/ipc/panelRpc.js";

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
  createChild(
    path: string,
    env?: Record<string, string>,
    requestedPanelId?: string
  ): Promise<string>;
  removeChild(childId: string): Promise<void>;
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

export interface CreateChildOptions {
  env?: Record<string, string>;
  panelId?: string;
}

const panelAPI = {
  getId(): string {
    return bridge.panelId;
  },

  async createChild(path: string, options?: CreateChildOptions): AsyncResult<string> {
    try {
      return await bridge.createChild(path, options?.env, options?.panelId);
    } catch (error) {
      console.error("Failed to create child panel", error);
      throw error;
    }
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
     * // Parent panel calls child
     * const childHandle = panelAPI.rpc.getHandle<EditorApi>(childPanelId);
     * const content = await childHandle.call.getContent();
     * ```
     */
    getHandle<T extends Rpc.ExposedMethods = Rpc.ExposedMethods>(
      targetPanelId: string
    ): Rpc.PanelRpcHandle<T> {
      // Create a proxy that allows typed method calls
      const callProxy = new Proxy({} as Rpc.PanelRpcHandle<T>["call"], {
        get(_target, prop: string) {
          return async (...args: unknown[]) => {
            return bridge.rpc.call(targetPanelId, prop, ...args);
          };
        },
      });

      const eventListeners = new Map<string, Set<(payload: unknown) => void>>();

      return {
        panelId: targetPanelId,
        call: callProxy,
        on(event: string, handler: (payload: unknown) => void): () => void {
          // Track local listeners for this handle
          const listeners = eventListeners.get(event) ?? new Set();
          listeners.add(handler);
          eventListeners.set(event, listeners);

          // Subscribe to RPC events, filtering by source panel
          const unsubscribe = bridge.rpc.onEvent(event, (fromPanelId, payload) => {
            if (fromPanelId === targetPanelId) {
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
    },

    /**
     * Alias for getHandle to retain existing call sites without schema validation.
     */
    getTypedHandle<T extends Rpc.ExposedMethods = Rpc.ExposedMethods>(
      targetPanelId: string
    ): Rpc.PanelRpcHandle<T> {
      return panelAPI.rpc.getHandle<T>(targetPanelId);
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
