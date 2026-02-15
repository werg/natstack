/**
 * Common bridge handler logic shared between Electron and headless modes.
 *
 * Both `src/main/ipc/bridgeHandlers.ts` and `src/server/headlessBridge.ts`
 * delegate portable cases here. Environment-specific cases (Electron dialogs,
 * DevTools, navigation, browser state) remain in the environment-specific files.
 */

import type { CreateChildOptions } from "./types.js";

/**
 * Minimal panel manager interface — the subset of PanelManager /
 * HeadlessPanelManager that common bridge handlers need.
 */
export interface BridgePanelManager {
  createPanel(callerId: string, source: string, options?: any, stateArgs?: Record<string, unknown>): Promise<any>;
  closePanel(panelId: string): void;
  getInfo(panelId: string): unknown;
  findParentId(childId: string): string | null;
  getChildPanels(parentId: string, options?: { includeStateArgs?: boolean }): unknown;
  handleSetStateArgs(panelId: string, updates: Record<string, unknown>): void;
}

/**
 * Try to handle a bridge method that is portable across Electron and headless.
 * Returns `{ handled: true, result }` if this method was handled, or
 * `{ handled: false }` if the caller should handle it (environment-specific).
 */
export async function handleCommonBridgeMethod(
  pm: BridgePanelManager,
  callerId: string,
  method: string,
  args: unknown[],
): Promise<{ handled: true; result: unknown } | { handled: false }> {
  switch (method) {
    // =========================================================================
    // Panel lifecycle
    // =========================================================================

    case "createChild": {
      const [source, options, stateArgs] = args as [
        string,
        CreateChildOptions | undefined,
        Record<string, unknown> | undefined,
      ];
      const panelOptions = options
        ? { ...options, templateSpec: (options as any).templateSpec ?? "contexts/default" }
        : { templateSpec: "contexts/default" };
      return { handled: true, result: await pm.createPanel(callerId, source, panelOptions, stateArgs) };
    }

    case "closeSelf":
      return { handled: true, result: pm.closePanel(callerId) };

    case "closeChild": {
      const [childId] = args as [string];
      const parentId = pm.findParentId(childId);
      if (parentId !== callerId) {
        throw new Error(`Panel "${callerId}" is not the parent of "${childId}"`);
      }
      return { handled: true, result: pm.closePanel(childId) };
    }

    // =========================================================================
    // Panel queries
    // =========================================================================

    case "getInfo":
      return { handled: true, result: pm.getInfo(callerId) };

    case "getChildPanels": {
      const [options] = (args ?? []) as [{ includeStateArgs?: boolean }?];
      return { handled: true, result: pm.getChildPanels(callerId, options) };
    }

    // =========================================================================
    // State management
    // =========================================================================

    case "setStateArgs": {
      const [updates] = args as [Record<string, unknown>];
      return { handled: true, result: pm.handleSetStateArgs(callerId, updates) };
    }

    // =========================================================================
    // Context template operations
    // =========================================================================

    case "listContextTemplates": {
      const { listAvailableTemplates } = await import("../main/contextTemplate/discovery.js");
      return { handled: true, result: await listAvailableTemplates() };
    }

    case "hasContextTemplate": {
      const [repoPath] = args as [string];
      if (!repoPath?.trim()) throw new Error("Repo path is required");
      const { hasContextTemplate } = await import("../main/contextTemplate/discovery.js");
      return { handled: true, result: await hasContextTemplate(repoPath) };
    }

    case "loadContextTemplate": {
      const [repoPath] = args as [string];
      if (!repoPath?.trim()) throw new Error("Repo path is required");
      const { loadContextTemplate } = await import("../main/contextTemplate/discovery.js");
      return { handled: true, result: await loadContextTemplate(repoPath) };
    }

    case "initContextTemplate": {
      const [repoPath] = args as [string];
      if (!repoPath?.trim()) throw new Error("Repo path is required");
      const { initContextTemplate } = await import("../main/contextTemplate/discovery.js");
      return { handled: true, result: await initContextTemplate(repoPath) };
    }

    case "saveContextTemplate": {
      const [repoPath, info] = args as [
        string,
        { name?: string; description?: string; extends?: string; structure?: Record<string, string> },
      ];
      if (!repoPath?.trim()) throw new Error("Repo path is required");
      const { saveContextTemplate } = await import("../main/contextTemplate/discovery.js");
      return { handled: true, result: await saveContextTemplate(repoPath, info) };
    }

    case "createRepo": {
      const [repoPath] = args as [string];
      if (!repoPath?.trim()) throw new Error("Repo path is required");
      const { createRepo } = await import("../main/contextTemplate/discovery.js");
      return { handled: true, result: await createRepo(repoPath) };
    }

    default:
      return { handled: false };
  }
}
