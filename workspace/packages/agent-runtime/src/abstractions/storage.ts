/**
 * Storage API - unified database interface for agent state persistence.
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
 * @example
 * ```typescript
 * await storage.exec(`CREATE TABLE IF NOT EXISTS my_table (...)`);
 * const rows = await storage.query<MyRow>(`SELECT * FROM my_table WHERE id = ?`, [id]);
 * await storage.run(`INSERT INTO my_table (id, value) VALUES (?, ?)`, [id, value]);
 * ```
 */
export interface StorageApi {
  /**
   * Execute raw SQL (typically for schema creation).
   * Safe to call multiple times (use IF NOT EXISTS for idempotency).
   */
  exec(sql: string): void | Promise<void>;

  /**
   * Run a write query (INSERT, UPDATE, DELETE).
   */
  run(sql: string, params?: unknown[]): RunResult | Promise<RunResult>;

  /**
   * Query for a single row.
   */
  get<T>(sql: string, params?: unknown[]): T | null | Promise<T | null>;

  /**
   * Query for multiple rows.
   */
  query<T>(sql: string, params?: unknown[]): T[] | Promise<T[]>;

  /**
   * Flush any pending writes to durable storage.
   */
  flush(): void | Promise<void>;
}
