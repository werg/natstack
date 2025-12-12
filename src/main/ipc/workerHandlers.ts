/**
 * Worker handlers for routing RPC messages between panels and workers.
 *
 * Note: Workers are now created via the unified `createChild` API in PanelManager.
 * This module handles:
 * - RPC message routing from workers to panels
 * - Service registration for bridge and AI services
 */

import { getWorkerManager } from "../workerManager.js";
import type { PanelManager } from "../panelManager.js";
import { getCdpServer } from "../cdpServer.js";
import { isViewManagerInitialized, getViewManager } from "../viewManager.js";
import { handleBridgeCall } from "./bridgeHandlers.js";
import { handleAiServiceCall } from "./aiHandlers.js";
import { getCdpEndpointForCaller } from "./browserHandlers.js";

/**
 * Register worker-related handlers.
 * Sets up RPC routing and registers services with WorkerManager.
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

  // Register the "bridge" service for panel bridge operations
  workerManager.registerService("bridge", async (workerId, method, args) => {
    return handleBridgeCall(panelManager, workerId, method, args);
  });

  // Register the "ai" service for AI operations (unified streamText API)
  workerManager.registerService("ai", async (workerId, method, args) => {
    // Import aiHandler dynamically to avoid circular dependencies
    const { aiHandler } = await import("../index.js");
    if (!aiHandler) {
      throw new Error("AI handler not initialized");
    }

    return handleAiServiceCall(aiHandler, method, args, (handler, options, streamId) => {
      // Start streaming and route chunks back through workerManager.sendPush
      void handler.streamTextToWorker(workerManager, workerId, crypto.randomUUID(), options, streamId);
    });
  });

  // Register the "browser" service for browser panel control
  workerManager.registerService("browser", async (workerId, method, args) => {
    const cdpServer = getCdpServer();

    switch (method) {
      case "getCdpEndpoint": {
        const [browserId] = args as [string];
        return getCdpEndpointForCaller(cdpServer, browserId, workerId);
      }
      default:
        throw new Error(`Unknown browser method: ${method}`);
    }
  });
}
