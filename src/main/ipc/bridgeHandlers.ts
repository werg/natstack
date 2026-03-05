/**
 * Bridge service handlers for panel RPC calls.
 * Handles panel lifecycle operations like close, state management, etc.
 *
 * Common portable handlers (closeSelf, getInfo, setStateArgs, focusPanel,
 * getBootstrapConfig) are delegated to src/shared/bridgeHandlersCommon.ts.
 * This file handles Electron-specific operations (dialogs, DevTools).
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
 * @param method - The method name (e.g., "closeSelf")
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
    case "openFolderDialog": {
      const [options] = (args ?? []) as [{ title?: string }?];
      const result = await dialog.showOpenDialog({
        properties: ["openDirectory", "createDirectory"],
        title: options?.title ?? "Select Folder",
      });
      return result.canceled ? null : result.filePaths[0] ?? null;
    }
    case "listAgents": {
      return pm.listAgents();
    }
    case "createRepo": {
      const [repoPath] = args as [string];
      if (!repoPath?.trim()) throw new Error("Repo path is required");
      const workspace = getActiveWorkspace();
      if (!workspace) throw new Error("No active workspace");
      const absolutePath = resolve(workspace.path, repoPath);
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
    // DevTools
    // =========================================================================
    case "openDevtools": {
      const vm = getViewManager();
      vm.openDevTools(callerId);
      return;
    }

    default:
      throw new Error(`Unknown bridge method: ${method}`);
  }
}
