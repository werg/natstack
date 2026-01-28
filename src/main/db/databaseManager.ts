/**
 * DatabaseManager - Manages SQLite database connections for workers and panels.
 *
 * Provides connection pooling, path management, and query execution using better-sqlite3.
 * All databases are stored under: <workspace>/.databases/
 */

import Database from "better-sqlite3";
import * as path from "path";
import * as fs from "fs";
import * as crypto from "crypto";
import { getActiveWorkspace } from "../paths.js";
import type { DbRunResult } from "../../shared/db/types.js";

/**
 * Singleton DatabaseManager instance.
 */
let instance: DatabaseManager | null = null;

/**
 * Get the singleton DatabaseManager instance.
 */
export function getDatabaseManager(): DatabaseManager {
  if (!instance) {
    instance = new DatabaseManager();
  }
  return instance;
}

export class DatabaseManager {
  /** Connection pool: path → actual database connection */
  private pathToConnection = new Map<string, Database.Database>();

  /** Reference count per path (how many handles point to this connection) */
  private pathRefCount = new Map<string, number>();

  /** Map handle to database path for cleanup */
  private handleToPath = new Map<string, string>();

  /** Map handle to owner (worker/panel ID) for cleanup tracking */
  private handleToOwner = new Map<string, string>();

  /**
   * Open a database.
   * Path: <workspace>/.databases/<name>.db
   *
   * Databases are stored in workspace-specific .databases/ directory, not in .cache/
   * because they are persistent data that should not be cleared by cache operations.
   *
   * @param ownerId - The worker or panel ID (for cleanup tracking)
   * @param dbName - The database name
   * @param readOnly - Whether to open in read-only mode
   */
  open(ownerId: string, dbName: string, readOnly = false): string {
    const workspace = getActiveWorkspace();
    if (!workspace) {
      throw new Error("No active workspace");
    }

    // Store databases in workspace .databases directory, not in .cache/
    // Databases are persistent data, not temporary cache
    const dbDir = path.join(workspace.path, ".databases");
    fs.mkdirSync(dbDir, { recursive: true });

    const dbPath = path.join(dbDir, this.sanitizeDbName(dbName) + ".db");

    // Debug: Check if file exists before opening
    const fileExisted = fs.existsSync(dbPath);
    let birthTime: Date | null = null;
    let fileSize = 0;
    if (fileExisted) {
      try {
        const stats = fs.statSync(dbPath);
        birthTime = stats.birthtime;
        fileSize = stats.size;
      } catch {
        // Ignore stat errors
      }
    }
    console.log(`[DatabaseManager] Opening database: path=${dbPath}, workspaceId=${workspace.config.id}, owner=${ownerId}, fileExisted=${fileExisted}, birthTime=${birthTime?.toISOString()}, size=${fileSize}`);

    return this.openDatabase(dbPath, ownerId, readOnly);
  }

  /**
   * Open a database at an explicit file path.
   * Use this for global databases that don't belong to a specific workspace.
   *
   * @param ownerId - The owner ID (for cleanup tracking)
   * @param dbPath - Full absolute path to the database file
   * @param readOnly - Whether to open in read-only mode
   */
  openAtPath(ownerId: string, dbPath: string, readOnly = false): string {
    // Ensure parent directory exists
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    return this.openDatabase(dbPath, ownerId, readOnly);
  }

  /**
   * Open a database at the given path.
   * Each caller gets a unique handle, but the underlying connection is shared.
   * Uses reference counting to close connection only when all handles are closed.
   */
  private openDatabase(dbPath: string, ownerId: string, readOnly: boolean): string {
    // Always create a new handle for each caller
    const handle = crypto.randomUUID();

    // Reuse existing connection or create new one
    let db = this.pathToConnection.get(dbPath);
    if (!db) {
      db = new Database(dbPath, { readonly: readOnly });

      // Debug: Log the actual path better-sqlite3 is using
      console.log(`[DatabaseManager] Created new connection: requested=${dbPath}, actual=${db.name}, inTransaction=${db.inTransaction}, open=${db.open}, memory=${db.memory}, readonly=${db.readonly}`);

      // Enable WAL mode for better concurrent access (unless read-only)
      if (!readOnly) {
        const walResult = db.pragma("journal_mode = WAL");
        db.pragma("synchronous = NORMAL");
        console.log(`[DatabaseManager] Set WAL mode, result:`, walResult);
      }
      db.pragma("foreign_keys = ON");

      this.pathToConnection.set(dbPath, db);
      this.pathRefCount.set(dbPath, 0);
    } else {
      console.log(`[DatabaseManager] Reusing existing connection for: ${dbPath}`);
    }

    // Increment ref count and track handle
    this.pathRefCount.set(dbPath, (this.pathRefCount.get(dbPath) ?? 0) + 1);
    this.handleToPath.set(handle, dbPath);
    this.handleToOwner.set(handle, ownerId);

    return handle;
  }

  /**
   * Execute a query and return all rows.
   */
  query<T>(handle: string, sql: string, params?: unknown[]): T[] {
    const db = this.getConnection(handle);
    const stmt = db.prepare(sql);
    return (params ? stmt.all(...params) : stmt.all()) as T[];
  }

  /**
   * Execute a statement and return changes info.
   */
  run(handle: string, sql: string, params?: unknown[]): DbRunResult {
    const db = this.getConnection(handle);
    const stmt = db.prepare(sql);
    const result = params ? stmt.run(...params) : stmt.run();
    return {
      changes: result.changes,
      lastInsertRowid: result.lastInsertRowid,
    };
  }

  /**
   * Execute a query and return only the first row.
   */
  get<T>(handle: string, sql: string, params?: unknown[]): T | null {
    const db = this.getConnection(handle);
    const stmt = db.prepare(sql);
    const row = params ? stmt.get(...params) : stmt.get();
    return (row as T) ?? null;
  }

  /**
   * Execute raw SQL (for schema changes, multi-statement scripts).
   */
  exec(handle: string, sql: string): void {
    const db = this.getConnection(handle);
    db.exec(sql);
  }

  /**
   * Close a database handle.
   * The underlying connection is only closed when all handles are released.
   */
  close(handle: string): void {
    const dbPath = this.handleToPath.get(handle);
    if (!dbPath) return;

    // Clean up handle tracking
    this.handleToPath.delete(handle);
    this.handleToOwner.delete(handle);

    // Decrement ref count
    const refCount = (this.pathRefCount.get(dbPath) ?? 1) - 1;

    if (refCount <= 0) {
      // Last reference - close actual connection
      const db = this.pathToConnection.get(dbPath);
      db?.close();
      this.pathToConnection.delete(dbPath);
      this.pathRefCount.delete(dbPath);
    } else {
      this.pathRefCount.set(dbPath, refCount);
    }
  }

  /**
   * Close all databases owned by a specific worker/panel.
   * Called when a worker or panel is terminated.
   */
  closeAllForOwner(ownerId: string): void {
    const handlesToClose: string[] = [];
    for (const [handle, owner] of this.handleToOwner) {
      if (owner === ownerId) {
        handlesToClose.push(handle);
      }
    }
    for (const handle of handlesToClose) {
      this.close(handle);
    }
  }

  /**
   * Shutdown: close all database connections.
   */
  shutdown(): void {
    for (const handle of [...this.handleToPath.keys()]) {
      this.close(handle);
    }
  }

  /**
   * Get a connection by handle, throwing if not found.
   */
  private getConnection(handle: string): Database.Database {
    const dbPath = this.handleToPath.get(handle);
    if (!dbPath) {
      throw new Error(`Invalid database handle: ${handle}`);
    }
    const db = this.pathToConnection.get(dbPath);
    if (!db) {
      throw new Error(`Invalid database handle: ${handle}`);
    }
    return db;
  }

  /**
   * Sanitize a database name for use in filesystem path.
   * Only allows alphanumeric, underscore, hyphen. Max 64 chars.
   */
  private sanitizeDbName(name: string): string {
    const sanitized = name.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
    if (!sanitized) {
      throw new Error("Invalid database name");
    }
    return sanitized;
  }
}
