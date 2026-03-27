/**
 * Panel Search Index
 *
 * Manages full-text search indexing for panels.
 * Indexes panel metadata, manifests, and extracted content.
 */

import type Database from "better-sqlite3";
import type { PanelPersistence } from "./panelPersistence.js";
import type { DbPanelRow } from "./panelSchema.js";
import { createDevLogger } from "@natstack/dev-log";

const log = createDevLogger("PanelSearchIndex");

/**
 * Search result with relevance score.
 */
export interface PanelSearchResult {
  id: string;
  title: string;
  relevance: number;
  accessCount: number;
  matchContext?: string;
}

/**
 * Panel metadata for indexing.
 */
interface IndexablePanel {
  id: string;
  title: string;
  /** Source path for the panel */
  path?: string;
  manifestDescription?: string;
  manifestDependencies?: string[];
  tags?: string[];
  keywords?: string[];
}

/**
 * PanelSearchIndex class for managing FTS5 index.
 */
export class PanelSearchIndex {
  private readonly persistence: PanelPersistence;

  constructor(persistence: PanelPersistence) {
    this.persistence = persistence;
  }

  /**
   * Index a panel for full-text search.
   * Called when a panel is created or updated.
   */
  indexPanel(panel: IndexablePanel): void {
    try {
      const db = this.getDb();
      const now = Date.now();

      // Check if panel exists in search metadata
      const existing = db
        .prepare("SELECT rowid FROM panel_search_metadata WHERE panel_id = ?")
        .get(panel.id) as { rowid: number } | undefined;

      if (existing) {
        // Update existing record
        db.prepare(`
          UPDATE panel_search_metadata SET
            searchable_title = ?,
            searchable_path = ?,
            manifest_description = ?,
            manifest_dependencies = ?,
            tags = ?,
            keywords = ?,
            last_indexed_at = ?
          WHERE panel_id = ?
        `).run(
          panel.title,
          panel.path ?? null,
          panel.manifestDescription ?? null,
          panel.manifestDependencies ? JSON.stringify(panel.manifestDependencies) : null,
          panel.tags ? JSON.stringify(panel.tags) : null,
          panel.keywords ? JSON.stringify(panel.keywords) : null,
          now,
          panel.id
        );
      } else {
        // Insert new record
        db.prepare(`
          INSERT INTO panel_search_metadata (
            panel_id,
            searchable_title,
            searchable_path,
            manifest_description,
            manifest_dependencies,
            tags,
            keywords,
            access_count,
            last_indexed_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)
        `).run(
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
    } catch (error) {
      console.error(`[PanelSearchIndex] Failed to index panel ${panel.id}:`, error);
    }
  }

  /**
   * Search panels using full-text search.
   *
   * @param query - The search query (supports FTS5 syntax)
   * @param limit - Maximum number of results
   * @returns Search results sorted by relevance and access count
   */
  search(query: string, limit = 50): PanelSearchResult[] {
    try {
      const db = this.getDb();
      const workspaceId = this.persistence.getWorkspaceId();

      // Escape special FTS5 characters and wrap in quotes for phrase matching
      const safeQuery = this.sanitizeQuery(query);
      if (!safeQuery) {
        return [];
      }

      const rows = db
        .prepare(`
          SELECT
            p.id,
            p.title,
            m.access_count,
            bm25(panel_fts) as relevance
          FROM panel_fts
          JOIN panel_search_metadata m ON panel_fts.rowid = m.rowid
          JOIN panels p ON m.panel_id = p.id
          WHERE panel_fts MATCH ?1 AND p.workspace_id = ?2 AND p.archived_at IS NULL
          ORDER BY relevance, m.access_count DESC
          LIMIT ?3
        `)
        .all(safeQuery, workspaceId, limit) as Array<{
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
    } catch (error) {
      console.error("[PanelSearchIndex] Search failed:", error);
      return [];
    }
  }

  /**
   * Increment access count for a panel (called on focus).
   */
  incrementAccessCount(panelId: string): void {
    try {
      const db = this.getDb();
      db.prepare(`
        UPDATE panel_search_metadata
        SET access_count = access_count + 1
        WHERE panel_id = ?
      `).run(panelId);
    } catch (error) {
      console.error(`[PanelSearchIndex] Failed to increment access count for ${panelId}:`, error);
    }
  }

  /**
   * Update searchable title for a panel (called when title changes).
   */
  updateTitle(panelId: string, title: string): void {
    try {
      const db = this.getDb();
      db.prepare(`
        UPDATE panel_search_metadata
        SET searchable_title = ?, last_indexed_at = ?
        WHERE panel_id = ?
      `).run(title, Date.now(), panelId);
    } catch (error) {
      console.error(`[PanelSearchIndex] Failed to update title for ${panelId}:`, error);
    }
  }

  /**
   * Rebuild the search index from scratch.
   * Useful for fixing index corruption or after schema changes.
   */
  rebuildIndex(): void {
    try {
      const db = this.getDb();
      const workspaceId = this.persistence.getWorkspaceId();

      // Get all active (non-archived) panels
      const panels = db
        .prepare("SELECT * FROM panels WHERE workspace_id = ? AND archived_at IS NULL")
        .all(workspaceId) as DbPanelRow[];

      log.verbose(` Rebuilding index for ${panels.length} panels`);

      // Clear existing search metadata
      db.prepare("DELETE FROM panel_search_metadata WHERE panel_id IN (SELECT id FROM panels WHERE workspace_id = ?)").run(
        workspaceId
      );

      // Re-index each panel
      for (const panel of panels) {
        // Parse history to get current snapshot
        const history = JSON.parse(panel.history) as Array<{
          source: string;
        }>;
        const currentSnapshot = history[panel.history_index] ?? history[0];
        if (!currentSnapshot) continue;

        this.indexPanel({
          id: panel.id,
          title: panel.title,
          path: currentSnapshot.source,
        });
      }

      console.log("[PanelSearchIndex] Index rebuild complete");
    } catch (error) {
      console.error("[PanelSearchIndex] Failed to rebuild index:", error);
      throw error;
    }
  }

  /**
   * Get the database connection from PanelPersistence.
   * Shares the same connection to avoid connection leaks.
   */
  private getDb(): Database.Database {
    return this.persistence.getDb();
  }

  /**
   * Sanitize a search query for FTS5.
   *
   * Limitations:
   * - Special characters (", *, (, ), :, ^) are replaced with spaces
   * - This prevents advanced FTS5 queries but ensures safety
   * - Queries with spaces are treated as phrase matches
   *
   * @param query - Raw user input
   * @returns Sanitized query safe for FTS5 MATCH
   */
  private sanitizeQuery(query: string): string {
    // Trim and normalize whitespace
    const trimmed = query.trim();
    if (!trimmed) {
      return "";
    }

    // Escape special FTS5 characters: " * ( ) : ^
    // Replace with space to treat as separate tokens
    const escaped = trimmed.replace(/["\*\(\):^]/g, " ").trim();

    // If the query contains spaces, treat as phrase match
    if (escaped.includes(" ")) {
      return `"${escaped}"`;
    }

    return escaped;
  }
}

/**
 * Create a PanelSearchIndex instance.
 * Startup code should create this explicitly and pass it to consumers.
 */
export function createPanelSearchIndex(persistence: PanelPersistence): PanelSearchIndex {
  return new PanelSearchIndex(persistence);
}
