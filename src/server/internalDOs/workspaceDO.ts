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

import { DurableObjectBase, type DurableObjectContext } from "@natstack/durable";
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
  current_entity_title?: string | null;
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

export interface LifecycleKey {
  source: string;
  className: string;
  objectKey: string;
}

export interface LifecycleLeaseInput extends LifecycleKey {
  detail?: unknown;
}

export interface LifecycleEpochInput {
  kind: "planned" | "crash" | "server_restart";
  reason: string;
  generation: number;
}

export interface LifecycleOpInput {
  epochId: string;
  key: LifecycleKey;
  opKind: "prepare" | "resume";
  status: "pending" | "ready" | "timed_out" | "failed" | "resumed";
  detail?: unknown;
}

export interface LifecycleLease extends LifecycleKey {
  detail: unknown | null;
  createdAt: number;
  refreshedAt: number;
}

export interface LifecycleOp extends LifecycleKey {
  epochId: string;
  opKind: "prepare" | "resume";
  status: "pending" | "ready" | "timed_out" | "failed" | "resumed";
  detail: unknown | null;
  updatedAt: number;
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
const WORKSPACE_REQUIRED_TABLES = [
  "entities",
  "slots",
  "slot_history",
  "panel_search_metadata",
  "workspace_meta",
  "lifecycle_epochs",
  "lifecycle_leases",
  "lifecycle_ops",
  "do_alarms",
] as const;

export class WorkspaceDO extends DurableObjectBase {
  static override schemaVersion = 11;

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
        error TEXT,
        display_title TEXT
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

    // panel_search_metadata is an FTS5 staging table — per-slot, holds the
    // text we want indexed. `searchable_title` is intentionally a
    // denormalization of `entities.display_title` (the canonical source of
    // truth for titles, accessed via the slot's current_entity_id). The
    // denormalization exists because FTS5 external-content tables require
    // their content columns to live on a regular table, and contentless
    // FTS5 doesn't support the upsert-by-rowid pattern we'd need under
    // workerd. All writes to `searchable_title` flow through one site
    // (`entitySetDisplayTitle`), so there is no second code path that can
    // diverge from the source.
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS panel_search_metadata (
        slot_id TEXT PRIMARY KEY,
        searchable_title TEXT NOT NULL DEFAULT '',
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
    this.createLifecycleTables();
  }

  protected override requiredTables(): readonly string[] {
    return WORKSPACE_REQUIRED_TABLES;
  }

  protected override migrate(fromVersion: number, _toVersion: number): void {
    if (fromVersion === 0) return;
    // Pre-release. Schema changes are destructive — there is no user data to
    // preserve, and we'd rather keep migration code small than carry layered
    // ALTERs forever. Anything older than the current schema gets wiped and
    // recreated by createTables().
    this.sql.exec(`DROP TABLE IF EXISTS panel_fts`);
    this.sql.exec(`DROP TABLE IF EXISTS panel_search_metadata`);
    this.sql.exec(`DROP TABLE IF EXISTS panel_ops`);
    this.sql.exec(`DROP TABLE IF EXISTS panels`);
    this.sql.exec(`DROP TABLE IF EXISTS workspace_meta`);
    this.sql.exec(`DROP TABLE IF EXISTS slot_history`);
    this.sql.exec(`DROP TABLE IF EXISTS slots`);
    this.sql.exec(`DROP TABLE IF EXISTS entities`);
    this.sql.exec(`DROP TABLE IF EXISTS lifecycle_ops`);
    this.sql.exec(`DROP TABLE IF EXISTS lifecycle_leases`);
    this.sql.exec(`DROP TABLE IF EXISTS lifecycle_epochs`);
    this.sql.exec(`DROP TABLE IF EXISTS do_alarms`);
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
      if (row.kind === "do" && row.class_name) {
        this.lifecycleLeaseClear({
          source: row.source_repo_path,
          className: row.class_name,
          objectKey: row.key,
        });
      }
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

  // ─────────────────────────────────────────────────────────────
  // lifecycle.* operations
  // ─────────────────────────────────────────────────────────────

  lifecycleLeaseUpsert(input: LifecycleLeaseInput): void {
    this.assertLifecycleKey(input);
    const now = Date.now();
    this.sql.exec(
      `INSERT INTO lifecycle_leases (
        source, class_name, object_key, detail, created_at, refreshed_at
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(source, class_name, object_key) DO UPDATE SET
        detail = excluded.detail,
        refreshed_at = excluded.refreshed_at`,
      input.source,
      input.className,
      input.objectKey,
      input.detail === undefined ? null : JSON.stringify(input.detail),
      now,
      now
    );
  }

  lifecycleLeaseClear(input: LifecycleKey): void {
    this.assertLifecycleKey(input);
    this.sql.exec(
      `DELETE FROM lifecycle_leases WHERE source = ? AND class_name = ? AND object_key = ?`,
      input.source,
      input.className,
      input.objectKey
    );
  }

  // ─────────────────────────────────────────────────────────────
  // do alarms (server-driven; see do_alarms table comment)
  // ─────────────────────────────────────────────────────────────

  /** Register/replace a DO's wake time (absolute epoch ms). */
  alarmSet(input: LifecycleKey & { wakeAt: number }): void {
    this.assertLifecycleKey(input);
    this.sql.exec(
      `INSERT INTO do_alarms (source, class_name, object_key, wake_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(source, class_name, object_key) DO UPDATE SET wake_at = excluded.wake_at`,
      input.source,
      input.className,
      input.objectKey,
      Math.round(input.wakeAt)
    );
  }

  /** Clear a DO's pending alarm (no-op if none). */
  alarmClear(input: LifecycleKey): void {
    this.assertLifecycleKey(input);
    this.sql.exec(
      `DELETE FROM do_alarms WHERE source = ? AND class_name = ? AND object_key = ?`,
      input.source,
      input.className,
      input.objectKey
    );
  }

  /** Soonest pending wake time, or null when no alarms are scheduled. */
  alarmNextWakeAt(): number | null {
    const row = this.sql.exec(`SELECT MIN(wake_at) AS next FROM do_alarms`).toArray()[0] as
      | { next: number | null }
      | undefined;
    return row && row.next !== null ? row.next : null;
  }

  /** Atomically return and delete all alarms due at/before `now`. Each fires once;
   *  recurring DOs re-arm from inside their own `alarm()` handler. */
  alarmTakeDue(now: number): Array<LifecycleKey & { wakeAt: number }> {
    return this.ctx.storage.transactionSync(() => {
      const rows = this.sql
        .exec(
          `SELECT source, class_name, object_key, wake_at FROM do_alarms WHERE wake_at <= ?`,
          now
        )
        .toArray() as Array<{
        source: string;
        class_name: string;
        object_key: string;
        wake_at: number;
      }>;
      if (rows.length > 0) {
        this.sql.exec(`DELETE FROM do_alarms WHERE wake_at <= ?`, now);
      }
      return rows.map((r) => ({
        source: r.source,
        className: r.class_name,
        objectKey: r.object_key,
        wakeAt: r.wake_at,
      }));
    });
  }

  lifecycleListLeases(): LifecycleLease[] {
    const rows = this.sql
      .exec(
        `SELECT source, class_name, object_key, detail, created_at, refreshed_at
         FROM lifecycle_leases
         ORDER BY refreshed_at, source, class_name, object_key`
      )
      .toArray() as Array<{
      source: string;
      class_name: string;
      object_key: string;
      detail: string | null;
      created_at: number;
      refreshed_at: number;
    }>;
    return rows.map((row) => ({
      source: row.source,
      className: row.class_name,
      objectKey: row.object_key,
      detail: this.parseJsonOrNull(row.detail),
      createdAt: row.created_at,
      refreshedAt: row.refreshed_at,
    }));
  }

  lifecycleOpenEpoch(input: LifecycleEpochInput): string {
    return this.ctx.storage.transactionSync(() => {
      const seqRow = this.sql
        .exec(
          `SELECT COALESCE(MAX(CAST(substr(epoch_id, 7) AS INTEGER)), 0) + 1 AS seq
           FROM lifecycle_epochs
           WHERE epoch_id LIKE 'epoch-%'`
        )
        .toArray()[0] as { seq: number } | undefined;
      const epochId = `epoch-${String(seqRow?.seq ?? 1).padStart(12, "0")}`;
      const now = Date.now();
      this.sql.exec(
        `INSERT INTO lifecycle_epochs (epoch_id, kind, reason, created_at, generation, status)
         VALUES (?, ?, ?, ?, ?, 'open')`,
        epochId,
        input.kind,
        input.reason,
        now,
        input.generation
      );
      const leases = this.lifecycleListLeases();
      for (const lease of leases) {
        this.insertLifecycleOp(epochId, lease, "prepare", "pending", null, now);
        this.insertLifecycleOp(epochId, lease, "resume", "pending", null, now);
      }
      return epochId;
    });
  }

  lifecycleRecordOp(input: LifecycleOpInput): void {
    this.assertLifecycleKey(input.key);
    this.insertLifecycleOp(
      input.epochId,
      input.key,
      input.opKind,
      input.status,
      input.detail === undefined ? null : JSON.stringify(input.detail),
      Date.now()
    );
  }

  lifecycleListOps(epochId: string): LifecycleOp[] {
    const rows = this.sql
      .exec(
        `SELECT epoch_id, source, class_name, object_key, op_kind, status, detail, updated_at
         FROM lifecycle_ops
         WHERE epoch_id = ?
         ORDER BY source, class_name, object_key, op_kind`,
        epochId
      )
      .toArray() as Array<{
      epoch_id: string;
      source: string;
      class_name: string;
      object_key: string;
      op_kind: "prepare" | "resume";
      status: "pending" | "ready" | "timed_out" | "failed" | "resumed";
      detail: string | null;
      updated_at: number;
    }>;
    return rows.map((row) => ({
      epochId: row.epoch_id,
      source: row.source,
      className: row.class_name,
      objectKey: row.object_key,
      opKind: row.op_kind,
      status: row.status,
      detail: this.parseJsonOrNull(row.detail),
      updatedAt: row.updated_at,
    }));
  }

  lifecycleCompleteEpoch(epochId: string): void {
    this.sql.exec(`UPDATE lifecycle_epochs SET status = 'completed' WHERE epoch_id = ?`, epochId);
  }

  lifecycleListResumeTargets(): LifecycleKey[] {
    const rows = this.sql
      .exec(
        `SELECT source, class_name, object_key FROM lifecycle_leases
         UNION
         SELECT source, class_name, object_key FROM lifecycle_ops
         WHERE op_kind = 'resume' AND status IN ('pending', 'ready', 'timed_out', 'failed')
         ORDER BY source, class_name, object_key`
      )
      .toArray() as Array<{ source: string; class_name: string; object_key: string }>;
    return rows.map((row) => ({
      source: row.source,
      className: row.class_name,
      objectKey: row.object_key,
    }));
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
      // The slot now points at a different entity. Refresh the FTS
      // denormalization so search hits the new entity's title.
      this.refreshSlotSearchableTitle(slotId);
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
      this.refreshSlotSearchableTitle(slotId);
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
    const row = this.sql
      .exec(
        `SELECT s.*, e.display_title AS current_entity_title
         FROM slots s
         LEFT JOIN entities e ON s.current_entity_id = e.id
         WHERE s.slot_id = ?`,
        slotId
      )
      .toArray()[0] as DbSlotRow | undefined;
    return row ?? null;
  }

  slotListOpen(): DbSlotRow[] {
    return this.sql
      .exec(
        `SELECT s.*, e.display_title AS current_entity_title
         FROM slots s
         LEFT JOIN entities e ON s.current_entity_id = e.id
         WHERE s.closed_at IS NULL
         ORDER BY s.position_id, s.created_at, s.slot_id`
      )
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

  /**
   * Upsert the slot-static search metadata for a panel and stamp the initial
   * title onto the slot's current entity (the canonical title store).
   * Returns the slot's current entity id when one is bound, so callers (the
   * workspace-state RPC handler) can refresh their entity-keyed caches.
   */
  panelIndex(input: IndexablePanel): string | null {
    const now = Date.now();
    let resolvedEntityId: string | null = null;
    this.ctx.storage.transactionSync(() => {
      const trimmedTitle = typeof input.title === "string" ? input.title.trim() : "";
      const slot = this.sql
        .exec(`SELECT current_entity_id FROM slots WHERE slot_id = ?`, input.id)
        .toArray()[0];
      const entityIdFromSlot = slot?.["current_entity_id"];
      const currentTitle =
        typeof entityIdFromSlot === "string" && entityIdFromSlot.length > 0
          ? ((this.sql
              .exec(`SELECT display_title FROM entities WHERE id = ?`, entityIdFromSlot)
              .toArray()[0]?.["display_title"] as string | null | undefined) ?? "")
          : "";
      const ftsTitle = trimmedTitle.length > 0 ? trimmedTitle : currentTitle;

      const existing = this.sql
        .exec(`SELECT rowid FROM panel_search_metadata WHERE slot_id = ?`, input.id)
        .toArray()[0];
      if (existing) {
        this.sql.exec(
          `UPDATE panel_search_metadata SET
            searchable_title = ?, searchable_path = ?, manifest_description = ?,
            manifest_dependencies = ?, tags = ?, keywords = ?, last_indexed_at = ?
          WHERE slot_id = ?`,
          ftsTitle,
          input.path ?? null,
          input.manifestDescription ?? null,
          input.manifestDependencies ? JSON.stringify(input.manifestDependencies) : null,
          input.tags ? JSON.stringify(input.tags) : null,
          input.keywords ? JSON.stringify(input.keywords) : null,
          now,
          input.id
        );
      } else {
        this.sql.exec(
          `INSERT INTO panel_search_metadata (
            slot_id, searchable_title, searchable_path, manifest_description,
            manifest_dependencies, tags, keywords, access_count, last_indexed_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)`,
          input.id,
          ftsTitle,
          input.path ?? null,
          input.manifestDescription ?? null,
          input.manifestDependencies ? JSON.stringify(input.manifestDependencies) : null,
          input.tags ? JSON.stringify(input.tags) : null,
          input.keywords ? JSON.stringify(input.keywords) : null,
          now
        );
      }
      // The canonical title lives on the entity row. Stamp the manifest
      // title there so approval UIs (which look up by entity id) and the
      // FTS denormalization above agree from the moment the panel exists.
      if (
        trimmedTitle.length > 0 &&
        typeof entityIdFromSlot === "string" &&
        entityIdFromSlot.length > 0
      ) {
        this.sql.exec(
          `UPDATE entities SET display_title = ? WHERE id = ?`,
          trimmedTitle,
          entityIdFromSlot
        );
        resolvedEntityId = entityIdFromSlot;
      }
    });
    return resolvedEntityId;
  }

  /**
   * Update a panel's title by slot id. The shell-side `searchIndex.updateTitle`
   * API is keyed by slot id (the caller never has the per-entity id at hand),
   * so this is the surface that bridges to the entity-keyed source of truth.
   *
   * Resolves the slot's current entity and delegates to
   * `entitySetDisplayTitle`. Returns the resolved entity id (or null when
   * the slot is empty / closed) so callers can mirror the change into their
   * entity-keyed caches without a second round-trip.
   */
  panelUpdateTitle(slotId: string, title: string): string | null {
    const row = this.sql
      .exec(`SELECT current_entity_id FROM slots WHERE slot_id = ?`, slotId)
      .toArray()[0];
    const entityId = row?.["current_entity_id"];
    if (typeof entityId !== "string" || entityId.length === 0) return null;
    this.entitySetDisplayTitle(entityId, title);
    return entityId;
  }

  panelIncrementAccess(entityId: string): void {
    this.sql.exec(
      `UPDATE panel_search_metadata SET access_count = access_count + 1 WHERE slot_id = ?`,
      entityId
    );
  }

  /**
   * Set the display title for an entity. This is the canonical write site
   * for titles — both `entities.display_title` (the source of truth) and
   * the FTS denormalization in `panel_search_metadata.searchable_title`
   * (for panel entities that are currently bound to a slot) are updated in
   * one transaction.
   *
   * Pass null or an empty string to clear the entity title; we keep the
   * FTS staging row's title alone in that case (rather than blanking it) so
   * the panel stays findable in search.
   */
  entitySetDisplayTitle(entityId: string, title: string | null): void {
    const normalized = typeof title === "string" ? title.trim() : "";
    const stored = normalized.length > 0 ? normalized : null;
    this.ctx.storage.transactionSync(() => {
      this.sql.exec(`UPDATE entities SET display_title = ? WHERE id = ?`, stored, entityId);
      if (stored === null) return;
      const slot = this.sql
        .exec(
          `SELECT slot_id FROM slots WHERE current_entity_id = ? AND closed_at IS NULL`,
          entityId
        )
        .toArray()[0];
      if (slot && typeof slot["slot_id"] === "string") {
        this.sql.exec(
          `UPDATE panel_search_metadata SET searchable_title = ?, last_indexed_at = ? WHERE slot_id = ?`,
          stored,
          Date.now(),
          slot["slot_id"]
        );
      }
    });
  }

  /**
   * Return every active entity that has a non-empty display_title. Used to
   * seed the server-side in-process cache at boot so synchronous title
   * lookups (e.g. when building a pending approval) don't have to round-trip
   * to the DO on the hot path.
   */
  entityListDisplayTitles(): Array<{ id: string; title: string }> {
    return this.sql
      .exec(
        `SELECT id, display_title
         FROM entities
         WHERE status = 'active' AND display_title IS NOT NULL AND display_title != ''`
      )
      .toArray() as Array<{ id: string; title: string }>;
  }

  /**
   * Pull the current title from the slot's current entity into the FTS
   * staging column. Used when history navigation swaps the current entity
   * (the new entity may have a different display_title). No-op when the
   * slot has no metadata row or no current entity.
   */
  private refreshSlotSearchableTitle(slotId: string): void {
    const row = this.sql
      .exec(
        `SELECT e.display_title AS title
         FROM slots s
         JOIN entities e ON s.current_entity_id = e.id
         WHERE s.slot_id = ?`,
        slotId
      )
      .toArray()[0] as { title: string | null } | undefined;
    if (!row) return;
    const title = (row.title ?? "").toString();
    this.sql.exec(
      `UPDATE panel_search_metadata SET searchable_title = ?, last_indexed_at = ? WHERE slot_id = ?`,
      title,
      Date.now(),
      slotId
    );
  }

  panelSearch(query: string, limit = 50): PanelSearchResult[] {
    const safeQuery = this.sanitizeSearchQuery(query);
    if (!safeQuery) return [];
    // The displayable title is sourced from entities.display_title (the
    // canonical store) via the slot's current_entity_id. The FTS index
    // itself is built over panel_search_metadata.searchable_title, which is
    // a denormalization maintained by entitySetDisplayTitle.
    const rows = this.sql
      .exec(
        `SELECT m.slot_id AS id,
                COALESCE(e.display_title, m.searchable_title) AS title,
                m.access_count AS access_count,
                bm25(panel_fts) AS relevance
         FROM panel_fts
         JOIN panel_search_metadata m ON panel_fts.rowid = m.rowid
         JOIN slots s ON m.slot_id = s.slot_id
         LEFT JOIN entities e ON s.current_entity_id = e.id
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
    this.ctx.storage.transactionSync(() => {
      this.sql.exec(`DELETE FROM panel_search_metadata`);
      // Rebuild from open slots + their current entity. Title is sourced
      // from entities.display_title; when no title was ever stamped (panel
      // existed before this feature, or the agent never called set_title)
      // we backfill from stateArgs.title → entity key → slot id, then
      // mirror that into the FTS staging column.
      const rows = this.sql
        .exec(
          `SELECT s.slot_id AS slot_id, e.id AS entity_id, e.state_args AS state_args,
                  e.source_repo_path AS source_repo_path, e.key AS key,
                  e.display_title AS display_title
           FROM slots s
           LEFT JOIN entities e ON s.current_entity_id = e.id
           WHERE s.closed_at IS NULL`
        )
        .toArray() as Array<{
        slot_id: string;
        entity_id: string | null;
        state_args: string | null;
        source_repo_path: string | null;
        key: string | null;
        display_title: string | null;
      }>;
      const now = Date.now();
      for (const row of rows) {
        let title: string = row.display_title ?? "";
        if (!title && row.entity_id) {
          // Backfill a best-effort title onto the entity row.
          if (row.state_args) {
            try {
              const args = JSON.parse(row.state_args) as { title?: string };
              if (typeof args?.title === "string" && args.title.trim().length > 0) {
                title = args.title;
              }
            } catch {
              // ignore — fall through to other fallbacks
            }
          }
          if (!title) title = row.key || row.slot_id;
          this.sql.exec(`UPDATE entities SET display_title = ? WHERE id = ?`, title, row.entity_id);
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
    });
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

  private createLifecycleTables(): void {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS lifecycle_epochs (
        epoch_id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        reason TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        generation INTEGER NOT NULL,
        status TEXT NOT NULL
      )
    `);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS lifecycle_leases (
        source TEXT NOT NULL,
        class_name TEXT NOT NULL,
        object_key TEXT NOT NULL,
        detail TEXT,
        created_at INTEGER NOT NULL,
        refreshed_at INTEGER NOT NULL,
        PRIMARY KEY (source, class_name, object_key)
      )
    `);
    this.sql.exec(
      `CREATE INDEX IF NOT EXISTS idx_lifecycle_leases_refreshed ON lifecycle_leases(refreshed_at)`
    );
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS lifecycle_ops (
        epoch_id TEXT NOT NULL,
        source TEXT NOT NULL,
        class_name TEXT NOT NULL,
        object_key TEXT NOT NULL,
        op_kind TEXT NOT NULL,
        status TEXT NOT NULL,
        detail TEXT,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (epoch_id, source, class_name, object_key, op_kind)
      )
    `);
    this.sql.exec(
      `CREATE INDEX IF NOT EXISTS idx_lifecycle_ops_resume
       ON lifecycle_ops(op_kind, status, source, class_name, object_key)`
    );
    // Durable DO alarm schedule. workerd does not implement alarms for
    // SQLite-backed DOs (and never for facets), so the server drives them: a DO
    // registers its wake time here, and the AlarmDriver fires `__alarm` on
    // schedule. Survives server/workerd restart (durable WorkspaceDO storage).
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS do_alarms (
        source TEXT NOT NULL,
        class_name TEXT NOT NULL,
        object_key TEXT NOT NULL,
        wake_at INTEGER NOT NULL,
        PRIMARY KEY (source, class_name, object_key)
      )
    `);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_do_alarms_wake ON do_alarms(wake_at)`);
  }

  private insertLifecycleOp(
    epochId: string,
    key: LifecycleKey,
    opKind: "prepare" | "resume",
    status: LifecycleOpInput["status"],
    detail: string | null,
    updatedAt: number
  ): void {
    this.sql.exec(
      `INSERT INTO lifecycle_ops (
        epoch_id, source, class_name, object_key, op_kind, status, detail, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(epoch_id, source, class_name, object_key, op_kind) DO UPDATE SET
        status = excluded.status,
        detail = excluded.detail,
        updated_at = excluded.updated_at`,
      epochId,
      key.source,
      key.className,
      key.objectKey,
      opKind,
      status,
      detail,
      updatedAt
    );
  }

  private assertLifecycleKey(key: LifecycleKey): void {
    if (!key.source || !key.className || !key.objectKey) {
      throw new Error("lifecycle key requires source, className, and objectKey");
    }
  }

  private parseJsonOrNull(value: string | null): unknown | null {
    if (value === null) return null;
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }

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
