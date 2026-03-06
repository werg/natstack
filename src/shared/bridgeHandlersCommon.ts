/**
 * Common bridge handler logic shared between Electron and headless modes.
 *
 * Both `src/main/services/bridgeService.ts` and `src/server/headlessBridge.ts`
 * delegate portable cases here. Environment-specific cases (Electron dialogs,
 * DevTools) remain in the environment-specific files.
 */

import type { BridgePanelManager } from "./panelManagerInterface.js";

// Re-export for consumers that import from this module
export type { BridgePanelManager } from "./panelManagerInterface.js";

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

    case "closeSelf":
      return { handled: true, result: pm.closePanel(callerId) };

    // =========================================================================
    // Panel queries
    // =========================================================================

    case "getInfo":
      return { handled: true, result: pm.getInfo(callerId) };

    // =========================================================================
    // State management
    // =========================================================================

    case "setStateArgs": {
      const [updates] = args as [Record<string, unknown>];
      return { handled: true, result: await pm.handleSetStateArgs(callerId, updates) };
    }

    case "focusPanel": {
      const [targetId] = args as [string];
      pm.focusPanel?.(targetId);
      return { handled: true, result: undefined };
    }

    case "getBootstrapConfig": {
      if (!pm.getBootstrapConfig) return { handled: false };
      return { handled: true, result: await pm.getBootstrapConfig(callerId) };
    }

    default:
      return { handled: false };
  }
}
