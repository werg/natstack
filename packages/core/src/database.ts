/**
 * Database - Minimal database interface for state persistence.
 *
 * Provides:
 * - DatabaseInterface: The interface for database operations
 * - createDbClient: Factory for creating RPC-based database clients
 *
 * The actual SQLite implementation lives in the main process.
 * Workers and agents use createDbClient() to access databases via RPC.
 */

// =============================================================================
// Database Interface Types
// =============================================================================

/**
 * Result from INSERT/UPDATE/DELETE operations.
 */
export interface DbRunResult {
  changes: number;
  lastInsertRowid: number | bigint;
}

/**
 * Minimal database interface for state persistence.
 * Implemented by the main process's DatabaseManager.
 */
export interface DatabaseInterface {
  /** Execute raw SQL (for schema creation) */
  exec(sql: string): Promise<void>;

  /** Run a single query with parameters */
  run(sql: string, params?: unknown[]): Promise<DbRunResult>;

  /** Query single row. Returns null/undefined if no row found. */
  get<T = unknown>(sql: string, params?: unknown[]): Promise<T | null | undefined>;

  /** Query multiple rows */
  query<T = unknown>(sql: string, params?: unknown[]): Promise<T[]>;

  /** Close the database connection */
  close(): Promise<void>;
}

/**
 * Factory function type for opening databases.
 */
export type DatabaseOpener = (name: string, readOnly?: boolean) => Promise<DatabaseInterface>;

// =============================================================================
// RPC-based Database Client
// =============================================================================

/**
 * Minimal RPC caller interface.
 * RpcBridge from @natstack/rpc satisfies this interface.
 * Defined here to avoid circular dependencies (core is a leaf package).
 */
export interface RpcCaller {
  call<T = unknown>(targetId: string, method: string, ...args: unknown[]): Promise<T>;
}

/**
 * Database client interface returned by createDbClient().
 */
export interface DbClient {
  /**
   * Open a database by name.
   * The database file is managed by the main process.
   *
   * @param name - Database name (will be sanitized for filesystem)
   * @param readOnly - Whether to open in read-only mode
   */
  open(name: string, readOnly?: boolean): Promise<DatabaseInterface>;
}

/**
 * Create a DatabaseInterface proxy that calls the main process via RPC.
 *
 * @param rpc - RPC caller (e.g., RpcBridge from @natstack/rpc)
 * @param handle - Database handle returned from db.open
 * @returns DatabaseInterface that proxies all calls to the main process
 */
function createDatabaseProxy(rpc: RpcCaller, handle: string): DatabaseInterface {
  let closed = false;

  const assertOpen = () => {
    if (closed) throw new Error("Database connection is closed");
  };

  return {
    async exec(sql: string): Promise<void> {
      assertOpen();
      await rpc.call("main", "db.exec", handle, sql);
    },

    async run(sql: string, params?: unknown[]): Promise<DbRunResult> {
      assertOpen();
      return rpc.call<DbRunResult>("main", "db.run", handle, sql, params);
    },

    async get<T = unknown>(sql: string, params?: unknown[]): Promise<T | null | undefined> {
      assertOpen();
      return rpc.call<T | null | undefined>("main", "db.get", handle, sql, params);
    },

    async query<T = unknown>(sql: string, params?: unknown[]): Promise<T[]> {
      assertOpen();
      return rpc.call<T[]>("main", "db.query", handle, sql, params);
    },

    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      await rpc.call("main", "db.close", handle);
    },
  };
}

/**
 * Create a database client that uses RPC to access databases in the main process.
 *
 * @param rpc - RPC caller (e.g., RpcBridge from @natstack/rpc)
 * @returns DbClient for opening databases
 *
 * @example
 * ```typescript
 * import { createRpcBridge } from '@natstack/rpc';
 * import { createDbClient } from '@natstack/core';
 *
 * const rpc = createRpcBridge({ selfId: 'worker:123', transport });
 * const dbClient = createDbClient(rpc);
 *
 * const db = await dbClient.open('my-database');
 * await db.exec('CREATE TABLE IF NOT EXISTS items (id INTEGER PRIMARY KEY, name TEXT)');
 * await db.run('INSERT INTO items (name) VALUES (?)', ['item1']);
 * const items = await db.query('SELECT * FROM items');
 * await db.close();
 * ```
 */
export function createDbClient(rpc: RpcCaller): DbClient {
  return {
    async open(name: string, readOnly = false): Promise<DatabaseInterface> {
      const handle = await rpc.call<string>("main", "db.open", name, readOnly);
      return createDatabaseProxy(rpc, handle);
    },
  };
}
