/**
 * Database service handlers.
 *
 * Provides a unified handler for SQLite operations that can be used by both
 * panels and workers via the ServiceDispatcher.
 */

import type { DatabaseManager } from "../db/databaseManager.js";

/**
 * Handle a database service call.
 * Shared logic for both workers and panels.
 *
 * @param dbManager - The DatabaseManager instance
 * @param ownerId - The owner ID (worker or panel ID) for cleanup tracking
 * @param method - The database method to call
 * @param args - Arguments for the method
 */
export function handleDbCall(
  dbManager: DatabaseManager,
  ownerId: string,
  method: string,
  args: unknown[]
): unknown {
  switch (method) {
    case "open": {
      const [dbName, readOnly] = args as [string, boolean?];
      return dbManager.open(ownerId, dbName, readOnly ?? false);
    }

    case "query": {
      const [handle, sql, params] = args as [string, string, unknown[]?];
      return dbManager.query(handle, sql, params);
    }

    case "run": {
      const [handle, sql, params] = args as [string, string, unknown[]?];
      return dbManager.run(handle, sql, params);
    }

    case "get": {
      const [handle, sql, params] = args as [string, string, unknown[]?];
      return dbManager.get(handle, sql, params);
    }

    case "exec": {
      const [handle, sql] = args as [string, string];
      dbManager.exec(handle, sql);
      return;
    }

    case "close": {
      const [handle] = args as [string];
      dbManager.close(handle);
      return;
    }

    default:
      throw new Error(`Unknown db method: ${method}`);
  }
}
