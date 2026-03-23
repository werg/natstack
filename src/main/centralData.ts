/**
 * Central data management for NatStack.
 *
 * Manages persistent data stored in ~/.config/natstack/data.json including:
 * - Workspace registry (authoritative source for workspace metadata)
 */

import * as fs from "fs";
import * as path from "path";
import { getCentralConfigPaths } from "../shared/workspace/loader.js";
import { getWorkspaceDir } from "@natstack/env-paths";
import type { CentralData, WorkspaceEntry } from "../shared/workspace/types.js";

/**
 * Default empty central data structure
 */
function getDefaultData(): CentralData {
  return {
    workspaces: [],
  };
}

/**
 * CentralDataManager handles persistence of workspace registry data.
 * data.json is the sole authoritative source for workspace metadata.
 */
export class CentralDataManager {
  private dataPath: string;
  private data: CentralData;

  constructor() {
    const paths = getCentralConfigPaths();
    this.dataPath = paths.dataPath;
    this.data = this.load();
  }

  /**
   * Load data from disk, migrating legacy format if needed.
   */
  private load(): CentralData {
    try {
      if (!fs.existsSync(this.dataPath)) {
        return getDefaultData();
      }
      const content = fs.readFileSync(this.dataPath, "utf-8");
      const parsed = JSON.parse(content) as Record<string, unknown>;

      if (Array.isArray(parsed["workspaces"])) {
        return { workspaces: parsed["workspaces"] as WorkspaceEntry[] };
      }

      return getDefaultData();
    } catch (error) {
      console.warn("[CentralData] Failed to load:", error);
      return getDefaultData();
    }
  }

  /**
   * Save data to disk
   */
  private save(): void {
    try {
      const paths = getCentralConfigPaths();
      fs.mkdirSync(paths.configDir, { recursive: true });
      fs.writeFileSync(this.dataPath, JSON.stringify(this.data, null, 2), "utf-8");
    } catch (error) {
      console.error("[CentralData] Failed to save:", error);
    }
  }

  /**
   * List workspaces sorted by lastOpened descending (most recent first).
   * Prunes entries whose directory no longer exists on disk.
   */
  listWorkspaces(): WorkspaceEntry[] {
    let pruned = false;
    this.data.workspaces = this.data.workspaces.filter((w) => {
      const configPath = path.join(getWorkspaceDir(w.name), "source", "natstack.yml");
      if (fs.existsSync(configPath)) return true;
      pruned = true;
      return false;
    });
    if (pruned) this.save();
    return [...this.data.workspaces].sort((a, b) => b.lastOpened - a.lastOpened);
  }

  /**
   * Check if a workspace exists in registry AND on disk.
   * Prunes stale registry entries (dir gone).
   */
  hasWorkspace(name: string): boolean {
    const idx = this.data.workspaces.findIndex((w) => w.name === name);
    if (idx === -1) return false;

    const configPath = path.join(getWorkspaceDir(name), "source", "natstack.yml");
    if (fs.existsSync(configPath)) return true;

    // Stale entry — prune it
    this.data.workspaces.splice(idx, 1);
    this.save();
    return false;
  }

  /**
   * Add a new workspace to the registry.
   */
  addWorkspace(name: string): void {
    // Remove existing entry if present
    this.data.workspaces = this.data.workspaces.filter((w) => w.name !== name);

    this.data.workspaces.unshift({
      name,
      lastOpened: Date.now(),
    });

    this.save();
  }

  /**
   * Remove a workspace from the registry.
   */
  removeWorkspace(name: string): void {
    this.data.workspaces = this.data.workspaces.filter((w) => w.name !== name);
    this.save();
  }

  /**
   * Update the lastOpened timestamp for an existing workspace.
   */
  touchWorkspace(name: string): void {
    const workspace = this.data.workspaces.find((w) => w.name === name);
    if (workspace) {
      workspace.lastOpened = Date.now();
      this.save();
    }
  }

  /**
   * Get the full entry for a workspace by name.
   * Returns null if not found in registry.
   */
  getWorkspaceEntry(name: string): WorkspaceEntry | null {
    return this.data.workspaces.find((w) => w.name === name) ?? null;
  }

  /**
   * Get the last-opened workspace that still exists on disk.
   * Returns null if no valid workspaces exist.
   */
  getLastOpenedWorkspace(): WorkspaceEntry | null {
    const sorted = [...this.data.workspaces].sort((a, b) => b.lastOpened - a.lastOpened);
    let pruned = false;
    for (const entry of sorted) {
      const configPath = path.join(getWorkspaceDir(entry.name), "source", "natstack.yml");
      if (fs.existsSync(configPath)) return entry;
      // Stale — prune
      this.data.workspaces = this.data.workspaces.filter((w) => w.name !== entry.name);
      pruned = true;
    }
    if (pruned) this.save();
    return null;
  }
}
