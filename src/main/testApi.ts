/**
 * Test API for E2E testing.
 *
 * Exposes PanelManager methods to Playwright tests via Electron's evaluate().
 * Only loaded when NATSTACK_TEST_MODE=1 environment variable is set.
 */

import type { PanelManager } from "./panelManager.js";
import type { Panel } from "./panelTypes.js";
import type * as SharedPanel from "../shared/ipc/types.js";

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
  ): Promise<{ id: string; type: SharedPanel.PanelType; title: string }>;

  /** Close a panel and all its children */
  closePanel(id: string): Promise<void>;

  /** Navigate back in panel history */
  goBack(panelId: string): Promise<void>;

  /** Navigate forward in panel history */
  goForward(panelId: string): Promise<void>;

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
export function setupTestApi(panelManager: PanelManager): void {
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
      for (const root of panelManager.getRootPanels()) {
        traverse(root);
      }
      return result;
    },

    getRootPanels(): Panel[] {
      return panelManager.getRootPanels();
    },

    getPanel(id: string): Panel | undefined {
      return panelManager.getPanel(id);
    },

    getFocusedPanelId(): string | null {
      return panelManager.getFocusedPanelId();
    },

    async createPanel(parentId, source, options) {
      return panelManager.createPanel(parentId, source, options);
    },

    async closePanel(id) {
      return panelManager.closePanel(id);
    },

    async goBack(panelId) {
      return panelManager.goBack(panelId);
    },

    async goForward(panelId) {
      return panelManager.goForward(panelId);
    },

    isPanelLoaded(panelId): boolean {
      const wc = panelManager.getWebContentsForPanel(panelId);
      return wc !== undefined && !wc.isDestroyed();
    },

    unloadPanel(panelId): void {
      // Get the webContents and close it to simulate a crash
      const wc = panelManager.getWebContentsForPanel(panelId);
      if (wc && !wc.isDestroyed()) {
        wc.close();
      }
    },

    focusPanel(panelId): void {
      // Use updateSelectedPath which is public and handles focus state
      panelManager.updateSelectedPath(panelId);
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
