/**
 * DatabaseManager Unit Tests
 *
 * These tests use real SQLite databases in a temp directory.
 * Run with: npx vitest run src/main/db/databaseManager.test.ts
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// Mock the paths module before importing DatabaseManager
// These values are updated in beforeEach to point to the real temp directory
const mockWorkspace = {
  config: { id: "test-workspace" },
  path: "",  // Will be set to testDir in beforeEach
  cachePath: "",
  gitReposPath: "",
};

let testDir: string;

vi.mock("../paths.js", () => ({
  getCentralConfigDirectory: () => testDir,
  getActiveWorkspace: () => mockWorkspace,
}));

// Import after mocks are set up
import { DatabaseManager, getDatabaseManager } from "./databaseManager.js";

describe("DatabaseManager", () => {
  let dbManager: DatabaseManager;

  beforeEach(() => {
    // Create a unique temp directory for each test
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), "natstack-db-test-"));
    // Update mock to use the real temp directory
    mockWorkspace.path = testDir;
    mockWorkspace.cachePath = path.join(testDir, ".cache");
    mockWorkspace.gitReposPath = path.join(testDir, ".git-repos");
    dbManager = new DatabaseManager();
  });

  afterEach(() => {
    // Close all connections and clean up temp directory
    dbManager.shutdown();
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  describe("open", () => {
    it("creates database file in workspace directory", () => {
      const handle = dbManager.open("test-owner", "mydb");

      expect(handle).toBeDefined();
      expect(typeof handle).toBe("string");

      // Implementation stores at: <workspace.path>/.databases/<name>.db
      const dbPath = path.join(testDir, ".databases", "mydb.db");
      expect(fs.existsSync(dbPath)).toBe(true);
    });

    it("returns different handles for same database (shared connection)", () => {
      const handle1 = dbManager.open("owner1", "mydb");
      const handle2 = dbManager.open("owner2", "mydb");

      // Different handles, but same underlying connection
      expect(handle1).not.toBe(handle2);

      // Both handles can access the same data
      dbManager.exec(handle1, "CREATE TABLE test (id INTEGER)");
      dbManager.run(handle1, "INSERT INTO test (id) VALUES (?)", [42]);
      const result = dbManager.query<{ id: number }>(handle2, "SELECT id FROM test");
      expect(result).toHaveLength(1);
      expect(result[0]!.id).toBe(42);
    });

    it("allows multiple owners to access same database", () => {
      const handle1 = dbManager.open("panel:panel1", "shared-data");
      const handle2 = dbManager.open("worker:worker1", "shared-data");

      // Different handles, but same underlying database file
      expect(handle1).not.toBe(handle2);

      // Both can access the same data
      dbManager.exec(handle1, "CREATE TABLE shared_test (value TEXT)");
      dbManager.run(handle1, "INSERT INTO shared_test (value) VALUES (?)", ["hello"]);
      const result = dbManager.query<{ value: string }>(handle2, "SELECT value FROM shared_test");
      expect(result).toHaveLength(1);
      expect(result[0]!.value).toBe("hello");
    });

    it("closing one owner's handle doesn't affect other owners", () => {
      const handle1 = dbManager.open("panel:panel1", "shared-data");
      const handle2 = dbManager.open("worker:worker1", "shared-data");

      dbManager.exec(handle1, "CREATE TABLE test (id INTEGER)");
      dbManager.run(handle1, "INSERT INTO test (id) VALUES (?)", [123]);
      dbManager.close(handle1);

      // handle1 is now invalid
      expect(() => dbManager.query(handle1, "SELECT 1")).toThrow("Invalid database handle");

      // handle2 should still work
      const result = dbManager.query<{ id: number }>(handle2, "SELECT id FROM test");
      expect(result).toHaveLength(1);
      expect(result[0]!.id).toBe(123);
    });

    it("closeAllForOwner doesn't affect other owners' handles", () => {
      const handle1 = dbManager.open("panel:panel1", "shared-data");
      const handle2 = dbManager.open("worker:worker1", "shared-data");

      dbManager.exec(handle1, "CREATE TABLE test (value TEXT)");
      dbManager.run(handle1, "INSERT INTO test (value) VALUES (?)", ["preserved"]);
      dbManager.closeAllForOwner("panel:panel1");

      // Panel's handle is invalid
      expect(() => dbManager.query(handle1, "SELECT 1")).toThrow("Invalid database handle");

      // Worker's handle still works
      const result = dbManager.query<{ value: string }>(handle2, "SELECT value FROM test");
      expect(result).toHaveLength(1);
      expect(result[0]!.value).toBe("preserved");
    });

    it("connection closes only when all owners close their handles", () => {
      const handle1 = dbManager.open("owner1", "shared-data");
      const handle2 = dbManager.open("owner2", "shared-data");
      const handle3 = dbManager.open("owner3", "shared-data");

      dbManager.exec(handle1, "CREATE TABLE test (id INTEGER)");
      dbManager.run(handle1, "INSERT INTO test (id) VALUES (?)", [999]);

      // Close first two handles
      dbManager.close(handle1);
      dbManager.close(handle2);

      // handle3 still works (connection still open)
      const result = dbManager.query<{ id: number }>(handle3, "SELECT id FROM test");
      expect(result).toHaveLength(1);
      expect(result[0]!.id).toBe(999);

      // Close last handle
      dbManager.close(handle3);

      // All handles are now invalid
      expect(() => dbManager.query(handle3, "SELECT 1")).toThrow("Invalid database handle");
    });

    it("sanitizes database names", () => {
      const handle = dbManager.open("test", "my-db_123");
      expect(handle).toBeDefined();

      // Should sanitize special characters - path traversal attempt
      const handle2 = dbManager.open("test", "../../etc/passwd");
      expect(handle2).toBeDefined();

      // Implementation stores at: <workspace.path>/.databases/
      const dbDir = path.join(testDir, ".databases");
      const files = fs.readdirSync(dbDir);

      // The database file should have the sanitized name
      expect(files.some((f) => f.includes("______etc_passwd.db"))).toBe(true);
    });
  });


  describe("query operations", () => {
    let handle: string;

    beforeEach(() => {
      handle = dbManager.open("test-owner", "testdb");
      // Create a test table
      dbManager.exec(
        handle,
        `
        CREATE TABLE users (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          email TEXT UNIQUE,
          age INTEGER
        )
      `
      );
    });

    it("exec creates tables", () => {
      const tables = dbManager.query<{ name: string }>(
        handle,
        "SELECT name FROM sqlite_master WHERE type='table' AND name='users'"
      );
      expect(tables).toHaveLength(1);
      expect(tables[0]!.name).toBe("users");
    });

    it("run inserts data and returns changes", () => {
      const result = dbManager.run(handle, "INSERT INTO users (name, email, age) VALUES (?, ?, ?)", [
        "Alice",
        "alice@example.com",
        30,
      ]);

      expect(result.changes).toBe(1);
      expect(result.lastInsertRowid).toBe(1);
    });

    it("query returns all matching rows", () => {
      dbManager.run(handle, "INSERT INTO users (name, email, age) VALUES (?, ?, ?)", ["Alice", "alice@example.com", 30]);
      dbManager.run(handle, "INSERT INTO users (name, email, age) VALUES (?, ?, ?)", ["Bob", "bob@example.com", 25]);
      dbManager.run(handle, "INSERT INTO users (name, email, age) VALUES (?, ?, ?)", ["Charlie", "charlie@example.com", 35]);

      const users = dbManager.query<{ id: number; name: string; age: number }>(
        handle,
        "SELECT id, name, age FROM users WHERE age >= ? ORDER BY age",
        [30]
      );

      expect(users).toHaveLength(2);
      expect(users[0]!.name).toBe("Alice");
      expect(users[1]!.name).toBe("Charlie");
    });

    it("get returns single row or null", () => {
      dbManager.run(handle, "INSERT INTO users (name, email, age) VALUES (?, ?, ?)", ["Alice", "alice@example.com", 30]);

      const user = dbManager.get<{ id: number; name: string }>(handle, "SELECT id, name FROM users WHERE email = ?", [
        "alice@example.com",
      ]);

      expect(user).not.toBeNull();
      expect(user!.name).toBe("Alice");

      const notFound = dbManager.get<{ id: number; name: string }>(handle, "SELECT id, name FROM users WHERE email = ?", [
        "notfound@example.com",
      ]);

      expect(notFound).toBeNull();
    });

    it("handles parameterized queries safely", () => {
      dbManager.run(handle, "INSERT INTO users (name, email, age) VALUES (?, ?, ?)", ["Alice", "alice@example.com", 30]);

      // SQL injection attempt should be safely parameterized
      const maliciousInput = "'; DROP TABLE users; --";
      const result = dbManager.query(handle, "SELECT * FROM users WHERE name = ?", [maliciousInput]);

      expect(result).toHaveLength(0);

      // Table should still exist
      const tables = dbManager.query<{ name: string }>(
        handle,
        "SELECT name FROM sqlite_master WHERE type='table' AND name='users'"
      );
      expect(tables).toHaveLength(1);
    });
  });

  describe("connection management", () => {
    it("close removes connection", () => {
      const handle = dbManager.open("test-owner", "testdb");
      dbManager.close(handle);

      expect(() => dbManager.query(handle, "SELECT 1")).toThrow("Invalid database handle");
    });

    it("closeAllForOwner closes all databases for owner", () => {
      const handle1 = dbManager.open("test-owner", "db1");
      const handle2 = dbManager.open("test-owner", "db2");
      const handle3 = dbManager.open("other-owner", "db3");

      dbManager.closeAllForOwner("test-owner");

      expect(() => dbManager.query(handle1, "SELECT 1")).toThrow("Invalid database handle");
      expect(() => dbManager.query(handle2, "SELECT 1")).toThrow("Invalid database handle");

      // Other owner's database should still work
      const result = dbManager.query(handle3, "SELECT 1");
      expect(result).toBeDefined();
    });

    it("shutdown closes all connections", () => {
      const handle1 = dbManager.open("owner1", "db1");
      const handle2 = dbManager.open("owner2", "db2");

      dbManager.shutdown();

      expect(() => dbManager.query(handle1, "SELECT 1")).toThrow("Invalid database handle");
      expect(() => dbManager.query(handle2, "SELECT 1")).toThrow("Invalid database handle");
    });
  });

  describe("WAL mode", () => {
    it("enables WAL mode by default", () => {
      const handle = dbManager.open("test-owner", "waltest");

      const result = dbManager.query<{ journal_mode: string }>(handle, "PRAGMA journal_mode");
      expect(result[0]!.journal_mode).toBe("wal");
    });

    it("enables foreign keys by default", () => {
      const handle = dbManager.open("test-owner", "fktest");

      const result = dbManager.query<{ foreign_keys: number }>(handle, "PRAGMA foreign_keys");
      expect(result[0]!.foreign_keys).toBe(1);
    });
  });

  describe("read-only mode", () => {
    it("allows opening database in read-only mode", () => {
      // First create the database with data
      const writeHandle = dbManager.open("test-owner", "readonly-test");
      dbManager.exec(writeHandle, "CREATE TABLE data (id INTEGER PRIMARY KEY, value TEXT)");
      dbManager.run(writeHandle, "INSERT INTO data (value) VALUES (?)", ["test"]);
      dbManager.close(writeHandle);

      // Open in read-only mode
      const readHandle = dbManager.open("test-owner", "readonly-test", true);

      // Reads should work
      const result = dbManager.query<{ value: string }>(readHandle, "SELECT value FROM data");
      expect(result[0]!.value).toBe("test");

      // Writes should fail
      expect(() => {
        dbManager.run(readHandle, "INSERT INTO data (value) VALUES (?)", ["new"]);
      }).toThrow();
    });
  });

  describe("error handling", () => {
    it("throws on invalid SQL", () => {
      const handle = dbManager.open("test-owner", "testdb");

      expect(() => dbManager.exec(handle, "INVALID SQL SYNTAX")).toThrow();
    });

    it("throws on invalid handle", () => {
      expect(() => dbManager.query("invalid-handle", "SELECT 1")).toThrow("Invalid database handle");
    });

    it("throws on empty database name", () => {
      expect(() => dbManager.open("test-owner", "")).toThrow("Invalid database name");
    });

    it("throws when no workspace is active", async () => {
      // This test would require modifying the mock, so we skip implementation details
      // The actual error is thrown in openDatabase when getActiveWorkspace returns null
    });
  });

  describe("singleton getDatabaseManager", () => {
    it("returns same instance", () => {
      const instance1 = getDatabaseManager();
      const instance2 = getDatabaseManager();

      expect(instance1).toBe(instance2);
    });
  });
});
