import { describe, expect, it } from "vitest";
import initSqlJs from "sql.js";

import { DurableObjectBase } from "@natstack/durable";
import { createTestDO } from "@natstack/durable/test-utils";
import { ScopeStoreDO } from "./internalDOs/scopeStoreDO.js";

describe("internal storage Durable Objects", () => {
  it("persists and lists REPL scopes through ScopeStoreDO", async () => {
    const { call } = await createTestDO(ScopeStoreDO);

    await call("upsert", {
      id: "scope-1",
      channelId: "channel-1",
      panelId: "panel-1",
      data: "const answer = 42",
      serializedKeys: ["answer"],
      droppedPaths: [],
      partialKeys: ["answer"],
      createdAt: 100,
    });
    await call("upsert", {
      id: "scope-2",
      channelId: "channel-1",
      panelId: "panel-1",
      data: "const answer = 43",
      serializedKeys: ["answer"],
      droppedPaths: [{ path: "old", reason: "shadowed" }],
      partialKeys: [],
      createdAt: 200,
    });

    expect(await call("loadCurrent", "channel-1", "panel-1")).toMatchObject({
      id: "scope-2",
      data: "const answer = 43",
    });
    expect(await call("list", "channel-1")).toEqual([
      { id: "scope-1", createdAt: 100, keys: ["answer"], partial: ["answer"] },
      { id: "scope-2", createdAt: 200, keys: ["answer"], partial: [] },
    ]);
  });
});

class MigrationProbeDO extends DurableObjectBase {
  static override schemaVersion = 2;

  protected createTables(): void {
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS migration_log (from_version INTEGER, to_version INTEGER)`
    );
  }

  protected override migrate(fromVersion: number, toVersion: number): void {
    this.sql.exec(
      `INSERT INTO migration_log (from_version, to_version) VALUES (?, ?)`,
      fromVersion,
      toVersion
    );
  }

  countMigrations(): number {
    return (this.sql.exec(`SELECT COUNT(*) as count FROM migration_log`).one() as { count: number })
      .count;
  }
}

class DestructiveMigrationProbeDO extends DurableObjectBase {
  static override schemaVersion = 2;

  protected createTables(): void {
    this.sql.exec(`CREATE TABLE IF NOT EXISTS required_table (id TEXT PRIMARY KEY)`);
  }

  protected override migrate(fromVersion: number, _toVersion: number): void {
    if (fromVersion > 0) this.sql.exec(`DROP TABLE IF EXISTS required_table`);
  }

  hasRequiredTable(): boolean {
    return (
      this.sql
        .exec(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'required_table'`)
        .toArray().length === 1
    );
  }
}

describe("DurableObjectBase migration hook", () => {
  it("runs migrate before recording the target schema version and skips after readiness", async () => {
    const { call, sql } = await createTestDO(MigrationProbeDO);

    expect(await call("countMigrations")).toBe(1);
    expect(await call("countMigrations")).toBe(1);
    expect(sql.exec(`SELECT value FROM state WHERE key = 'schema_version'`).one()).toEqual({
      value: "2",
    });
  });

  it("recreates current tables after a destructive migration before recording readiness", async () => {
    const SQL = await initSqlJs();
    const db = new SQL.Database();
    db.run(`CREATE TABLE state (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    db.run(`INSERT INTO state (key, value) VALUES ('schema_version', ?)`, ["1"]);

    const { call, sql } = await createTestDO(DestructiveMigrationProbeDO, undefined, { db });

    expect(await call("hasRequiredTable")).toBe(true);
    sql.exec(`INSERT INTO required_table (id) VALUES ('row-1')`);
    expect(sql.exec(`SELECT id FROM required_table`).one()).toEqual({ id: "row-1" });
    expect(sql.exec(`SELECT value FROM state WHERE key = 'schema_version'`).one()).toEqual({
      value: "2",
    });
  });

  it("repairs a current-version schema that is missing idempotent tables", async () => {
    const SQL = await initSqlJs();
    const db = new SQL.Database();
    db.run(`CREATE TABLE state (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    db.run(`INSERT INTO state (key, value) VALUES ('schema_version', ?)`, ["2"]);

    const { call, sql } = await createTestDO(DestructiveMigrationProbeDO, undefined, { db });

    expect(await call("hasRequiredTable")).toBe(true);
    expect(sql.exec(`SELECT value FROM state WHERE key = 'schema_version'`).one()).toEqual({
      value: "2",
    });
  });
});
