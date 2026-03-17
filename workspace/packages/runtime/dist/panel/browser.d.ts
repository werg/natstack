/**
 * Browser panel API — create and control external-URL panels with CDP access.
 *
 * Primary automation path: `createBrowserPanel(url)` returns a `BrowserHandle`
 * with typed methods for navigation and CDP endpoint retrieval.
 *
 * Fire-and-forget path: `window.open("https://...")` in Electron mode also
 * creates browser panels; the parent is notified via `onChildCreated`.
 *
 * System browser escape hatch: `openExternal(url)` opens in the OS browser.
 */
import type { RpcBridge } from "@natstack/rpc";
export interface BrowserHandle {
    readonly id: string;
    readonly title: string;
    getCdpEndpoint(): Promise<string>;
    navigate(url: string): Promise<void>;
    goBack(): Promise<void>;
    goForward(): Promise<void>;
    reload(): Promise<void>;
    stop(): Promise<void>;
    close(): Promise<void>;
}
/** @internal Called once from panel/index.ts to inject the RPC bridge. */
export declare function _initBrowserBridge(rpc: RpcBridge): void;
/**
 * Create a browser panel that loads an external URL.
 * Returns a `BrowserHandle` for navigation control and CDP access.
 */
export declare function createBrowserPanel(url: string, options?: {
    name?: string;
    focus?: boolean;
}): Promise<BrowserHandle>;
/**
 * Open a URL in the system browser (no CDP access).
 */
export declare function openExternal(url: string): Promise<void>;
/**
 * Subscribe to `child-created` events (fired when `window.open` creates a
 * browser panel in Electron mode). Returns an unsubscribe function.
 */
export declare function onChildCreated(handler: (info: {
    childId: string;
    url: string;
}) => void): () => void;
/**
 * Get a `BrowserHandle` for an existing browser panel by ID.
 * Useful after discovering a child via `onChildCreated`.
 */
export declare function getBrowserHandle(id: string, title?: string): BrowserHandle;
//# sourceMappingURL=browser.d.ts.map