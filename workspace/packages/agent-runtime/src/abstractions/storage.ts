/**
 * Storage API Abstraction
 *
 * Provides a unified interface for database operations that works across:
 * - Electron: RPC-based SQLite via better-sqlite3
 * - Durable Objects: Synchronous ctx.storage.sql
 *
 * Implementations:
 * - ElectronStorageAdapter: Wraps DatabaseInterface with Promise-based methods
 * - DoStorageAdapter: Wraps DO's synchronous SQL API
 */

/**
 * Result from a write query (INSERT, UPDATE, DELETE).
 */
export interface RunResult {
  /** Number of rows affected */
  changes: number;
  /** Last inserted row ID (for auto-increment) */
  lastInsertRowid: number | bigint;
}

/**
 * Unified storage interface for agent state persistence.
 *
 * All methods can return either sync or async results, allowing
 * the same interface to work with:
 * - Electron's async RPC-based database
 * - DO's synchronous ctx.storage.sql
 *
 * @example
 * ```typescript
 * // Works the same way in both runtimes:
 * await storage.exec(`CREATE TABLE IF NOT EXISTS my_table (...)`);
 * const rows = await storage.query<MyRow>(`SELECT * FROM my_table WHERE id = ?`, [id]);
 * await storage.run(`INSERT INTO my_table (id, value) VALUES (?, ?)`, [id, value]);
 * ```
 */
export interface StorageApi {
  /**
   * Execute raw SQL (typically for schema creation).
   * Safe to call multiple times (use IF NOT EXISTS for idempotency).
   *
   * @param sql - SQL statement(s) to execute
   */
  exec(sql: string): void | Promise<void>;

  /**
   * Run a write query (INSERT, UPDATE, DELETE).
   *
   * @param sql - SQL statement with ? placeholders
   * @param params - Parameter values to bind
   * @returns Result with changes count and lastInsertRowid
   */
  run(sql: string, params?: unknown[]): RunResult | Promise<RunResult>;

  /**
   * Query for a single row.
   *
   * @param sql - SQL query with ? placeholders
   * @param params - Parameter values to bind
   * @returns The first matching row, or null if none
   */
  get<T>(sql: string, params?: unknown[]): T | null | Promise<T | null>;

  /**
   * Query for multiple rows.
   *
   * @param sql - SQL query with ? placeholders
   * @param params - Parameter values to bind
   * @returns Array of matching rows (empty if none)
   */
  query<T>(sql: string, params?: unknown[]): T[] | Promise<T[]>;

  /**
   * Flush any pending writes to durable storage.
   *
   * - Electron: Forces immediate write of debounced changes
   * - DO: No-op (writes are already synchronous)
   */
  flush(): void | Promise<void>;
}
