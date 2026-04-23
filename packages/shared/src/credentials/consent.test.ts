import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConsentGrantStore } from "./consent.js";
import type { DatabaseHandle } from "./consent.js";

class BetterSqliteHandle implements DatabaseHandle {
  constructor(private readonly db: Database.Database) {}

  run(sql: string, params: readonly unknown[] = []): void {
    this.db.prepare(sql).run(...params);
  }

  all<T>(sql: string, params: readonly unknown[] = []): T[] {
    return this.db.prepare(sql).all(...params) as T[];
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }
}

describe("ConsentGrantStore", () => {
  let db: Database.Database;
  let store: ConsentGrantStore;

  beforeEach(() => {
    db = new Database(":memory:");
    store = new ConsentGrantStore(new BetterSqliteHandle(db));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    db.close();
  });

  it("grants consent and lists grants for a worker", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);

    await store.grant({
      workerId: "worker-1",
      providerId: "github",
      connectionId: "primary",
      scopes: ["repo", "user:email"],
      role: "owner",
    });

    await expect(store.list("worker-1")).resolves.toEqual([
      {
        workerId: "worker-1",
        providerId: "github",
        connectionId: "primary",
        scopes: ["repo", "user:email"],
        grantedAt: 1_700_000_000_000,
        role: "owner",
      },
    ]);
  });

  it("upserts an existing grant", async () => {
    const nowSpy = vi.spyOn(Date, "now");
    nowSpy.mockReturnValueOnce(1_700_000_000_000);
    await store.grant({
      workerId: "worker-1",
      providerId: "github",
      connectionId: "primary",
      scopes: ["repo"],
      role: "reader",
    });

    nowSpy.mockReturnValueOnce(1_700_000_000_500);
    await store.grant({
      workerId: "worker-1",
      providerId: "github",
      connectionId: "primary",
      scopes: ["repo", "user:email"],
      role: "owner",
    });

    await expect(store.list("worker-1")).resolves.toEqual([
      {
        workerId: "worker-1",
        providerId: "github",
        connectionId: "primary",
        scopes: ["repo", "user:email"],
        grantedAt: 1_700_000_000_500,
        role: "owner",
      },
    ]);
  });

  it("revokes a single connection or all provider grants", async () => {
    await store.grant({
      workerId: "worker-1",
      providerId: "github",
      connectionId: "primary",
      scopes: ["repo"],
    });
    await store.grant({
      workerId: "worker-1",
      providerId: "github",
      connectionId: "secondary",
      scopes: ["repo"],
    });
    await store.grant({
      workerId: "worker-1",
      providerId: "slack",
      connectionId: "workspace",
      scopes: ["channels:read"],
    });

    await store.revoke("worker-1", "github", "primary");
    await expect(store.list("worker-1")).resolves.toEqual([
      {
        workerId: "worker-1",
        providerId: "github",
        connectionId: "secondary",
        scopes: ["repo"],
        grantedAt: expect.any(Number),
        role: undefined,
      },
      {
        workerId: "worker-1",
        providerId: "slack",
        connectionId: "workspace",
        scopes: ["channels:read"],
        grantedAt: expect.any(Number),
        role: undefined,
      },
    ]);

    await store.revoke("worker-1", "github");
    await expect(store.list("worker-1")).resolves.toEqual([
      {
        workerId: "worker-1",
        providerId: "slack",
        connectionId: "workspace",
        scopes: ["channels:read"],
        grantedAt: expect.any(Number),
        role: undefined,
      },
    ]);
  });

  it("checks whether a grant covers the requested scopes", async () => {
    await store.grant({
      workerId: "worker-1",
      providerId: "github",
      connectionId: "primary",
      scopes: ["user:email", "repo", "repo"],
    });

    await expect(store.has("worker-1", "github")).resolves.toBe(true);
    await expect(store.has("worker-1", "github", ["repo"])).resolves.toBe(true);
    await expect(store.has("worker-1", "github", ["repo", "user:email"])).resolves.toBe(true);
    await expect(store.has("worker-1", "github", ["repo", "admin:org"])).resolves.toBe(false);
    await expect(store.has("worker-1", "slack", ["channels:read"])).resolves.toBe(false);
  });
});
