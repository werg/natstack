/**
 * Tests for database service.
 */

import { createDbService } from "../../server/services/dbService.js";
import type { ServiceContext } from "../serviceDispatcher.js";

describe("dbService", () => {
  const dbManager = {
    open: vi.fn().mockReturnValue("handle-1"),
    query: vi.fn().mockReturnValue([{ id: 1 }]),
    run: vi.fn().mockReturnValue({ changes: 1 }),
    get: vi.fn().mockReturnValue({ id: 1, name: "test" }),
    exec: vi.fn(),
    close: vi.fn(),
  };

  const svc = createDbService({ databaseManager: dbManager as any });
  const handler = svc.handler;
  const ctx: ServiceContext = { callerId: "owner-1", callerKind: "panel" };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("open calls dbManager.open(ownerId, dbName, readOnly)", async () => {
    const result = await handler(ctx, "open", ["mydb", true]);
    expect(dbManager.open).toHaveBeenCalledWith("owner-1", "mydb", true);
    expect(result).toBe("handle-1");
  });

  it("open defaults readOnly to false when not provided", async () => {
    await handler(ctx, "open", ["mydb"]);
    expect(dbManager.open).toHaveBeenCalledWith("owner-1", "mydb", false);
  });

  it("query calls dbManager.query(handle, sql, params)", async () => {
    const result = await handler(ctx, "query", [
      "handle-1",
      "SELECT * FROM t WHERE id = ?",
      [42],
    ]);
    expect(dbManager.query).toHaveBeenCalledWith(
      "handle-1",
      "SELECT * FROM t WHERE id = ?",
      [42],
    );
    expect(result).toEqual([{ id: 1 }]);
  });

  it("run calls dbManager.run(handle, sql, params)", async () => {
    const result = await handler(ctx, "run", [
      "handle-1",
      "INSERT INTO t VALUES (?)",
      ["val"],
    ]);
    expect(dbManager.run).toHaveBeenCalledWith("handle-1", "INSERT INTO t VALUES (?)", ["val"]);
    expect(result).toEqual({ changes: 1 });
  });

  it("get calls dbManager.get(handle, sql, params)", async () => {
    const result = await handler(ctx, "get", [
      "handle-1",
      "SELECT * FROM t WHERE id = ?",
      [1],
    ]);
    expect(dbManager.get).toHaveBeenCalledWith(
      "handle-1",
      "SELECT * FROM t WHERE id = ?",
      [1],
    );
    expect(result).toEqual({ id: 1, name: "test" });
  });

  it("exec calls dbManager.exec(handle, sql)", async () => {
    await handler(ctx, "exec", ["handle-1", "CREATE TABLE t (id INT)"]);
    expect(dbManager.exec).toHaveBeenCalledWith("handle-1", "CREATE TABLE t (id INT)");
  });

  it("close calls dbManager.close(handle)", async () => {
    await handler(ctx, "close", ["handle-1"]);
    expect(dbManager.close).toHaveBeenCalledWith("handle-1");
  });

  it("throws on unknown method", async () => {
    await expect(handler(ctx, "unknownMethod", [])).rejects.toThrow(
      "Unknown db method: unknownMethod",
    );
  });
});
