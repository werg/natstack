/**
 * Electron Storage Adapter
 *
 * Wraps the existing RPC-based DatabaseInterface to implement StorageApi.
 * All operations are async (RPC to host process with better-sqlite3).
 */

import type { DatabaseInterface } from "@natstack/core";
import type { StorageApi, RunResult } from "../abstractions/storage.js";

/**
 * Create an Electron storage adapter from a DatabaseInterface.
 *
 * This adapter wraps the existing RPC-based database interface used in
 * Electron's utilityProcess to implement the unified StorageApi.
 *
 * @param db - Database interface from createDbClient().open()
 * @returns StorageApi implementation
 */
export function createElectronStorage(db: DatabaseInterface): StorageApi {
  return {
    async exec(sql: string): Promise<void> {
      await db.exec(sql);
    },

    async run(sql: string, params?: unknown[]): Promise<RunResult> {
      const result = await db.run(sql, params ?? []);
      return {
        changes: result.changes,
        lastInsertRowid: result.lastInsertRowid,
      };
    },

    async get<T>(sql: string, params?: unknown[]): Promise<T | null> {
      const row = await db.get<T>(sql, params ?? []);
      return row ?? null;
    },

    async query<T>(sql: string, params?: unknown[]): Promise<T[]> {
      const rows = await db.query<T>(sql, params ?? []);
      return rows;
    },

    async flush(): Promise<void> {
      // In Electron, the DB write is synchronous in the host process
      // when the RPC completes. No additional flush needed, but we
      // include this for the state store's flush() call.
    },
  };
}
