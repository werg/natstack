/**
 * Headless Bridge Service Handler
 *
 * Handles bridge service calls in headless mode (no Electron). Common portable
 * handlers (closeSelf, getInfo, setStateArgs, focusPanel, getBootstrapConfig)
 * are delegated to src/shared/bridgeHandlersCommon.ts.
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
      const { getAgentDiscovery } = await import(
        "../main/agentDiscovery.js"
      );
      return getAgentDiscovery()?.list() ?? [];
    }

    // =========================================================================
    // GUI-only operations — not supported in headless mode
    // =========================================================================

    case "openDevtools":
      // Silently succeed — no-op without a GUI
      return;

    case "openFolderDialog":
      throw new Error(
        "Folder dialogs are not available in headless mode. " +
        "Pass folder paths via stateArgs or CLI arguments."
      );

    default:
      throw new Error(`Unknown bridge method: ${method}`);
  }
}
