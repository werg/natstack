/**
 * Bridge service handlers for panel RPC calls.
 * Handles panel lifecycle operations like createChild, setTitle, etc.
 */

import type { PanelManager } from "../panelManager.js";
import type { CreateChildOptions } from "../../shared/ipc/types.js";

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
      const [source, options] = args as [string, CreateChildOptions | undefined];
      return pm.createChild(callerId, source, options);
    }
    case "createBrowserChild": {
      const [url] = args as [string];
      return pm.createBrowserChild(callerId, url);
    }
    case "setTitle": {
      const [title] = args as [string];
      return pm.setTitle(callerId, title);
    }
    case "getInfo": {
      return pm.getInfo(callerId);
    }
    case "closeChild": {
      const [childId] = args as [string];
      // Verify caller is the parent of the child
      const parentId = pm.findParentId(childId);
      if (parentId !== callerId) {
        throw new Error(`Panel "${callerId}" is not the parent of "${childId}"`);
      }
      return pm.closePanel(childId);
    }
    // Navigation methods - allow panels to navigate their children
    case "goBack": {
      const [targetId] = args as [string];
      // Verify caller is the parent of the target
      const parentId = pm.findParentId(targetId);
      if (parentId !== callerId) {
        throw new Error(`Panel "${callerId}" is not the parent of "${targetId}"`);
      }
      return pm.goBack(targetId);
    }
    case "goForward": {
      const [targetId] = args as [string];
      // Verify caller is the parent of the target
      const parentId = pm.findParentId(targetId);
      if (parentId !== callerId) {
        throw new Error(`Panel "${callerId}" is not the parent of "${targetId}"`);
      }
      return pm.goForward(targetId);
    }
    case "navigatePanel": {
      const [targetId, source, targetType] = args as [string, string, string];
      // Verify caller is the parent of the target
      const parentId = pm.findParentId(targetId);
      if (parentId !== callerId) {
        throw new Error(`Panel "${callerId}" is not the parent of "${targetId}"`);
      }
      return pm.navigatePanel(targetId, source, targetType as import("../../shared/ipc/types.js").PanelType);
    }
    default:
      throw new Error(`Unknown bridge method: ${method}`);
  }
}
