import type Database from "better-sqlite3";
import type { ImportedFavicon } from "../types.js";

export interface StoredFavicon {
  id: number;
  url: string;
  data: Buffer | null;
  mime_type: string | null;
  last_updated: number | null;
}

export class FaviconStore {
  constructor(private db: Database.Database) {}

  add(url: string, data: Buffer, mimeType: string = "image/png"): number {
    const stmt = this.db.prepare(`
      INSERT INTO favicons (url, data, mime_type, last_updated)
      VALUES (@url, @data, @mimeType, @lastUpdated)
      ON CONFLICT(url) DO UPDATE SET
        data = @data,
        mime_type = @mimeType,
        last_updated = @lastUpdated
    `);
    const result = stmt.run({
      url,
      data,
      mimeType,
      lastUpdated: Date.now(),
    });
    return Number(result.lastInsertRowid);
  }

  get(url: string): StoredFavicon | undefined {
    return this.db.prepare("SELECT * FROM favicons WHERE url = ?").get(url) as
      | StoredFavicon
      | undefined;
  }

  getById(id: number): StoredFavicon | undefined {
    return this.db.prepare("SELECT * FROM favicons WHERE id = ?").get(id) as
      | StoredFavicon
      | undefined;
  }

  addBatch(favicons: ImportedFavicon[]): number {
    const stmt = this.db.prepare(`
      INSERT INTO favicons (url, data, mime_type, last_updated)
      VALUES (@url, @data, @mimeType, @lastUpdated)
      ON CONFLICT(url) DO UPDATE SET
        data = @data,
        mime_type = @mimeType,
        last_updated = @lastUpdated
    `);

    let count = 0;
    const insertMany = this.db.transaction((items: ImportedFavicon[]) => {
      const now = Date.now();
      for (const fav of items) {
        stmt.run({
          url: fav.url,
          data: fav.data,
          mimeType: fav.mimeType,
          lastUpdated: now,
        });
        count++;
      }
    });

    insertMany(favicons);
    return count;
  }
}
