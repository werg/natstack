/**
 * Shared database types for SQLite service.
 * Used by main process, preload, and worker-runtime.
 */

/** Supported SQLite value types */
export type DbValue = string | number | bigint | Buffer | null;

/** Result of a query operation */
export interface DbQueryResult<T = Record<string, DbValue>> {
  rows: T[];
  columns: string[];
}

/** Result of a run (INSERT/UPDATE/DELETE) operation */
export interface DbRunResult {
  /** Number of rows changed */
  changes: number;
  /** Row ID of the last inserted row */
  lastInsertRowid: number | bigint;
}

/** Database connection info returned when opening */
export interface DbConnectionInfo {
  /** Opaque handle for subsequent operations */
  handle: string;
  /** Resolved path to the database file */
  path: string;
  /** Whether this is a shared workspace database */
  shared: boolean;
  /** Whether opened in read-only mode */
  readOnly: boolean;
}

/** Options for opening a database */
export interface DbOpenOptions {
  /** Open in read-only mode */
  readOnly?: boolean;
}
