/**
 * Tests for database service handlers.
 */

import { handleDbCall } from "./dbHandlers.js";

describe("handleDbCall", () => {
  const dbManager = {
    open: vi.fn().mockReturnValue("handle-1"),
    query: vi.fn().mockReturnValue([{ id: 1 }]),
    run: vi.fn().mockReturnValue({ changes: 1 }),
    get: vi.fn().mockReturnValue({ id: 1, name: "test" }),
    exec: vi.fn(),
    close: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("open calls dbManager.open(ownerId, dbName, readOnly)", () => {
    const result = handleDbCall(dbManager as any, "owner-1", "open", [
      "mydb",
      true,
    ]);
    expect(dbManager.open).toHaveBeenCalledWith("owner-1", "mydb", true);
    expect(result).toBe("handle-1");
  });

  it("open defaults readOnly to false when not provided", () => {
    handleDbCall(dbManager as any, "owner-1", "open", ["mydb"]);
    expect(dbManager.open).toHaveBeenCalledWith("owner-1", "mydb", false);
  });

  it("query calls dbManager.query(handle, sql, params)", () => {
    const result = handleDbCall(dbManager as any, "owner-1", "query", [
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

  it("run calls dbManager.run(handle, sql, params)", () => {
    const result = handleDbCall(dbManager as any, "owner-1", "run", [
      "handle-1",
      "INSERT INTO t VALUES (?)",
      ["val"],
    ]);
    expect(dbManager.run).toHaveBeenCalledWith("handle-1", "INSERT INTO t VALUES (?)", [
      "val",
    ]);
    expect(result).toEqual({ changes: 1 });
  });

  it("get calls dbManager.get(handle, sql, params)", () => {
    const result = handleDbCall(dbManager as any, "owner-1", "get", [
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

  it("exec calls dbManager.exec(handle, sql)", () => {
    handleDbCall(dbManager as any, "owner-1", "exec", [
      "handle-1",
      "CREATE TABLE t (id INT)",
    ]);
    expect(dbManager.exec).toHaveBeenCalledWith(
      "handle-1",
      "CREATE TABLE t (id INT)",
    );
  });

  it("close calls dbManager.close(handle)", () => {
    handleDbCall(dbManager as any, "owner-1", "close", ["handle-1"]);
    expect(dbManager.close).toHaveBeenCalledWith("handle-1");
  });

  it("throws on unknown method", () => {
    expect(() =>
      handleDbCall(dbManager as any, "owner-1", "unknownMethod", []),
    ).toThrow("Unknown db method: unknownMethod");
  });
});
