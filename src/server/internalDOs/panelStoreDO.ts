import {
  DurableObjectBase,
  type DurableObjectContext,
} from "../../../workspace/packages/runtime/src/worker/durable-base.js";
import type { Panel, PanelSnapshot, PanelSummary } from "../../../packages/shared/src/types.js";
import type {
  CreatePanelInput,
  IndexablePanel,
  PanelContext,
  PanelSearchResult,
  UpdatePanelInput,
} from "../../../packages/shared/src/panelPersistenceTypes.js";

interface DbPanelRow {
  id: string;
  title: string;
  workspace_id: string;
  parent_id: string | null;
  position: number;
  selected_child_id: string | null;
  created_at: number;
  updated_at: number;
  history: string;
  history_index: number;
  archived_at: number | null;
}

export class PanelStoreDO extends DurableObjectBase {
  static override schemaVersion = 1;

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
        position INTEGER NOT NULL DEFAULT 0,
        selected_child_id TEXT,
        collapsed INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        history TEXT NOT NULL,
        history_index INTEGER NOT NULL DEFAULT 0,
        archived_at INTEGER DEFAULT NULL
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

  getWorkspaceId(): string {
    return this.objectKey;
  }

  createPanel(input: CreatePanelInput): void {
    const now = Date.now();
    this.shiftSiblingPositions(input.parentId, 0, now);
    this.sql.exec(
      `INSERT INTO panels (
        id, title, workspace_id, parent_id, position, selected_child_id,
        created_at, updated_at, history, history_index
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      input.id,
      input.title,
      this.getWorkspaceId(),
      input.parentId,
      0,
      null,
      now,
      now,
      JSON.stringify([input.snapshot]),
      0
    );
  }

  getPanel(panelId: string): Panel | null {
    const row = this.sql
      .exec(`SELECT * FROM panels WHERE id = ?`, panelId)
      .toArray()[0] as unknown as DbPanelRow | undefined;
    return row ? this.rowToPanel(row) : null;
  }

  getRootPanels(): PanelSummary[] {
    return this.summaryRows(
      `SELECT p.id, p.title, p.position,
        (SELECT COUNT(*) FROM panels c WHERE c.parent_id = p.id AND c.archived_at IS NULL) as child_count
       FROM panels p
       WHERE p.parent_id IS NULL AND p.workspace_id = ? AND p.archived_at IS NULL
       ORDER BY p.position`,
      this.getWorkspaceId()
    );
  }

  getChildren(parentId: string): PanelSummary[] {
    return this.summaryRows(
      `SELECT p.id, p.title, p.position,
        (SELECT COUNT(*) FROM panels c WHERE c.parent_id = p.id AND c.archived_at IS NULL) as child_count
       FROM panels p WHERE p.parent_id = ? AND p.archived_at IS NULL
       ORDER BY p.position`,
      parentId
    );
  }

  getSiblings(panelId: string): PanelSummary[] {
    return this.summaryRows(
      `SELECT p.id, p.title, p.position,
        (SELECT COUNT(*) FROM panels c WHERE c.parent_id = p.id AND c.archived_at IS NULL) as child_count
       FROM panels p
       WHERE p.parent_id = (SELECT parent_id FROM panels WHERE id = ?) AND p.archived_at IS NULL
       ORDER BY p.position`,
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

  updatePanel(panelId: string, input: UpdatePanelInput): void {
    const updates = ["updated_at = ?"];
    const params: unknown[] = [Date.now()];
    if (input.selectedChildId !== undefined) {
      updates.push("selected_child_id = ?");
      params.push(input.selectedChildId);
    }
    if (input.parentId !== undefined) {
      updates.push("parent_id = ?");
      params.push(input.parentId);
    }
    if (input.snapshot !== undefined) {
      updates.push("history = ?", "history_index = ?");
      const row = this.requireRow(panelId);
      const history = this.parseHistory(row);
      const historyIndex = this.normalizeHistoryIndex(row, history);
      history[historyIndex] = input.snapshot;
      params.push(JSON.stringify(history), historyIndex);
    }
    params.push(panelId);
    this.sql.exec(`UPDATE panels SET ${updates.join(", ")} WHERE id = ?`, ...params);
  }

  pushHistorySnapshot(panelId: string, snapshot: PanelSnapshot): void {
    const row = this.requireRow(panelId);
    const history = this.parseHistory(row);
    const historyIndex = this.normalizeHistoryIndex(row, history);
    const nextHistory = history.slice(0, historyIndex + 1);
    nextHistory.push(snapshot);
    this.sql.exec(
      `UPDATE panels SET history = ?, history_index = ?, updated_at = ? WHERE id = ?`,
      JSON.stringify(nextHistory),
      nextHistory.length - 1,
      Date.now(),
      panelId
    );
  }

  navigateHistory(panelId: string, delta: -1 | 1): Panel | null {
    const row = this.requireRow(panelId);
    const history = this.parseHistory(row);
    const historyIndex = this.normalizeHistoryIndex(row, history);
    const nextIndex = Math.max(0, Math.min(history.length - 1, historyIndex + delta));
    if (nextIndex !== historyIndex) {
      this.sql.exec(
        `UPDATE panels SET history_index = ?, updated_at = ? WHERE id = ?`,
        nextIndex,
        Date.now(),
        panelId
      );
    }
    const nextRow = { ...row, history_index: nextIndex };
    return this.rowToPanel(nextRow);
  }

  setSelectedChild(panelId: string, childId: string | null): void {
    this.sql.exec(
      `UPDATE panels SET selected_child_id = ?, updated_at = ? WHERE id = ?`,
      childId,
      Date.now(),
      panelId
    );
  }

  updateSelectedPath(focusedPanelId: string): void {
    const now = Date.now();
    const visited = new Set<string>();
    let currentId: string | null = focusedPanelId;
    for (let depth = 0; currentId && depth < 100; depth++) {
      if (visited.has(currentId)) break;
      visited.add(currentId);
      const row = this.sql
        .exec(`SELECT parent_id FROM panels WHERE id = ?`, currentId)
        .toArray()[0] as { parent_id: string | null } | undefined;
      if (!row) break;
      if (row.parent_id) {
        this.sql.exec(
          `UPDATE panels SET selected_child_id = ?, updated_at = ? WHERE id = ?`,
          currentId,
          now,
          row.parent_id
        );
      }
      currentId = row.parent_id;
    }
  }

  setTitle(panelId: string, title: string): void {
    this.sql.exec(
      `UPDATE panels SET title = ?, updated_at = ? WHERE id = ?`,
      title,
      Date.now(),
      panelId
    );
  }

  movePanel(panelId: string, newParentId: string | null, targetPosition: number): void {
    const currentRow = this.sql
      .exec(`SELECT parent_id FROM panels WHERE id = ?`, panelId)
      .toArray()[0] as { parent_id: string | null } | undefined;
    if (!currentRow) throw new Error(`Panel ${panelId} not found`);
    const oldParentId = currentRow.parent_id;
    const now = Date.now();
    this.shiftSiblingPositions(newParentId, targetPosition, now);
    this.sql.exec(
      `UPDATE panels SET parent_id = ?, position = ?, updated_at = ? WHERE id = ?`,
      newParentId,
      targetPosition,
      now,
      panelId
    );
    if (oldParentId !== newParentId) this.normalizePositions(oldParentId);
    this.normalizePositions(newParentId);
  }

  getChildrenPaginated(
    parentId: string,
    offset: number,
    limit: number
  ): { children: PanelSummary[]; total: number; hasMore: boolean } {
    const total = (
      this.sql
        .exec(
          `SELECT COUNT(*) as count FROM panels WHERE parent_id = ? AND archived_at IS NULL`,
          parentId
        )
        .one() as { count: number }
    ).count;
    const children = this.summaryRows(
      `SELECT p.id, p.title, p.position,
        (SELECT COUNT(*) FROM panels c WHERE c.parent_id = p.id AND c.archived_at IS NULL) as child_count
       FROM panels p WHERE p.parent_id = ? AND p.archived_at IS NULL
       ORDER BY p.position ASC LIMIT ? OFFSET ?`,
      parentId,
      limit,
      offset
    );
    return { children, total, hasMore: offset + children.length < total };
  }

  getRootPanelsPaginated(
    offset: number,
    limit: number
  ): { panels: PanelSummary[]; total: number; hasMore: boolean } {
    const total = (
      this.sql
        .exec(
          `SELECT COUNT(*) as count FROM panels WHERE parent_id IS NULL AND workspace_id = ? AND archived_at IS NULL`,
          this.getWorkspaceId()
        )
        .one() as { count: number }
    ).count;
    const panels = this.summaryRows(
      `SELECT p.id, p.title, p.position,
        (SELECT COUNT(*) FROM panels c WHERE c.parent_id = p.id AND c.archived_at IS NULL) as child_count
       FROM panels p WHERE p.parent_id IS NULL AND p.workspace_id = ? AND p.archived_at IS NULL
       ORDER BY p.position ASC LIMIT ? OFFSET ?`,
      this.getWorkspaceId(),
      limit,
      offset
    );
    return { panels, total, hasMore: offset + panels.length < total };
  }

  getFullTree(): Panel[] {
    const rows = this.sql
      .exec(
        `SELECT * FROM panels WHERE workspace_id = ? AND archived_at IS NULL ORDER BY position`,
        this.getWorkspaceId()
      )
      .toArray() as unknown as DbPanelRow[];
    const panelMap = new Map<string, Panel>();
    for (const row of rows) panelMap.set(row.id, this.rowToPanel(row));
    const roots: Panel[] = [];
    for (const row of rows) {
      const panel = panelMap.get(row.id)!;
      if (row.parent_id && panelMap.has(row.parent_id)) {
        panelMap.get(row.parent_id)!.children.push(panel);
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

  getCollapsedIds(): string[] {
    const rows = this.sql
      .exec(
        `SELECT id FROM panels WHERE workspace_id = ? AND collapsed = 1 AND archived_at IS NULL`,
        this.getWorkspaceId()
      )
      .toArray() as Array<{ id: string }>;
    return rows.map((row) => row.id);
  }

  setCollapsed(panelId: string, collapsed: boolean): void {
    this.sql.exec(
      `UPDATE panels SET collapsed = ?, updated_at = ? WHERE id = ?`,
      collapsed ? 1 : 0,
      Date.now(),
      panelId
    );
  }

  setCollapsedBatch(panelIds: string[], collapsed: boolean): void {
    const now = Date.now();
    const value = collapsed ? 1 : 0;
    for (const id of panelIds) {
      this.sql.exec(`UPDATE panels SET collapsed = ?, updated_at = ? WHERE id = ?`, value, now, id);
    }
  }

  archivePanel(panelId: string): void {
    const now = Date.now();
    this.sql.exec(
      `UPDATE panels SET archived_at = ?, updated_at = ? WHERE id = ?`,
      now,
      now,
      panelId
    );
  }

  unarchivePanel(panelId: string): void {
    this.sql.exec(
      `UPDATE panels SET archived_at = NULL, updated_at = ? WHERE id = ?`,
      Date.now(),
      panelId
    );
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
      const history = JSON.parse(row.history) as Array<{ source?: string }>;
      const current = history[row.history_index] ?? history[0];
      this.indexPanel({ id: row.id, title: row.title, path: current?.source });
    }
  }

  private shiftSiblingPositions(
    parentId: string | null,
    targetPosition: number,
    now: number
  ): void {
    this.sql.exec(
      `UPDATE panels
       SET position = position + 1, updated_at = ?
       WHERE (parent_id = ? OR (parent_id IS NULL AND ? IS NULL))
         AND workspace_id = ?
         AND position >= ?
         AND archived_at IS NULL`,
      now,
      parentId,
      parentId,
      this.getWorkspaceId(),
      targetPosition
    );
  }

  private normalizePositions(parentId: string | null): void {
    const rows =
      parentId === null
        ? this.sql
            .exec(
              `SELECT id, position FROM panels WHERE parent_id IS NULL AND workspace_id = ? ORDER BY position ASC`,
              this.getWorkspaceId()
            )
            .toArray()
        : this.sql
            .exec(
              `SELECT id, position FROM panels WHERE parent_id = ? ORDER BY position ASC`,
              parentId
            )
            .toArray();
    const now = Date.now();
    (rows as Array<{ id: string; position: number }>).forEach((row, index) => {
      if (row.position !== index) {
        this.sql.exec(
          `UPDATE panels SET position = ?, updated_at = ? WHERE id = ?`,
          index,
          now,
          row.id
        );
      }
    });
  }

  private summaryRows(sql: string, ...args: unknown[]): PanelSummary[] {
    const rows = this.sql.exec(sql, ...args).toArray() as Array<{
      id: string;
      title: string;
      position: number;
      child_count: number;
    }>;
    return rows.map((row) => ({
      id: row.id,
      title: row.title,
      childCount: row.child_count,
      position: row.position,
    }));
  }

  private rowToPanel(row: DbPanelRow): Panel {
    const history = this.parseHistory(row);
    const historyIndex = this.normalizeHistoryIndex(row, history);
    return {
      id: row.id,
      title: row.title,
      children: [],
      selectedChildId: row.selected_child_id,
      history: { entries: history, index: historyIndex },
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

  private parseHistory(row: DbPanelRow): PanelSnapshot[] {
    const history = JSON.parse(row.history) as PanelSnapshot[];
    if (!Array.isArray(history) || history.length === 0) {
      throw new Error(`Panel ${row.id} has invalid history: must be non-empty array`);
    }
    return history;
  }

  private normalizeHistoryIndex(row: DbPanelRow, history: PanelSnapshot[]): number {
    return row.history_index < 0 || row.history_index >= history.length ? 0 : row.history_index;
  }

  private sanitizeQuery(query: string): string {
    const trimmed = query.trim();
    if (!trimmed) return "";
    const escaped = trimmed.replace(/["*():^]/g, " ").trim();
    return escaped.includes(" ") ? `"${escaped}"` : escaped;
  }
}
