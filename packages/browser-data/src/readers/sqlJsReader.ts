import initSqlJs, { type Database as SqlJsDatabase, type SqlJsStatic } from "sql.js";

let sqlJsPromise: Promise<SqlJsStatic> | null = null;

async function getSqlJs(): Promise<SqlJsStatic> {
  if (!sqlJsPromise) sqlJsPromise = initSqlJs();
  return sqlJsPromise;
}

export interface ReaderStatement {
  all(...bindings: unknown[]): Record<string, unknown>[];
  get(...bindings: unknown[]): Record<string, unknown> | undefined;
}

export interface ReaderDatabase {
  prepare(sql: string): ReaderStatement;
  close(): void;
}

export async function openReadonlySqlite(bytes: Uint8Array): Promise<ReaderDatabase> {
  const SQL = await getSqlJs();
  const db = new SQL.Database(bytes);
  return {
    prepare(sql: string): ReaderStatement {
      return {
        all(...bindings: unknown[]) {
          const stmt = db.prepare(sql);
          try {
            if (bindings.length > 0) stmt.bind(bindings as never);
            const rows: Record<string, unknown>[] = [];
            while (stmt.step()) rows.push(stmt.getAsObject() as Record<string, unknown>);
            return rows;
          } finally {
            stmt.free();
          }
        },
        get(...bindings: unknown[]) {
          return this.all(...bindings)[0];
        },
      };
    },
    close() {
      db.close();
    },
  };
}

export type { ReaderDatabase as Database };

