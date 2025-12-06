/**
 * Panel API for NatStack panels.
 *
 * This module provides the browser-side API for panels to interact with
 * the NatStack framework, including child management, RPC, theme, and git.
 */
import typia from "typia";
const getBridge = () => {
    const bridge = window.__natstackPanelBridge;
    if (!bridge) {
        throw new Error("NatStack panel bridge is not available");
    }
    return bridge;
};
const bridge = getBridge();
let currentTheme = { appearance: bridge.getTheme() };
const themeListeners = new Set();
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
        }
        catch (err) {
            // Silently fail if quota API not available
        }
    })();
}
const panelAPI = {
    getId() {
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
    async createChild(spec) {
        return bridge.createChild(spec);
    },
    async removeChild(childId) {
        return bridge.removeChild(childId);
    },
    async setTitle(title) {
        return bridge.setTitle(title);
    },
    async close() {
        return bridge.close();
    },
    onChildRemoved(callback) {
        return bridge.on("child-removed", (payload) => {
            if (typeof payload === "string") {
                callback(payload);
            }
        });
    },
    onFocus(callback) {
        return bridge.on("focus", () => callback());
    },
    getTheme() {
        return currentTheme;
    },
    onThemeChange(callback) {
        callback(currentTheme);
        themeListeners.add(callback);
        return () => {
            themeListeners.delete(callback);
        };
    },
    async getEnv() {
        return bridge.getEnv();
    },
    async getInfo() {
        return bridge.getInfo();
    },
    async getPartition() {
        const info = await bridge.getInfo();
        return info.partition;
    },
    async getPanelId() {
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
        async getConfig() {
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
        async getCdpEndpoint(browserId) {
            return bridge.browser.getCdpEndpoint(browserId);
        },
        /**
         * Navigate browser panel to a URL (human UI control).
         */
        async navigate(browserId, url) {
            return bridge.browser.navigate(browserId, url);
        },
        /**
         * Go back in browser history.
         */
        async goBack(browserId) {
            return bridge.browser.goBack(browserId);
        },
        /**
         * Go forward in browser history.
         */
        async goForward(browserId) {
            return bridge.browser.goForward(browserId);
        },
        /**
         * Reload the current page.
         */
        async reload(browserId) {
            return bridge.browser.reload(browserId);
        },
        /**
         * Stop loading the current page.
         */
        async stop(browserId) {
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
        expose(methods) {
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
        getHandle(targetPanelId, options) {
            // Create a proxy that allows typed method calls
            const callProxy = new Proxy({}, {
                get(_target, prop) {
                    return async (...args) => {
                        return bridge.rpc.call(targetPanelId, prop, ...args);
                    };
                },
            });
            const eventListeners = new Map();
            const validateEvents = options?.validateEvents ?? false;
            const eventValidators = new Map();
            const getValidator = validateEvents
                ? (event) => {
                    if (!eventValidators.has(event)) {
                        let assertPayload;
                        try {
                            assertPayload = typia.createAssert();
                        }
                        catch (error) {
                            console.warn(`[Panel RPC] Falling back to unvalidated events for "${event}":`, error);
                            assertPayload = () => { };
                        }
                        eventValidators.set(event, assertPayload);
                    }
                    return eventValidators.get(event);
                }
                : null;
            // Create the handle with proper overload support
            const handle = {
                panelId: targetPanelId,
                call: callProxy,
                on(event, handler) {
                    // Track local listeners for this handle
                    const listeners = eventListeners.get(event) ?? new Set();
                    listeners.add(handler);
                    eventListeners.set(event, listeners);
                    // Subscribe to RPC events, filtering by source panel
                    const unsubscribe = bridge.rpc.onEvent(event, (fromPanelId, payload) => {
                        if (fromPanelId === targetPanelId) {
                            try {
                                if (getValidator) {
                                    const assertPayload = getValidator(event);
                                    assertPayload(payload);
                                }
                            }
                            catch (error) {
                                console.error(`[Panel RPC] Event payload validation failed for "${event}" from ${fromPanelId}:`, error);
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
        getTypedHandle(targetPanelId) {
            return panelAPI.rpc.getHandle(targetPanelId);
        },
        /**
         * Convenience helper: get a handle with typia-backed event validation enabled.
         * Useful during development to surface schema drift between panels.
         */
        getValidatedHandle(targetPanelId) {
            return panelAPI.rpc.getHandle(targetPanelId, { validateEvents: true });
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
        async emit(targetPanelId, event, payload) {
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
        onEvent(event, listener) {
            return bridge.rpc.onEvent(event, listener);
        },
    },
};
export default panelAPI;
export function createRadixThemeProvider(ReactLib, ThemeComponent) {
    return function NatstackRadixThemeProvider({ children }) {
        const [theme, setTheme] = ReactLib.useState(panelAPI.getTheme());
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
//# sourceMappingURL=panelApi.js.map