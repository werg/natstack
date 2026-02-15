/**
 * Headless Bridge Service Handler
 *
 * Handles bridge service calls in headless mode (no Electron). Mirrors the
 * subset of bridge operations from src/main/ipc/bridgeHandlers.ts that make
 * sense without a GUI: panel creation, closing, state management, and tree
 * queries. GUI-only operations (devtools, repaint, dialogs) return errors.
 */

import type { HeadlessPanelManager } from "./headlessPanelManager.js";
import type { CreateChildOptions } from "../shared/types.js";

/**
 * Handle a bridge service call in headless mode.
 */
export async function handleHeadlessBridgeCall(
  pm: HeadlessPanelManager,
  callerId: string,
  method: string,
  args: unknown[],
): Promise<unknown> {
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
        ? { ...options, templateSpec: options.templateSpec ?? "contexts/default" }
        : { templateSpec: "contexts/default" };
      return pm.createPanel(callerId, source, panelOptions, stateArgs);
    }

    case "closeSelf": {
      return pm.closePanel(callerId);
    }

    case "closeChild": {
      const [childId] = args as [string];
      const parentId = pm.findParentId(childId);
      if (parentId !== callerId) {
        throw new Error(`Panel "${callerId}" is not the parent of "${childId}"`);
      }
      return pm.closePanel(childId);
    }

    // =========================================================================
    // Panel queries
    // =========================================================================

    case "getInfo": {
      return pm.getInfo(callerId);
    }

    case "getChildPanels": {
      const [options] = (args ?? []) as [{ includeStateArgs?: boolean }?];
      return pm.getChildPanels(callerId, options);
    }

    // =========================================================================
    // State management
    // =========================================================================

    case "setStateArgs": {
      const [updates] = args as [Record<string, unknown>];
      return pm.handleSetStateArgs(callerId, updates);
    }

    // =========================================================================
    // Context templates (portable — no Electron dependency)
    // =========================================================================

    case "listContextTemplates": {
      const { listAvailableTemplates } = await import(
        "../main/contextTemplate/discovery.js"
      );
      return listAvailableTemplates();
    }

    case "hasContextTemplate": {
      const [repoPath] = args as [string];
      if (!repoPath?.trim()) throw new Error("Repo path is required");
      const { hasContextTemplate } = await import(
        "../main/contextTemplate/discovery.js"
      );
      return hasContextTemplate(repoPath);
    }

    case "loadContextTemplate": {
      const [repoPath] = args as [string];
      if (!repoPath?.trim()) throw new Error("Repo path is required");
      const { loadContextTemplate } = await import(
        "../main/contextTemplate/discovery.js"
      );
      return loadContextTemplate(repoPath);
    }

    case "initContextTemplate": {
      const [repoPath] = args as [string];
      if (!repoPath?.trim()) throw new Error("Repo path is required");
      const { initContextTemplate } = await import(
        "../main/contextTemplate/discovery.js"
      );
      return initContextTemplate(repoPath);
    }

    case "saveContextTemplate": {
      const [repoPath, info] = args as [
        string,
        {
          name?: string;
          description?: string;
          extends?: string;
          structure?: Record<string, string>;
        },
      ];
      if (!repoPath?.trim()) throw new Error("Repo path is required");
      const { saveContextTemplate } = await import(
        "../main/contextTemplate/discovery.js"
      );
      return saveContextTemplate(repoPath, info);
    }

    case "createRepo": {
      const [repoPath] = args as [string];
      if (!repoPath?.trim()) throw new Error("Repo path is required");
      const { createRepo } = await import(
        "../main/contextTemplate/discovery.js"
      );
      return createRepo(repoPath);
    }

    // =========================================================================
    // Agent listing (portable)
    // =========================================================================

    case "listAgents": {
      const { getDiscoveredAgents } = await import(
        "../main/agentDiscovery.js"
      );
      return getDiscoveredAgents();
    }

    // =========================================================================
    // GUI-only operations — not supported in headless mode
    // =========================================================================

    case "createBrowserChild":
      throw new Error(
        "Browser panels are not supported in headless mode. " +
        "Use the Electron app or connect via a web browser."
      );

    case "openDevtools":
    case "forceRepaint":
      // Silently succeed — these are no-ops without a GUI
      return;

    case "openFolderDialog":
      throw new Error(
        "Folder dialogs are not available in headless mode. " +
        "Pass folder paths via stateArgs or CLI arguments."
      );

    // =========================================================================
    // Navigation/history — tracked but no visual effect in headless
    // =========================================================================

    case "navigatePanel":
    case "goBack":
    case "goForward":
    case "historyPush":
    case "historyReplace":
    case "historyBack":
    case "historyForward":
    case "historyGo":
    case "historyReload":
      // No-op in headless mode — no WebContentsView to navigate
      return;

    case "updateBrowserState":
    case "ensurePanelLoaded":
    case "unloadSelf":
    case "signalTemplateComplete":
      // No-op
      return;

    default:
      throw new Error(`Unknown bridge method: ${method}`);
  }
}
