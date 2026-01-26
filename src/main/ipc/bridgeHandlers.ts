/**
 * Bridge service handlers for panel RPC calls.
 * Handles panel lifecycle operations like createChild, close, navigation, etc.
 */

import type { PanelManager } from "../panelManager.js";
import type { CreateChildOptions } from "../../shared/ipc/types.js";
import { handleTemplateComplete, type TemplateCompleteResult } from "../contextTemplate/partitionBuilder.js";

/**
 * Handle bridge service calls from panels.
 *
 * @param pm - PanelManager instance
 * @param callerId - The calling panel/worker ID
 * @param method - The method name (e.g., "createChild", "closeSelf")
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
      // Keep case name as "createChild" for backwards compatibility with panels calling bridge.createChild
      // stateArgs is passed as a separate third parameter to enforce single source of truth
      const [source, options, stateArgs] = args as [
        string,
        CreateChildOptions | undefined,
        Record<string, unknown> | undefined
      ];
      // Map CreateChildOptions to PanelCreateOptions with default templateSpec
      const panelOptions = options
        ? { ...options, templateSpec: options.templateSpec ?? "contexts/default" }
        : { templateSpec: "contexts/default" };
      return pm.createPanel(callerId, source, panelOptions, stateArgs);
    }
    case "createBrowserChild": {
      const [url] = args as [string];
      return pm.createBrowserChild(callerId, url);
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
    case "getWorkspaceTree": {
      return pm.getWorkspaceTree();
    }
    case "listBranches": {
      const [repoPath] = args as [string];
      return pm.listBranches(repoPath);
    }
    case "listCommits": {
      const [repoPath, ref, limit] = args as [string, string?, number?];
      return pm.listCommits(repoPath, ref, limit);
    }
    case "closeSelf": {
      // Allow any panel to close itself
      return pm.closePanel(callerId);
    }
    case "unloadSelf": {
      // Allow any panel to unload itself (release resources but stay in tree)
      return pm.unloadPanel(callerId);
    }
    case "ensurePanelLoaded": {
      // Allow any panel to ensure another panel is loaded
      // Used for agent worker recovery - chat panels can reload disconnected workers
      const [targetPanelId] = args as [string];
      return pm.ensurePanelLoaded(targetPanelId);
    }
    case "setStateArgs": {
      // Allow any panel to update its own state args
      const [updates] = args as [Record<string, unknown>];
      return pm.handleSetStateArgs(callerId, updates);
    }
    case "signalTemplateComplete": {
      // Called by template-builder workers to signal completion
      const [result] = args as [TemplateCompleteResult];
      handleTemplateComplete(callerId, result);
      return { success: true };
    }
    case "forceRepaint": {
      // Allow a panel to request a force repaint to recover from compositor stalls
      // where content exists in DOM but isn't being painted
      return pm.forceRepaint(callerId);
    }
    case "listContextTemplates": {
      // List available context templates in the workspace
      const { listAvailableTemplates } = await import("../contextTemplate/discovery.js");
      return listAvailableTemplates();
    }
    case "createContextFromTemplate": {
      // Create a new context from a template spec
      const [templateSpec] = args as [string];
      const { resolveTemplate } = await import("../contextTemplate/resolver.js");
      const { computeImmutableSpec } = await import("../contextTemplate/specHash.js");
      const { createContextId, generateInstanceId } = await import("../contextTemplate/contextId.js");
      const { ensureContextPartitionInitialized } = await import("../contextTemplate/index.js");
      const { getGitServer } = await import("../index.js");

      // Resolve template and compute immutable spec
      const resolved = await resolveTemplate(templateSpec);
      const immutableSpec = computeImmutableSpec(resolved);
      const instanceId = generateInstanceId("chat");
      const contextId = createContextId("safe", immutableSpec.specHash, instanceId);

      // Get git config for partition initialization
      const gitServer = getGitServer();
      if (!gitServer) {
        throw new Error("Git server not available - cannot initialize context");
      }

      const gitConfig = {
        serverUrl: gitServer.getBaseUrl(),
        token: gitServer.getTokenForPanel(callerId),
      };

      // Initialize OPFS partition
      await ensureContextPartitionInitialized(contextId, immutableSpec, gitConfig);

      return contextId;
    }
    default:
      throw new Error(`Unknown bridge method: ${method}`);
  }
}
