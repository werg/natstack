/**
 * Database - Minimal database interface for state persistence.
 *
 * Defines the interface that @natstack/runtime implements.
 * Agents and other consumers use this interface via dependency injection.
 */

/**
 * Result from INSERT/UPDATE/DELETE operations.
 */
export interface DbRunResult {
  changes?: number;
  lastInsertRowid?: number | bigint;
}

/**
 * Minimal database interface for state persistence.
 * Implemented by @natstack/runtime's db service.
 */
export interface DatabaseInterface {
  /** Execute raw SQL (for schema creation) */
  exec(sql: string): Promise<void>;

  /** Run a single query with parameters */
  run(sql: string, params?: unknown[]): Promise<DbRunResult>;

  /** Query single row */
  get<T = unknown>(sql: string, params?: unknown[]): Promise<T | undefined>;

  /** Query multiple rows */
  query<T = unknown>(sql: string, params?: unknown[]): Promise<T[]>;
}

/**
 * Factory function type for opening databases.
 */
export type DatabaseOpener = (name: string) => Promise<DatabaseInterface>;
