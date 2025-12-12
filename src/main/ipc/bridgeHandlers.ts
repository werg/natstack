/**
 * Bridge service handlers for panel RPC calls.
 * Handles panel lifecycle operations like createChild, removeChild, etc.
 */

import type { PanelManager } from "../panelManager.js";
import type { ChildSpec } from "../../shared/ipc/types.js";

/**
 * Handle bridge service calls from panels.
 *
 * @param pm - PanelManager instance
 * @param callerId - The calling panel/worker ID
 * @param method - The method name (e.g., "createChild", "setTitle")
 * @param args - The method arguments
 * @returns The result of the method call
 */
export async function handleBridgeCall(
  pm: PanelManager,
  callerId: string,
  method: string,
  args: unknown[]
): Promise<unknown> {
  switch (method) {
    case "createChild": {
      const [spec] = args as [ChildSpec];
      return pm.createChild(callerId, spec);
    }
    case "removeChild": {
      const [childId] = args as [string];
      return pm.removeChild(callerId, childId);
    }
    case "setTitle": {
      const [title] = args as [string];
      return pm.setTitle(callerId, title);
    }
    case "close": {
      return pm.closePanel(callerId);
    }
    case "getEnv": {
      return pm.getEnv(callerId);
    }
    case "getInfo": {
      return pm.getInfo(callerId);
    }
    case "getGitConfig": {
      return pm.getGitConfig(callerId);
    }
    default:
      throw new Error(`Unknown bridge method: ${method}`);
  }
}
