/**
 * Common bridge handler logic shared between Electron and headless modes.
 *
 * Both `src/main/services/bridgeService.ts` and `src/server/standaloneBridge.ts`
 * delegate portable cases here. Environment-specific cases (Electron dialogs,
 * DevTools) remain in the environment-specific files.
 */

import type { BridgePanelManager } from "./panelInterfaces.js";

// Re-export for consumers that import from this module
export type { BridgePanelManager } from "./panelInterfaces.js";

/**
 * Git operations interface for bridge handlers.
 * Implemented by both ServerInfo (Electron, over RPC) and GitServer (headless, in-process).
 */
export interface GitBridgeLike {
  getWorkspaceTree(): Promise<unknown> | unknown;
  listBranches(repoPath: string): Promise<unknown> | unknown;
  listCommits(repoPath: string, ref: string, limit: number): Promise<unknown> | unknown;
}

/**
 * Try to handle a bridge method that is portable across Electron and headless.
 * Returns `{ handled: true, result }` if this method was handled, or
 * `{ handled: false }` if the caller should handle it (environment-specific).
 */
export async function handleCommonBridgeMethod(
  pm: BridgePanelManager,
  callerId: string,
  method: string,
  args: unknown[],
  git?: GitBridgeLike,
): Promise<{ handled: true; result: unknown } | { handled: false }> {
  switch (method) {
    // =========================================================================
    // Panel lifecycle
    // =========================================================================

    case "closeSelf":
      return { handled: true, result: pm.closePanel(callerId) };

    case "closeChild": {
      if (!pm.closeChild) return { handled: false };
      const [childId] = args as [string];
      return { handled: true, result: await pm.closeChild(callerId, childId) };
    }

    // =========================================================================
    // Panel queries
    // =========================================================================

    case "getInfo":
      return { handled: true, result: pm.getInfo(callerId) };

    // =========================================================================
    // State management
    // =========================================================================

    case "setStateArgs": {
      const [updates] = args as [Record<string, unknown>];
      return { handled: true, result: await pm.handleSetStateArgs(callerId, updates) };
    }

    case "focusPanel": {
      const [targetId] = args as [string];
      pm.focusPanel?.(targetId);
      return { handled: true, result: undefined };
    }

    case "getBootstrapConfig": {
      if (!pm.getBootstrapConfig) return { handled: false };
      return { handled: true, result: await pm.getBootstrapConfig(callerId) };
    }

    // =========================================================================
    // Git operations (shared — works via RPC in Electron, in-process in headless)
    // =========================================================================

    case "getWorkspaceTree":
      if (!git) return { handled: false };
      return { handled: true, result: await git.getWorkspaceTree() };

    case "listBranches": {
      if (!git) return { handled: false };
      const [repoPath] = args as [string];
      return { handled: true, result: await git.listBranches(repoPath) };
    }

    case "listCommits": {
      if (!git) return { handled: false };
      const [repoPath, ref, limit] = args as [string, string?, number?];
      return { handled: true, result: await git.listCommits(repoPath, ref ?? "HEAD", limit ?? 50) };
    }

    default:
      return { handled: false };
  }
}
