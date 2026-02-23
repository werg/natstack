/**
 * Bridge service handlers for panel RPC calls.
 * Handles panel lifecycle operations like createChild, close, navigation, etc.
 *
 * Common portable handlers (createChild, closeSelf, closeChild, getInfo,
 * getChildPanels, setStateArgs, context templates) are delegated to
 * src/shared/bridgeHandlersCommon.ts. This file handles Electron-specific
 * operations (dialogs, DevTools, navigation, browser state).
 */

import { dialog } from "electron";
import { existsSync } from "fs";
import { mkdir, writeFile } from "fs/promises";
import { join, resolve } from "path";
import { execSync } from "child_process";
import type { PanelManager } from "../panelManager.js";
import type { CdpServer } from "../cdpServer.js";
import { getViewManager } from "../viewManager.js";
import { getActiveWorkspace } from "../paths.js";
import { handleCommonBridgeMethod } from "../../shared/bridgeHandlersCommon.js";

/**
 * Handle bridge service calls from panels.
 *
 * @param pm - PanelManager instance
 * @param cdpServer - CdpServer instance for browser ownership checks
 * @param callerId - The calling panel/worker ID
 * @param method - The method name (e.g., "createChild", "closeSelf")
 * @param args - The method arguments
 * @returns The result of the method call
 */
export async function handleBridgeCall(
  pm: PanelManager,
  cdpServer: CdpServer,
  callerId: string,
  method: string,
  args: unknown[]
): Promise<unknown> {
  // Try common handlers first (shared with headless mode)
  const common = await handleCommonBridgeMethod(pm, callerId, method, args);
  if (common.handled) return common.result;

  // Electron-specific handlers
  switch (method) {
    case "createBrowserChild": {
      const [url] = args as [string];
      return pm.createBrowserChild(callerId, url);
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
      return pm.navigatePanel(targetId, source, targetType as import("../../shared/types.js").PanelType);
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
    case "forceRepaint": {
      // Allow a panel to request a force repaint to recover from compositor stalls
      // where content exists in DOM but isn't being painted
      return pm.forceRepaint(callerId);
    }
    case "openFolderDialog": {
      // Folder picker for panels (mirrors shell's workspace.openFolderDialog)
      const [options] = (args ?? []) as [{ title?: string }?];
      const result = await dialog.showOpenDialog({
        properties: ["openDirectory", "createDirectory"],
        title: options?.title ?? "Select Folder",
      });
      return result.canceled ? null : result.filePaths[0] ?? null;
    }
    case "listAgents": {
      // List available agents - delegates to server where AgentDiscovery runs
      return pm.listAgents();
    }
    case "createRepo": {
      const [repoPath] = args as [string];
      if (!repoPath?.trim()) throw new Error("Repo path is required");
      const workspace = getActiveWorkspace();
      if (!workspace) throw new Error("No active workspace");
      const absolutePath = resolve(workspace.path, repoPath);
      // Path traversal guard: ensure resolved path stays inside workspace
      if (!absolutePath.startsWith(workspace.path + "/") && absolutePath !== workspace.path) {
        throw new Error(`Invalid repo path: escapes workspace root`);
      }
      if (existsSync(absolutePath)) throw new Error(`Path already exists: ${repoPath}`);
      await mkdir(absolutePath, { recursive: true });
      execSync("git init", { cwd: absolutePath, stdio: "pipe" });
      const repoName = repoPath.split("/").pop() ?? "project";
      await writeFile(join(absolutePath, "README.md"), `# ${repoName}\n\nA new NatStack project.\n`, "utf-8");
      execSync("git add README.md", { cwd: absolutePath, stdio: "pipe" });
      execSync('git commit -m "Initial commit"', { cwd: absolutePath, stdio: "pipe" });
      return;
    }
    // =========================================================================
    // History integration (replaces IPC panel:history-* handlers)
    // =========================================================================
    case "historyPush": {
      const [payload] = args as [{ state: unknown; path: string }];
      pm.handleHistoryPushState(callerId, payload.state, payload.path);
      return;
    }
    case "historyReplace": {
      const [payload] = args as [{ state: unknown; path: string }];
      pm.handleHistoryReplaceState(callerId, payload.state, payload.path);
      return;
    }
    case "historyBack": {
      await pm.goBack(callerId);
      return;
    }
    case "historyForward": {
      await pm.goForward(callerId);
      return;
    }
    case "historyGo": {
      const [offset] = args as [number];
      await pm.goToHistoryOffset(callerId, offset);
      return;
    }
    case "historyReload": {
      await pm.reloadPanel(callerId);
      return;
    }

    // =========================================================================
    // DevTools (replaces IPC panel:open-devtools handler)
    // =========================================================================
    case "openDevtools": {
      const vm = getViewManager();
      vm.openDevTools(callerId);
      return;
    }

    // =========================================================================
    // Browser state (replaces IPC panel:update-browser-state handler)
    // =========================================================================
    case "updateBrowserState": {
      const [browserId, state] = args as [string, { url?: string; pageTitle?: string; isLoading?: boolean; canGoBack?: boolean; canGoForward?: boolean }];
      // Verify caller owns or is an ancestor of this browser panel
      if (!cdpServer.panelOwnsBrowser(callerId, browserId) &&
          !pm.isDescendantOf(browserId, callerId)) {
        throw new Error(`Panel ${callerId} cannot update browser ${browserId}`);
      }
      pm.updateBrowserState(browserId, state);
      return;
    }

    default:
      throw new Error(`Unknown bridge method: ${method}`);
  }
}
