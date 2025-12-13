/**
 * Database API for workers.
 *
 * Provides SQLite database access via RPC to the main process.
 * All databases are shared across the workspace.
 *
 * @example
 * ```typescript
 * import { db } from "@natstack/worker-runtime";
 *
 * // Open a database
 * const database = await db.open("my-data");
 *
 * // Create tables
 * await database.exec(`
 *   CREATE TABLE IF NOT EXISTS notes (
 *     id INTEGER PRIMARY KEY AUTOINCREMENT,
 *     title TEXT NOT NULL,
 *     content TEXT
 *   )
 * `);
 *
 * // Insert data
 * const result = await database.run(
 *   "INSERT INTO notes (title, content) VALUES (?, ?)",
 *   ["My Note", "Some content"]
 * );
 * console.log("Inserted row:", result.lastInsertRowid);
 *
 * // Query data
 * const notes = await database.query<{ id: number; title: string }>(
 *   "SELECT id, title FROM notes"
 * );
 * ```
 */

import { rpc } from "./rpc.js";

/** Result of a run (INSERT/UPDATE/DELETE) operation */
export interface DbRunResult {
  /** Number of rows changed */
  changes: number;
  /** Row ID of the last inserted row */
  lastInsertRowid: number | bigint;
}

/** Database connection handle with query methods */
export interface Database {
  /**
   * Execute a query and return all rows.
   * Use parameterized queries to prevent SQL injection.
   */
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;

  /**
   * Execute a statement (INSERT/UPDATE/DELETE) and return changes info.
   * Use parameterized queries to prevent SQL injection.
   */
  run(sql: string, params?: unknown[]): Promise<DbRunResult>;

  /**
   * Execute a query and return only the first row, or null if no results.
   * Use parameterized queries to prevent SQL injection.
   */
  get<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T | null>;

  /**
   * Execute raw SQL (for schema changes, multi-statement scripts).
   * Does not support parameters - use for DDL statements only.
   */
  exec(sql: string): Promise<void>;

  /**
   * Close the database connection.
   * After closing, all methods will throw an error.
   */
  close(): Promise<void>;
}

/**
 * Create a Database wrapper around a handle.
 */
function createDatabase(handle: string): Database {
  let closed = false;

  const assertOpen = () => {
    if (closed) {
      throw new Error("Database connection is closed");
    }
  };

  return {
    async query<T>(sql: string, params?: unknown[]): Promise<T[]> {
      assertOpen();
      return rpc.call<T[]>("main", "db.query", handle, sql, params);
    },

    async run(sql: string, params?: unknown[]): Promise<DbRunResult> {
      assertOpen();
      return rpc.call<DbRunResult>("main", "db.run", handle, sql, params);
    },

    async get<T>(sql: string, params?: unknown[]): Promise<T | null> {
      assertOpen();
      return rpc.call<T | null>("main", "db.get", handle, sql, params);
    },

    async exec(sql: string): Promise<void> {
      assertOpen();
      await rpc.call("main", "db.exec", handle, sql);
    },

    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      await rpc.call("main", "db.close", handle);
    },
  };
}

/**
 * Open a database.
 * All databases are shared across the workspace.
 *
 * @param name - Database name (alphanumeric, underscore, hyphen only)
 * @param readOnly - Open in read-only mode (default: false)
 */
export async function openDatabase(name: string, readOnly = false): Promise<Database> {
  const handle = await rpc.call<string>("main", "db.open", name, readOnly);
  return createDatabase(handle);
}

/**
 * Database API namespace.
 */
export const db = {
  open: openDatabase,
};
