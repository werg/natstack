/**
 * Headless Bridge Service Handler
 *
 * Handles bridge service calls in headless mode (no Electron). Common portable
 * handlers (closeSelf, getInfo, setStateArgs, focusPanel, getBootstrapConfig)
 * are delegated to src/shared/bridgeHandlersCommon.ts.
 */

import type { BridgePanelManager } from "../shared/panelInterfaces.js";
import type { GitServer } from "@natstack/git-server";
import type { CdpBridge } from "./cdpBridge.js";
import { handleCommonBridgeMethod } from "../shared/bridgeHandlersCommon.js";

export type HeadlessBridgeDeps = {
  pm: BridgePanelManager;
  gitServer: GitServer;
  cdpBridge: CdpBridge | null;
};

/**
 * Handle a bridge service call in headless mode.
 */
export async function handleHeadlessBridgeCall(
  deps: HeadlessBridgeDeps,
  callerId: string,
  method: string,
  args: unknown[],
): Promise<unknown> {
  const { pm, gitServer } = deps;
  // Try common handlers first (shared with Electron mode)
  const common = await handleCommonBridgeMethod(pm, callerId, method, args);
  if (common.handled) return common.result;

  // Headless-specific handlers
  switch (method) {
    // =========================================================================
    // Repo discovery (delegates to git server)
    // =========================================================================

    case "getWorkspaceTree":
      return gitServer.getWorkspaceTree();

    case "listBranches": {
      const [repoPath] = args as [string];
      return gitServer.listBranches(repoPath);
    }

    case "listCommits": {
      const [repoPath, ref, limit] = args as [string, string?, number?];
      return gitServer.listCommits(repoPath, ref ?? "HEAD", limit ?? 50);
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

    // =========================================================================
    // Browser panel creation
    // =========================================================================

    case "createBrowserPanel": {
      if (!pm.createBrowserPanel) {
        throw new Error("Browser panel creation not available");
      }
      if (!deps.cdpBridge) {
        throw new Error("Browser automation requires --serve-panels");
      }
      const [url, opts] = args as [string, { name?: string; focus?: boolean }?];
      const result = await pm.createBrowserPanel(callerId, url, opts);
      // In headless mode, open the tab via extension
      try {
        await deps.cdpBridge.openBrowserTab(result.id, url);
      } catch (err) {
        // Rollback: remove the panel if extension fails
        await pm.closePanel(result.id);
        throw err;
      }
      return result;
    }

    case "openExternal": {
      if (!deps.cdpBridge) {
        throw new Error("Browser automation requires --serve-panels");
      }
      const [url] = args as [string];
      if (!/^https?:\/\//i.test(url)) {
        throw new Error("openExternal only supports http/https URLs");
      }
      await deps.cdpBridge.openExternalTab(url);
      return;
    }

    default:
      throw new Error(`Unknown bridge method: ${method}`);
  }
}
