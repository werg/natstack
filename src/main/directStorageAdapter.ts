/**
 * Direct Storage Adapter
 *
 * Implements the StorageApi interface from @workspace/agent-runtime using
 * the DatabaseManager directly, bypassing the RPC bridge that was needed
 * when agents ran in separate processes.
 *
 * Used by the in-process AgentHost to provide state persistence
 * for responders that now run in the main server process.
 */

import type { StorageApi, RunResult } from "@workspace/agent-runtime";
import { getDatabaseManager } from "./db/databaseManager.js";

/**
 * Create a StorageApi backed by the DatabaseManager singleton.
 *
 * Uses the same DB name ("agent-state") and path conventions as the old
 * RPC-based adapter so existing agent state survives the migration.
 *
 * @param ownerId - Owner identifier for the DB connection (e.g., "agent:claude-code-responder:assistant")
 */
export function createDirectStorageApi(ownerId: string): StorageApi {
  const dbManager = getDatabaseManager();
  const handle = dbManager.open(ownerId, "agent-state");

  return {
    exec(sql: string): void {
      dbManager.exec(handle, sql);
    },

    run(sql: string, params?: unknown[]): RunResult {
      const result = dbManager.run(handle, sql, params);
      return {
        changes: result.changes,
        lastInsertRowid: result.lastInsertRowid,
      };
    },

    get<T>(sql: string, params?: unknown[]): T | null {
      return dbManager.get<T>(handle, sql, params);
    },

    query<T>(sql: string, params?: unknown[]): T[] {
      return dbManager.query<T>(handle, sql, params);
    },

    flush(): void {
      // No-op: better-sqlite3 writes are synchronous
    },
  };
}
