/**
 * Workspace operations — composes shared filesystem functions with
 * main-process-only registry (CentralDataManager).
 */

import { initWorkspace, deleteWorkspaceDir } from "../shared/workspace/loader.js";
import type { CentralDataManager } from "./centralData.js";
import type { WorkspaceEntry } from "../shared/workspace/types.js";

/**
 * Create a new workspace and register it in the central data store.
 * Used by both auto-creation (first run) and user-initiated creation (wizard).
 */
export function createAndRegisterWorkspace(
  name: string,
  centralData: CentralDataManager,
  opts?: { gitUrl?: string; templateDir?: string; forkFrom?: string },
): WorkspaceEntry {
  // Fail if registry already has this workspace (after disk-pruning)
  if (centralData.hasWorkspace(name)) {
    throw new Error(`Workspace "${name}" already exists`);
  }

  // Create on disk (fails if dir already exists)
  initWorkspace(name, opts);

  // Register in central data
  centralData.addWorkspace(name, opts?.gitUrl);

  return {
    name,
    lastOpened: Date.now(),
    ...(opts?.gitUrl ? { gitUrl: opts.gitUrl } : {}),
  };
}

export { deleteWorkspaceDir };
