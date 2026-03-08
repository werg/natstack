import type Database from "better-sqlite3";
import type { ImportedSearchEngine } from "../types.js";

export interface StoredSearchEngine {
  id: number;
  name: string;
  keyword: string | null;
  search_url: string;
  suggest_url: string | null;
  favicon_url: string | null;
  is_default: number;
}

export class SearchEngineStore {
  constructor(private db: Database.Database) {}

  add(engine: {
    name: string;
    keyword?: string;
    searchUrl: string;
    suggestUrl?: string;
    faviconUrl?: string;
    isDefault?: boolean;
  }): number {
    if (engine.isDefault) {
      this.db.prepare("UPDATE search_engines SET is_default = 0").run();
    }
    const stmt = this.db.prepare(`
      INSERT INTO search_engines (name, keyword, search_url, suggest_url, favicon_url, is_default)
      VALUES (@name, @keyword, @searchUrl, @suggestUrl, @faviconUrl, @isDefault)
    `);
    const result = stmt.run({
      name: engine.name,
      keyword: engine.keyword ?? null,
      searchUrl: engine.searchUrl,
      suggestUrl: engine.suggestUrl ?? null,
      faviconUrl: engine.faviconUrl ?? null,
      isDefault: engine.isDefault ? 1 : 0,
    });
    return Number(result.lastInsertRowid);
  }

  getAll(): StoredSearchEngine[] {
    return this.db
      .prepare("SELECT * FROM search_engines ORDER BY is_default DESC, name")
      .all() as StoredSearchEngine[];
  }

  setDefault(id: number): void {
    const tx = this.db.transaction(() => {
      this.db.prepare("UPDATE search_engines SET is_default = 0").run();
      this.db.prepare("UPDATE search_engines SET is_default = 1 WHERE id = ?").run(id);
    });
    tx();
  }

  delete(id: number): void {
    this.db.prepare("DELETE FROM search_engines WHERE id = ?").run(id);
  }

  addBatch(engines: ImportedSearchEngine[]): number {
    const stmt = this.db.prepare(`
      INSERT INTO search_engines (name, keyword, search_url, suggest_url, favicon_url, is_default)
      VALUES (@name, @keyword, @searchUrl, @suggestUrl, @faviconUrl, @isDefault)
    `);

    let count = 0;
    const insertMany = this.db.transaction((items: ImportedSearchEngine[]) => {
      // Ensure at most one default: use the last engine marked isDefault
      let defaultSeen = false;
      for (let i = items.length - 1; i >= 0; i--) {
        if (items[i]!.isDefault) {
          if (defaultSeen) {
            items[i] = { ...items[i]!, isDefault: false };
          }
          defaultSeen = true;
        }
      }
      // Clear existing defaults if any incoming engine is default
      if (defaultSeen) {
        this.db.prepare("UPDATE search_engines SET is_default = 0").run();
      }
      for (const engine of items) {
        stmt.run({
          name: engine.name,
          keyword: engine.keyword ?? null,
          searchUrl: engine.searchUrl,
          suggestUrl: engine.suggestUrl ?? null,
          faviconUrl: engine.faviconUrl ?? null,
          isDefault: engine.isDefault ? 1 : 0,
        });
        count++;
      }
    });

    insertMany(engines);
    return count;
  }
}
