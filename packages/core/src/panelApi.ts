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
  ChildSpec as SharedChildSpec,
  AppChildSpec as SharedAppChildSpec,
  WorkerChildSpec as SharedWorkerChildSpec,
  BrowserChildSpec as SharedBrowserChildSpec,
  GitConfig as SharedGitConfig,
  RpcHandleOptions,
} from "./index.js";

// Re-export shared types
export type ChildSpec = SharedChildSpec;
export type AppChildSpec = SharedAppChildSpec;
export type WorkerChildSpec = SharedWorkerChildSpec;
export type BrowserChildSpec = SharedBrowserChildSpec;
export type GitConfig = SharedGitConfig;
export type PanelRpcHandleOptions = RpcHandleOptions;

// =============================================================================
// Unified ViewChild API Types
// =============================================================================

/**
 * Options for creating a view child (panel or browser).
 * Uses source discriminator: `url` for browsers, `panel` for app panels.
 */
export interface CreateViewChildOptions {
  /** Unique name within parent (used for ID generation) */
  name: string;
  /** Display title (defaults to name) */
  title?: string;
  /** Environment variables to pass */
  env?: Record<string, string>;

  // Source - exactly one of:
  /** External URL → creates browser view */
  url?: string;
  /** Panel path → creates app panel view */
  panel?: string;
}

/**
 * Unified handle for managing child views (both panels and browsers).
 * Provides consistent API for CDP automation, screenshots, and lifecycle.
 */
export interface ViewChild {
  /** Unique view ID */
  id: string;
  /** View type discriminator */
  type: "browser" | "panel";
  /** Name within parent */
  name: string;
  /** Display title */
  title: string;

  /** Get CDP WebSocket endpoint for automation (works for both panel and browser) */
  getCdpEndpoint(): Promise<string>;

  /** Close the view */
  close(): Promise<void>;
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
   * Create a child panel, worker, or browser from a spec.
   * The main process handles git checkout and build for app/worker types.
   * Returns the panel ID immediately; build happens asynchronously.
   *
   * @param spec - Child specification with type discriminator
   * @returns Panel ID that can be used for communication
   *
   * @example
   * ```ts
   * // Create an app panel
   * const editorId = await panel.createChild({
   *   type: 'app',
   *   name: 'editor',
   *   path: 'panels/editor',
   *   env: { FILE_PATH: '/foo.txt' },
   * });
   *
   * // Create a worker
   * const computeId = await panel.createChild({
   *   type: 'worker',
   *   name: 'compute-worker',
   *   path: 'workers/compute',
   *   memoryLimitMB: 512,
   * });
   *
   * // Create a browser panel
   * const browserId = await panel.createChild({
   *   type: 'browser',
   *   name: 'web-scraper',
   *   url: 'https://example.com',
   * });
   * ```
   */
  async createChild(spec: ChildSpec): AsyncResult<string> {
    return bridge.createChild(spec);
  },

  async removeChild(childId: string): AsyncResult<void> {
    return bridge.removeChild(childId);
  },

  /**
   * Create a unified view child (panel or browser).
   * This is the recommended API for creating child views.
   *
   * @param options - Options with either `url` (browser) or `panel` (app panel)
   * @returns ViewChild handle for managing the view
   *
   * @example
   * ```ts
   * // Create a browser view
   * const browser = await panel.createViewChild({
   *   name: "web-scraper",
   *   url: "https://example.com",
   * });
   * const cdpUrl = await browser.getCdpEndpoint();
   *
   * // Create an app panel view
   * const subPanel = await panel.createViewChild({
   *   name: "editor",
   *   panel: "panels/code-editor",
   *   env: { FILE_PATH: "/foo.txt" },
   * });
   * const panelCdp = await subPanel.getCdpEndpoint();
   * ```
   */
  async createViewChild(options: CreateViewChildOptions): AsyncResult<ViewChild> {
    // Validate: exactly one of url or panel must be provided
    if (options.url && options.panel) {
      throw new Error("Cannot specify both 'url' and 'panel' - choose one");
    }
    if (!options.url && !options.panel) {
      throw new Error("Must specify either 'url' (browser) or 'panel' (app panel)");
    }

    // Convert to ChildSpec and create
    let childId: string;
    let childType: "browser" | "panel";

    if (options.url) {
      childType = "browser";
      childId = await bridge.createChild({
        type: "browser",
        name: options.name,
        title: options.title,
        url: options.url,
        env: options.env,
      });
    } else {
      childType = "panel";
      childId = await bridge.createChild({
        type: "app",
        name: options.name,
        path: options.panel!,
        env: options.env,
      });
    }

    // Return ViewChild handle
    const viewChild: ViewChild = {
      id: childId,
      type: childType,
      name: options.name,
      title: options.title ?? options.name,

      async getCdpEndpoint(): Promise<string> {
        return bridge.browser.getCdpEndpoint(childId);
      },

      async close(): Promise<void> {
        return bridge.removeChild(childId);
      },
    };

    return viewChild;
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
  // Browser Panel Operations
  // ===========================================================================

  browser: {
    /**
     * Get CDP WebSocket endpoint for Playwright connection.
     * Only the parent panel that created the browser can access this.
     *
     * @param browserId - The browser panel's ID
     * @returns WebSocket URL for CDP connection (e.g., ws://localhost:63525/browser-id?token=xyz)
     *
     * @example
     * ```ts
     * import { chromium } from 'playwright-core';
     *
     * const browserId = await panel.createChild({
     *   type: 'browser',
     *   name: 'automation-target',
     *   url: 'https://example.com',
     * });
     *
     * const cdpUrl = await panel.browser.getCdpEndpoint(browserId);
     * const browser = await chromium.connectOverCDP(cdpUrl);
     * const page = browser.contexts()[0].pages()[0];
     * await page.click('.button');
     * ```
     */
    async getCdpEndpoint(browserId: string): AsyncResult<string> {
      return bridge.browser.getCdpEndpoint(browserId);
    },

    /**
     * Navigate browser panel to a URL (human UI control).
     */
    async navigate(browserId: string, url: string): AsyncResult<void> {
      return bridge.browser.navigate(browserId, url);
    },

    /**
     * Go back in browser history.
     */
    async goBack(browserId: string): AsyncResult<void> {
      return bridge.browser.goBack(browserId);
    },

    /**
     * Go forward in browser history.
     */
    async goForward(browserId: string): AsyncResult<void> {
      return bridge.browser.goForward(browserId);
    },

    /**
     * Reload the current page.
     */
    async reload(browserId: string): AsyncResult<void> {
      return bridge.browser.reload(browserId);
    },

    /**
     * Stop loading the current page.
     */
    async stop(browserId: string): AsyncResult<void> {
      return bridge.browser.stop(browserId);
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
