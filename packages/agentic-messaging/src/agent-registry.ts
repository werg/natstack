/**
 * Agent Registry
 *
 * SQLite-backed registry for agent definitions. Replaces broker-based discovery
 * with a simple database table that chat-launcher reads directly.
 */

import { openDb, type Database } from "./db-inject.js";
import type { FieldDefinition, MethodAdvertisement, RequiredMethodSpec } from "@natstack/core";

// Re-export types for backward compatibility
export type { MethodAdvertisement, RequiredMethodSpec } from "@natstack/core";

const REGISTRY_DB_NAME = "agent-registry";

/**
 * Agent definition stored in the registry.
 */
export interface AgentDefinition {
  id: string;
  name: string;
  description: string;
  proposedHandle: string;
  workerSource: string;
  tags?: string[];
  parameters?: FieldDefinition[];
  providesMethods?: MethodAdvertisement[];
  requiresMethods?: RequiredMethodSpec[];
  enabled: boolean;
  sortOrder?: number;
  createdAt?: number;
  updatedAt?: number;
}

/**
 * SQLite row structure for agent_definitions table.
 */
interface AgentDefinitionRow {
  id: string;
  name: string;
  description: string;
  proposed_handle: string;
  worker_source: string;
  tags: string | null;
  parameters: string | null;
  provides_methods: string | null;
  requires_methods: string | null;
  enabled: number;
  sort_order: number;
  created_at: number;
  updated_at: number;
}

/**
 * Agent Registry - CRUD operations for agent definitions.
 */
export class AgentRegistry {
  private dbPromise: Promise<Database> | null = null;

  /**
   * Initialize the database and create the table if needed.
   */
  async initialize(): Promise<void> {
    await this.getDb();
  }

  private async getDb() {
    if (!this.dbPromise) {
      this.dbPromise = (async () => {
        const database = await openDb(REGISTRY_DB_NAME);
        await database.exec(`
          CREATE TABLE IF NOT EXISTS agent_definitions (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            description TEXT NOT NULL,
            proposed_handle TEXT NOT NULL,
            worker_source TEXT NOT NULL,
            tags TEXT,
            parameters TEXT,
            provides_methods TEXT,
            requires_methods TEXT,
            enabled INTEGER DEFAULT 1,
            sort_order INTEGER DEFAULT 999,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
          )
        `);
        // Add sort_order column if it doesn't exist (migration for existing DBs)
        try {
          await database.exec(`ALTER TABLE agent_definitions ADD COLUMN sort_order INTEGER DEFAULT 999`);
        } catch {
          // Column already exists, ignore
        }
        return database;
      })();
    }
    return this.dbPromise;
  }

  /**
   * Convert a database row to an AgentDefinition.
   */
  private rowToDefinition(row: AgentDefinitionRow): AgentDefinition {
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      proposedHandle: row.proposed_handle,
      workerSource: row.worker_source,
      tags: row.tags ? JSON.parse(row.tags) : undefined,
      parameters: row.parameters ? JSON.parse(row.parameters) : undefined,
      providesMethods: row.provides_methods ? JSON.parse(row.provides_methods) : undefined,
      requiresMethods: row.requires_methods ? JSON.parse(row.requires_methods) : undefined,
      enabled: row.enabled === 1,
      sortOrder: row.sort_order,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  /**
   * List all enabled agent definitions.
   */
  async listEnabled(): Promise<AgentDefinition[]> {
    const database = await this.getDb();
    const rows = await database.query<AgentDefinitionRow>(
      "SELECT * FROM agent_definitions WHERE enabled = 1 ORDER BY sort_order, name"
    );
    return rows.map((row) => this.rowToDefinition(row));
  }

  /**
   * List all agent definitions (enabled and disabled).
   */
  async listAll(): Promise<AgentDefinition[]> {
    const database = await this.getDb();
    const rows = await database.query<AgentDefinitionRow>(
      "SELECT * FROM agent_definitions ORDER BY sort_order, name"
    );
    return rows.map((row) => this.rowToDefinition(row));
  }

  /**
   * Get a specific agent definition by ID.
   */
  async get(id: string): Promise<AgentDefinition | null> {
    const database = await this.getDb();
    const rows = await database.query<AgentDefinitionRow>(
      "SELECT * FROM agent_definitions WHERE id = ?",
      [id]
    );
    if (rows.length === 0) return null;
    return this.rowToDefinition(rows[0]!);
  }

  /**
   * Insert or update an agent definition.
   */
  async upsert(definition: Omit<AgentDefinition, "createdAt" | "updatedAt">): Promise<void> {
    const database = await this.getDb();
    const now = Date.now();

    // Check if exists
    const existing = await this.get(definition.id);

    if (existing) {
      // Update
      await database.run(
        `UPDATE agent_definitions SET
          name = ?,
          description = ?,
          proposed_handle = ?,
          worker_source = ?,
          tags = ?,
          parameters = ?,
          provides_methods = ?,
          requires_methods = ?,
          enabled = ?,
          sort_order = ?,
          updated_at = ?
        WHERE id = ?`,
        [
          definition.name,
          definition.description,
          definition.proposedHandle,
          definition.workerSource,
          definition.tags ? JSON.stringify(definition.tags) : null,
          definition.parameters ? JSON.stringify(definition.parameters) : null,
          definition.providesMethods ? JSON.stringify(definition.providesMethods) : null,
          definition.requiresMethods ? JSON.stringify(definition.requiresMethods) : null,
          definition.enabled ? 1 : 0,
          definition.sortOrder ?? 999,
          now,
          definition.id,
        ]
      );
    } else {
      // Insert
      await database.run(
        `INSERT INTO agent_definitions (
          id, name, description, proposed_handle, worker_source,
          tags, parameters, provides_methods, requires_methods,
          enabled, sort_order, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          definition.id,
          definition.name,
          definition.description,
          definition.proposedHandle,
          definition.workerSource,
          definition.tags ? JSON.stringify(definition.tags) : null,
          definition.parameters ? JSON.stringify(definition.parameters) : null,
          definition.providesMethods ? JSON.stringify(definition.providesMethods) : null,
          definition.requiresMethods ? JSON.stringify(definition.requiresMethods) : null,
          definition.enabled ? 1 : 0,
          definition.sortOrder ?? 999,
          now,
          now,
        ]
      );
    }
  }

  /**
   * Delete an agent definition.
   */
  async delete(id: string): Promise<boolean> {
    const database = await this.getDb();
    const result = await database.run(
      "DELETE FROM agent_definitions WHERE id = ?",
      [id]
    );
    return (result.changes ?? 0) > 0;
  }

  /**
   * Enable or disable an agent.
   */
  async setEnabled(id: string, enabled: boolean): Promise<boolean> {
    const database = await this.getDb();
    const result = await database.run(
      "UPDATE agent_definitions SET enabled = ?, updated_at = ? WHERE id = ?",
      [enabled ? 1 : 0, Date.now(), id]
    );
    return (result.changes ?? 0) > 0;
  }
}

// Singleton instance
let registryInstance: AgentRegistry | null = null;

/**
 * Get the singleton AgentRegistry instance.
 */
export function getAgentRegistry(): AgentRegistry {
  if (!registryInstance) {
    registryInstance = new AgentRegistry();
  }
  return registryInstance;
}
