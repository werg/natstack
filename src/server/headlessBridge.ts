/**
 * Headless Bridge Service Handler
 *
 * Handles bridge service calls in headless mode (no Electron). Common portable
 * handlers (createChild, closeSelf, closeChild, getInfo, getChildPanels,
 * setStateArgs, context templates) are delegated to
 * src/shared/bridgeHandlersCommon.ts. This file handles headless-specific
 * operations and stubs out GUI-only operations.
 */

import type { HeadlessPanelManager } from "./headlessPanelManager.js";
import { handleCommonBridgeMethod } from "../shared/bridgeHandlersCommon.js";

/**
 * Handle a bridge service call in headless mode.
 */
export async function handleHeadlessBridgeCall(
  pm: HeadlessPanelManager,
  callerId: string,
  method: string,
  args: unknown[],
): Promise<unknown> {
  // Try common handlers first (shared with Electron mode)
  const common = await handleCommonBridgeMethod(pm, callerId, method, args);
  if (common.handled) return common.result;

  // Headless-specific handlers
  switch (method) {
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
