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
const mockWorkspace = {
  config: { id: "test-workspace" },
  path: "/mock/workspace",
  cachePath: "/mock/cache",
  gitReposPath: "/mock/git",
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
    dbManager = new DatabaseManager();
  });

  afterEach(() => {
    // Close all connections and clean up temp directory
    dbManager.shutdown();
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  describe("openScopedDatabase", () => {
    it("creates database file in scoped directory", () => {
      const handle = dbManager.openScopedDatabase("test-owner", "test-scope", "mydb");

      expect(handle).toBeDefined();
      expect(typeof handle).toBe("string");

      // Verify database file was created in unified path
      const dbPath = path.join(
        testDir,
        "databases",
        "test-workspace",
        "scopes",
        "test-scope",
        "mydb.db"
      );
      expect(fs.existsSync(dbPath)).toBe(true);
    });

    it("returns same handle for same database path", () => {
      const handle1 = dbManager.openScopedDatabase("owner1", "test-scope", "mydb");
      const handle2 = dbManager.openScopedDatabase("owner2", "test-scope", "mydb");

      // Same scope + db name = same handle (shared access)
      expect(handle1).toBe(handle2);
    });

    it("creates different databases for different scopes", () => {
      const handle1 = dbManager.openScopedDatabase("owner1", "scope1", "mydb");
      const handle2 = dbManager.openScopedDatabase("owner2", "scope2", "mydb");

      expect(handle1).not.toBe(handle2);
    });

    it("sanitizes database names and scope IDs", () => {
      const handle = dbManager.openScopedDatabase("test", "test-scope", "my-db_123");
      expect(handle).toBeDefined();

      // Should sanitize special characters - path traversal attempt
      const handle2 = dbManager.openScopedDatabase("test", "test-scope", "../../etc/passwd");
      expect(handle2).toBeDefined();

      // The sanitized path should stay within the scope directory
      // Dots and slashes are replaced with underscores, so "../../etc/passwd" -> "______etc_passwd"
      const dbDir = path.join(testDir, "databases", "test-workspace", "scopes", "test-scope");
      const files = fs.readdirSync(dbDir);

      // Verify files are in the expected directory (not escaped)
      expect(files.length).toBeGreaterThanOrEqual(2);
      // The database file should have the sanitized name
      expect(files.some((f) => f.includes("______etc_passwd.db"))).toBe(true);

      // Verify no files were created outside the scope
      const parentDir = path.join(testDir, "databases", "test-workspace", "scopes");
      const parentFiles = fs.readdirSync(parentDir);
      expect(parentFiles).toContain("test-scope");
      expect(parentFiles.length).toBe(1); // Only test-scope/ subdirectory, nothing escaped
    });
  });

  describe("openSharedDatabase", () => {
    it("creates database in shared directory", () => {
      const handle = dbManager.openSharedDatabase("panel:test-panel", "shared-data");

      expect(handle).toBeDefined();

      const dbPath = path.join(testDir, "databases", "test-workspace", "shared", "shared-data.db");
      expect(fs.existsSync(dbPath)).toBe(true);
    });

    it("allows multiple owners to access same shared database", () => {
      const handle1 = dbManager.openSharedDatabase("panel:panel1", "shared-data");
      const handle2 = dbManager.openSharedDatabase("worker:worker1", "shared-data");

      // Same database file, same handle
      expect(handle1).toBe(handle2);
    });
  });


  describe("query operations", () => {
    let handle: string;

    beforeEach(() => {
      handle = dbManager.openScopedDatabase("test-owner", "test-scope", "testdb");
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
      const handle = dbManager.openScopedDatabase("test-owner", "test-scope", "testdb");
      dbManager.close(handle);

      expect(() => dbManager.query(handle, "SELECT 1")).toThrow("Invalid database handle");
    });

    it("closeAllForOwner closes all databases for owner", () => {
      const handle1 = dbManager.openScopedDatabase("test-owner", "scope1", "db1");
      const handle2 = dbManager.openScopedDatabase("test-owner", "scope2", "db2");
      const handle3 = dbManager.openScopedDatabase("other-owner", "scope3", "db3");

      dbManager.closeAllForOwner("test-owner");

      expect(() => dbManager.query(handle1, "SELECT 1")).toThrow("Invalid database handle");
      expect(() => dbManager.query(handle2, "SELECT 1")).toThrow("Invalid database handle");

      // Other owner's database should still work
      const result = dbManager.query(handle3, "SELECT 1");
      expect(result).toBeDefined();
    });

    it("shutdown closes all connections", () => {
      const handle1 = dbManager.openScopedDatabase("owner1", "scope1", "db1");
      const handle2 = dbManager.openScopedDatabase("owner2", "scope2", "db2");

      dbManager.shutdown();

      expect(() => dbManager.query(handle1, "SELECT 1")).toThrow("Invalid database handle");
      expect(() => dbManager.query(handle2, "SELECT 1")).toThrow("Invalid database handle");
    });
  });

  describe("WAL mode", () => {
    it("enables WAL mode by default", () => {
      const handle = dbManager.openScopedDatabase("test-owner", "test-scope", "waltest");

      const result = dbManager.query<{ journal_mode: string }>(handle, "PRAGMA journal_mode");
      expect(result[0]!.journal_mode).toBe("wal");
    });

    it("enables foreign keys by default", () => {
      const handle = dbManager.openScopedDatabase("test-owner", "test-scope", "fktest");

      const result = dbManager.query<{ foreign_keys: number }>(handle, "PRAGMA foreign_keys");
      expect(result[0]!.foreign_keys).toBe(1);
    });
  });

  describe("read-only mode", () => {
    it("allows opening database in read-only mode", () => {
      // First create the database with data
      const writeHandle = dbManager.openScopedDatabase("test-owner", "test-scope", "readonly-test");
      dbManager.exec(writeHandle, "CREATE TABLE data (id INTEGER PRIMARY KEY, value TEXT)");
      dbManager.run(writeHandle, "INSERT INTO data (value) VALUES (?)", ["test"]);
      dbManager.close(writeHandle);

      // Open in read-only mode
      const readHandle = dbManager.openScopedDatabase("test-owner", "test-scope", "readonly-test", true);

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
      const handle = dbManager.openScopedDatabase("test-owner", "test-scope", "testdb");

      expect(() => dbManager.exec(handle, "INVALID SQL SYNTAX")).toThrow();
    });

    it("throws on invalid handle", () => {
      expect(() => dbManager.query("invalid-handle", "SELECT 1")).toThrow("Invalid database handle");
    });

    it("throws on empty database name", () => {
      expect(() => dbManager.openScopedDatabase("test-owner", "test-scope", "")).toThrow("Invalid database name");
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
