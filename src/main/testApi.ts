/**
 * Test API for E2E testing.
 *
 * Exposes PanelOrchestrator + PanelRegistry methods to Playwright tests via Electron's evaluate().
 * Only loaded when NATSTACK_TEST_MODE=1 environment variable is set.
 */

import type { PanelOrchestrator } from "./panelOrchestrator.js";
import type { PanelRegistry } from "@natstack/shared/panelRegistry";
import type { PanelView } from "./panelView.js";
import type { Panel } from "@natstack/shared/types";
import { webContents as electronWebContents } from "electron";

export type PanelDiagnostic = {
  type: "console" | "did-fail-load" | "render-process-gone" | "unresponsive";
  level?: string;
  message: string;
  timestamp: number;
};

export interface PanelLayoutAudit {
  viewport: { width: number; height: number };
  document: { scrollWidth: number; scrollHeight: number };
  horizontalOverflow: Array<{
    tag: string;
    className: string;
    text: string;
    left: number;
    right: number;
    width: number;
  }>;
  verticalOverflow: Array<{
    tag: string;
    className: string;
    text: string;
    top: number;
    bottom: number;
    height: number;
  }>;
}

export interface TestApi {
  /** Get the full panel tree as a flat array */
  getPanelTree(): Panel[];

  /** Get root panels */
  getRootPanels(): Panel[];

  /** Get a specific panel by ID */
  getPanel(id: string): Panel | undefined;

  /** Get the currently focused panel ID */
  getFocusedPanelId(): string | null;

  /** Get the panel whose WebContents currently has Electron focus */
  getFocusedPanelWebContentsId(): string | null;

  /** Create a new panel */
  createPanel(
    parentId: string,
    source: string,
    options?: {
      name?: string;
      env?: Record<string, string>;
      focus?: boolean;
      stateArgs?: Record<string, unknown>;
    }
  ): Promise<{ id: string; title: string }>;

  /** Close a panel and all its children */
  closePanel(id: string): Promise<void>;

  /** Reload a panel in place */
  reloadPanel(id: string): Promise<void>;

  /** Check if a panel's view is loaded */
  isPanelLoaded(panelId: string): boolean;

  /** Read text content from a panel's WebContents */
  getPanelText(panelId: string): Promise<string>;

  /** Read HTML content from a panel's WebContents */
  getPanelHtml(panelId: string): Promise<string>;

  /** Start collecting panel WebContents diagnostics for test assertions */
  startPanelDiagnostics(panelId: string): Promise<void>;

  /** Read collected panel WebContents diagnostics */
  getPanelDiagnostics(panelId: string): PanelDiagnostic[];

  /** Return viewport and visible overflow diagnostics from a panel WebContents */
  getPanelLayoutAudit(panelId: string): Promise<PanelLayoutAudit>;

  /** Click an element inside a panel's WebContents */
  clickPanelSelector(panelId: string, selector: string): Promise<boolean>;

  /** Click an element matching selector and visible text inside a panel's WebContents */
  clickPanelText(panelId: string, selector: string, text: string): Promise<boolean>;

  /** Get an element center inside a panel translated to main-window coordinates */
  getPanelSelectorWindowPoint(
    panelId: string,
    selector: string
  ): Promise<{ x: number; y: number } | null>;

  /** Type text into a panel's WebContents using Electron input events */
  typePanelText(panelId: string, text: string): Promise<void>;

  /** Call the terminal panel's test bridge without depending on terminal DOM internals */
  callTerminalPanel(panelId: string, method: string, args?: unknown): Promise<unknown>;

  /** Call a server RPC through the panel orchestrator's verified path */
  rpcCall(service: string, method: string, args?: unknown[]): Promise<unknown>;

  /** Unload a panel's view (simulate disconnect/crash) */
  unloadPanel(panelId: string): void;

  /** Focus a panel */
  focusPanel(panelId: string): void;
}

declare global {
  var __testApi: TestApi | undefined;
}

/**
 * Set up the test API on the global object.
 * This is only called when NATSTACK_TEST_MODE=1.
 */
export function setupTestApi(
  panelOrchestrator: PanelOrchestrator,
  panelRegistry: PanelRegistry,
  panelView: PanelView | null
): void {
  if (process.env["NATSTACK_TEST_MODE"] !== "1") {
    return;
  }

  console.log("[TestApi] Setting up test API for E2E testing");
  const panelDiagnostics = new Map<
    string,
    {
      records: PanelDiagnostic[];
      cleanup: () => void;
    }
  >();

  const recordPanelDiagnostic = (
    panelId: string,
    diagnostic: Omit<PanelDiagnostic, "timestamp">
  ) => {
    const entry = panelDiagnostics.get(panelId);
    if (!entry) return;
    entry.records.push({ ...diagnostic, timestamp: Date.now() });
  };

  global.__testApi = {
    getPanelTree(): Panel[] {
      const result: Panel[] = [];
      const traverse = (panel: Panel) => {
        result.push(panel);
        for (const child of panel.children) {
          traverse(child);
        }
      };
      for (const root of panelRegistry.getRootPanels()) {
        traverse(root);
      }
      return result;
    },

    getRootPanels(): Panel[] {
      return panelRegistry.getRootPanels();
    },

    getPanel(id: string): Panel | undefined {
      return panelRegistry.getPanel(id);
    },

    getFocusedPanelId(): string | null {
      return panelRegistry.getFocusedPanelId();
    },

    getFocusedPanelWebContentsId(): string | null {
      const focused = electronWebContents.getFocusedWebContents();
      if (!focused || !panelView) return null;
      return panelView.findViewIdByWebContentsId(focused.id);
    },

    async createPanel(parentId, source, options) {
      const { stateArgs, ...createOptions } = options ?? {};
      return panelOrchestrator.createPanel(parentId, source, createOptions, stateArgs);
    },

    async closePanel(id) {
      return panelOrchestrator.closePanel(id);
    },

    async reloadPanel(id) {
      return panelOrchestrator.reloadPanel(id);
    },

    isPanelLoaded(panelId): boolean {
      if (!panelView) return false;
      const wc = panelView.getWebContents(panelId);
      return wc !== null && !wc.isDestroyed();
    },

    async getPanelText(panelId): Promise<string> {
      if (!panelView) throw new Error("PanelView not available");
      const wc = panelView.getWebContents(panelId);
      if (!wc || wc.isDestroyed()) throw new Error(`Panel WebContents not available: ${panelId}`);
      return wc.executeJavaScript("document.body?.innerText ?? ''", true) as Promise<string>;
    },

    async getPanelHtml(panelId): Promise<string> {
      if (!panelView) throw new Error("PanelView not available");
      const wc = panelView.getWebContents(panelId);
      if (!wc || wc.isDestroyed()) throw new Error(`Panel WebContents not available: ${panelId}`);
      return wc.executeJavaScript(
        "document.documentElement?.outerHTML ?? ''",
        true
      ) as Promise<string>;
    },

    async startPanelDiagnostics(panelId): Promise<void> {
      if (!panelView) throw new Error("PanelView not available");
      const wc = panelView.getWebContents(panelId);
      if (!wc || wc.isDestroyed()) throw new Error(`Panel WebContents not available: ${panelId}`);
      panelDiagnostics.get(panelId)?.cleanup();
      const records: PanelDiagnostic[] = [];
      panelDiagnostics.set(panelId, { records, cleanup: () => {} });

      const consoleMessage = (
        _event: Electron.Event,
        levelOrDetails: number | { level?: number | string; message?: string },
        message?: string,
        line?: number,
        sourceId?: string
      ) => {
        const level =
          typeof levelOrDetails === "object"
            ? String(levelOrDetails.level ?? "")
            : String(levelOrDetails);
        const text =
          typeof levelOrDetails === "object"
            ? String(levelOrDetails.message ?? "")
            : String(message ?? "");
        recordPanelDiagnostic(panelId, {
          type: "console",
          level,
          message: [text, sourceId ? `${sourceId}:${line ?? 0}` : ""].filter(Boolean).join(" @ "),
        });
      };
      const didFailLoad = (_event: Electron.Event, code: number, desc: string, url: string) => {
        recordPanelDiagnostic(panelId, {
          type: "did-fail-load",
          message: `${desc} (${code}) - ${url}`,
        });
      };
      const renderProcessGone = (
        _event: Electron.Event,
        details: Electron.RenderProcessGoneDetails
      ) => {
        recordPanelDiagnostic(panelId, {
          type: "render-process-gone",
          message: details.reason,
        });
      };
      const unresponsive = () => {
        recordPanelDiagnostic(panelId, {
          type: "unresponsive",
          message: "Panel became unresponsive",
        });
      };
      const destroyed = () => {
        panelDiagnostics.get(panelId)?.cleanup();
        panelDiagnostics.delete(panelId);
      };

      wc.on("console-message", consoleMessage);
      wc.on("did-fail-load", didFailLoad);
      wc.on("render-process-gone", renderProcessGone);
      wc.on("unresponsive", unresponsive);
      wc.once("destroyed", destroyed);

      panelDiagnostics.set(panelId, {
        records,
        cleanup: () => {
          if (!wc.isDestroyed()) {
            wc.off("console-message", consoleMessage);
            wc.off("did-fail-load", didFailLoad);
            wc.off("render-process-gone", renderProcessGone);
            wc.off("unresponsive", unresponsive);
            wc.off("destroyed", destroyed);
          }
        },
      });
    },

    getPanelDiagnostics(panelId): PanelDiagnostic[] {
      return [...(panelDiagnostics.get(panelId)?.records ?? [])];
    },

    async getPanelLayoutAudit(panelId): Promise<PanelLayoutAudit> {
      if (!panelView) throw new Error("PanelView not available");
      const wc = panelView.getWebContents(panelId);
      if (!wc || wc.isDestroyed()) throw new Error(`Panel WebContents not available: ${panelId}`);
      return wc.executeJavaScript(
        `
          (() => {
            const viewport = { width: window.innerWidth, height: window.innerHeight };
            const documentSize = {
              scrollWidth: document.documentElement.scrollWidth,
              scrollHeight: document.documentElement.scrollHeight,
            };
            const describe = (node, rect) => ({
              tag: node.tagName.toLowerCase(),
              className: typeof node.className === "string" ? node.className : "",
              text: (node.innerText || node.textContent || "").trim().replace(/\\s+/g, " ").slice(0, 80),
              left: Math.round(rect.left),
              right: Math.round(rect.right),
              top: Math.round(rect.top),
              bottom: Math.round(rect.bottom),
              width: Math.round(rect.width),
              height: Math.round(rect.height),
            });
            const horizontalOverflow = [];
            const verticalOverflow = [];
            for (const node of document.body.querySelectorAll("*")) {
              if (!(node instanceof HTMLElement)) continue;
              const style = window.getComputedStyle(node);
              if (style.display === "none" || style.visibility === "hidden") continue;
              const rect = node.getBoundingClientRect();
              if (rect.width <= 0 || rect.height <= 0) continue;
              if (rect.right > viewport.width + 2 || rect.left < -2) {
                horizontalOverflow.push(describe(node, rect));
              }
              const isPositioned = style.position !== "static" && style.position !== "relative";
              if (
                isPositioned &&
                (rect.bottom > viewport.height + 2 || rect.top < -2)
              ) {
                verticalOverflow.push(describe(node, rect));
              }
            }
            return {
              viewport,
              document: documentSize,
              horizontalOverflow: horizontalOverflow.slice(0, 20),
              verticalOverflow: verticalOverflow.slice(0, 20),
            };
          })()
        `,
        true
      ) as Promise<PanelLayoutAudit>;
    },

    async clickPanelSelector(panelId, selector): Promise<boolean> {
      if (!panelView) throw new Error("PanelView not available");
      const wc = panelView.getWebContents(panelId);
      if (!wc || wc.isDestroyed()) throw new Error(`Panel WebContents not available: ${panelId}`);
      const rect = (await wc.executeJavaScript(
        `
          (() => {
            const node = document.querySelector(${JSON.stringify(selector)});
            if (!(node instanceof HTMLElement)) return false;
            const rect = node.getBoundingClientRect();
            return {
              x: Math.round(rect.left + rect.width / 2),
              y: Math.round(rect.top + rect.height / 2),
            };
          })()
        `,
        true
      )) as false | { x: number; y: number };
      if (!rect) return false;
      wc.focus();
      wc.sendInputEvent({ type: "mouseDown", x: rect.x, y: rect.y, button: "left", clickCount: 1 });
      wc.sendInputEvent({ type: "mouseUp", x: rect.x, y: rect.y, button: "left", clickCount: 1 });
      return true;
    },

    async clickPanelText(panelId, selector, text): Promise<boolean> {
      if (!panelView) throw new Error("PanelView not available");
      const wc = panelView.getWebContents(panelId);
      if (!wc || wc.isDestroyed()) throw new Error(`Panel WebContents not available: ${panelId}`);
      return wc.executeJavaScript(
        `
          (() => {
            const nodes = Array.from(document.querySelectorAll(${JSON.stringify(selector)}));
            const node = nodes.find((item) => item instanceof HTMLElement && item.innerText.trim() === ${JSON.stringify(text)});
            if (!(node instanceof HTMLElement)) return false;
            node.click();
            return true;
          })()
        `,
        true
      ) as Promise<boolean>;
    },

    async getPanelSelectorWindowPoint(panelId, selector): Promise<{ x: number; y: number } | null> {
      if (!panelView) throw new Error("PanelView not available");
      const wc = panelView.getWebContents(panelId);
      if (!wc || wc.isDestroyed()) throw new Error(`Panel WebContents not available: ${panelId}`);
      const viewInfo = panelView.getViewManager().getViewInfo(panelId);
      if (!viewInfo) throw new Error(`Panel view info not available: ${panelId}`);
      const rect = (await wc.executeJavaScript(
        `
          (() => {
            const node = document.querySelector(${JSON.stringify(selector)});
            if (!(node instanceof HTMLElement)) return null;
            const rect = node.getBoundingClientRect();
            if (rect.width <= 0 || rect.height <= 0) return null;
            return {
              x: Math.round(rect.left + rect.width / 2),
              y: Math.round(rect.top + rect.height / 2),
            };
          })()
        `,
        true
      )) as null | { x: number; y: number };
      if (!rect) return null;
      return {
        x: viewInfo.bounds.x + rect.x,
        y: viewInfo.bounds.y + rect.y,
      };
    },

    async typePanelText(panelId, text): Promise<void> {
      if (!panelView) throw new Error("PanelView not available");
      const wc = panelView.getWebContents(panelId);
      if (!wc || wc.isDestroyed()) throw new Error(`Panel WebContents not available: ${panelId}`);
      wc.focus();
      for (const char of text) {
        if (char === "\r" || char === "\n") {
          wc.sendInputEvent({ type: "keyDown", keyCode: "Enter" });
          wc.sendInputEvent({ type: "keyUp", keyCode: "Enter" });
          continue;
        }
        if (char === "\b") {
          wc.sendInputEvent({ type: "keyDown", keyCode: "Backspace" });
          wc.sendInputEvent({ type: "keyUp", keyCode: "Backspace" });
          continue;
        }
        if (char === "\t") {
          wc.sendInputEvent({ type: "keyDown", keyCode: "Tab" });
          wc.sendInputEvent({ type: "keyUp", keyCode: "Tab" });
          continue;
        }
        if (char === "\u0003") {
          wc.sendInputEvent({ type: "keyDown", keyCode: "C", modifiers: ["control"] });
          wc.sendInputEvent({ type: "keyUp", keyCode: "C", modifiers: ["control"] });
          continue;
        }
        if (char === "\u0015") {
          wc.sendInputEvent({ type: "keyDown", keyCode: "U", modifiers: ["control"] });
          wc.sendInputEvent({ type: "keyUp", keyCode: "U", modifiers: ["control"] });
          continue;
        }
        wc.sendInputEvent({ type: "char", keyCode: char });
      }
    },

    async callTerminalPanel(panelId, method, args): Promise<unknown> {
      if (!panelView) throw new Error("PanelView not available");
      const wc = panelView.getWebContents(panelId);
      if (!wc || wc.isDestroyed()) throw new Error(`Panel WebContents not available: ${panelId}`);
      const result = (await wc.executeJavaScript(
        `
          (() => {
            const api = window.__natstackTerminalTestApi;
            if (!api) {
              return { __natstackOk: false, error: "terminal test API not found" };
            }
            const fn = api[${JSON.stringify(method)}];
            if (typeof fn !== "function") {
              return { __natstackOk: false, error: "terminal test API method not found: ${method.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}" };
            }
            return Promise.resolve(fn.call(api, ${JSON.stringify(args)}))
              .then((value) => ({ __natstackOk: true, value }))
              .catch((err) => ({ __natstackOk: false, error: err instanceof Error ? err.message : String(err) }));
          })()
        `,
        true
      )) as { __natstackOk: true; value: unknown } | { __natstackOk: false; error: string };
      if (!result.__natstackOk) throw new Error(result.error);
      return result.value;
    },

    async rpcCall(service, method, args = []): Promise<unknown> {
      return panelOrchestrator.callServer(service, method, args);
    },

    unloadPanel(panelId): void {
      if (!panelView) return;
      const wc = panelView.getWebContents(panelId);
      if (wc && !wc.isDestroyed()) {
        wc.close();
      }
    },

    focusPanel(panelId): void {
      panelRegistry.updateSelectedPath(panelId);
    },
  };
}

/**
 * Clean up the test API.
 */
export function cleanupTestApi(): void {
  if (global.__testApi) {
    delete global.__testApi;
  }
}
