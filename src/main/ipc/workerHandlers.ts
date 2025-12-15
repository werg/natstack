/**
 * Worker handlers for routing RPC messages between panels and workers.
 *
 * Note: Workers are now created via the unified `createChild` API in PanelManager.
 * This module handles:
 * - RPC message routing from workers to panels
 */

import { getWorkerManager } from "../workerManager.js";
import type { PanelManager } from "../panelManager.js";
import { isViewManagerInitialized, getViewManager } from "../viewManager.js";

/**
 * Register worker-related handlers.
 * Sets up RPC routing and console log forwarding.
 */
export function registerWorkerHandlers(panelManager: PanelManager): void {
  const workerManager = getWorkerManager();

  // Set up callback to forward worker console logs to PanelManager
  workerManager.setConsoleLogCallback((workerId, level, message) => {
    panelManager.addWorkerConsoleLog(workerId, level, message);
  });

  // Set up callback to route RPC from workers to panels
  workerManager.setRpcToPanelCallback((panelId, fromId, message) => {
    // Get the panel's webContents via ViewManager and send the message
    if (!isViewManagerInitialized()) {
      console.warn(`[WorkerHandlers] ViewManager not initialized for RPC delivery to ${panelId}`);
      return;
    }

    const contents = getViewManager().getWebContents(panelId);
    if (!contents) {
      console.warn(`[WorkerHandlers] Panel ${panelId} has no view for RPC delivery`);
      return;
    }

    contents.send("worker-rpc:message", { fromId, message });
  });
}
