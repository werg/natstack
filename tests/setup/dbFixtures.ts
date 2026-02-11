/**
 * Database test fixtures for integration testing.
 *
 * Provides utilities for creating in-memory test databases
 * and populating them with test panel data.
 */

import Database from "better-sqlite3";
import { initializePanelSchema, type DbPanelRow } from "../../src/main/db/panelSchema.js";
import type { PanelSnapshot, PanelType } from "../../src/shared/types.js";

/**
 * Create an in-memory test database with the panel schema.
 */
export function createTestDatabase(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  initializePanelSchema(db);
  return db;
}

/**
 * Options for inserting a test panel.
 */
export interface TestPanelOptions {
  id: string;
  workspaceId?: string;
  parentId?: string | null;
  source: string;
  type: PanelType;
  title?: string;
  position?: number;
  env?: Record<string, string>;
  contextId?: string;
}

/**
 * Create a panel snapshot from options.
 */
function createTestSnapshot(options: TestPanelOptions): PanelSnapshot {
  const snapshot: PanelSnapshot = {
    source: options.source,
    type: options.type,
    options: {},
  };

  if (options.env) {
    snapshot.options.env = options.env;
  }
  if (options.contextId) {
    snapshot.options.contextId = options.contextId;
  }

  return snapshot;
}

/**
 * Insert a test panel into the database.
 */
export function insertTestPanel(db: Database.Database, options: TestPanelOptions): void {
  const snapshot = createTestSnapshot(options);
  const now = Date.now();

  db.prepare(
    `
    INSERT INTO panels (
      id, title, workspace_id, parent_id, position,
      created_at, updated_at, history, history_index, artifacts
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, '{}')
  `
  ).run(
    options.id,
    options.title ?? options.id,
    options.workspaceId ?? "test-workspace",
    options.parentId ?? null,
    options.position ?? 0,
    now,
    now,
    JSON.stringify([snapshot])
  );
}

/**
 * Get a panel from the database by ID.
 */
export function getTestPanel(db: Database.Database, id: string): DbPanelRow | undefined {
  return db.prepare("SELECT * FROM panels WHERE id = ?").get(id) as DbPanelRow | undefined;
}

/**
 * Get all panels from the database.
 */
export function getAllTestPanels(db: Database.Database): DbPanelRow[] {
  return db.prepare("SELECT * FROM panels WHERE archived_at IS NULL").all() as DbPanelRow[];
}

/**
 * Create a realistic panel tree fixture for testing.
 *
 * Creates:
 * - tree/root (launcher shell)
 *   - tree/root/editor (app panel)
 *   - tree/root/chat (app panel)
 *     - tree/root/chat/worker (worker panel)
 *
 * @returns The root panel ID and all created panel IDs
 */
export function createPanelTreeFixture(
  db: Database.Database,
  workspaceId = "test-workspace"
): { rootId: string; panelIds: string[] } {
  const rootId = "tree/root";
  const panelIds: string[] = [];

  // Root launcher
  insertTestPanel(db, {
    id: rootId,
    workspaceId,
    source: "panels/launcher",
    type: "shell",
    title: "Launcher",
    position: 0,
  });
  panelIds.push(rootId);

  // Editor child
  const editorId = `${rootId}/editor`;
  insertTestPanel(db, {
    id: editorId,
    workspaceId,
    parentId: rootId,
    source: "panels/code-editor",
    type: "app",
    title: "Editor",
    position: 0,
  });
  panelIds.push(editorId);

  // Chat child
  const chatId = `${rootId}/chat`;
  insertTestPanel(db, {
    id: chatId,
    workspaceId,
    parentId: rootId,
    source: "panels/chat",
    type: "app",
    title: "Chat",
    position: 1,
  });
  panelIds.push(chatId);

  // Worker grandchild under chat
  const workerId = `${chatId}/worker`;
  insertTestPanel(db, {
    id: workerId,
    workspaceId,
    parentId: chatId,
    source: "workers/chat-responder",
    type: "worker",
    title: "AI Worker",
    position: 0,
  });
  panelIds.push(workerId);

  return { rootId, panelIds };
}

/**
 * Create a minimal single-panel fixture.
 */
export function createSinglePanelFixture(
  db: Database.Database,
  options?: Partial<TestPanelOptions>
): string {
  const id = options?.id ?? "tree/root";
  insertTestPanel(db, {
    id,
    source: options?.source ?? "panels/launcher",
    type: options?.type ?? "app",
    title: options?.title ?? "Test Panel",
    workspaceId: options?.workspaceId ?? "test-workspace",
    parentId: options?.parentId ?? null,
    position: options?.position ?? 0,
    env: options?.env,
    contextId: options?.contextId,
  });
  return id;
}

/**
 * Archive a panel (soft delete).
 */
export function archiveTestPanel(db: Database.Database, id: string): void {
  const now = Date.now();
  db.prepare("UPDATE panels SET archived_at = ?, updated_at = ? WHERE id = ?").run(now, now, id);
}

/**
 * Clear all panels from the database.
 */
export function clearAllTestPanels(db: Database.Database): void {
  db.prepare("DELETE FROM panel_search_metadata").run();
  db.prepare("DELETE FROM panel_events").run();
  db.prepare("DELETE FROM panels").run();
}
