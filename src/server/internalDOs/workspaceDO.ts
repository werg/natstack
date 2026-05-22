/**
 * WorkspaceDO — durable workspace state store.
 *
 * Replaces PanelStoreDO with a unified entity/slot model. Entity rows are
 * immutable in their identity columns (write-once) and mutable in their
 * lifecycle columns (status, retired_at, cleanup_complete). Slot rows hold
 * the panel-tree position; slot_history holds the navigation history.
 *
 * Schema v7 ships clean-cut: the upgrade path drops every v6 table and
 * creates the new schema empty. No data migration.
 */

import {
  DurableObjectBase,
  type DurableObjectContext,
} from "../../../workspace/packages/runtime/src/worker/durable-base.js";
import {
  IdentityCollisionError,
  canonicalEntityId,
  type EntityKind,
  type EntityRecord,
} from "../../../packages/shared/src/runtime/entitySpec.js";
import type {
  IndexablePanel,
  PanelSearchResult,
} from "../../../packages/shared/src/panelSearchTypes.js";

interface DbEntityRow {
  id: string;
  kind: EntityKind;
  source_repo_path: string;
  source_effective_version: string;
  context_id: string;
  class_name: string | null;
  key: string;
  state_args: string | null;
  created_at: number;
  status: "active" | "retired";
  retired_at: number | null;
  cleanup_complete: number; // SQLite stores boolean as 0/1
  error: string | null;
}

interface DbSlotRow {
  slot_id: string;
  parent_slot_id: string | null;
  current_entity_id: string | null;
  current_entry_key: string | null;
  position_id: string;
  created_at: number;
  closed_at: number | null;
}

interface DbSlotHistoryRow {
  slot_id: string;
  cursor: number;
  entry_key: string;
  entity_id: string;
  source: string;
  context_id: string;
  state_args: string | null;
  recorded_at: number;
}

export interface EntityActivateInput {
  kind: EntityKind;
  source: { repoPath: string; effectiveVersion: string };
  contextId: string;
  className?: string;
  key: string;
  stateArgs?: unknown;
}

export interface SlotCreateInput {
  slotId: string;
  parentSlotId: string | null;
  positionId: string;
  initialEntry?: {
    entryKey: string;
    entityId: string;
    source: string;
    contextId: string;
    stateArgs?: unknown;
  };
}

export interface SlotHistoryEntryInput {
  entryKey: string;
  entityId: string;
  source: string;
  contextId: string;
  stateArgs?: unknown;
}

export interface GcOptions {
  /** Sweep all rows. If false (default), caller must scope by slotId. */
  all?: boolean;
  /** Only sweep entities tied to this slot's history. */
  slotId?: string;
  /** Don't delete rows newer than (now - graceMs). Default: 1 hour. */
  graceMs?: number;
}

const DEFAULT_GRACE_MS = 60 * 60 * 1000;

export class WorkspaceDO extends DurableObjectBase {
  static override schemaVersion = 7;

  constructor(ctx: DurableObjectContext, env: unknown) {
    super(ctx, env);
    this.ensureReady();
  }

  // ─────────────────────────────────────────────────────────────
  // Schema
  // ─────────────────────────────────────────────────────────────

  protected createTables(): void {
    this.sql.exec(`
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
    this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_entities_status ON entities(status, retired_at)`);
    this.sql.exec(
      `CREATE INDEX IF NOT EXISTS idx_entities_kind_source ON entities(kind, source_repo_path, class_name)`
    );
    this.sql.exec(
      `CREATE INDEX IF NOT EXISTS idx_entities_cleanup
        ON entities(cleanup_complete, retired_at) WHERE cleanup_complete = 0`
    );

    this.sql.exec(`
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
    this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_slots_parent ON slots(parent_slot_id)`);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_slots_current ON slots(current_entity_id)`);

    this.sql.exec(`
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
    this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_history_entity ON slot_history(entity_id)`);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_history_entry ON slot_history(entry_key)`);

    // panel_search_metadata is keyed by slot_id (the workspace-facing panel
    // handle), NOT the per-navigation entity row. Slot id is stable across
    // navigations, so the search row survives every back/forward without
    // re-indexing.
    this.sql.exec(`
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
    this.sql.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS panel_fts USING fts5(
        searchable_title,
        searchable_path,
        manifest_description,
        manifest_dependencies,
        tags,
        keywords,
        content='panel_search_metadata',
        content_rowid='rowid'
      )
    `);
    this.sql.exec(`
      CREATE TRIGGER IF NOT EXISTS panel_fts_insert AFTER INSERT ON panel_search_metadata BEGIN
        INSERT INTO panel_fts(rowid, searchable_title, searchable_path,
          manifest_description, manifest_dependencies, tags, keywords)
        VALUES (NEW.rowid, NEW.searchable_title, NEW.searchable_path,
          NEW.manifest_description, NEW.manifest_dependencies, NEW.tags, NEW.keywords);
      END
    `);
    this.sql.exec(`
      CREATE TRIGGER IF NOT EXISTS panel_fts_delete AFTER DELETE ON panel_search_metadata BEGIN
        INSERT INTO panel_fts(panel_fts, rowid, searchable_title, searchable_path,
          manifest_description, manifest_dependencies, tags, keywords)
        VALUES ('delete', OLD.rowid, OLD.searchable_title, OLD.searchable_path,
          OLD.manifest_description, OLD.manifest_dependencies, OLD.tags, OLD.keywords);
      END
    `);
    this.sql.exec(`
      CREATE TRIGGER IF NOT EXISTS panel_fts_update AFTER UPDATE ON panel_search_metadata BEGIN
        INSERT INTO panel_fts(panel_fts, rowid, searchable_title, searchable_path,
          manifest_description, manifest_dependencies, tags, keywords)
        VALUES ('delete', OLD.rowid, OLD.searchable_title, OLD.searchable_path,
          OLD.manifest_description, OLD.manifest_dependencies, OLD.tags, OLD.keywords);
        INSERT INTO panel_fts(rowid, searchable_title, searchable_path,
          manifest_description, manifest_dependencies, tags, keywords)
        VALUES (NEW.rowid, NEW.searchable_title, NEW.searchable_path,
          NEW.manifest_description, NEW.manifest_dependencies, NEW.tags, NEW.keywords);
      END
    `);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS workspace_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `);
  }

  protected override migrate(fromVersion: number, _toVersion: number): void {
    if (fromVersion === 0) return;
    if (fromVersion < 7) {
      // Clean-cut destructive upgrade. No data is preserved from v6 or earlier.
      this.sql.exec(`DROP TABLE IF EXISTS panel_fts`);
      this.sql.exec(`DROP TABLE IF EXISTS panel_search_metadata`);
      this.sql.exec(`DROP TABLE IF EXISTS panel_ops`);
      this.sql.exec(`DROP TABLE IF EXISTS panels`);
      // workspace_meta retained as bare KV; clear v6-era keys if any.
      this.sql.exec(
        `DELETE FROM workspace_meta WHERE key IN ('revision','compactedThroughRevision')`
      );
      // Old slot/entity/history tables (if a partial v7 ever existed) — drop to be sure.
      this.sql.exec(`DROP TABLE IF EXISTS slot_history`);
      this.sql.exec(`DROP TABLE IF EXISTS slots`);
      this.sql.exec(`DROP TABLE IF EXISTS entities`);
    }
  }

  getWorkspaceId(): string {
    return this.objectKey;
  }

  // ─────────────────────────────────────────────────────────────
  // entity.* operations
  // ─────────────────────────────────────────────────────────────

  /**
   * Three-way upsert keyed by canonical id derived from identity columns.
   * - No prior row → insert with status='active'.
   * - Prior 'active' row with identical identity → idempotent no-op.
   * - Prior 'retired' row with identical identity → reactivate (flip status).
   * - Prior row with mismatched identity → throw IDENTITY_COLLISION.
   */
  entityActivate(input: EntityActivateInput): EntityRecord {
    return this.ctx.storage.transactionSync(() => {
      const id = canonicalEntityId({
        kind: input.kind,
        source: input.source.repoPath,
        className: input.className,
        key: input.key,
      });

      const existing = this.readEntityRow(id);
      if (existing) {
        this.assertIdentityMatches(id, existing, input);
        if (existing.status === "active") {
          return this.rowToEntity(existing);
        }
        // Reactivate
        this.sql.exec(
          `UPDATE entities SET status = 'active', retired_at = NULL, cleanup_complete = 1, error = NULL WHERE id = ?`,
          id
        );
        return this.rowToEntity({
          ...existing,
          status: "active",
          retired_at: null,
          cleanup_complete: 1,
          error: null,
        });
      }

      const now = Date.now();
      this.sql.exec(
        `INSERT INTO entities (
          id, kind, source_repo_path, source_effective_version,
          context_id, class_name, key, state_args, created_at,
          status, retired_at, cleanup_complete, error
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', NULL, 1, NULL)`,
        id,
        input.kind,
        input.source.repoPath,
        input.source.effectiveVersion,
        input.contextId,
        input.className ?? null,
        input.key,
        input.stateArgs === undefined ? null : JSON.stringify(input.stateArgs),
        now
      );
      const row = this.readEntityRow(id);
      if (!row) throw new Error(`entityActivate: failed to read row after insert: ${id}`);
      return this.rowToEntity(row);
    });
  }

  /** Mark a single entity as retired. Idempotent. Returns the retired record (or null if not found). */
  entityRetire(id: string): EntityRecord | null {
    return this.ctx.storage.transactionSync(() => {
      const row = this.readEntityRow(id);
      if (!row) return null;
      if (row.status === "retired") {
        return this.rowToEntity(row);
      }
      const now = Date.now();
      this.sql.exec(
        `UPDATE entities SET status = 'retired', retired_at = ?, cleanup_complete = 0 WHERE id = ?`,
        now,
        id
      );
      const updated = this.readEntityRow(id);
      return updated ? this.rowToEntity(updated) : null;
    });
  }

  /** Mark cleanup_complete=1 after server-side hooks succeed. */
  entityCleanupComplete(id: string): void {
    this.sql.exec(`UPDATE entities SET cleanup_complete = 1 WHERE id = ?`, id);
  }

  /** Find rows whose cleanup hooks need retrying. */
  entityFindIncompleteCleanups(): EntityRecord[] {
    const rows = this.sql
      .exec(`SELECT * FROM entities WHERE retired_at IS NOT NULL AND cleanup_complete = 0`)
      .toArray() as unknown as DbEntityRow[];
    return rows.map((row) => this.rowToEntity(row));
  }

  /**
   * Hard-delete retired rows older than the grace window and unreferenced by slot_history.
   * Never deletes active rows; never deletes history-referenced rows. Fires no hooks.
   */
  entityGc(opts: GcOptions = {}): string[] {
    const graceMs = opts.graceMs ?? DEFAULT_GRACE_MS;
    const cutoff = Date.now() - graceMs;
    return this.ctx.storage.transactionSync(() => {
      let candidates: Array<{ id: string }>;
      if (opts.all) {
        candidates = this.sql
          .exec(
            `SELECT id FROM entities
             WHERE status = 'retired' AND retired_at IS NOT NULL AND retired_at <= ?
               AND id NOT IN (SELECT entity_id FROM slot_history)`,
            cutoff
          )
          .toArray() as Array<{ id: string }>;
      } else if (opts.slotId) {
        candidates = this.sql
          .exec(
            `SELECT e.id FROM entities e
             WHERE e.status = 'retired' AND e.retired_at IS NOT NULL AND e.retired_at <= ?
               AND e.id IN (SELECT entity_id FROM slot_history WHERE slot_id = ?)
               AND e.id NOT IN (SELECT entity_id FROM slot_history WHERE slot_id != ?)`,
            cutoff,
            opts.slotId,
            opts.slotId
          )
          .toArray() as Array<{ id: string }>;
      } else {
        return [];
      }

      const ids = candidates.map((row) => row.id);
      for (const id of ids) {
        this.sql.exec(`DELETE FROM entities WHERE id = ?`, id);
      }
      return ids;
    });
  }

  // ── Entity reads ──

  entityResolve(id: string): EntityRecord | null {
    const row = this.readEntityRow(id);
    return row ? this.rowToEntity(row) : null;
  }

  entityResolveActive(id: string): EntityRecord | null {
    const row = this.readEntityRow(id);
    if (!row || row.status !== "active") return null;
    return this.rowToEntity(row);
  }

  entityResolveContext(id: string): string | null {
    const row = this.readEntityRow(id);
    return row ? row.context_id : null;
  }

  entityResolveSource(id: string): { repoPath: string; effectiveVersion: string } | null {
    const row = this.readEntityRow(id);
    if (!row) return null;
    return { repoPath: row.source_repo_path, effectiveVersion: row.source_effective_version };
  }

  /** Return all active entities (used by restart revival to re-attach runtime). */
  entityListActive(): EntityRecord[] {
    const rows = this.sql
      .exec(`SELECT * FROM entities WHERE status = 'active' ORDER BY created_at`)
      .toArray() as unknown as DbEntityRow[];
    return rows.map((row) => this.rowToEntity(row));
  }

  /** Return active entities of a given kind (used by singleton reconciliation). */
  entityListActiveByKind(kind: EntityKind): EntityRecord[] {
    const rows = this.sql
      .exec(`SELECT * FROM entities WHERE status = 'active' AND kind = ? ORDER BY created_at`, kind)
      .toArray() as unknown as DbEntityRow[];
    return rows.map((row) => this.rowToEntity(row));
  }

  // ─────────────────────────────────────────────────────────────
  // slot.* operations
  // ─────────────────────────────────────────────────────────────

  slotCreate(input: SlotCreateInput): void {
    this.ctx.storage.transactionSync(() => {
      const existing = this.sql
        .exec(`SELECT slot_id FROM slots WHERE slot_id = ?`, input.slotId)
        .toArray()[0];
      if (existing) {
        throw new Error(`Slot already exists: ${input.slotId}`);
      }
      const now = Date.now();
      this.sql.exec(
        `INSERT INTO slots (slot_id, parent_slot_id, current_entity_id, current_entry_key, position_id, created_at, closed_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL)`,
        input.slotId,
        input.parentSlotId,
        input.initialEntry?.entityId ?? null,
        input.initialEntry?.entryKey ?? null,
        input.positionId,
        now
      );
      if (input.initialEntry) {
        this.appendHistoryRow(input.slotId, 0, input.initialEntry, now);
      }
    });
  }

  slotAppendHistory(slotId: string, entry: SlotHistoryEntryInput): number {
    return this.ctx.storage.transactionSync(() => {
      this.requireSlot(slotId);
      const lastRow = this.sql
        .exec(
          `SELECT cursor FROM slot_history WHERE slot_id = ? ORDER BY cursor DESC LIMIT 1`,
          slotId
        )
        .toArray()[0] as { cursor: number } | undefined;
      const cursor = (lastRow?.cursor ?? -1) + 1;
      this.appendHistoryRow(slotId, cursor, entry, Date.now());
      return cursor;
    });
  }

  slotSetCurrent(slotId: string, entryKey: string): void {
    this.ctx.storage.transactionSync(() => {
      this.requireSlot(slotId);
      const historyRow = this.sql
        .exec(
          `SELECT entity_id FROM slot_history WHERE slot_id = ? AND entry_key = ?`,
          slotId,
          entryKey
        )
        .toArray()[0] as { entity_id: string } | undefined;
      if (!historyRow) {
        throw new Error(`History entry not found: slot=${slotId} entry=${entryKey}`);
      }
      this.sql.exec(
        `UPDATE slots SET current_entity_id = ?, current_entry_key = ? WHERE slot_id = ?`,
        historyRow.entity_id,
        entryKey,
        slotId
      );
    });
  }

  slotUpdateCurrentStateArgs(slotId: string, stateArgs: unknown): void {
    this.ctx.storage.transactionSync(() => {
      const slot = this.requireSlot(slotId);
      if (!slot.current_entry_key) {
        throw new Error(`Slot ${slotId} has no current history entry`);
      }
      const serialized = stateArgs === undefined ? null : JSON.stringify(stateArgs);
      this.sql.exec(
        `UPDATE slot_history SET state_args = ? WHERE slot_id = ? AND entry_key = ?`,
        serialized,
        slotId,
        slot.current_entry_key
      );
      if (slot.current_entity_id) {
        this.sql.exec(
          `UPDATE entities SET state_args = ? WHERE id = ?`,
          serialized,
          slot.current_entity_id
        );
      }
    });
  }

  slotReplaceHistory(slotId: string, entries: SlotHistoryEntryInput[], cursor: number): void {
    this.ctx.storage.transactionSync(() => {
      this.requireSlot(slotId);
      this.sql.exec(`DELETE FROM slot_history WHERE slot_id = ?`, slotId);
      const now = Date.now();
      for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];
        if (entry) {
          this.appendHistoryRow(slotId, i, entry, now);
        }
      }
      const current = entries[cursor];
      if (current) {
        this.sql.exec(
          `UPDATE slots SET current_entity_id = ?, current_entry_key = ? WHERE slot_id = ?`,
          current.entityId,
          current.entryKey,
          slotId
        );
      } else {
        this.sql.exec(
          `UPDATE slots SET current_entity_id = NULL, current_entry_key = NULL WHERE slot_id = ?`,
          slotId
        );
      }
    });
  }

  slotSetParent(slotId: string, parentSlotId: string | null): void {
    this.requireSlot(slotId);
    this.sql.exec(`UPDATE slots SET parent_slot_id = ? WHERE slot_id = ?`, parentSlotId, slotId);
  }

  slotSetPosition(slotId: string, positionId: string): void {
    this.requireSlot(slotId);
    this.sql.exec(`UPDATE slots SET position_id = ? WHERE slot_id = ?`, positionId, slotId);
  }

  slotMove(slotId: string, parentSlotId: string | null, positionId: string): void {
    this.ctx.storage.transactionSync(() => {
      this.requireSlot(slotId);
      this.sql.exec(
        `UPDATE slots SET parent_slot_id = ?, position_id = ? WHERE slot_id = ?`,
        parentSlotId,
        positionId,
        slotId
      );
    });
  }

  slotClose(slotId: string): void {
    this.ctx.storage.transactionSync(() => {
      this.requireSlot(slotId);
      this.sql.exec(
        `UPDATE slots SET closed_at = ?, current_entity_id = NULL, current_entry_key = NULL WHERE slot_id = ?`,
        Date.now(),
        slotId
      );
      this.sql.exec(`DELETE FROM panel_search_metadata WHERE slot_id = ?`, slotId);
    });
  }

  slotGet(slotId: string): DbSlotRow | null {
    const row = this.sql.exec(`SELECT * FROM slots WHERE slot_id = ?`, slotId).toArray()[0] as
      | DbSlotRow
      | undefined;
    return row ?? null;
  }

  slotListOpen(): DbSlotRow[] {
    return this.sql
      .exec(`SELECT * FROM slots WHERE closed_at IS NULL ORDER BY position_id, created_at, slot_id`)
      .toArray() as unknown as DbSlotRow[];
  }

  slotHistory(slotId: string): DbSlotHistoryRow[] {
    return this.sql
      .exec(`SELECT * FROM slot_history WHERE slot_id = ? ORDER BY cursor`, slotId)
      .toArray() as unknown as DbSlotHistoryRow[];
  }

  // ─────────────────────────────────────────────────────────────
  // panel search (FTS5 over panel_search_metadata)
  // ─────────────────────────────────────────────────────────────

  panelIndex(input: IndexablePanel): void {
    const now = Date.now();
    const existing = this.sql
      .exec(`SELECT rowid FROM panel_search_metadata WHERE slot_id = ?`, input.id)
      .toArray()[0];
    if (existing) {
      this.sql.exec(
        `UPDATE panel_search_metadata SET
          searchable_title = ?, searchable_path = ?, manifest_description = ?,
          manifest_dependencies = ?, tags = ?, keywords = ?, last_indexed_at = ?
        WHERE slot_id = ?`,
        input.title,
        input.path ?? null,
        input.manifestDescription ?? null,
        input.manifestDependencies ? JSON.stringify(input.manifestDependencies) : null,
        input.tags ? JSON.stringify(input.tags) : null,
        input.keywords ? JSON.stringify(input.keywords) : null,
        now,
        input.id
      );
      return;
    }
    this.sql.exec(
      `INSERT INTO panel_search_metadata (
        slot_id, searchable_title, searchable_path, manifest_description,
        manifest_dependencies, tags, keywords, access_count, last_indexed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)`,
      input.id,
      input.title,
      input.path ?? null,
      input.manifestDescription ?? null,
      input.manifestDependencies ? JSON.stringify(input.manifestDependencies) : null,
      input.tags ? JSON.stringify(input.tags) : null,
      input.keywords ? JSON.stringify(input.keywords) : null,
      now
    );
  }

  panelUpdateTitle(entityId: string, title: string): void {
    this.sql.exec(
      `UPDATE panel_search_metadata SET searchable_title = ?, last_indexed_at = ? WHERE slot_id = ?`,
      title,
      Date.now(),
      entityId
    );
  }

  panelIncrementAccess(entityId: string): void {
    this.sql.exec(
      `UPDATE panel_search_metadata SET access_count = access_count + 1 WHERE slot_id = ?`,
      entityId
    );
  }

  panelSearch(query: string, limit = 50): PanelSearchResult[] {
    const safeQuery = this.sanitizeSearchQuery(query);
    if (!safeQuery) return [];
    // panel_search_metadata.slot_id stores the panel's slot id (the
    // workspace-facing panel handle), not the per-navigation entity row id.
    // We filter to open slots so closed panels drop out of search.
    const rows = this.sql
      .exec(
        `SELECT m.slot_id as id, m.searchable_title as title, m.access_count as access_count,
                bm25(panel_fts) as relevance
         FROM panel_fts
         JOIN panel_search_metadata m ON panel_fts.rowid = m.rowid
         JOIN slots s ON m.slot_id = s.slot_id
         WHERE panel_fts MATCH ? AND s.closed_at IS NULL
         ORDER BY relevance, m.access_count DESC
         LIMIT ?`,
        safeQuery,
        limit
      )
      .toArray() as Array<{
      id: string;
      title: string;
      access_count: number;
      relevance: number;
    }>;
    return rows.map((row) => ({
      id: row.id,
      title: row.title,
      relevance: row.relevance,
      accessCount: row.access_count,
    }));
  }

  panelRebuildIndex(): void {
    this.sql.exec(`DELETE FROM panel_search_metadata`);
    // Rebuild from open slots + their current entity's stateArgs/source.
    const rows = this.sql
      .exec(
        `SELECT s.slot_id as slot_id, e.state_args as state_args, e.source_repo_path as source_repo_path, e.key as key
         FROM slots s
         LEFT JOIN entities e ON s.current_entity_id = e.id
         WHERE s.closed_at IS NULL`
      )
      .toArray() as Array<{
      slot_id: string;
      state_args: string | null;
      source_repo_path: string | null;
      key: string | null;
    }>;
    const now = Date.now();
    for (const row of rows) {
      let title: string = row.slot_id;
      if (row.state_args) {
        try {
          const args = JSON.parse(row.state_args) as { title?: string };
          if (typeof args?.title === "string") title = args.title;
        } catch {
          // ignore; fall back
        }
      } else if (row.key) {
        title = row.key;
      }
      this.sql.exec(
        `INSERT INTO panel_search_metadata (
          slot_id, searchable_title, searchable_path, manifest_description,
          manifest_dependencies, tags, keywords, access_count, last_indexed_at
        ) VALUES (?, ?, ?, NULL, NULL, NULL, NULL, 0, ?)`,
        row.slot_id,
        title,
        row.source_repo_path,
        now
      );
    }
  }

  private sanitizeSearchQuery(query: string): string {
    const trimmed = query.trim();
    if (!trimmed) return "";
    const escaped = trimmed.replace(/["*():^]/g, " ").trim();
    return escaped.includes(" ") ? `"${escaped}"` : escaped;
  }

  // ─────────────────────────────────────────────────────────────
  // Helpers
  // ─────────────────────────────────────────────────────────────

  private entityRetireInTransaction(id: string): EntityRecord | null {
    const row = this.readEntityRow(id);
    if (!row) return null;
    if (row.status === "retired") {
      return this.rowToEntity(row);
    }
    const now = Date.now();
    this.sql.exec(
      `UPDATE entities SET status = 'retired', retired_at = ?, cleanup_complete = 0 WHERE id = ?`,
      now,
      id
    );
    return this.rowToEntity({
      ...row,
      status: "retired",
      retired_at: now,
      cleanup_complete: 0,
    });
  }

  private readEntityRow(id: string): DbEntityRow | null {
    const row = this.sql.exec(`SELECT * FROM entities WHERE id = ?`, id).toArray()[0] as unknown as
      | DbEntityRow
      | undefined;
    return row ?? null;
  }

  private rowToEntity(row: DbEntityRow): EntityRecord {
    const record: EntityRecord = {
      id: row.id,
      kind: row.kind,
      source: {
        repoPath: row.source_repo_path,
        effectiveVersion: row.source_effective_version,
      },
      contextId: row.context_id,
      key: row.key,
      createdAt: row.created_at,
      status: row.status,
      cleanupComplete: row.cleanup_complete === 1,
    };
    if (row.class_name) record.className = row.class_name;
    if (row.state_args !== null) record.stateArgs = JSON.parse(row.state_args);
    if (row.retired_at !== null) record.retiredAt = row.retired_at;
    if (row.error !== null) record.error = row.error;
    return record;
  }

  private assertIdentityMatches(
    id: string,
    existing: DbEntityRow,
    input: EntityActivateInput
  ): void {
    const checks: Array<{ field: string; existing: unknown; attempted: unknown }> = [
      { field: "kind", existing: existing.kind, attempted: input.kind },
      {
        field: "source.repoPath",
        existing: existing.source_repo_path,
        attempted: input.source.repoPath,
      },
      {
        field: "source.effectiveVersion",
        existing: existing.source_effective_version,
        attempted: input.source.effectiveVersion,
      },
      { field: "contextId", existing: existing.context_id, attempted: input.contextId },
      { field: "className", existing: existing.class_name, attempted: input.className ?? null },
      { field: "key", existing: existing.key, attempted: input.key },
    ];
    for (const check of checks) {
      if (check.existing !== check.attempted) {
        throw new IdentityCollisionError(id, check);
      }
    }
  }

  private appendHistoryRow(
    slotId: string,
    cursor: number,
    entry: SlotHistoryEntryInput,
    now: number
  ): void {
    this.sql.exec(
      `INSERT INTO slot_history (slot_id, cursor, entry_key, entity_id, source, context_id, state_args, recorded_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      slotId,
      cursor,
      entry.entryKey,
      entry.entityId,
      entry.source,
      entry.contextId,
      entry.stateArgs === undefined ? null : JSON.stringify(entry.stateArgs),
      now
    );
  }

  private requireSlot(slotId: string): DbSlotRow {
    const row = this.slotGet(slotId);
    if (!row) throw new Error(`Slot not found: ${slotId}`);
    return row;
  }
}
