/**
 * Database service handlers for workers and panels.
 *
 * Provides a unified handler for SQLite operations that can be used by both
 * the worker service registration and panel IPC handlers.
 */

import { getWorkerManager } from "../workerManager.js";
import { getDatabaseManager, type DatabaseManager } from "../db/databaseManager.js";

/**
 * Handle a database service call.
 * Shared logic for both workers and panels.
 *
 * @param dbManager - The DatabaseManager instance
 * @param ownerId - The owner ID (worker or panel ID) for access control
 * @param scopeId - The scope ID (worker ID or panel partition) for database isolation
 * @param method - The database method to call
 * @param args - Arguments for the method
 */
export function handleDbCall(
  dbManager: DatabaseManager,
  ownerId: string,
  scopeId: string,
  method: string,
  args: unknown[]
): unknown {
  switch (method) {
    case "open": {
      const [dbName, readOnly] = args as [string, boolean?];
      return dbManager.openScopedDatabase(ownerId, scopeId, dbName, readOnly ?? false);
    }

    case "openShared": {
      const [dbName, readOnly] = args as [string, boolean?];
      return dbManager.openSharedDatabase(ownerId, dbName, readOnly ?? false);
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

/**
 * Register database service handlers with WorkerManager.
 */
export function registerDbHandlers(): void {
  const workerManager = getWorkerManager();
  const dbManager = getDatabaseManager();

  // Register the "db" service for SQLite operations
  // Workers use their workerId as both ownerId and scopeId
  workerManager.registerService("db", async (workerId, method, args) => {
    return handleDbCall(dbManager, workerId, workerId, method, args);
  });
}
