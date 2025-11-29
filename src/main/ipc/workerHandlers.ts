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
import type { CreateChildOptions } from "../../shared/ipc/types.js";

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
    // Get the panel's webContents and send the message
    const views = panelManager.getPanelViews(panelId);
    if (!views || views.size === 0) {
      console.warn(`[WorkerHandlers] Panel ${panelId} has no views for RPC delivery`);
      return;
    }

    // Import webContents dynamically to avoid circular dependencies
    import("electron").then(({ webContents }) => {
      for (const contentsId of views) {
        const contents = webContents.fromId(contentsId);
        if (contents && !contents.isDestroyed()) {
          contents.send("worker-rpc:message", { fromId, message });
          break; // Send to first available view
        }
      }
    });
  });

  // Register the "bridge" service for panel bridge operations
  workerManager.registerService("bridge", async (workerId, method, args) => {
    switch (method) {
      case "createChild": {
        const [childPath, options] = args as [string, CreateChildOptions | undefined];
        return panelManager.createChild(workerId, childPath, options);
      }
      case "removeChild": {
        const [childId] = args as [string];
        return panelManager.removeChild(workerId, childId);
      }
      case "setTitle": {
        const [title] = args as [string];
        return panelManager.setTitle(workerId, title);
      }
      case "close": {
        return panelManager.closePanel(workerId);
      }
      case "getEnv": {
        return panelManager.getEnv(workerId);
      }
      case "getInfo": {
        return panelManager.getInfo(workerId);
      }
      case "getGitConfig": {
        return panelManager.getGitConfig(workerId);
      }
      default:
        throw new Error(`Unknown bridge method: ${method}`);
    }
  });

  // Register the "ai" service for AI operations
  workerManager.registerService("ai", async (workerId, method, args) => {
    // Import aiHandler dynamically to avoid circular dependencies
    const { aiHandler } = await import("../index.js");
    if (!aiHandler) {
      throw new Error("AI handler not initialized");
    }

    switch (method) {
      case "generate": {
        const [modelId, options] = args as [string, import("@natstack/ai").AICallOptions];
        const resolvedModelId = aiHandler.resolveModelId(modelId);
        const requestId = crypto.randomUUID();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return (aiHandler as any).generate(requestId, workerId, resolvedModelId, options);
      }
      case "streamStart": {
        const [modelId, options, streamId] = args as [
          string,
          import("@natstack/ai").AICallOptions,
          string,
        ];
        const resolvedModelId = aiHandler.resolveModelId(modelId);
        // Start streaming and route chunks back through workerManager.sendPush
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        void (aiHandler as any).streamToWorker(
          workerManager,
          workerId,
          crypto.randomUUID(),
          resolvedModelId,
          options,
          streamId
        );
        return;
      }
      case "streamCancel": {
        const [streamId] = args as [string];
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (aiHandler as any).cancelStream(streamId);
        return;
      }
      case "listRoles": {
        return aiHandler.getAvailableRoles();
      }
      case "ccConversationStart": {
        const [modelId, tools] = args as [string, import("@natstack/ai").AIToolDefinition[]];
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return (aiHandler as any).startWorkerConversation(workerId, modelId, tools);
      }
      case "ccGenerate": {
        const [conversationId, options] = args as [string, import("@natstack/ai").AICallOptions];
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return (aiHandler as any).ccGenerateForWorker(workerId, conversationId, options);
      }
      case "ccStreamStart": {
        const [conversationId, options, streamId] = args as [
          string,
          import("@natstack/ai").AICallOptions,
          string,
        ];
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        void (aiHandler as any).ccStreamToWorker(
          workerManager,
          workerId,
          conversationId,
          options,
          streamId
        );
        return;
      }
      case "ccConversationEnd": {
        const [conversationId] = args as [string];
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return (aiHandler as any).endWorkerConversation(workerId, conversationId);
      }
      case "ccToolResult": {
        const [executionId, result] = args as [string, unknown];
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return (aiHandler as any).handleWorkerToolResult(executionId, result);
      }
      default:
        throw new Error(`Unknown AI method: ${method}`);
    }
  });
}
