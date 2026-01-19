/**
 * Panel Tree SQLite Schema
 *
 * DB-first architecture for panel tree persistence:
 * - SQLite is the single source of truth
 * - Panels are append-only (never deleted)
 * - FTS5 for full-text search
 */

import type Database from "better-sqlite3";

/**
 * Current schema version.
 * Increment when adding migrations.
 */
export const PANEL_SCHEMA_VERSION = 2;

/**
 * Panel types stored in the database.
 */
export type DbPanelType = "app" | "worker" | "browser" | "shell";

/**
 * Panel build states.
 */
export type DbPanelBuildState =
  | "pending"
  | "cloning"
  | "building"
  | "ready"
  | "error"
  | "dirty"
  | "not-git-repo";

/**
 * Panel event types for audit log.
 */
export type DbPanelEventType = "created" | "focused";

/**
 * Panel row from the database.
 */
export interface DbPanelRow {
  id: string;
  type: DbPanelType;
  title: string;
  context_id: string;
  workspace_id: string;
  parent_id: string | null;
  position: number;
  selected_child_id: string | null;
  created_at: number;
  updated_at: number;
  type_data: string; // JSON
  artifacts: string; // JSON
}

/**
 * Panel event row from the database.
 */
export interface DbPanelEventRow {
  id: number;
  panel_id: string;
  event_type: DbPanelEventType;
  context: string | null; // JSON
  timestamp: number;
  workspace_id: string;
}

/**
 * Panel search metadata row from the database.
 */
export interface DbPanelSearchMetadataRow {
  panel_id: string;
  searchable_title: string;
  searchable_path: string | null;
  searchable_url: string | null;
  manifest_description: string | null;
  manifest_dependencies: string | null; // JSON array
  page_content_summary: string | null;
  tags: string | null; // JSON array
  keywords: string | null; // JSON array
  access_count: number;
  last_indexed_at: number;
}

/**
 * Schema creation SQL statements.
 */
const SCHEMA_SQL = `
-- Core panel data
CREATE TABLE IF NOT EXISTS panels (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL CHECK (type IN ('app', 'worker', 'browser', 'shell')),
    title TEXT NOT NULL,
    context_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,

    -- Tree structure
    parent_id TEXT REFERENCES panels(id),
    position INTEGER NOT NULL DEFAULT 0,
    selected_child_id TEXT,
    collapsed INTEGER NOT NULL DEFAULT 0,

    -- Timestamps (milliseconds since epoch)
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,

    -- Type-specific data as JSON (path, url, browserState, etc.)
    type_data TEXT NOT NULL DEFAULT '{}',

    -- Build artifacts as JSON
    artifacts TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_panels_parent ON panels(parent_id);
CREATE INDEX IF NOT EXISTS idx_panels_workspace ON panels(workspace_id);
CREATE INDEX IF NOT EXISTS idx_panels_context ON panels(context_id);

-- Audit log for panel events (optional)
CREATE TABLE IF NOT EXISTS panel_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    panel_id TEXT NOT NULL,
    event_type TEXT NOT NULL CHECK (event_type IN ('created', 'focused')),
    context TEXT,
    timestamp INTEGER NOT NULL,
    workspace_id TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_events_panel ON panel_events(panel_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_events_workspace ON panel_events(workspace_id, timestamp DESC);

-- Search metadata for full-text search
CREATE TABLE IF NOT EXISTS panel_search_metadata (
    panel_id TEXT PRIMARY KEY REFERENCES panels(id),

    -- Core searchable fields
    searchable_title TEXT NOT NULL,
    searchable_path TEXT,
    searchable_url TEXT,

    -- From manifest (package.json natstack section)
    manifest_description TEXT,
    manifest_dependencies TEXT,

    -- Extracted page content (for browser panels)
    page_content_summary TEXT,

    -- Auto-detected tags and keywords
    tags TEXT,
    keywords TEXT,

    -- Usage stats for ranking
    access_count INTEGER NOT NULL DEFAULT 0,

    last_indexed_at INTEGER NOT NULL
);

-- FTS5 virtual table for full-text search
CREATE VIRTUAL TABLE IF NOT EXISTS panel_fts USING fts5(
    searchable_title,
    searchable_path,
    searchable_url,
    manifest_description,
    manifest_dependencies,
    page_content_summary,
    tags,
    keywords,
    content='panel_search_metadata',
    content_rowid='rowid'
);

-- Schema version tracking
CREATE TABLE IF NOT EXISTS schema_version (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    version INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);
`;

/**
 * FTS triggers to keep the index in sync.
 * These must be created separately due to SQLite limitations with IF NOT EXISTS for triggers.
 */
const FTS_TRIGGERS_SQL = `
-- Trigger for insert
CREATE TRIGGER IF NOT EXISTS panel_fts_insert AFTER INSERT ON panel_search_metadata BEGIN
    INSERT INTO panel_fts(rowid, searchable_title, searchable_path, searchable_url,
        manifest_description, manifest_dependencies, page_content_summary, tags, keywords)
    VALUES (NEW.rowid, NEW.searchable_title, NEW.searchable_path, NEW.searchable_url,
        NEW.manifest_description, NEW.manifest_dependencies, NEW.page_content_summary,
        NEW.tags, NEW.keywords);
END;

-- Trigger for delete
CREATE TRIGGER IF NOT EXISTS panel_fts_delete AFTER DELETE ON panel_search_metadata BEGIN
    INSERT INTO panel_fts(panel_fts, rowid, searchable_title, searchable_path, searchable_url,
        manifest_description, manifest_dependencies, page_content_summary, tags, keywords)
    VALUES ('delete', OLD.rowid, OLD.searchable_title, OLD.searchable_path, OLD.searchable_url,
        OLD.manifest_description, OLD.manifest_dependencies, OLD.page_content_summary,
        OLD.tags, OLD.keywords);
END;

-- Trigger for update
CREATE TRIGGER IF NOT EXISTS panel_fts_update AFTER UPDATE ON panel_search_metadata BEGIN
    INSERT INTO panel_fts(panel_fts, rowid, searchable_title, searchable_path, searchable_url,
        manifest_description, manifest_dependencies, page_content_summary, tags, keywords)
    VALUES ('delete', OLD.rowid, OLD.searchable_title, OLD.searchable_path, OLD.searchable_url,
        OLD.manifest_description, OLD.manifest_dependencies, OLD.page_content_summary,
        OLD.tags, OLD.keywords);
    INSERT INTO panel_fts(rowid, searchable_title, searchable_path, searchable_url,
        manifest_description, manifest_dependencies, page_content_summary, tags, keywords)
    VALUES (NEW.rowid, NEW.searchable_title, NEW.searchable_path, NEW.searchable_url,
        NEW.manifest_description, NEW.manifest_dependencies, NEW.page_content_summary,
        NEW.tags, NEW.keywords);
END;
`;

/**
 * Migrations array for schema evolution.
 * Each migration has a version number and up SQL.
 */
interface Migration {
  version: number;
  up: string;
}

const MIGRATIONS: Migration[] = [
  // Add future migrations here
  // { version: 2, up: 'ALTER TABLE panels ADD COLUMN category TEXT' },
];

/**
 * Initialize the panel schema in a database.
 * Creates tables, indexes, triggers, and runs any pending migrations.
 *
 * @param db - The better-sqlite3 database connection
 */
export function initializePanelSchema(db: Database.Database): void {
  // Create base schema
  db.exec(SCHEMA_SQL);

  // Create FTS triggers (handle existing triggers gracefully)
  // Split triggers and execute individually since SQLite doesn't support
  // CREATE TRIGGER IF NOT EXISTS in all versions
  const triggerStatements = FTS_TRIGGERS_SQL.split(/;[\s]*(?=CREATE TRIGGER)/);
  for (const stmt of triggerStatements) {
    const trimmed = stmt.trim();
    if (trimmed) {
      try {
        db.exec(trimmed + (trimmed.endsWith(";") ? "" : ";"));
      } catch (error) {
        // Ignore "trigger already exists" errors, re-throw others
        if (
          error instanceof Error &&
          !error.message.includes("already exists")
        ) {
          throw error;
        }
      }
    }
  }

  // Check and set schema version
  const versionRow = db
    .prepare("SELECT version FROM schema_version WHERE id = 1")
    .get() as { version: number } | undefined;

  if (!versionRow) {
    // First initialization
    db.prepare(
      "INSERT INTO schema_version (id, version, updated_at) VALUES (1, ?, ?)"
    ).run(PANEL_SCHEMA_VERSION, Date.now());
  } else if (versionRow.version < PANEL_SCHEMA_VERSION) {
    // Run pending migrations
    runMigrations(db, versionRow.version);
  }
}

/**
 * Run pending migrations.
 *
 * @param db - The database connection
 * @param currentVersion - Current schema version in the database
 */
function runMigrations(db: Database.Database, currentVersion: number): void {
  const pendingMigrations = MIGRATIONS.filter((m) => m.version > currentVersion);

  if (pendingMigrations.length === 0) {
    // Just update version
    db.prepare("UPDATE schema_version SET version = ?, updated_at = ? WHERE id = 1").run(
      PANEL_SCHEMA_VERSION,
      Date.now()
    );
    return;
  }

  // Sort by version and run
  pendingMigrations.sort((a, b) => a.version - b.version);

  for (const migration of pendingMigrations) {
    console.log(`[panelSchema] Running migration to version ${migration.version}`);
    try {
      db.exec(migration.up);
    } catch (error) {
      console.error(`[panelSchema] Migration ${migration.version} failed:`, error);
      throw error;
    }
  }

  // Update version
  db.prepare("UPDATE schema_version SET version = ?, updated_at = ? WHERE id = 1").run(
    PANEL_SCHEMA_VERSION,
    Date.now()
  );
}

/**
 * SQL queries for common operations.
 */
export const PANEL_QUERIES = {
  /**
   * Get ancestors (for breadcrumb).
   * Returns panels from root to parent (not including the panel itself).
   */
  ANCESTORS: `
    WITH RECURSIVE ancestors AS (
      SELECT id, parent_id, title, type, 0 as depth
      FROM panels WHERE id = ?
      UNION ALL
      SELECT p.id, p.parent_id, p.title, p.type, a.depth + 1
      FROM panels p JOIN ancestors a ON p.id = a.parent_id
      WHERE a.depth < 20
    )
    SELECT id, parent_id, title, type, depth FROM ancestors WHERE depth > 0 ORDER BY depth DESC
  `,

  /**
   * Get siblings (for tab bar, ordered by position).
   */
  SIBLINGS: `
    SELECT p.id, p.title, p.type, p.position, p.artifacts,
      (SELECT COUNT(*) FROM panels c WHERE c.parent_id = p.id) as child_count
    FROM panels p
    WHERE p.parent_id = (SELECT parent_id FROM panels WHERE id = ?)
    ORDER BY p.position
  `,

  /**
   * Get children (for tree expansion, ordered by position).
   */
  CHILDREN: `
    SELECT p.id, p.title, p.type, p.position, p.artifacts,
      (SELECT COUNT(*) FROM panels c WHERE c.parent_id = p.id) as child_count
    FROM panels p WHERE p.parent_id = ?
    ORDER BY p.position
  `,

  /**
   * Get root panels (no parent).
   */
  ROOT_PANELS: `
    SELECT p.id, p.title, p.type, p.position, p.artifacts,
      (SELECT COUNT(*) FROM panels c WHERE c.parent_id = p.id) as child_count
    FROM panels p WHERE p.parent_id IS NULL AND p.workspace_id = ?
    ORDER BY p.position
  `,

  /**
   * Full-text search with ranking.
   */
  SEARCH: `
    SELECT p.*, m.access_count, bm25(panel_fts) as relevance
    FROM panel_fts
    JOIN panel_search_metadata m ON panel_fts.rowid = m.rowid
    JOIN panels p ON m.panel_id = p.id
    WHERE panel_fts MATCH ? AND p.workspace_id = ?
    ORDER BY relevance, m.access_count DESC
    LIMIT ?
  `,

  /**
   * Get a single panel by ID.
   */
  GET_PANEL: `
    SELECT * FROM panels WHERE id = ?
  `,

  /**
   * Get max position among siblings.
   */
  MAX_SIBLING_POSITION: `
    SELECT COALESCE(MAX(position), -1) as max_position
    FROM panels WHERE (parent_id = ? OR (parent_id IS NULL AND ? IS NULL)) AND workspace_id = ?
  `,

  /**
   * Get panel count for a workspace.
   */
  PANEL_COUNT: `
    SELECT COUNT(*) as count FROM panels WHERE workspace_id = ?
  `,

  /**
   * Shift sibling positions up by 1 for prepend/insert operations.
   * Used when inserting a panel at a specific position.
   */
  SHIFT_SIBLING_POSITIONS: `
    UPDATE panels
    SET position = position + 1, updated_at = ?
    WHERE (parent_id = ? OR (parent_id IS NULL AND ? IS NULL))
      AND workspace_id = ?
      AND position >= ?
  `,

  /**
   * Update a panel's position and parent.
   */
  UPDATE_POSITION_AND_PARENT: `
    UPDATE panels
    SET parent_id = ?, position = ?, updated_at = ?
    WHERE id = ?
  `,

  /**
   * Get children with pagination (ordered by position, newest first when prepending).
   */
  CHILDREN_PAGINATED: `
    SELECT p.id, p.title, p.type, p.position, p.artifacts,
      (SELECT COUNT(*) FROM panels c WHERE c.parent_id = p.id) as child_count
    FROM panels p WHERE p.parent_id = ?
    ORDER BY p.position ASC
    LIMIT ? OFFSET ?
  `,

  /**
   * Get children count for a parent.
   */
  CHILDREN_COUNT: `
    SELECT COUNT(*) as count FROM panels WHERE parent_id = ?
  `,

  /**
   * Get root panels with pagination.
   */
  ROOT_PANELS_PAGINATED: `
    SELECT p.id, p.title, p.type, p.position, p.artifacts,
      (SELECT COUNT(*) FROM panels c WHERE c.parent_id = p.id) as child_count
    FROM panels p WHERE p.parent_id IS NULL AND p.workspace_id = ?
    ORDER BY p.position ASC
    LIMIT ? OFFSET ?
  `,

  /**
   * Get root panels count for a workspace.
   */
  ROOT_PANELS_COUNT: `
    SELECT COUNT(*) as count FROM panels WHERE parent_id IS NULL AND workspace_id = ?
  `,
} as const;
