/**
 * Agent Registry
 *
 * SQLite-backed registry for agent definitions. Replaces broker-based discovery
 * with a simple database table that chat-launcher reads directly.
 */

import { db } from "@natstack/runtime";
import type { FieldDefinition } from "@natstack/runtime";

const REGISTRY_DB_NAME = "agent-registry";

/**
 * Required method specification for an agent.
 */
export interface RequiredMethodSpec {
  name?: string;
  pattern?: string;
  description?: string;
  required: boolean;
}

/**
 * Method advertisement for an agent.
 */
export interface MethodAdvertisement {
  name: string;
  description?: string;
  parameters: Record<string, unknown>;
  returns?: Record<string, unknown>;
  streaming?: boolean;
  timeout?: number;
}

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
  created_at: number;
  updated_at: number;
}

/**
 * Agent Registry - CRUD operations for agent definitions.
 */
export class AgentRegistry {
  private dbPromise: Promise<Awaited<ReturnType<typeof db.open>>> | null = null;

  /**
   * Initialize the database and create the table if needed.
   */
  async initialize(): Promise<void> {
    await this.getDb();
  }

  private async getDb() {
    if (!this.dbPromise) {
      this.dbPromise = (async () => {
        const database = await db.open(REGISTRY_DB_NAME);
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
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
          )
        `);
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
      "SELECT * FROM agent_definitions WHERE enabled = 1 ORDER BY name"
    );
    return rows.map((row) => this.rowToDefinition(row));
  }

  /**
   * List all agent definitions (enabled and disabled).
   */
  async listAll(): Promise<AgentDefinition[]> {
    const database = await this.getDb();
    const rows = await database.query<AgentDefinitionRow>(
      "SELECT * FROM agent_definitions ORDER BY name"
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
          enabled, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
