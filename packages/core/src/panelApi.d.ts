/**
 * Panel API for NatStack panels.
 *
 * This module provides the browser-side API for panels to interact with
 * the NatStack framework, including child management, RPC, theme, and git.
 */
import type { ComponentType, ReactNode } from "react";
import * as Rpc from "./types.js";
import type { ChildSpec as SharedChildSpec, AppChildSpec as SharedAppChildSpec, WorkerChildSpec as SharedWorkerChildSpec, BrowserChildSpec as SharedBrowserChildSpec, GitConfig as SharedGitConfig, RpcHandleOptions } from "./index.js";
export type ChildSpec = SharedChildSpec;
export type AppChildSpec = SharedAppChildSpec;
export type WorkerChildSpec = SharedWorkerChildSpec;
export type BrowserChildSpec = SharedBrowserChildSpec;
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
    getInfo(): Promise<{
        panelId: string;
        partition: string;
    }>;
    on(event: PanelBridgeEvent, listener: (payload?: unknown) => void): () => void;
    getTheme(): PanelThemeAppearance;
    onThemeChange(listener: (theme: PanelThemeAppearance) => void): () => void;
    rpc: PanelRpcBridge;
}
declare global {
    interface Window {
        __natstackPanelBridge?: PanelBridge;
    }
}
type AsyncResult<T> = Promise<T>;
declare const panelAPI: {
    getId(): string;
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
    createChild(spec: ChildSpec): AsyncResult<string>;
    removeChild(childId: string): AsyncResult<void>;
    setTitle(title: string): AsyncResult<void>;
    close(): AsyncResult<void>;
    onChildRemoved(callback: (childId: string) => void): () => void;
    onFocus(callback: () => void): () => void;
    getTheme(): PanelTheme;
    onThemeChange(callback: (theme: PanelTheme) => void): () => void;
    getEnv(): AsyncResult<Record<string, string>>;
    getInfo(): AsyncResult<{
        panelId: string;
        partition: string;
    }>;
    getPartition(): AsyncResult<string>;
    getPanelId(): AsyncResult<string>;
    git: {
        /**
         * Get git configuration for this panel.
         * Use with @natstack/git to clone/pull repos into OPFS.
         */
        getConfig(): AsyncResult<GitConfig>;
    };
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
        getCdpEndpoint(browserId: string): AsyncResult<string>;
        /**
         * Navigate browser panel to a URL (human UI control).
         */
        navigate(browserId: string, url: string): AsyncResult<void>;
        /**
         * Go back in browser history.
         */
        goBack(browserId: string): AsyncResult<void>;
        /**
         * Go forward in browser history.
         */
        goForward(browserId: string): AsyncResult<void>;
        /**
         * Reload the current page.
         */
        reload(browserId: string): AsyncResult<void>;
        /**
         * Stop loading the current page.
         */
        stop(browserId: string): AsyncResult<void>;
    };
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
        expose<T extends Rpc.ExposedMethods>(methods: T): void;
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
        getHandle<T extends Rpc.ExposedMethods = Rpc.ExposedMethods, E extends Rpc.RpcEventMap = Rpc.RpcEventMap>(targetPanelId: string, options?: PanelRpcHandleOptions): Rpc.PanelRpcHandle<T, E>;
        /**
         * Alias for getHandle to retain existing call sites without schema validation.
         */
        getTypedHandle<T extends Rpc.ExposedMethods = Rpc.ExposedMethods, E extends Rpc.RpcEventMap = Rpc.RpcEventMap>(targetPanelId: string): Rpc.PanelRpcHandle<T, E>;
        /**
         * Convenience helper: get a handle with typia-backed event validation enabled.
         * Useful during development to surface schema drift between panels.
         */
        getValidatedHandle<T extends Rpc.ExposedMethods = Rpc.ExposedMethods, E extends Rpc.RpcEventMap = Rpc.RpcEventMap>(targetPanelId: string): Rpc.PanelRpcHandle<T, E>;
        /**
         * Emit an event to a specific panel (must be parent or direct child).
         *
         * @example
         * ```ts
         * // Child notifies parent of a change
         * panelAPI.rpc.emit(parentPanelId, "contentChanged", { path: "/foo.txt" });
         * ```
         */
        emit(targetPanelId: string, event: string, payload: unknown): Promise<void>;
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
        onEvent(event: string, listener: (fromPanelId: string, payload: unknown) => void): () => void;
    };
};
export type PanelAPI = typeof panelAPI;
export default panelAPI;
export type { Rpc };
type ReactNamespace = typeof import("react");
type RadixThemeComponent = ComponentType<{
    appearance: PanelThemeAppearance;
    children?: ReactNode;
}>;
export declare function createRadixThemeProvider(ReactLib: ReactNamespace, ThemeComponent: RadixThemeComponent): ({ children }: {
    children?: ReactNode;
}) => ReactNode;
//# sourceMappingURL=panelApi.d.ts.map