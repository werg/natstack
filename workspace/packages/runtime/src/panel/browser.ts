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
import { buildPanelLink } from "../core/panelLinks.js";

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

let _rpc: RpcBridge | null = null;

/** @internal Called once from panel/index.ts to inject the RPC bridge. */
export function _initBrowserBridge(rpc: RpcBridge): void {
  _rpc = rpc;
}

function getRpc(): RpcBridge {
  if (!_rpc) throw new Error("Browser bridge not initialized");
  return _rpc;
}

/**
 * Create a browser panel that loads an external URL.
 * Returns a `BrowserHandle` for navigation control and CDP access.
 */
export async function createBrowserPanel(
  url: string,
  options?: { name?: string; focus?: boolean },
): Promise<BrowserHandle> {
  const rpc = getRpc();
  const { id, title } = await rpc.call<{ id: string; title: string }>(
    "main",
    "bridge.createBrowserPanel",
    url,
    options,
  );
  return makeBrowserHandle(rpc, id, title);
}

/**
 * Open a URL in the system browser (no CDP access).
 */
export async function openExternal(url: string): Promise<void> {
  await getRpc().call<void>("main", "bridge.openExternal", url);
}

/**
 * Subscribe to `child-created` events (fired when `window.open` creates a
 * browser panel in Electron mode). Returns an unsubscribe function.
 */
export function onChildCreated(
  handler: (info: { childId: string; url: string }) => void,
): () => void {
  const rpc = getRpc();
  return rpc.onEvent("runtime:child-created", (_fromId, payload) => {
    const data = payload as { childId?: string; url?: string } | null;
    if (data?.childId && data?.url) {
      handler({ childId: data.childId, url: data.url });
    }
  });
}

/**
 * Get a `BrowserHandle` for an existing browser panel by ID.
 * Useful after discovering a child via `onChildCreated`.
 */
export function getBrowserHandle(id: string, title?: string): BrowserHandle {
  return makeBrowserHandle(getRpc(), id, title ?? id);
}

/**
 * Open a panel by source path or URL.
 *
 * - For http/https URLs, creates a browser panel via {@link createBrowserPanel}.
 * - For workspace panel sources (e.g. "panels/my-app"), builds a panel link
 *   and opens it via `window.open`.
 *
 * @returns For browser panels, resolves with `{ id }` of the new panel.
 *          For workspace panels, resolves with `void`.
 */
export async function openPanel(
  source: string,
  options?: { name?: string; focus?: boolean; stateArgs?: Record<string, unknown> },
): Promise<{ id: string } | void> {
  if (/^https?:\/\//i.test(source)) {
    const handle = await createBrowserPanel(source, {
      name: options?.name,
      focus: options?.focus ?? true,
    });
    return { id: handle.id };
  }
  // For workspace panels, use buildPanelLink + window.open
  const link = buildPanelLink(source, {
    stateArgs: options?.stateArgs,
    name: options?.name,
    focus: options?.focus ?? true,
  });
  window.open(link);
}

function makeBrowserHandle(rpc: RpcBridge, id: string, title: string): BrowserHandle {
  return {
    id,
    title,
    getCdpEndpoint: () => rpc.call<string>("main", "browser.getCdpEndpoint", id),
    navigate: (u) => rpc.call<void>("main", "browser.navigate", id, u),
    goBack: () => rpc.call<void>("main", "browser.goBack", id),
    goForward: () => rpc.call<void>("main", "browser.goForward", id),
    reload: () => rpc.call<void>("main", "browser.reload", id),
    stop: () => rpc.call<void>("main", "browser.stop", id),
    close: () => rpc.call<void>("main", "bridge.closeChild", id),
  };
}
