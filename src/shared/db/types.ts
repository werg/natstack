/**
 * Shared database types for SQLite service.
 * Used by the main process database manager.
 */

/** Result of a run (INSERT/UPDATE/DELETE) operation */
export interface DbRunResult {
  /** Number of rows changed */
  changes: number;
  /** Row ID of the last inserted row */
  lastInsertRowid: number | bigint;
}
