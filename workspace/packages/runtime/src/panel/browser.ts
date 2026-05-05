/**
 * Browser panel API — create and control external-URL panels with CDP access.
 *
 * Primary automation path:
 *   const handle = await createBrowserPanel("https://example.com");
 *   const page = await handle.page();
 *   await page.click("button");
 *
 * The `page()` method connects Playwright via CDP automatically —
 * no manual CDP endpoint or sleep needed.
 *
 * Fire-and-forget path: `window.open("https://...")` in Electron mode also
 * creates browser panels; the parent is notified via `onChildCreated`.
 *
 * System browser escape hatch: `openExternal(url)` opens in the OS browser.
 */

import type { RpcBridge } from "@natstack/rpc";
import type { OpenExternalOptions, OpenExternalResult } from "@natstack/shared/externalOpen";
import { buildPanelLink } from "../core/panelLinks.js";

export interface BrowserHandle {
  readonly id: string;
  readonly title: string;
  /**
   * Connect Playwright and return the page. No manual sleep or CDP endpoint needed.
   * The returned page has methods: goto, evaluate, click, fill, type,
   * waitForSelector, querySelector, screenshot, title, content, close.
   */
  page(): Promise<any>;
  getCdpEndpoint(): Promise<string>;
  navigate(url: string): Promise<void>;
  goBack(): Promise<void>;
  goForward(): Promise<void>;
  reload(): Promise<void>;
  stop(): Promise<void>;
  close(): Promise<void>;
}

let _rpc: RpcBridge | null = null;
const shell = (globalThis as any).__natstackShell ?? (globalThis as any).__natstackElectron;

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
  const result = await shell.createBrowserPanel(url, options) as { id: string; title: string };
  return makeBrowserHandle(getRpc(), result.id, result.title);
}

/**
 * Open a URL in the system browser (no CDP access).
 */
export async function openExternal(url: string, options?: OpenExternalOptions): Promise<OpenExternalResult> {
  return getRpc().call<OpenExternalResult>("main", "externalOpen.openExternal", url, options);
}

/**
 * Subscribe to `child-created` events (fired when `window.open` creates a
 * browser panel in Electron mode). Returns an unsubscribe function.
 */
export function onChildCreated(
  handler: (info: { childId: string; url: string }) => void,
): () => void {
  // In Electron mode, child-created events come via __natstackElectron IPC.
  // In standalone mode, they come via the server WS (rpc.onEvent).
  const unsubs: Array<() => void> = [];

  if (shell?.addEventListener) {
    const listenerId = shell.addEventListener((event: string, payload: unknown) => {
      if (event === "runtime:child-created") {
        const data = payload as { childId?: string; url?: string } | null;
        if (data?.childId && data?.url) {
          handler({ childId: data.childId, url: data.url });
        }
      }
    });
    unsubs.push(() => shell.removeEventListener(listenerId));
  }

  // Also listen on RPC events (works in both modes; standalone relies on this)
  const rpc = getRpc();
  unsubs.push(rpc.onEvent("runtime:child-created", (_fromId, payload) => {
    const data = payload as { childId?: string; url?: string } | null;
    if (data?.childId && data?.url) {
      handler({ childId: data.childId, url: data.url });
    }
  }));

  return () => { for (const unsub of unsubs) unsub(); };
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
    async page() {
      const require = (globalThis as Record<string, unknown>)["__natstackRequire__"] as
        | ((id: string) => { BrowserImpl: { connect(ws: string, opts: object): Promise<any> } })
        | undefined;
      if (!require) {
        throw new Error("handle.page() requires __natstackRequire__ (panel runtime)");
      }
      const { BrowserImpl } = require("@workspace/playwright-client");
      let wsEndpoint: string;
      if (shell?.getCdpEndpoint) {
        wsEndpoint = await shell.getCdpEndpoint(id);
      } else {
        wsEndpoint = await rpc.call<string>("main", "browser.getCdpEndpoint", id);
      }
      const browser = await BrowserImpl.connect(wsEndpoint, { isElectronWebview: true });
      const page = browser.contexts()[0]?.pages()[0];
      if (!page) throw new Error("No page found in browser panel");
      return page;
    },
    getCdpEndpoint: () => {
      if (shell?.getCdpEndpoint) return shell.getCdpEndpoint(id);
      return rpc.call<string>("main", "browser.getCdpEndpoint", id);
    },
    navigate: (u) => {
      if (shell?.navigate) return shell.navigate(id, u);
      return rpc.call<void>("main", "browser.navigate", id, u);
    },
    goBack: () => {
      if (shell?.goBack) return shell.goBack(id);
      return rpc.call<void>("main", "browser.goBack", id);
    },
    goForward: () => {
      if (shell?.goForward) return shell.goForward(id);
      return rpc.call<void>("main", "browser.goForward", id);
    },
    reload: () => {
      if (shell?.reload) return shell.reload(id);
      return rpc.call<void>("main", "browser.reload", id);
    },
    stop: () => {
      if (shell?.stop) return shell.stop(id);
      return rpc.call<void>("main", "browser.stop", id);
    },
    close: () => {
      return shell.closeChild(id);
    },
  };
}
