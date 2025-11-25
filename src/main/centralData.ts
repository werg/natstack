/**
 * Central data management for NatStack.
 *
 * Manages persistent data stored in ~/.config/natstack/data.json including:
 * - Recent workspaces list for the workspace chooser
 */

import * as fs from "fs";
import { getCentralConfigPaths } from "./workspace/loader.js";
import type { CentralData, RecentWorkspace } from "./workspace/types.js";

const MAX_RECENT_WORKSPACES = 10;

/**
 * Default empty central data structure
 */
function getDefaultData(): CentralData {
  return {
    recentWorkspaces: [],
  };
}

/**
 * CentralDataManager handles persistence of app-level data.
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
   * Load data from disk
   */
  private load(): CentralData {
    try {
      if (!fs.existsSync(this.dataPath)) {
        return getDefaultData();
      }
      const content = fs.readFileSync(this.dataPath, "utf-8");
      const parsed = JSON.parse(content) as Partial<CentralData>;
      return {
        recentWorkspaces: parsed.recentWorkspaces ?? [],
      };
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
   * Get the list of recent workspaces, sorted by most recently opened first
   */
  getRecentWorkspaces(): RecentWorkspace[] {
    return [...this.data.recentWorkspaces].sort((a, b) => b.lastOpened - a.lastOpened);
  }

  /**
   * Add or update a workspace in the recent list
   */
  addRecentWorkspace(path: string, name: string): void {
    // Remove existing entry if present
    this.data.recentWorkspaces = this.data.recentWorkspaces.filter(
      (w) => w.path !== path
    );

    // Add new entry at the beginning
    this.data.recentWorkspaces.unshift({
      path,
      name,
      lastOpened: Date.now(),
    });

    // Prune to max size
    this.pruneOldWorkspaces();

    this.save();
  }

  /**
   * Remove a workspace from the recent list
   */
  removeRecentWorkspace(path: string): void {
    this.data.recentWorkspaces = this.data.recentWorkspaces.filter(
      (w) => w.path !== path
    );
    this.save();
  }

  /**
   * Update just the lastOpened timestamp for an existing workspace
   */
  touchRecentWorkspace(path: string): void {
    const workspace = this.data.recentWorkspaces.find((w) => w.path === path);
    if (workspace) {
      workspace.lastOpened = Date.now();
      this.save();
    }
  }

  /**
   * Keep only the most recent MAX_RECENT_WORKSPACES entries
   */
  private pruneOldWorkspaces(): void {
    if (this.data.recentWorkspaces.length > MAX_RECENT_WORKSPACES) {
      // Sort by lastOpened and keep only the newest
      this.data.recentWorkspaces.sort((a, b) => b.lastOpened - a.lastOpened);
      this.data.recentWorkspaces = this.data.recentWorkspaces.slice(0, MAX_RECENT_WORKSPACES);
    }
  }
}

// Singleton instance
let centralDataInstance: CentralDataManager | null = null;

/**
 * Get the singleton CentralDataManager instance
 */
export function getCentralData(): CentralDataManager {
  if (!centralDataInstance) {
    centralDataInstance = new CentralDataManager();
  }
  return centralDataInstance;
}
