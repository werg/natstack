/**
 * Test-only subclass of WorkspaceDO that omits the FTS5 virtual table.
 *
 * sql.js (used by `createTestDO`) does not include the fts5 module, so a
 * `CREATE VIRTUAL TABLE … USING fts5` statement fails at schema creation.
 * The FTS5 search path is exercised by the workerd-backed integration tests
 * in `internalStorageWorkerd.test.ts`; this subclass exists purely so unit
 * tests can stand WorkspaceDO up under sql.js.
 *
 * Do not use in production code.
 */

import { WorkspaceDO } from "./workspaceDO.js";

export class WorkspaceDOTestable extends WorkspaceDO {
  protected override createTables(): void {
    const sql = (this as unknown as { sql: { exec(s: string, ...b: unknown[]): unknown } }).sql;
    sql.exec(`
      CREATE TABLE IF NOT EXISTS entities (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        source_repo_path TEXT NOT NULL,
        source_effective_version TEXT NOT NULL,
        context_id TEXT NOT NULL,
        class_name TEXT,
        key TEXT NOT NULL,
        state_args TEXT,
        created_at INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        retired_at INTEGER,
        cleanup_complete INTEGER NOT NULL DEFAULT 1,
        error TEXT
      )
    `);
    sql.exec(`CREATE INDEX IF NOT EXISTS idx_entities_status ON entities(status, retired_at)`);
    sql.exec(
      `CREATE INDEX IF NOT EXISTS idx_entities_kind_source ON entities(kind, source_repo_path, class_name)`
    );
    sql.exec(
      `CREATE INDEX IF NOT EXISTS idx_entities_cleanup
        ON entities(cleanup_complete, retired_at) WHERE cleanup_complete = 0`
    );
    sql.exec(`
      CREATE TABLE IF NOT EXISTS slots (
        slot_id TEXT PRIMARY KEY,
        parent_slot_id TEXT REFERENCES slots(slot_id),
        current_entity_id TEXT REFERENCES entities(id),
        current_entry_key TEXT,
        position_id TEXT NOT NULL DEFAULT '000001000000',
        created_at INTEGER NOT NULL,
        closed_at INTEGER
      )
    `);
    sql.exec(`CREATE INDEX IF NOT EXISTS idx_slots_parent ON slots(parent_slot_id)`);
    sql.exec(`CREATE INDEX IF NOT EXISTS idx_slots_current ON slots(current_entity_id)`);
    sql.exec(`
      CREATE TABLE IF NOT EXISTS slot_history (
        slot_id TEXT NOT NULL REFERENCES slots(slot_id),
        cursor INTEGER NOT NULL,
        entry_key TEXT NOT NULL,
        entity_id TEXT NOT NULL REFERENCES entities(id),
        source TEXT NOT NULL,
        context_id TEXT NOT NULL,
        state_args TEXT,
        recorded_at INTEGER NOT NULL,
        PRIMARY KEY (slot_id, cursor)
      )
    `);
    sql.exec(`CREATE INDEX IF NOT EXISTS idx_history_entity ON slot_history(entity_id)`);
    sql.exec(`CREATE INDEX IF NOT EXISTS idx_history_entry ON slot_history(entry_key)`);
    sql.exec(`
      CREATE TABLE IF NOT EXISTS panel_search_metadata (
        slot_id TEXT PRIMARY KEY,
        searchable_title TEXT NOT NULL,
        searchable_path TEXT,
        manifest_description TEXT,
        manifest_dependencies TEXT,
        tags TEXT,
        keywords TEXT,
        access_count INTEGER NOT NULL DEFAULT 0,
        last_indexed_at INTEGER NOT NULL
      )
    `);
    sql.exec(`
      CREATE TABLE IF NOT EXISTS workspace_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `);
  }
}
