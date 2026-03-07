/**
 * Test API for E2E testing.
 *
 * Exposes PanelLifecycle + PanelRegistry methods to Playwright tests via Electron's evaluate().
 * Only loaded when NATSTACK_TEST_MODE=1 environment variable is set.
 */

import type { PanelLifecycle } from "../shared/panelLifecycle.js";
import type { PanelRegistry } from "../shared/panelRegistry.js";
import type { PanelView } from "./panelView.js";
import type { Panel } from "../shared/types.js";

export interface TestApi {
  /** Get the full panel tree as a flat array */
  getPanelTree(): Panel[];

  /** Get root panels */
  getRootPanels(): Panel[];

  /** Get a specific panel by ID */
  getPanel(id: string): Panel | undefined;

  /** Get the currently focused panel ID */
  getFocusedPanelId(): string | null;

  /** Create a new panel */
  createPanel(
    parentId: string,
    source: string,
    options?: {
      name?: string;
      env?: Record<string, string>;
      focus?: boolean;
    }
  ): Promise<{ id: string; title: string }>;

  /** Close a panel and all its children */
  closePanel(id: string): Promise<void>;

  /** Check if a panel's view is loaded */
  isPanelLoaded(panelId: string): boolean;

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
  panelLifecycle: PanelLifecycle,
  panelRegistry: PanelRegistry,
  panelView: PanelView | null,
): void {
  if (process.env["NATSTACK_TEST_MODE"] !== "1") {
    return;
  }

  console.log("[TestApi] Setting up test API for E2E testing");

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

    async createPanel(parentId, source, options) {
      return panelLifecycle.createPanel(parentId, source, options ?? {});
    },

    async closePanel(id) {
      return panelLifecycle.closePanel(id);
    },

    isPanelLoaded(panelId): boolean {
      if (!panelView) return false;
      const wc = panelView.getWebContents(panelId);
      return wc !== null && !wc.isDestroyed();
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
