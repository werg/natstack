import {
  DurableObjectBase,
  type DurableObjectContext,
} from "../../../workspace/packages/runtime/src/worker/durable-base.js";
import type { Panel, PanelSnapshot, PanelSummary } from "../../../packages/shared/src/types.js";
import type {
  AppendPanelOpResult,
  AppendPanelOpsResult,
  IndexablePanel,
  PanelContext,
  PanelOpsSinceResult,
  PanelSearchResult,
  PanelSnapshotResult,
  PersistedPanelOp,
  SubmittedPanelOp,
} from "../../../packages/shared/src/panelOpsTypes.js";
import {
  between as rankBetween,
  first as firstRank,
} from "../../../packages/shared/src/lexorank.js";
import { assertPresent } from "../../lintHelpers";

interface DbPanelRow {
  id: string;
  title: string;
  workspace_id: string;
  parent_id: string | null;
  position_id: string;
  position_actor_id: string;
  position_op_id: string;
  created_at: number;
  updated_at: number;
  snapshot: string;
  history: string | null;
  history_index: number | null;
  archived_at: number | null;
  archived_by: string | null;
}

class PanelOpsRejected extends Error {
  constructor(readonly rejectedOps: Array<{ opId: string; reason: string }>) {
    super("Panel ops rejected");
  }
}

export class PanelStoreDO extends DurableObjectBase {
  static override schemaVersion = 6;

  constructor(ctx: DurableObjectContext, env: unknown) {
    super(ctx, env);
    this.ensureReady();
  }

  protected createTables(): void {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS panels (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        parent_id TEXT REFERENCES panels(id),
        position_id TEXT NOT NULL DEFAULT '000001000000',
        position_actor_id TEXT NOT NULL DEFAULT '',
        position_op_id TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        snapshot TEXT NOT NULL,
        history TEXT NOT NULL,
        history_index INTEGER NOT NULL DEFAULT 0,
        archived_at INTEGER DEFAULT NULL,
        archived_by TEXT DEFAULT NULL
      )
    `);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_panels_parent ON panels(parent_id)`);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_panels_workspace ON panels(workspace_id)`);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS panel_search_metadata (
        panel_id TEXT PRIMARY KEY REFERENCES panels(id),
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
      CREATE TABLE IF NOT EXISTS panel_ops (
        revision INTEGER PRIMARY KEY,
        op_id TEXT NOT NULL UNIQUE,
        actor_id TEXT NOT NULL,
        ts INTEGER NOT NULL,
        type TEXT NOT NULL,
        payload TEXT NOT NULL
      )
    `);
    this.sql.exec(
      `CREATE INDEX IF NOT EXISTS idx_panel_ops_actor ON panel_ops(actor_id, revision)`
    );
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS workspace_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
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
  }

  protected override migrate(fromVersion: number, toVersion: number): void {
    void toVersion;
    if (fromVersion === 0) return;
    if (fromVersion < 3 && this.hasPanelColumn("history") && this.hasPanelColumn("position")) {
      this.sql.exec(`ALTER TABLE panels RENAME TO panels_old`);
      this.sql.exec(`
        CREATE TABLE panels (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          workspace_id TEXT NOT NULL,
          parent_id TEXT REFERENCES panels(id),
          position_id TEXT NOT NULL DEFAULT '000001000000',
          position_actor_id TEXT NOT NULL DEFAULT '',
          position_op_id TEXT NOT NULL DEFAULT '',
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          snapshot TEXT NOT NULL,
          history TEXT NOT NULL,
          history_index INTEGER NOT NULL DEFAULT 0,
          archived_at INTEGER DEFAULT NULL,
          archived_by TEXT DEFAULT NULL
        )
      `);
      this.sql.exec(`
        INSERT INTO panels (
          id, title, workspace_id, parent_id, position_id, position_actor_id, position_op_id,
          created_at, updated_at, snapshot, history, history_index, archived_at, archived_by
        )
        SELECT
          id, title, workspace_id, parent_id, printf('%012d', (position + 1) * 1000000), '', '',
          created_at, updated_at,
          json_extract(history, '$[' || history_index || ']'),
          history,
          history_index,
          archived_at, NULL
        FROM panels_old
      `);
      this.sql.exec(`DROP TABLE panels_old`);
      this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_panels_parent ON panels(parent_id)`);
      this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_panels_workspace ON panels(workspace_id)`);
    }
    if (fromVersion < 4 && this.hasPanelColumn("position")) {
      this.sql.exec(`ALTER TABLE panels RENAME TO panels_old`);
      this.sql.exec(`
        CREATE TABLE panels (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          workspace_id TEXT NOT NULL,
          parent_id TEXT REFERENCES panels(id),
          position_id TEXT NOT NULL DEFAULT '000001000000',
          position_actor_id TEXT NOT NULL DEFAULT '',
          position_op_id TEXT NOT NULL DEFAULT '',
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          snapshot TEXT NOT NULL,
          history TEXT NOT NULL,
          history_index INTEGER NOT NULL DEFAULT 0,
          archived_at INTEGER DEFAULT NULL,
          archived_by TEXT DEFAULT NULL
        )
      `);
      this.sql.exec(`
        INSERT INTO panels (
          id, title, workspace_id, parent_id, position_id, position_actor_id, position_op_id,
          created_at, updated_at, snapshot, history, history_index, archived_at, archived_by
        )
        SELECT
          id, title, workspace_id, parent_id, printf('%012d', (position + 1) * 1000000),
          '', '', created_at, updated_at, snapshot, json_array(snapshot), 0, archived_at, NULL
        FROM panels_old
      `);
      this.sql.exec(`DROP TABLE panels_old`);
      this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_panels_parent ON panels(parent_id)`);
      this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_panels_workspace ON panels(workspace_id)`);
    }
    if (fromVersion < 5 && !this.hasPanelColumn("archived_by")) {
      this.sql.exec(`ALTER TABLE panels ADD COLUMN archived_by TEXT DEFAULT NULL`);
    }
    if (fromVersion < 6) {
      if (!this.hasPanelColumn("history")) {
        this.sql.exec(`ALTER TABLE panels ADD COLUMN history TEXT`);
        this.sql.exec(`UPDATE panels SET history = json_array(snapshot) WHERE history IS NULL`);
      }
      if (!this.hasPanelColumn("history_index")) {
        this.sql.exec(`ALTER TABLE panels ADD COLUMN history_index INTEGER NOT NULL DEFAULT 0`);
      }
    }
  }

  getWorkspaceId(): string {
    return this.objectKey;
  }

  appendOp(op: SubmittedPanelOp, actorId: string): AppendPanelOpResult {
    return this.ctx.storage.transactionSync(() => this.appendOpInTransaction(op, actorId));
  }

  appendOps(ops: SubmittedPanelOp[], actorId: string): AppendPanelOpsResult {
    try {
      return this.ctx.storage.transactionSync(() => {
        const acceptedOps: string[] = [];
        for (const op of ops) {
          const result = this.appendOpInTransaction(op, actorId);
          if (result.accepted || result.alreadyApplied) {
            acceptedOps.push(op.opId);
          } else {
            throw new PanelOpsRejected([
              { opId: op.opId, reason: result.rejectedReason ?? "UNKNOWN" },
            ]);
          }
        }
        return { acceptedOps, rejectedOps: [], revision: this.getRevision() };
      });
    } catch (error) {
      if (error instanceof PanelOpsRejected) {
        return { acceptedOps: [], rejectedOps: error.rejectedOps, revision: this.getRevision() };
      }
      throw error;
    }
  }

  getOpsSince(baseRevision: number, limit = 1000): PanelOpsSinceResult {
    const revision = this.getRevision();
    if (revision - baseRevision > 10_000) {
      return { ops: [], revision, snapshotRequired: true };
    }
    const oldest = this.sql.exec(`SELECT MIN(revision) as revision FROM panel_ops`).one() as {
      revision: number | null;
    };
    if (oldest.revision != null && baseRevision < oldest.revision - 1) {
      return { ops: [], revision, snapshotRequired: true };
    }
    const rows = this.sql
      .exec(
        `SELECT revision, op_id, actor_id, ts, type, payload
         FROM panel_ops
         WHERE revision > ?
         ORDER BY revision ASC
         LIMIT ?`,
        baseRevision,
        limit
      )
      .toArray() as Array<{
      revision: number;
      op_id: string;
      actor_id: string;
      ts: number;
      type: string;
      payload: string;
    }>;
    const ops = rows.map((row) => ({
      ...(JSON.parse(row.payload) as SubmittedPanelOp),
      actorId: row.actor_id,
      ts: row.ts,
      revision: row.revision,
    })) as PersistedPanelOp[];
    return { ops, revision };
  }

  getSnapshot(): PanelSnapshotResult {
    return { tree: this.getFullTree(), revision: this.getRevision() };
  }

  compactOps(throughRevision?: number) {
    return this.ctx.storage.transactionSync(() => {
      const revision = this.getRevision();
      const target = Math.max(0, Math.min(Math.floor(throughRevision ?? revision), revision));
      if (target > 0) {
        this.sql.exec(`DELETE FROM panel_ops WHERE revision <= ?`, target);
      }
      this.sql.exec(
        `INSERT OR REPLACE INTO workspace_meta (key, value) VALUES ('compactedThroughRevision', ?)`,
        String(target)
      );
      const retained = this.sql.exec(`SELECT COUNT(*) as count FROM panel_ops`).one() as {
        count: number;
      };
      return {
        compactedThroughRevision: target,
        retainedOps: retained.count,
        revision,
      };
    });
  }

  getRevision(): number {
    const row = this.sql
      .exec(`SELECT value FROM workspace_meta WHERE key = 'revision'`)
      .toArray()[0] as { value: string } | undefined;
    return row ? Number.parseInt(row.value, 10) || 0 : 0;
  }

  getPanel(panelId: string): Panel | null {
    const row = this.sql
      .exec(`SELECT * FROM panels WHERE id = ?`, panelId)
      .toArray()[0] as unknown as DbPanelRow | undefined;
    return row ? this.rowToPanel(row) : null;
  }

  getRootPanels(): PanelSummary[] {
    return this.summaryRows(
      `SELECT p.id, p.title, p.position_id,
        (SELECT COUNT(*) FROM panels c WHERE c.parent_id = p.id AND c.archived_at IS NULL) as child_count
       FROM panels p
       WHERE p.parent_id IS NULL AND p.workspace_id = ? AND p.archived_at IS NULL
       ORDER BY p.position_id, p.position_actor_id, p.position_op_id`,
      this.getWorkspaceId()
    );
  }

  getChildren(parentId: string): PanelSummary[] {
    return this.summaryRows(
      `SELECT p.id, p.title, p.position_id,
        (SELECT COUNT(*) FROM panels c WHERE c.parent_id = p.id AND c.archived_at IS NULL) as child_count
       FROM panels p WHERE p.parent_id = ? AND p.archived_at IS NULL
       ORDER BY p.position_id, p.position_actor_id, p.position_op_id`,
      parentId
    );
  }

  getSiblings(panelId: string): PanelSummary[] {
    return this.summaryRows(
      `SELECT p.id, p.title, p.position_id,
        (SELECT COUNT(*) FROM panels c WHERE c.parent_id = p.id AND c.archived_at IS NULL) as child_count
       FROM panels p
       WHERE p.parent_id = (SELECT parent_id FROM panels WHERE id = ?) AND p.archived_at IS NULL
       ORDER BY p.position_id, p.position_actor_id, p.position_op_id`,
      panelId
    );
  }

  getAncestors(panelId: string): PanelSummary[] {
    const rows = this.sql
      .exec(
        `WITH RECURSIVE ancestors AS (
        SELECT id, parent_id, title, 0 as depth FROM panels WHERE id = ? AND archived_at IS NULL
        UNION ALL
        SELECT p.id, p.parent_id, p.title, a.depth + 1
        FROM panels p JOIN ancestors a ON p.id = a.parent_id
        WHERE a.depth < 20 AND p.archived_at IS NULL
       )
       SELECT id, title, depth FROM ancestors WHERE depth > 0 ORDER BY depth DESC`,
        panelId
      )
      .toArray() as Array<{ id: string; title: string }>;
    return rows.map((row) => ({ id: row.id, title: row.title, childCount: 0, position: 0 }));
  }

  getPanelContext(panelId: string): PanelContext | null {
    const panel = this.getPanel(panelId);
    if (!panel) return null;
    return {
      panel,
      ancestors: this.getAncestors(panelId),
      siblings: this.getSiblings(panelId),
      children: this.getChildren(panelId),
    };
  }

  panelExists(panelId: string): boolean {
    return this.sql.exec(`SELECT 1 FROM panels WHERE id = ?`, panelId).toArray().length > 0;
  }

  getPanelCount(): number {
    const row = this.sql
      .exec(
        `SELECT COUNT(*) as count FROM panels WHERE workspace_id = ? AND archived_at IS NULL`,
        this.getWorkspaceId()
      )
      .one() as { count: number };
    return row.count;
  }

  getFullTree(): Panel[] {
    const rows = this.sql
      .exec(
        `SELECT * FROM panels WHERE workspace_id = ? AND archived_at IS NULL
         ORDER BY position_id, position_actor_id, position_op_id`,
        this.getWorkspaceId()
      )
      .toArray() as unknown as DbPanelRow[];
    const panelMap = new Map<string, Panel>();
    for (const row of rows) panelMap.set(row.id, this.rowToPanel(row));
    const roots: Panel[] = [];
    for (const row of rows) {
      const panel = assertPresent(panelMap.get(row.id));
      if (row.parent_id && panelMap.has(row.parent_id)) {
        assertPresent(panelMap.get(row.parent_id)).children.push(panel);
      } else if (!row.parent_id) {
        roots.push(panel);
      }
    }
    return roots;
  }

  getParentId(panelId: string): string | null {
    const row = this.sql.exec(`SELECT parent_id FROM panels WHERE id = ?`, panelId).toArray()[0] as
      | { parent_id: string | null }
      | undefined;
    return row?.parent_id ?? null;
  }

  isArchived(panelId: string): boolean {
    const row = this.sql
      .exec(`SELECT archived_at FROM panels WHERE id = ?`, panelId)
      .toArray()[0] as { archived_at: number | null } | undefined;
    return row?.archived_at != null;
  }

  indexPanel(panel: IndexablePanel): void {
    const now = Date.now();
    const existing = this.sql
      .exec(`SELECT rowid FROM panel_search_metadata WHERE panel_id = ?`, panel.id)
      .toArray()[0];
    if (existing) {
      this.sql.exec(
        `UPDATE panel_search_metadata SET
          searchable_title = ?, searchable_path = ?, manifest_description = ?,
          manifest_dependencies = ?, tags = ?, keywords = ?, last_indexed_at = ?
        WHERE panel_id = ?`,
        panel.title,
        panel.path ?? null,
        panel.manifestDescription ?? null,
        panel.manifestDependencies ? JSON.stringify(panel.manifestDependencies) : null,
        panel.tags ? JSON.stringify(panel.tags) : null,
        panel.keywords ? JSON.stringify(panel.keywords) : null,
        now,
        panel.id
      );
      return;
    }
    this.sql.exec(
      `INSERT INTO panel_search_metadata (
        panel_id, searchable_title, searchable_path, manifest_description,
        manifest_dependencies, tags, keywords, access_count, last_indexed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)`,
      panel.id,
      panel.title,
      panel.path ?? null,
      panel.manifestDescription ?? null,
      panel.manifestDependencies ? JSON.stringify(panel.manifestDependencies) : null,
      panel.tags ? JSON.stringify(panel.tags) : null,
      panel.keywords ? JSON.stringify(panel.keywords) : null,
      now
    );
  }

  search(query: string, limit = 50): PanelSearchResult[] {
    const safeQuery = this.sanitizeQuery(query);
    if (!safeQuery) return [];
    const rows = this.sql
      .exec(
        `SELECT p.id, p.title, m.access_count, bm25(panel_fts) as relevance
       FROM panel_fts
       JOIN panel_search_metadata m ON panel_fts.rowid = m.rowid
       JOIN panels p ON m.panel_id = p.id
       WHERE panel_fts MATCH ? AND p.workspace_id = ? AND p.archived_at IS NULL
       ORDER BY relevance, m.access_count DESC
       LIMIT ?`,
        safeQuery,
        this.getWorkspaceId(),
        limit
      )
      .toArray() as Array<{ id: string; title: string; access_count: number; relevance: number }>;
    return rows.map((row) => ({
      id: row.id,
      title: row.title,
      relevance: row.relevance,
      accessCount: row.access_count,
    }));
  }

  incrementAccessCount(panelId: string): void {
    this.sql.exec(
      `UPDATE panel_search_metadata SET access_count = access_count + 1 WHERE panel_id = ?`,
      panelId
    );
  }

  updateSearchTitle(panelId: string, title: string): void {
    this.sql.exec(
      `UPDATE panel_search_metadata SET searchable_title = ?, last_indexed_at = ? WHERE panel_id = ?`,
      title,
      Date.now(),
      panelId
    );
  }

  rebuildIndex(): void {
    const rows = this.sql
      .exec(
        `SELECT * FROM panels WHERE workspace_id = ? AND archived_at IS NULL`,
        this.getWorkspaceId()
      )
      .toArray() as unknown as DbPanelRow[];
    this.sql.exec(
      `DELETE FROM panel_search_metadata WHERE panel_id IN (SELECT id FROM panels WHERE workspace_id = ?)`,
      this.getWorkspaceId()
    );
    for (const row of rows) {
      const current = JSON.parse(row.snapshot) as { source?: string };
      this.indexPanel({ id: row.id, title: row.title, path: current?.source });
    }
  }

  private appendOpInTransaction(op: SubmittedPanelOp, actorId: string): AppendPanelOpResult {
    if (!op.opId || !op.type || !actorId) {
      return { accepted: false, revision: this.getRevision(), rejectedReason: "MALFORMED" };
    }

    const existing = this.sql
      .exec(`SELECT revision FROM panel_ops WHERE op_id = ?`, op.opId)
      .toArray()[0] as { revision: number } | undefined;
    if (existing) {
      return { accepted: false, alreadyApplied: true, revision: existing.revision };
    }

    const ts = Date.now();
    const validation = this.validateOp(op);
    if (!validation.ok) {
      return { accepted: false, revision: this.getRevision(), rejectedReason: validation.reason };
    }

    const revision = this.getRevision() + 1;
    this.sql.exec(
      `INSERT INTO panel_ops (revision, op_id, actor_id, ts, type, payload)
       VALUES (?, ?, ?, ?, ?, ?)`,
      revision,
      op.opId,
      actorId,
      ts,
      op.type,
      JSON.stringify(op)
    );
    this.applyOp(op, ts, actorId);
    this.sql.exec(
      `INSERT OR REPLACE INTO workspace_meta (key, value) VALUES ('revision', ?)`,
      String(revision)
    );
    return { accepted: true, revision };
  }

  private validateOp(op: SubmittedPanelOp): { ok: true } | { ok: false; reason: string } {
    switch (op.type) {
      case "panel.create":
        if (this.panelExists(op.panelId)) return { ok: false, reason: "EXISTS" };
        if (!this.isValidSnapshot(op.snapshot)) return { ok: false, reason: "MALFORMED_SNAPSHOT" };
        if (!this.isValidPositionId(op.positionId))
          return { ok: false, reason: "MALFORMED_POSITION" };
        if (op.parentId && !this.panelExists(op.parentId)) {
          return { ok: false, reason: "STALE_PARENT" };
        }
        return { ok: true };
      case "panel.archive":
      case "panel.restore":
        if (!this.panelExists(op.panelId)) return { ok: false, reason: "NOT_FOUND" };
        return { ok: true };
      case "panel.move":
        if (!this.panelExists(op.panelId)) return { ok: false, reason: "NOT_FOUND" };
        if (this.isArchived(op.panelId)) return { ok: false, reason: "ARCHIVED" };
        if (!this.isValidPositionId(op.positionId))
          return { ok: false, reason: "MALFORMED_POSITION" };
        if (op.parentId && !this.panelExists(op.parentId)) {
          return { ok: false, reason: "STALE_PARENT" };
        }
        return { ok: true };
      case "panel.setSnapshot":
        if (!this.panelExists(op.panelId)) return { ok: false, reason: "NOT_FOUND" };
        if (this.isArchived(op.panelId)) return { ok: false, reason: "ARCHIVED" };
        if (!this.isValidSnapshot(op.snapshot)) return { ok: false, reason: "MALFORMED_SNAPSHOT" };
        if (op.history && !this.isValidHistory(op.history)) {
          return { ok: false, reason: "MALFORMED_HISTORY" };
        }
        return { ok: true };
      case "panel.setTitle":
        if (!this.panelExists(op.panelId)) return { ok: false, reason: "NOT_FOUND" };
        if (this.isArchived(op.panelId)) return { ok: false, reason: "ARCHIVED" };
        return { ok: true };
    }
  }

  private applyOp(op: SubmittedPanelOp, ts: number, actorId: string): void {
    switch (op.type) {
      case "panel.create":
        this.sql.exec(
          `INSERT INTO panels (
            id, title, workspace_id, parent_id, position_id, position_actor_id, position_op_id,
            created_at, updated_at, snapshot, history, history_index
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          op.panelId,
          op.title,
          this.getWorkspaceId(),
          op.parentId,
          op.positionId,
          actorId,
          op.opId,
          ts,
          ts,
          JSON.stringify(op.snapshot),
          JSON.stringify([op.snapshot]),
          0
        );
        return;
      case "panel.archive":
        this.sql.exec(
          `WITH RECURSIVE subtree(id) AS (
             SELECT id FROM panels WHERE id = ?
             UNION ALL
             SELECT p.id FROM panels p JOIN subtree s ON p.parent_id = s.id
           )
           UPDATE panels
           SET archived_at = ?, archived_by = ?, updated_at = ?
           WHERE id IN (SELECT id FROM subtree)`,
          op.panelId,
          ts,
          actorId,
          ts
        );
        return;
      case "panel.restore": {
        const row = this.requireRow(op.panelId);
        const parentUnavailable =
          row.parent_id != null &&
          !this.sql
            .exec(`SELECT 1 FROM panels WHERE id = ? AND archived_at IS NULL`, row.parent_id)
            .toArray()[0];
        if (parentUnavailable) {
          const positionId = this.rankForPosition(null, this.getRootPanels().length, op.panelId);
          this.sql.exec(
            `UPDATE panels
             SET parent_id = NULL, position_id = ?, position_actor_id = ?, position_op_id = ?,
                 archived_at = NULL, archived_by = NULL, updated_at = ?
             WHERE id = ?`,
            positionId,
            actorId,
            op.opId,
            ts,
            op.panelId
          );
          return;
        }
        this.sql.exec(
          `UPDATE panels SET archived_at = NULL, archived_by = NULL, updated_at = ? WHERE id = ?`,
          ts,
          op.panelId
        );
        return;
      }
      case "panel.move": {
        const currentRow = this.requireRow(op.panelId);
        const oldParentId = currentRow.parent_id;
        this.sql.exec(
          `UPDATE panels SET parent_id = ?, position_id = ?, position_actor_id = ?, position_op_id = ?, updated_at = ? WHERE id = ?`,
          op.parentId,
          op.positionId,
          actorId,
          op.opId,
          ts,
          op.panelId
        );
        void oldParentId;
        return;
      }
      case "panel.setTitle":
        this.sql.exec(
          `UPDATE panels SET title = ?, updated_at = ? WHERE id = ?`,
          op.title,
          ts,
          op.panelId
        );
        return;
      case "panel.setSnapshot": {
        const history = this.normalizeHistory(
          op.history ?? { entries: [op.snapshot], index: 0 },
          op.snapshot
        );
        this.sql.exec(
          `UPDATE panels SET snapshot = ?, history = ?, history_index = ?, updated_at = ? WHERE id = ?`,
          JSON.stringify(op.snapshot),
          JSON.stringify(history.entries),
          history.index,
          ts,
          op.panelId
        );
        return;
      }
    }
  }

  private hasPanelColumn(columnName: string): boolean {
    const rows = this.sql.exec(`PRAGMA table_info(panels)`).toArray() as Array<{ name: string }>;
    return rows.some((row) => row.name === columnName);
  }

  private rankForPosition(
    parentId: string | null,
    targetPosition: number,
    excludePanelId?: string
  ): string {
    const rows = this.sql
      .exec(
        `SELECT id, position_id FROM panels
         WHERE (parent_id = ? OR (parent_id IS NULL AND ? IS NULL))
           AND workspace_id = ?
           AND archived_at IS NULL
         ORDER BY position_id, position_actor_id, position_op_id`,
        parentId,
        parentId,
        this.getWorkspaceId()
      )
      .toArray() as Array<{ id: string; position_id: string }>;
    const siblings = excludePanelId ? rows.filter((row) => row.id !== excludePanelId) : rows;
    if (siblings.length === 0) return firstRank();
    const clamped = Math.max(0, Math.min(targetPosition, siblings.length));
    return rankBetween(siblings[clamped - 1]?.position_id, siblings[clamped]?.position_id);
  }

  private summaryRows(sql: string, ...args: unknown[]): PanelSummary[] {
    const rows = this.sql.exec(sql, ...args).toArray() as Array<{
      id: string;
      title: string;
      position_id: string;
      child_count: number;
    }>;
    return rows.map((row, index) => ({
      id: row.id,
      title: row.title,
      childCount: row.child_count,
      position: index,
    }));
  }

  private rowToPanel(row: DbPanelRow): Panel {
    const snapshot = JSON.parse(row.snapshot) as PanelSnapshot;
    const history = this.normalizeHistory(
      row.history
        ? { entries: JSON.parse(row.history) as PanelSnapshot[], index: row.history_index ?? 0 }
        : undefined,
      snapshot
    );
    return {
      id: row.id,
      title: row.title,
      children: [],
      positionId: row.position_id,
      snapshot,
      history,
      artifacts: {},
    };
  }

  private requireRow(panelId: string): DbPanelRow {
    const row = this.sql
      .exec(`SELECT * FROM panels WHERE id = ?`, panelId)
      .toArray()[0] as unknown as DbPanelRow | undefined;
    if (!row) throw new Error(`Panel ${panelId} not found`);
    return row;
  }

  private isValidSnapshot(value: unknown): value is PanelSnapshot {
    const snapshot = value as Partial<PanelSnapshot> | null;
    return Boolean(
      snapshot &&
      typeof snapshot === "object" &&
      typeof snapshot.source === "string" &&
      typeof snapshot.contextId === "string" &&
      snapshot.options &&
      typeof snapshot.options === "object"
    );
  }

  private isValidPositionId(value: unknown): value is string {
    return typeof value === "string" && value.length > 0 && value.length <= 128;
  }

  private isValidHistory(value: unknown): value is NonNullable<Panel["history"]> {
    const history = value as Partial<NonNullable<Panel["history"]>> | null;
    if (!history || !Array.isArray(history.entries)) return false;
    if (!Number.isInteger(history.index)) return false;
    const index = history.index;
    if (history.entries.length === 0) return false;
    if (index == null || index < 0 || index >= history.entries.length) return false;
    if (!history.entries.every((entry) => this.isValidSnapshot(entry))) return false;
    return true;
  }

  private normalizeHistory(
    history: NonNullable<Panel["history"]> | undefined,
    currentSnapshot: PanelSnapshot
  ): NonNullable<Panel["history"]> {
    if (!this.isValidHistory(history)) {
      return { entries: [currentSnapshot], index: 0 };
    }
    const current = history.entries[history.index];
    if (JSON.stringify(current) !== JSON.stringify(currentSnapshot)) {
      const entries = history.entries.slice();
      entries[history.index] = currentSnapshot;
      return { entries, index: history.index };
    }
    return history;
  }

  private sanitizeQuery(query: string): string {
    const trimmed = query.trim();
    if (!trimmed) return "";
    const escaped = trimmed.replace(/["*():^]/g, " ").trim();
    return escaped.includes(" ") ? `"${escaped}"` : escaped;
  }
}
