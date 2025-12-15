import type { RpcBridge } from "@natstack/rpc";

export interface DbRunResult {
  changes: number;
  lastInsertRowid: number | bigint;
}

export interface Database {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  run(sql: string, params?: unknown[]): Promise<DbRunResult>;
  get<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T | null>;
  exec(sql: string): Promise<void>;
  close(): Promise<void>;
}

function createDatabase(rpc: RpcBridge, handle: string): Database {
  let closed = false;
  const assertOpen = () => {
    if (closed) throw new Error("Database connection is closed");
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

export function createDbClient(rpc: RpcBridge) {
  return {
    async open(name: string, readOnly = false): Promise<Database> {
      const handle = await rpc.call<string>("main", "db.open", name, readOnly);
      return createDatabase(rpc, handle);
    },
  };
}

