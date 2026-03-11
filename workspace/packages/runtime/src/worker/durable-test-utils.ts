import initSqlJs, { type Database, type SqlJsStatic } from "sql.js";
import type { AgentWorkerBase } from "./durable.js";

interface SqlResult {
  toArray(): Record<string, unknown>[];
  one(): Record<string, unknown>;
}

interface TestDOResult<T> {
  instance: T;
  sql: { exec(query: string, ...bindings: unknown[]): SqlResult };
}

/** Shared sql.js initialization (cached after first call) */
let sqlJsPromise: Promise<SqlJsStatic> | null = null;
function getSqlJs(): Promise<SqlJsStatic> {
  if (!sqlJsPromise) sqlJsPromise = initSqlJs();
  return sqlJsPromise;
}

/**
 * Create a workerd-compatible SQL proxy backed by sql.js (pure WASM).
 * Matches the `ctx.storage.sql.exec()` API that workerd DOs use.
 */
function createSqlProxy(db: Database) {
  return {
    exec(query: string, ...bindings: unknown[]): SqlResult {
      const trimmed = query.trim().toUpperCase();
      const isQuery = trimmed.startsWith("SELECT") || trimmed.startsWith("WITH") || trimmed.startsWith("PRAGMA");

      if (isQuery) {
        const stmt = db.prepare(query);
        if (bindings.length > 0) stmt.bind(bindings);
        const rows: Record<string, unknown>[] = [];
        while (stmt.step()) rows.push(stmt.getAsObject() as Record<string, unknown>);
        stmt.free();
        return {
          toArray() { return rows; },
          one() {
            if (rows.length === 0) throw new Error("Expected one row, got none");
            return rows[0]!;
          },
        };
      } else {
        if (bindings.length === 0) {
          db.run(query);
        } else {
          db.run(query, bindings);
        }
        return {
          toArray() { return []; },
          one() { throw new Error("No rows from mutation"); },
        };
      }
    },
  };
}

/**
 * Create a test DO instance backed by in-memory SQLite (sql.js / WASM).
 * Eliminates the need for workerd or native modules in unit tests.
 *
 * Must be awaited since sql.js initialization is async.
 */
export async function createTestDO<T>(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  DOClass: new (ctx: any, env: any) => T,
  env?: Record<string, unknown>,
): Promise<TestDOResult<T>> {
  const SQL = await getSqlJs();
  const db = new SQL.Database();
  const sqlProxy = createSqlProxy(db);

  const ctx = {
    storage: { sql: sqlProxy },
  };

  const instance = new DOClass(ctx, env ?? {});

  return { instance, sql: sqlProxy };
}
