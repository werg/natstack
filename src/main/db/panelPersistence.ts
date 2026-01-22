/**
 * Panel Persistence Layer
 *
 * CRUD operations for the panel tree SQLite database.
 * Uses unified PanelSnapshot architecture (v3 schema).
 */

import Database from "better-sqlite3";
import * as path from "path";
import * as fs from "fs";
import { getActiveWorkspace } from "../paths.js";
import {
  initializePanelSchema,
  PANEL_QUERIES,
  type DbPanelRow,
  type DbPanelEventType,
} from "./panelSchema.js";
import type {
  Panel,
  PanelSnapshot,
  PanelArtifacts,
  PanelSummary,
  PanelType,
} from "../../shared/ipc/types.js";

// Re-export PanelSummary from shared types
export type { PanelSummary };

/**
 * Panel context assembled from DB queries.
 */
export interface PanelContext {
  panel: Panel;
  ancestors: PanelSummary[];
  siblings: PanelSummary[];
  children: PanelSummary[];
}

/**
 * Input for creating a new panel (v3 schema).
 * Uses PanelSnapshot for initial state.
 */
export interface CreatePanelInput {
  id: string;
  title: string;
  parentId: string | null;
  /** Initial snapshot (source, type, options) */
  snapshot: PanelSnapshot;
  artifacts?: PanelArtifacts;
}

/**
 * Input for updating a panel (v3 schema).
 */
export interface UpdatePanelInput {
  selectedChildId?: string | null;
  /** Update the history array (for navigation) */
  history?: PanelSnapshot[];
  /** Update the history index */
  historyIndex?: number;
  artifacts?: PanelArtifacts;
  parentId?: string | null;
}

/**
 * Singleton PanelPersistence instance.
 */
let instance: PanelPersistence | null = null;

/**
 * Get the singleton PanelPersistence instance.
 */
export function getPanelPersistence(): PanelPersistence {
  if (!instance) {
    instance = new PanelPersistence();
  }
  return instance;
}

/**
 * Reset the singleton instance (for testing).
 */
export function resetPanelPersistence(): void {
  if (instance) {
    instance.close();
    instance = null;
  }
}

/**
 * Panel Persistence class.
 *
 * Manages the panels database with CRUD operations.
 */
export class PanelPersistence {
  private db: Database.Database | null = null;
  private workspaceId: string | null = null;

  /**
   * Ensure the database is open and initialized.
   */
  private ensureOpen(): Database.Database {
    const workspace = getActiveWorkspace();
    if (!workspace) {
      throw new Error("No active workspace");
    }

    // Check if workspace changed
    if (this.workspaceId !== workspace.config.id) {
      this.close();
    }

    if (!this.db) {
      const dbDir = path.join(workspace.path, ".databases");
      fs.mkdirSync(dbDir, { recursive: true });

      const dbPath = path.join(dbDir, "panels.db");
      this.db = new Database(dbPath);

      // Enable WAL mode for better concurrent access
      this.db.pragma("journal_mode = WAL");
      this.db.pragma("synchronous = NORMAL");
      this.db.pragma("foreign_keys = ON");

      // Initialize schema
      initializePanelSchema(this.db);
      this.workspaceId = workspace.config.id;

      console.log(`[PanelPersistence] Opened database: ${dbPath}`);
    }

    return this.db;
  }

  /**
   * Get the current workspace ID.
   */
  getWorkspaceId(): string {
    const workspace = getActiveWorkspace();
    if (!workspace) {
      throw new Error("No active workspace");
    }
    return workspace.config.id;
  }

  /**
   * Get the database connection.
   * Used by PanelSearchIndex to share the same connection.
   */
  getDb(): Database.Database {
    return this.ensureOpen();
  }

  /**
   * Close the database connection.
   */
  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
      this.workspaceId = null;
    }
  }

  // =========================================================================
  // Create Operations
  // =========================================================================

  /**
   * Create a new panel in the database (v3 schema).
   * New panels are prepended (position 0) so newest children appear first.
   */
  createPanel(input: CreatePanelInput): void {
    const db = this.ensureOpen();
    const workspaceId = this.getWorkspaceId();
    const now = Date.now();

    // Shift existing siblings to make room at position 0
    db.prepare(PANEL_QUERIES.SHIFT_SIBLING_POSITIONS).run(
      now,
      input.parentId,
      input.parentId,
      workspaceId,
      0
    );

    // Create initial history with the snapshot
    const history: PanelSnapshot[] = [input.snapshot];

    // Insert at position 0 (prepend)
    db.prepare(`
      INSERT INTO panels (
        id, title, workspace_id,
        parent_id, position, selected_child_id,
        created_at, updated_at, history, history_index, artifacts
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.id,
      input.title,
      workspaceId,
      input.parentId,
      0, // Always prepend at position 0
      null, // selected_child_id
      now,
      now,
      JSON.stringify(history),
      0, // history_index starts at 0
      JSON.stringify(input.artifacts ?? {})
    );
  }

  // =========================================================================
  // Read Operations
  // =========================================================================

  /**
   * Get a panel by ID.
   */
  getPanel(panelId: string): Panel | null {
    const db = this.ensureOpen();
    const row = db.prepare(PANEL_QUERIES.GET_PANEL).get(panelId) as DbPanelRow | undefined;

    if (!row) {
      return null;
    }

    return this.rowToPanel(row);
  }

  /**
   * Get all root panels for the current workspace.
   */
  getRootPanels(): PanelSummary[] {
    const db = this.ensureOpen();
    const workspaceId = this.getWorkspaceId();

    const rows = db.prepare(PANEL_QUERIES.ROOT_PANELS).all(workspaceId) as Array<{
      id: string;
      title: string;
      type: PanelType; // Extracted from history JSON
      position: number;
      artifacts: string;
      child_count: number;
    }>;

    return rows.map((row) => ({
      id: row.id,
      type: row.type,
      title: row.title,
      childCount: row.child_count,
      buildState: this.extractBuildState(row.artifacts),
      position: row.position,
    }));
  }

  /**
   * Get children of a panel.
   */
  getChildren(parentId: string): PanelSummary[] {
    const db = this.ensureOpen();

    const rows = db.prepare(PANEL_QUERIES.CHILDREN).all(parentId) as Array<{
      id: string;
      title: string;
      type: PanelType; // Extracted from history JSON
      position: number;
      artifacts: string;
      child_count: number;
    }>;

    return rows.map((row) => ({
      id: row.id,
      type: row.type,
      title: row.title,
      childCount: row.child_count,
      buildState: this.extractBuildState(row.artifacts),
      position: row.position,
    }));
  }

  /**
   * Get siblings of a panel.
   */
  getSiblings(panelId: string): PanelSummary[] {
    const db = this.ensureOpen();

    const rows = db.prepare(PANEL_QUERIES.SIBLINGS).all(panelId) as Array<{
      id: string;
      title: string;
      type: PanelType; // Extracted from history JSON
      position: number;
      artifacts: string;
      child_count: number;
    }>;

    return rows.map((row) => ({
      id: row.id,
      type: row.type,
      title: row.title,
      childCount: row.child_count,
      buildState: this.extractBuildState(row.artifacts),
      position: row.position,
    }));
  }

  /**
   * Get ancestors of a panel (for breadcrumb).
   */
  getAncestors(panelId: string): PanelSummary[] {
    const db = this.ensureOpen();

    const rows = db.prepare(PANEL_QUERIES.ANCESTORS).all(panelId) as Array<{
      id: string;
      title: string;
      type: PanelType; // Extracted from history JSON
      depth: number;
    }>;

    return rows.map((row) => ({
      id: row.id,
      type: row.type,
      title: row.title,
      childCount: 0, // Not relevant for breadcrumbs
      position: 0,
    }));
  }

  /**
   * Get full panel context for UI rendering.
   */
  getPanelContext(panelId: string): PanelContext | null {
    const panel = this.getPanel(panelId);
    if (!panel) {
      return null;
    }

    return {
      panel,
      ancestors: this.getAncestors(panelId),
      siblings: this.getSiblings(panelId),
      children: this.getChildren(panelId),
    };
  }

  /**
   * Check if a panel exists.
   */
  panelExists(panelId: string): boolean {
    const db = this.ensureOpen();
    const row = db.prepare("SELECT 1 FROM panels WHERE id = ?").get(panelId);
    return row !== undefined;
  }

  /**
   * Get panel count for the current workspace.
   */
  getPanelCount(): number {
    const db = this.ensureOpen();
    const workspaceId = this.getWorkspaceId();
    const row = db.prepare(PANEL_QUERIES.PANEL_COUNT).get(workspaceId) as { count: number };
    return row.count;
  }

  // =========================================================================
  // Update Operations
  // =========================================================================

  /**
   * Update a panel (v3 schema).
   */
  updatePanel(panelId: string, input: UpdatePanelInput): void {
    const db = this.ensureOpen();
    const now = Date.now();

    // Build update query dynamically
    const updates: string[] = ["updated_at = ?"];
    const params: unknown[] = [now];

    if (input.selectedChildId !== undefined) {
      updates.push("selected_child_id = ?");
      params.push(input.selectedChildId);
    }

    if (input.artifacts !== undefined) {
      updates.push("artifacts = ?");
      params.push(JSON.stringify(input.artifacts));
    }

    if (input.parentId !== undefined) {
      updates.push("parent_id = ?");
      params.push(input.parentId);
    }

    if (input.history !== undefined) {
      updates.push("history = ?");
      params.push(JSON.stringify(input.history));
    }

    if (input.historyIndex !== undefined) {
      updates.push("history_index = ?");
      params.push(input.historyIndex);
    }

    params.push(panelId);

    // SECURITY: This dynamic SQL is safe because:
    // 1. Column names come ONLY from hardcoded strings in UpdatePanelInput type checks above
    // 2. All VALUES are passed via parameterized query (params array)
    // 3. DO NOT add any user input to the 'updates' array - use params instead
    // If you need to add a new updatable field, add it as a hardcoded string check above
    db.prepare(`UPDATE panels SET ${updates.join(", ")} WHERE id = ?`).run(...params);
  }

  /**
   * Update panel history (for navigation).
   */
  updateHistory(panelId: string, history: PanelSnapshot[], historyIndex: number): void {
    const db = this.ensureOpen();
    db.prepare("UPDATE panels SET history = ?, history_index = ?, updated_at = ? WHERE id = ?").run(
      JSON.stringify(history),
      historyIndex,
      Date.now(),
      panelId
    );
  }

  /**
   * Update panel artifacts.
   */
  updateArtifacts(panelId: string, artifacts: PanelArtifacts): void {
    const db = this.ensureOpen();
    db.prepare("UPDATE panels SET artifacts = ?, updated_at = ? WHERE id = ?").run(
      JSON.stringify(artifacts),
      Date.now(),
      panelId
    );
  }

  /**
   * Set selected child for a panel.
   */
  setSelectedChild(panelId: string, childId: string | null): void {
    const db = this.ensureOpen();
    db.prepare("UPDATE panels SET selected_child_id = ?, updated_at = ? WHERE id = ?").run(
      childId,
      Date.now(),
      panelId
    );
  }

  /**
   * Update the selected path from a focused panel up to the root.
   * This sets each ancestor's selected_child_id to point to the child along the path.
   */
  updateSelectedPath(focusedPanelId: string): void {
    const db = this.ensureOpen();
    const now = Date.now();
    const visited = new Set<string>();
    const MAX_DEPTH = 100;

    // Walk up the tree from the focused panel
    let currentId: string | null = focusedPanelId;
    let depth = 0;

    while (currentId && depth < MAX_DEPTH) {
      if (visited.has(currentId)) {
        console.error(`[PanelPersistence] Cycle detected in panel tree at ${currentId}`);
        break;
      }
      visited.add(currentId);

      const row = db.prepare("SELECT parent_id FROM panels WHERE id = ?").get(currentId) as
        | { parent_id: string | null }
        | undefined;

      if (!row) break;

      // Update the parent to point to the current node
      if (row.parent_id) {
        db.prepare("UPDATE panels SET selected_child_id = ?, updated_at = ? WHERE id = ?").run(
          currentId,
          now,
          row.parent_id
        );
      }

      // Move up to the parent
      currentId = row.parent_id;
      depth++;
    }

    if (depth >= MAX_DEPTH) {
      console.error(`[PanelPersistence] Max depth exceeded in updateSelectedPath`);
    }
  }

  /**
   * Update panel title (used internally for browser panel navigation).
   */
  setTitle(panelId: string, title: string): void {
    const db = this.ensureOpen();
    db.prepare("UPDATE panels SET title = ?, updated_at = ? WHERE id = ?").run(
      title,
      Date.now(),
      panelId
    );
  }

  /**
   * Move a panel to a new parent at a specific position.
   * Handles position shifting in both old and new parent contexts.
   */
  movePanel(panelId: string, newParentId: string | null, targetPosition: number): void {
    const db = this.ensureOpen();
    const workspaceId = this.getWorkspaceId();
    const now = Date.now();

    // Get current parent for normalization later
    const oldParentId = this.getParentId(panelId);

    // Get current position to determine if we need to adjust the target position
    const currentRow = db.prepare("SELECT parent_id, position FROM panels WHERE id = ?").get(panelId) as
      | { parent_id: string | null; position: number }
      | undefined;

    if (!currentRow) {
      throw new Error(`Panel ${panelId} not found`);
    }

    const isSameParent =
      (oldParentId === newParentId) ||
      (oldParentId === null && newParentId === null);

    // Note: targetPosition is the final desired position after the move.
    // Callers (e.g., DnD) already compute this with the dragged item excluded,
    // so no adjustment is needed here.

    // Shift positions in new parent to make room
    db.prepare(PANEL_QUERIES.SHIFT_SIBLING_POSITIONS).run(
      now,
      newParentId,
      newParentId,
      workspaceId,
      targetPosition
    );

    // Update panel's parent and position
    db.prepare(PANEL_QUERIES.UPDATE_POSITION_AND_PARENT).run(
      newParentId,
      targetPosition,
      now,
      panelId
    );

    // Normalize positions to close gaps and ensure correct ordering
    if (!isSameParent) {
      this.normalizePositions(oldParentId);
    }
    this.normalizePositions(newParentId);
  }

  /**
   * Normalize positions for siblings to close gaps.
   * Assigns positions 0, 1, 2, ... based on current order.
   */
  normalizePositions(parentId: string | null): void {
    const db = this.ensureOpen();
    const workspaceId = this.getWorkspaceId();
    const now = Date.now();

    // Get all siblings in current order
    let siblings: Array<{ id: string; position: number }>;
    if (parentId === null) {
      siblings = db
        .prepare(
          `SELECT id, position FROM panels
           WHERE parent_id IS NULL AND workspace_id = ?
           ORDER BY position ASC`
        )
        .all(workspaceId) as Array<{ id: string; position: number }>;
    } else {
      siblings = db
        .prepare(
          `SELECT id, position FROM panels
           WHERE parent_id = ?
           ORDER BY position ASC`
        )
        .all(parentId) as Array<{ id: string; position: number }>;
    }

    // Update positions to be sequential starting from 0
    const updateStmt = db.prepare("UPDATE panels SET position = ?, updated_at = ? WHERE id = ?");
    siblings.forEach((sibling, index) => {
      if (sibling.position !== index) {
        updateStmt.run(index, now, sibling.id);
      }
    });
  }

  /**
   * Get children with pagination.
   */
  getChildrenPaginated(
    parentId: string,
    offset: number,
    limit: number
  ): { children: PanelSummary[]; total: number; hasMore: boolean } {
    const db = this.ensureOpen();

    // Get total count
    const countRow = db.prepare(PANEL_QUERIES.CHILDREN_COUNT).get(parentId) as { count: number };
    const total = countRow.count;

    // Get paginated children
    const rows = db.prepare(PANEL_QUERIES.CHILDREN_PAGINATED).all(parentId, limit, offset) as Array<{
      id: string;
      title: string;
      type: PanelType; // Extracted from history JSON
      position: number;
      artifacts: string;
      child_count: number;
    }>;

    const children = rows.map((row) => ({
      id: row.id,
      type: row.type,
      title: row.title,
      childCount: row.child_count,
      buildState: this.extractBuildState(row.artifacts),
      position: row.position,
    }));

    return {
      children,
      total,
      hasMore: offset + rows.length < total,
    };
  }

  /**
   * Get root panels with pagination.
   */
  getRootPanelsPaginated(
    offset: number,
    limit: number
  ): { panels: PanelSummary[]; total: number; hasMore: boolean } {
    const db = this.ensureOpen();
    const workspaceId = this.getWorkspaceId();

    // Get total count
    const countRow = db.prepare(PANEL_QUERIES.ROOT_PANELS_COUNT).get(workspaceId) as { count: number };
    const total = countRow.count;

    // Get paginated root panels
    const rows = db
      .prepare(PANEL_QUERIES.ROOT_PANELS_PAGINATED)
      .all(workspaceId, limit, offset) as Array<{
      id: string;
      title: string;
      type: PanelType; // Extracted from history JSON
      position: number;
      artifacts: string;
      child_count: number;
    }>;

    const panels = rows.map((row) => ({
      id: row.id,
      type: row.type,
      title: row.title,
      childCount: row.child_count,
      buildState: this.extractBuildState(row.artifacts),
      position: row.position,
    }));

    return {
      panels,
      total,
      hasMore: offset + rows.length < total,
    };
  }

  /**
   * Get the first root panel ID (the "pinned" root).
   */
  getPinnedRootId(): string | null {
    const db = this.ensureOpen();
    const workspaceId = this.getWorkspaceId();

    const row = db
      .prepare(
        `SELECT id FROM panels
         WHERE parent_id IS NULL AND workspace_id = ?
         ORDER BY position ASC LIMIT 1`
      )
      .get(workspaceId) as { id: string } | undefined;

    return row?.id ?? null;
  }

  // =========================================================================
  // Event Logging
  // =========================================================================

  /**
   * Log a panel event.
   */
  logEvent(panelId: string, eventType: DbPanelEventType, context?: Record<string, unknown>): void {
    const db = this.ensureOpen();
    const workspaceId = this.getWorkspaceId();

    db.prepare(`
      INSERT INTO panel_events (panel_id, event_type, context, timestamp, workspace_id)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      panelId,
      eventType,
      context ? JSON.stringify(context) : null,
      Date.now(),
      workspaceId
    );
  }

  /**
   * Get recent events for analytics.
   */
  getRecentEvents(limit = 100): Array<{
    id: number;
    panelId: string;
    eventType: DbPanelEventType;
    context: Record<string, unknown> | null;
    timestamp: number;
  }> {
    const db = this.ensureOpen();
    const workspaceId = this.getWorkspaceId();

    const rows = db
      .prepare(
        `
      SELECT id, panel_id, event_type, context, timestamp
      FROM panel_events
      WHERE workspace_id = ?
      ORDER BY timestamp DESC
      LIMIT ?
    `
      )
      .all(workspaceId, limit) as Array<{
      id: number;
      panel_id: string;
      event_type: DbPanelEventType;
      context: string | null;
      timestamp: number;
    }>;

    return rows.map((row) => ({
      id: row.id,
      panelId: row.panel_id,
      eventType: row.event_type,
      context: row.context ? (JSON.parse(row.context) as Record<string, unknown>) : null,
      timestamp: row.timestamp,
    }));
  }

  // =========================================================================
  // Tree Operations
  // =========================================================================

  /**
   * Get the full panel tree for the current workspace.
   * Used for initial tree load and serialization.
   */
  getFullTree(): Panel[] {
    const db = this.ensureOpen();
    const workspaceId = this.getWorkspaceId();

    // Get all active (non-archived) panels for this workspace
    const rows = db
      .prepare(
        `
      SELECT * FROM panels WHERE workspace_id = ? AND archived_at IS NULL ORDER BY position
    `
      )
      .all(workspaceId) as DbPanelRow[];

    // Build a map for quick lookup
    const panelMap = new Map<string, Panel>();
    for (const row of rows) {
      panelMap.set(row.id, this.rowToPanel(row));
    }

    // Build tree structure
    const rootPanels: Panel[] = [];
    for (const row of rows) {
      const panel = panelMap.get(row.id)!;

      if (row.parent_id && panelMap.has(row.parent_id)) {
        const parent = panelMap.get(row.parent_id)!;
        parent.children.push(panel);
      } else if (!row.parent_id) {
        rootPanels.push(panel);
      }
    }

    return rootPanels;
  }

  /**
   * Get parent ID for a panel.
   */
  getParentId(panelId: string): string | null {
    const db = this.ensureOpen();
    const row = db.prepare("SELECT parent_id FROM panels WHERE id = ?").get(panelId) as
      | { parent_id: string | null }
      | undefined;
    return row?.parent_id ?? null;
  }

  // =========================================================================
  // Collapse State Operations
  // =========================================================================

  /**
   * Get all collapsed panel IDs for the current workspace.
   */
  getCollapsedIds(): string[] {
    const db = this.ensureOpen();
    const workspaceId = this.getWorkspaceId();
    const stmt = db.prepare(`
      SELECT id FROM panels
      WHERE workspace_id = ? AND collapsed = 1 AND archived_at IS NULL
    `);
    const rows = stmt.all(workspaceId) as Array<{ id: string }>;
    return rows.map((row) => row.id);
  }

  /**
   * Set collapse state for a single panel.
   */
  setCollapsed(panelId: string, collapsed: boolean): void {
    const db = this.ensureOpen();
    const stmt = db.prepare(`
      UPDATE panels SET collapsed = ?, updated_at = ? WHERE id = ?
    `);
    stmt.run(collapsed ? 1 : 0, Date.now(), panelId);
  }

  /**
   * Set collapse state for multiple panels in a single transaction.
   */
  setCollapsedBatch(panelIds: string[], collapsed: boolean): void {
    const db = this.ensureOpen();
    const stmt = db.prepare(`
      UPDATE panels SET collapsed = ?, updated_at = ? WHERE id = ?
    `);
    const now = Date.now();
    const collapsedInt = collapsed ? 1 : 0;
    db.transaction(() => {
      for (const id of panelIds) {
        stmt.run(collapsedInt, now, id);
      }
    })();
  }

  // =========================================================================
  // Build State Operations
  // =========================================================================

  /**
   * Reset all panels with error buildState to pending.
   * Called when the build cache is cleared so panels can rebuild.
   * Returns the number of panels reset.
   */
  resetErrorPanels(): number {
    const db = this.ensureOpen();
    const workspaceId = this.getWorkspaceId();
    const now = Date.now();

    // Find all panels with buildState = 'error' in their artifacts JSON
    const errorPanels = db
      .prepare(
        `SELECT id, artifacts FROM panels
         WHERE workspace_id = ?
         AND json_extract(artifacts, '$.buildState') = 'error'`
      )
      .all(workspaceId) as Array<{ id: string; artifacts: string }>;

    if (errorPanels.length === 0) {
      return 0;
    }

    // Update each panel to pending state
    const updateStmt = db.prepare(
      "UPDATE panels SET artifacts = ?, updated_at = ? WHERE id = ?"
    );

    const pendingArtifacts = JSON.stringify({
      buildState: "pending",
      buildProgress: "Build cache cleared - will rebuild when focused",
    });

    for (const panel of errorPanels) {
      updateStmt.run(pendingArtifacts, now, panel.id);
    }

    console.log(
      `[PanelPersistence] Reset ${errorPanels.length} error panels to pending state`
    );
    return errorPanels.length;
  }

  /**
   * Reset all app/worker panels with "ready" buildState to "pending".
   * Called when the build cache is cleared so panels can rebuild.
   * Returns the IDs of panels that were reset (for unloading).
   */
  resetAllReadyPanels(): string[] {
    const db = this.ensureOpen();
    const workspaceId = this.getWorkspaceId();
    const now = Date.now();

    const readyPanels = db
      .prepare(
        `SELECT id FROM panels
         WHERE workspace_id = ?
         AND type IN ('app', 'worker')
         AND json_extract(artifacts, '$.buildState') = 'ready'`
      )
      .all(workspaceId) as Array<{ id: string }>;

    if (readyPanels.length === 0) {
      return [];
    }

    const updateStmt = db.prepare(
      "UPDATE panels SET artifacts = ?, updated_at = ? WHERE id = ?"
    );
    const pendingArtifacts = JSON.stringify({
      buildState: "pending",
      buildProgress: "Build cache cleared - will rebuild when focused",
    });

    const resetIds: string[] = [];
    for (const panel of readyPanels) {
      updateStmt.run(pendingArtifacts, now, panel.id);
      resetIds.push(panel.id);
    }

    console.log(
      `[PanelPersistence] Reset ${resetIds.length} ready panels to pending state`
    );
    return resetIds;
  }

  // =========================================================================
  // Archive Operations
  // =========================================================================

  /**
   * Archive a panel (soft delete).
   * The panel remains in the database but is excluded from queries.
   */
  archivePanel(panelId: string): void {
    const db = this.ensureOpen();
    const now = Date.now();
    db.prepare(PANEL_QUERIES.ARCHIVE_PANEL).run(now, now, panelId);
  }

  /**
   * Unarchive a panel (restore from soft delete).
   */
  unarchivePanel(panelId: string): void {
    const db = this.ensureOpen();
    db.prepare("UPDATE panels SET archived_at = NULL, updated_at = ? WHERE id = ?").run(
      Date.now(),
      panelId
    );
  }

  /**
   * Check if a panel is archived.
   */
  isArchived(panelId: string): boolean {
    const db = this.ensureOpen();
    const row = db.prepare("SELECT archived_at FROM panels WHERE id = ?").get(panelId) as
      | { archived_at: number | null }
      | undefined;
    return row?.archived_at != null;
  }

  // =========================================================================
  // Internal Helpers
  // =========================================================================

  /**
   * Convert a database row to a Panel object (v3 schema).
   * Validates that history is non-empty.
   */
  private rowToPanel(row: DbPanelRow): Panel {
    const history = JSON.parse(row.history) as PanelSnapshot[];
    const artifacts = JSON.parse(row.artifacts) as PanelArtifacts;

    // Validate history is non-empty
    if (!Array.isArray(history) || history.length === 0) {
      throw new Error(`Panel ${row.id} has invalid history: must be non-empty array`);
    }

    // Validate historyIndex is within bounds
    if (row.history_index < 0 || row.history_index >= history.length) {
      console.warn(
        `[PanelPersistence] Panel ${row.id} has out-of-bounds history_index ${row.history_index}, resetting to 0`
      );
      row.history_index = 0;
    }

    return {
      id: row.id,
      title: row.title,
      children: [], // Will be populated by tree builder
      selectedChildId: row.selected_child_id,
      history,
      historyIndex: row.history_index,
      artifacts,
    };
  }

  /**
   * Extract build state from artifacts JSON string.
   */
  private extractBuildState(artifactsJson: string): string | undefined {
    try {
      const artifacts = JSON.parse(artifactsJson) as PanelArtifacts;
      return artifacts.buildState;
    } catch (error) {
      console.warn(`[PanelPersistence] Failed to parse artifacts JSON: ${error}`);
      return undefined;
    }
  }
}
