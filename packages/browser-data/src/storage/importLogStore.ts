import type Database from "better-sqlite3";

export interface ImportLogEntry {
  browser: string;
  profilePath: string;
  dataType: string;
  itemsImported: number;
  itemsSkipped: number;
  warnings?: string[];
}

export interface StoredImportLog {
  id: number;
  browser: string;
  profile_path: string;
  data_type: string;
  items_imported: number;
  items_skipped: number;
  imported_at: number;
  warnings: string | null;
}

export class ImportLogStore {
  constructor(private db: Database.Database) {}

  log(entry: ImportLogEntry): number {
    const stmt = this.db.prepare(`
      INSERT INTO import_log (browser, profile_path, data_type, items_imported, items_skipped, imported_at, warnings)
      VALUES (@browser, @profilePath, @dataType, @itemsImported, @itemsSkipped, @importedAt, @warnings)
    `);
    const result = stmt.run({
      browser: entry.browser,
      profilePath: entry.profilePath,
      dataType: entry.dataType,
      itemsImported: entry.itemsImported,
      itemsSkipped: entry.itemsSkipped,
      importedAt: Date.now(),
      warnings: entry.warnings ? JSON.stringify(entry.warnings) : null,
    });
    return Number(result.lastInsertRowid);
  }

  getAll(): StoredImportLog[] {
    return this.db
      .prepare("SELECT * FROM import_log ORDER BY imported_at DESC")
      .all() as StoredImportLog[];
  }
}
