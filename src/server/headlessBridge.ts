/**
 * Headless Bridge Service Handler
 *
 * Handles bridge service calls in headless mode (no Electron). Common portable
 * handlers (closeSelf, getInfo, setStateArgs, focusPanel, getBootstrapConfig)
 * are delegated to src/shared/bridgeHandlersCommon.ts.
 */

import type { BridgePanelManager } from "../shared/panelManagerInterface.js";
import type { GitServer } from "../shared/gitServer.js";
import type { AgentDiscovery } from "../shared/agentDiscovery.js";
import { handleCommonBridgeMethod } from "../shared/bridgeHandlersCommon.js";

export type HeadlessBridgeDeps = {
  pm: BridgePanelManager;
  gitServer: GitServer;
  agentDiscovery: AgentDiscovery | null;
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
    // Agent listing (portable)
    // =========================================================================

    case "listAgents": {
      return deps.agentDiscovery?.list() ?? [];
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

    default:
      throw new Error(`Unknown bridge method: ${method}`);
  }
}
