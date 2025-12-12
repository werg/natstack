/**
 * DatabaseManager - Manages SQLite database connections for workers and panels.
 *
 * Provides connection pooling, path management, and query execution using better-sqlite3.
 * All databases (worker-scoped, panel-scoped, or shared) are stored under a unified
 * path structure: ~/.config/natstack/databases/<workspace>/
 */

import Database from "better-sqlite3";
import * as path from "path";
import * as fs from "fs";
import * as crypto from "crypto";
import { getCentralConfigDirectory, getActiveWorkspace } from "../paths.js";
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
  /** Open database connections keyed by handle */
  private connections = new Map<string, Database.Database>();

  /** Map handle to database path for cleanup */
  private handleToPath = new Map<string, string>();

  /** Map path to handle to reuse connections */
  private pathToHandle = new Map<string, string>();

  /** Map handle to owner (worker/panel ID) for access control */
  private handleToOwner = new Map<string, string>();

  /**
   * Open a scoped database for a worker or panel.
   * Path: ~/.config/natstack/databases/<workspace>/scopes/<scopeId>/<name>.db
   *
   * @param ownerId - The worker or panel ID (for access control tracking)
   * @param scopeId - The scope identifier (worker ID or panel partition)
   * @param dbName - The database name
   * @param readOnly - Whether to open in read-only mode
   */
  openScopedDatabase(ownerId: string, scopeId: string, dbName: string, readOnly = false): string {
    const workspace = getActiveWorkspace();
    if (!workspace) {
      throw new Error("No active workspace");
    }

    const configDir = getCentralConfigDirectory();
    const sanitizedScopeId = this.sanitizeDbName(scopeId);
    const dbDir = path.join(configDir, "databases", workspace.config.id, "scopes", sanitizedScopeId);
    fs.mkdirSync(dbDir, { recursive: true });

    const dbPath = path.join(dbDir, this.sanitizeDbName(dbName) + ".db");
    return this.openDatabase(dbPath, ownerId, readOnly);
  }


  /**
   * Open a shared workspace database.
   * Path: ~/.config/natstack/databases/<workspace>/shared/<name>.db
   */
  openSharedDatabase(ownerId: string, dbName: string, readOnly = false): string {
    const workspace = getActiveWorkspace();
    if (!workspace) {
      throw new Error("No active workspace");
    }

    const configDir = getCentralConfigDirectory();
    const dbDir = path.join(configDir, "databases", workspace.config.id, "shared");
    fs.mkdirSync(dbDir, { recursive: true });

    const dbPath = path.join(dbDir, this.sanitizeDbName(dbName) + ".db");
    return this.openDatabase(dbPath, ownerId, readOnly);
  }

  /**
   * Open a database at the given path.
   * Returns existing handle if already open, otherwise creates new connection.
   */
  private openDatabase(dbPath: string, ownerId: string, readOnly: boolean): string {
    // Return existing handle if database is already open
    const existingHandle = this.pathToHandle.get(dbPath);
    if (existingHandle && this.connections.has(existingHandle)) {
      return existingHandle;
    }

    const db = new Database(dbPath, { readonly: readOnly });

    // Enable WAL mode for better concurrent access (unless read-only)
    if (!readOnly) {
      db.pragma("journal_mode = WAL");
      db.pragma("synchronous = NORMAL");
    }
    db.pragma("foreign_keys = ON");

    const handle = crypto.randomUUID();
    this.connections.set(handle, db);
    this.handleToPath.set(handle, dbPath);
    this.pathToHandle.set(dbPath, handle);
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
   * Close a database connection.
   */
  close(handle: string): void {
    const db = this.connections.get(handle);
    if (db) {
      db.close();
      const dbPath = this.handleToPath.get(handle);
      this.connections.delete(handle);
      this.handleToPath.delete(handle);
      this.handleToOwner.delete(handle);
      if (dbPath) {
        this.pathToHandle.delete(dbPath);
      }
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
    for (const [handle] of this.connections) {
      this.close(handle);
    }
  }

  /**
   * Get a connection by handle, throwing if not found.
   */
  private getConnection(handle: string): Database.Database {
    const db = this.connections.get(handle);
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
