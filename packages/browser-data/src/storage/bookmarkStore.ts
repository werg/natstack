import type Database from "better-sqlite3";
import type { ImportedBookmark } from "../types.js";

export interface StoredBookmark {
  id: number;
  title: string;
  url: string | null;
  folder_path: string;
  date_added: number;
  date_modified: number | null;
  favicon_id: number | null;
  position: number;
  source_browser: string | null;
  tags: string | null;
  keyword: string | null;
}

export class BookmarkStore {
  constructor(private db: Database.Database) {}

  add(bookmark: {
    title: string;
    url?: string;
    folderPath?: string;
    dateAdded?: number;
    tags?: string;
    keyword?: string;
    position?: number;
    sourceBrowser?: string;
    faviconId?: number;
  }): number {
    const stmt = this.db.prepare(`
      INSERT INTO bookmarks (title, url, folder_path, date_added, tags, keyword, position, source_browser, favicon_id)
      VALUES (@title, @url, @folderPath, @dateAdded, @tags, @keyword, @position, @sourceBrowser, @faviconId)
    `);
    const result = stmt.run({
      title: bookmark.title,
      url: bookmark.url ?? null,
      folderPath: bookmark.folderPath ?? "/",
      dateAdded: bookmark.dateAdded ?? Date.now(),
      tags: bookmark.tags ?? null,
      keyword: bookmark.keyword ?? null,
      position: bookmark.position ?? 0,
      sourceBrowser: bookmark.sourceBrowser ?? null,
      faviconId: bookmark.faviconId ?? null,
    });
    return Number(result.lastInsertRowid);
  }

  update(
    id: number,
    partial: Partial<{
      title: string;
      url: string;
      folderPath: string;
      tags: string;
      keyword: string;
      position: number;
      faviconId: number;
    }>,
  ): void {
    const sets: string[] = [];
    const params: Record<string, unknown> = { id };

    if (partial.title !== undefined) {
      sets.push("title = @title");
      params['title'] = partial.title;
    }
    if (partial.url !== undefined) {
      sets.push("url = @url");
      params['url'] = partial.url;
    }
    if (partial.folderPath !== undefined) {
      sets.push("folder_path = @folderPath");
      params['folderPath'] = partial.folderPath;
    }
    if (partial.tags !== undefined) {
      sets.push("tags = @tags");
      params['tags'] = partial.tags;
    }
    if (partial.keyword !== undefined) {
      sets.push("keyword = @keyword");
      params['keyword'] = partial.keyword;
    }
    if (partial.position !== undefined) {
      sets.push("position = @position");
      params['position'] = partial.position;
    }
    if (partial.faviconId !== undefined) {
      sets.push("favicon_id = @faviconId");
      params['faviconId'] = partial.faviconId;
    }

    if (sets.length === 0) return;

    sets.push("date_modified = @dateModified");
    params['dateModified'] = Date.now();

    this.db.prepare(`UPDATE bookmarks SET ${sets.join(", ")} WHERE id = @id`).run(params);
  }

  delete(id: number): void {
    this.db.prepare("DELETE FROM bookmarks WHERE id = ?").run(id);
  }

  get(id: number): StoredBookmark | undefined {
    return this.db.prepare("SELECT * FROM bookmarks WHERE id = ?").get(id) as
      | StoredBookmark
      | undefined;
  }

  getByFolder(folderPath: string): StoredBookmark[] {
    return this.db
      .prepare("SELECT * FROM bookmarks WHERE folder_path = ? ORDER BY position")
      .all(folderPath) as StoredBookmark[];
  }

  move(id: number, folderPath: string, position: number): void {
    this.db
      .prepare(
        "UPDATE bookmarks SET folder_path = @folderPath, position = @position, date_modified = @dateModified WHERE id = @id",
      )
      .run({ id, folderPath, position, dateModified: Date.now() });
  }

  getAll(): StoredBookmark[] {
    return this.db
      .prepare("SELECT * FROM bookmarks ORDER BY folder_path, position")
      .all() as StoredBookmark[];
  }

  search(query: string): StoredBookmark[] {
    const pattern = `%${query}%`;
    return this.db
      .prepare(
        "SELECT * FROM bookmarks WHERE title LIKE @pattern OR url LIKE @pattern ORDER BY date_added DESC",
      )
      .all({ pattern }) as StoredBookmark[];
  }

  addBatch(bookmarks: ImportedBookmark[]): number {
    const stmt = this.db.prepare(`
      INSERT INTO bookmarks (title, url, folder_path, date_added, date_modified, tags, keyword, position)
      VALUES (@title, @url, @folderPath, @dateAdded, @dateModified, @tags, @keyword, @position)
    `);

    let count = 0;
    const insertMany = this.db.transaction((items: ImportedBookmark[]) => {
      for (const bm of items) {
        stmt.run({
          title: bm.title,
          url: bm.url,
          folderPath: "/" + bm.folder.join("/"),
          dateAdded: bm.dateAdded,
          dateModified: bm.dateModified ?? null,
          tags: bm.tags ? JSON.stringify(bm.tags) : null,
          keyword: bm.keyword ?? null,
          position: count,
        });
        count++;
      }
    });

    insertMany(bookmarks);
    return count;
  }
}
