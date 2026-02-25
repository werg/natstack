/**
 * Database - RPC database proxy factory.
 *
 * Inlined from @workspace/core/database.ts during package rescoping.
 */

import type { DatabaseInterface, DbRunResult, RpcCaller, DbClient } from "@natstack/types";

/**
 * Create a DatabaseInterface proxy that calls the main process via RPC.
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
 */
export function createDbClient(rpc: RpcCaller): DbClient {
  return {
    async open(name: string, readOnly = false): Promise<DatabaseInterface> {
      const handle = await rpc.call<string>("main", "db.open", name, readOnly);
      return createDatabaseProxy(rpc, handle);
    },
  };
}
