/**
 * AgentSettingsService - Centralized service for agent preferences and settings.
 *
 * Owns the "agent-settings" database exclusively. No panel should create this
 * database directly - all access goes through this service via RPC.
 *
 * Database schema:
 * - global_settings: key-value store for GlobalAgentSettings properties
 * - agent_settings: per-agent default parameter values
 */

import Database from "better-sqlite3";
import * as path from "path";
import * as fs from "fs";
import type { GlobalAgentSettings, AgentSettings } from "@natstack/types";
import { getActiveWorkspace } from "./paths.js";
import { getAgentDiscovery } from "./agentDiscovery.js";
import { createDevLogger } from "./devLog.js";

const log = createDevLogger("AgentSettings");

const DATABASE_NAME = "agent-settings";

/** Default global settings */
const DEFAULT_GLOBAL_SETTINGS: GlobalAgentSettings = {
  defaultProjectLocation: "external",
  defaultAutonomy: 2,
};

/**
 * Singleton instance
 */
let instance: AgentSettingsService | null = null;

/**
 * Get the singleton AgentSettingsService instance.
 */
export function getAgentSettingsService(): AgentSettingsService | null {
  return instance;
}

/**
 * Initialize the AgentSettingsService.
 * Call this after AgentDiscovery has completed its initial scan.
 */
export async function initAgentSettingsService(): Promise<AgentSettingsService> {
  if (instance) {
    return instance;
  }

  instance = new AgentSettingsService();
  await instance.initialize();
  return instance;
}

/**
 * Shutdown the AgentSettingsService.
 */
export function shutdownAgentSettingsService(): void {
  if (instance) {
    instance.shutdown();
    instance = null;
  }
}

export class AgentSettingsService {
  private db: Database.Database | null = null;
  private unsubscribeDiscovery: (() => void)[] = [];

  /**
   * Initialize the service - open database and sync with discovery.
   */
  async initialize(): Promise<void> {
    const workspace = getActiveWorkspace();
    if (!workspace) {
      throw new Error("No active workspace - cannot initialize AgentSettingsService");
    }

    // Open database
    const dbDir = path.join(workspace.path, ".databases");
    fs.mkdirSync(dbDir, { recursive: true });

    const dbPath = path.join(dbDir, `${DATABASE_NAME}.db`);
    this.db = new Database(dbPath);

    // Enable WAL mode for better concurrent access
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.db.pragma("foreign_keys = ON");

    // Create schema
    this.db.exec(`
      -- Global settings: key-value store, each key is a GlobalAgentSettings property
      -- Values are JSON-serialized (e.g., '"external"' for string, '2' for number)
      CREATE TABLE IF NOT EXISTS global_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      -- Per-agent settings: stores default parameter values
      CREATE TABLE IF NOT EXISTS agent_settings (
        agent_id TEXT PRIMARY KEY,
        settings TEXT NOT NULL DEFAULT '{}',
        updated_at INTEGER NOT NULL
      );
    `);

    log.verbose(`Database initialized at: ${dbPath}`);

    // Sync with AgentDiscovery
    await this.syncWithDiscovery();

    // Subscribe to discovery events for live updates
    const discovery = getAgentDiscovery();
    if (discovery) {
      const safeSync = () => {
        this.syncWithDiscovery().catch((err) => {
          console.error("[AgentSettings] Failed to sync with discovery:", err);
        });
      };
      this.unsubscribeDiscovery.push(
        discovery.on("added", safeSync),
        discovery.on("removed", safeSync)
      );
    }
  }

  /**
   * Sync database with AgentDiscovery.
   * - Adds rows for newly discovered agents (with empty settings)
   * - Deletes rows for agents no longer in workspace/agents/
   * - Preserves existing settings for agents that still exist
   */
  async syncWithDiscovery(): Promise<void> {
    if (!this.db) return;

    const discovery = getAgentDiscovery();
    if (!discovery) {
      log.verbose("AgentDiscovery not available - skipping sync");
      return;
    }

    const validAgents = discovery.listValid();
    const validAgentIds = new Set(validAgents.map((a) => a.manifest.id));

    // Get existing agent IDs from database
    const existingRows = this.db
      .prepare("SELECT agent_id FROM agent_settings")
      .all() as { agent_id: string }[];
    const existingIds = new Set(existingRows.map((r) => r.agent_id));

    // Add new agents
    const insertStmt = this.db.prepare(
      "INSERT OR IGNORE INTO agent_settings (agent_id, settings, updated_at) VALUES (?, '{}', ?)"
    );
    const now = Date.now();
    for (const agentId of validAgentIds) {
      if (!existingIds.has(agentId)) {
        insertStmt.run(agentId, now);
        log.verbose(`Added settings row for new agent: ${agentId}`);
      }
    }

    // Remove agents that no longer exist
    const deleteStmt = this.db.prepare("DELETE FROM agent_settings WHERE agent_id = ?");
    for (const agentId of existingIds) {
      if (!validAgentIds.has(agentId)) {
        deleteStmt.run(agentId);
        log.verbose(`Removed settings row for deleted agent: ${agentId}`);
      }
    }
  }

  /**
   * Get global settings, merging with defaults.
   */
  getGlobalSettings(): GlobalAgentSettings {
    if (!this.db) {
      return { ...DEFAULT_GLOBAL_SETTINGS };
    }

    const rows = this.db
      .prepare("SELECT key, value FROM global_settings")
      .all() as { key: string; value: string }[];

    const result: Partial<GlobalAgentSettings> = {};
    for (const row of rows) {
      try {
        (result as Record<string, unknown>)[row.key] = JSON.parse(row.value);
      } catch {
        // Skip malformed entries
      }
    }

    return { ...DEFAULT_GLOBAL_SETTINGS, ...result };
  }

  /**
   * Set a single global setting.
   */
  setGlobalSetting<K extends keyof GlobalAgentSettings>(
    key: K,
    value: GlobalAgentSettings[K]
  ): void {
    if (!this.db) {
      throw new Error("AgentSettingsService not initialized");
    }

    const valueJson = JSON.stringify(value);
    const now = Date.now();

    this.db
      .prepare(
        `INSERT INTO global_settings (key, value, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = ?`
      )
      .run(key, valueJson, now, valueJson, now);

    log.verbose(`Set global setting: ${key} = ${valueJson}`);
  }

  /**
   * Get settings for a specific agent.
   */
  getAgentSettings(agentId: string): AgentSettings | null {
    if (!this.db) {
      return null;
    }

    const row = this.db
      .prepare("SELECT settings FROM agent_settings WHERE agent_id = ?")
      .get(agentId) as { settings: string } | undefined;

    if (!row) {
      return null;
    }

    try {
      return JSON.parse(row.settings) as AgentSettings;
    } catch {
      return {};
    }
  }

  /**
   * Get all agent settings as a map.
   */
  getAllAgentSettings(): Record<string, AgentSettings> {
    if (!this.db) {
      return {};
    }

    const rows = this.db
      .prepare("SELECT agent_id, settings FROM agent_settings")
      .all() as { agent_id: string; settings: string }[];

    const result: Record<string, AgentSettings> = {};
    for (const row of rows) {
      try {
        result[row.agent_id] = JSON.parse(row.settings) as AgentSettings;
      } catch {
        result[row.agent_id] = {};
      }
    }

    return result;
  }

  /**
   * Set settings for a specific agent.
   */
  setAgentSettings(agentId: string, settings: AgentSettings): void {
    if (!this.db) {
      throw new Error("AgentSettingsService not initialized");
    }

    const settingsJson = JSON.stringify(settings);
    const now = Date.now();

    this.db
      .prepare(
        `INSERT INTO agent_settings (agent_id, settings, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(agent_id) DO UPDATE SET settings = ?, updated_at = ?`
      )
      .run(agentId, settingsJson, now, settingsJson, now);

    log.verbose(`Set agent settings: ${agentId}`);
  }

  /**
   * Shutdown the service.
   */
  shutdown(): void {
    // Unsubscribe from discovery events
    for (const unsub of this.unsubscribeDiscovery) {
      unsub();
    }
    this.unsubscribeDiscovery = [];

    // Close database
    if (this.db) {
      this.db.close();
      this.db = null;
    }

    log.verbose("AgentSettingsService shutdown complete");
  }
}
