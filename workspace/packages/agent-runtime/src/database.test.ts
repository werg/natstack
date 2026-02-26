import { createDbClient } from "./database.js";

describe("createDbClient", () => {
  const mockRpc = { call: vi.fn() };

  beforeEach(() => {
    mockRpc.call.mockReset();
  });

  it("open calls rpc.call with db.open", async () => {
    mockRpc.call.mockResolvedValueOnce("handle-1");

    const client = createDbClient(mockRpc);
    const db = await client.open("mydb", true);

    expect(mockRpc.call).toHaveBeenCalledWith("main", "db.open", "mydb", true);
    expect(db).toBeDefined();
  });

  it("exec delegates to rpc.call with db.exec", async () => {
    mockRpc.call.mockResolvedValueOnce("handle-1"); // open
    mockRpc.call.mockResolvedValueOnce(undefined); // exec

    const client = createDbClient(mockRpc);
    const db = await client.open("mydb");

    await db.exec("CREATE TABLE t (id INTEGER)");

    expect(mockRpc.call).toHaveBeenCalledWith("main", "db.exec", "handle-1", "CREATE TABLE t (id INTEGER)");
  });

  it("run delegates to rpc.call with db.run", async () => {
    mockRpc.call.mockResolvedValueOnce("handle-1"); // open
    mockRpc.call.mockResolvedValueOnce({ changes: 1, lastInsertRowid: 1 }); // run

    const client = createDbClient(mockRpc);
    const db = await client.open("mydb");

    const result = await db.run("INSERT INTO t VALUES (?)", [42]);

    expect(mockRpc.call).toHaveBeenCalledWith("main", "db.run", "handle-1", "INSERT INTO t VALUES (?)", [42]);
    expect(result).toEqual({ changes: 1, lastInsertRowid: 1 });
  });

  it("get delegates to rpc.call with db.get", async () => {
    mockRpc.call.mockResolvedValueOnce("handle-1"); // open
    mockRpc.call.mockResolvedValueOnce({ id: 1, name: "test" }); // get

    const client = createDbClient(mockRpc);
    const db = await client.open("mydb");

    const row = await db.get("SELECT * FROM t WHERE id = ?", [1]);

    expect(mockRpc.call).toHaveBeenCalledWith("main", "db.get", "handle-1", "SELECT * FROM t WHERE id = ?", [1]);
    expect(row).toEqual({ id: 1, name: "test" });
  });

  it("query delegates to rpc.call with db.query", async () => {
    mockRpc.call.mockResolvedValueOnce("handle-1"); // open
    mockRpc.call.mockResolvedValueOnce([{ id: 1 }, { id: 2 }]); // query

    const client = createDbClient(mockRpc);
    const db = await client.open("mydb");

    const rows = await db.query("SELECT * FROM t", []);

    expect(mockRpc.call).toHaveBeenCalledWith("main", "db.query", "handle-1", "SELECT * FROM t", []);
    expect(rows).toEqual([{ id: 1 }, { id: 2 }]);
  });

  it("close delegates to rpc.call with db.close; second close is a no-op", async () => {
    mockRpc.call.mockResolvedValueOnce("handle-1"); // open
    mockRpc.call.mockResolvedValueOnce(undefined); // close

    const client = createDbClient(mockRpc);
    const db = await client.open("mydb");

    await db.close();
    expect(mockRpc.call).toHaveBeenCalledWith("main", "db.close", "handle-1");

    const callCountAfterFirst = mockRpc.call.mock.calls.length;

    // Second close should be a no-op
    await db.close();
    expect(mockRpc.call.mock.calls.length).toBe(callCountAfterFirst);
  });

  it("operations after close throw 'Database connection is closed'", async () => {
    mockRpc.call.mockResolvedValueOnce("handle-1"); // open
    mockRpc.call.mockResolvedValueOnce(undefined); // close

    const client = createDbClient(mockRpc);
    const db = await client.open("mydb");

    await db.close();

    await expect(db.exec("SELECT 1")).rejects.toThrow("Database connection is closed");
    await expect(db.run("SELECT 1")).rejects.toThrow("Database connection is closed");
    await expect(db.get("SELECT 1")).rejects.toThrow("Database connection is closed");
    await expect(db.query("SELECT 1")).rejects.toThrow("Database connection is closed");
  });
});
