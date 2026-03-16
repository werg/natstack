import initSqlJs, { type Database, type SqlJsStatic } from "sql.js";

interface SqlResult {
  toArray(): Record<string, unknown>[];
  one(): Record<string, unknown>;
}

interface TestDOResult<T> {
  instance: T;
  sql: { exec(query: string, ...bindings: unknown[]): SqlResult };
  /** Alarms scheduled via ctx.storage.setAlarm(). Inspectable in tests. */
  alarms: number[];
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

/** Default env stubs so AgentWorkerBase subclasses don't crash during construction.
 *  The HTTP clients are created but never called in unit tests. */
const AGENTIC_ENV_DEFAULTS: Record<string, string> = {
  PUBSUB_URL: "http://test-pubsub.invalid",
  SERVER_URL: "http://test-server.invalid",
  RPC_AUTH_TOKEN: "test-token",
};

/**
 * Create a test DO instance backed by in-memory SQLite (sql.js / WASM).
 * Eliminates the need for workerd or native modules in unit tests.
 *
 * Works with both DurableObjectBase and AgentWorkerBase subclasses.
 * For AgentWorkerBase subclasses, PUBSUB_URL/SERVER_URL/RPC_AUTH_TOKEN
 * are automatically stubbed unless overridden via the env parameter.
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

  const alarms: number[] = [];

  const ctx = {
    storage: {
      sql: sqlProxy,
      setAlarm(scheduledTime: number | Date) {
        const ts = typeof scheduledTime === "number" ? scheduledTime : scheduledTime.getTime();
        alarms.push(ts);
      },
      async getAlarm(): Promise<number | null> {
        return alarms.length > 0 ? alarms[alarms.length - 1]! : null;
      },
      deleteAlarm() {
        alarms.length = 0;
      },
    },
    acceptWebSocket(_ws: unknown) { /* no-op in tests */ },
    getWebSockets() { return []; },
  };

  const mergedEnv = { ...AGENTIC_ENV_DEFAULTS, ...env };
  const instance = new DOClass(ctx, mergedEnv);

  return { instance, sql: sqlProxy, alarms };
}
