/**
 * Workspace operations — composes shared filesystem functions with
 * main-process-only registry (CentralDataManager).
 */

import * as fs from "fs";
import YAML from "yaml";
import { initWorkspace, deleteWorkspaceDir } from "../shared/workspace/loader.js";
import type { CentralDataManager } from "./centralData.js";
import type { WorkspaceConfig } from "../shared/workspace/types.js";
import type { WorkspaceEntry } from "../shared/types.js";

/**
 * Create a new workspace and register it in the central data store.
 * Used by both auto-creation (first run) and user-initiated creation (wizard).
 */
export function createAndRegisterWorkspace(
  name: string,
  centralData: CentralDataManager,
  opts?: { templateDir?: string; forkFrom?: string },
): WorkspaceEntry {
  // Fail if registry already has this workspace (after disk-pruning)
  if (centralData.hasWorkspace(name)) {
    throw new Error(`Workspace "${name}" already exists`);
  }

  // Create on disk (fails if dir already exists)
  initWorkspace(name, opts);

  // Register in central data
  centralData.addWorkspace(name);

  return {
    name,
    lastOpened: Date.now(),
  };
}

/**
 * Manages atomic reads/writes of workspace config fields.
 * Updates both the in-memory config and disk (natstack.yml).
 */
export function createWorkspaceConfigManager(configPath: string, config: WorkspaceConfig) {
  return {
    get: () => config,
    set(key: "initPanels", value: unknown): void {
      // Write disk first — if I/O fails, in-memory config stays consistent
      const content = fs.readFileSync(configPath, "utf-8");
      const onDisk = (YAML.parse(content) as Record<string, unknown>) ?? {};
      onDisk[key] = value;
      fs.writeFileSync(configPath, YAML.stringify(onDisk), "utf-8");
      // Only mutate in-memory after successful disk write
      (config as unknown as Record<string, unknown>)[key] = value;
    },
  };
}

export { deleteWorkspaceDir };
