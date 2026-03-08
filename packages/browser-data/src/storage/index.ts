import Database from "better-sqlite3";
import * as fs from "node:fs";
import * as path from "node:path";
import { BROWSER_DATA_SCHEMA } from "./schema.js";
import { BookmarkStore } from "./bookmarkStore.js";
import { HistoryStore } from "./historyStore.js";
import { PasswordStore } from "./passwordStore.js";
import { CookieStore } from "./cookieStore.js";
import { AutofillStore } from "./autofillStore.js";
import { SearchEngineStore } from "./searchEngineStore.js";
import { FaviconStore } from "./faviconStore.js";
import { PermissionStore } from "./permissionStore.js";
import { ImportLogStore } from "./importLogStore.js";

export { BROWSER_DATA_SCHEMA } from "./schema.js";
export { BookmarkStore, type StoredBookmark } from "./bookmarkStore.js";
export { HistoryStore, type StoredHistory, type StoredVisit } from "./historyStore.js";
export { PasswordStore, type StoredPassword } from "./passwordStore.js";
export { CookieStore, type StoredCookie } from "./cookieStore.js";
export { AutofillStore, type StoredAutofill } from "./autofillStore.js";
export { SearchEngineStore, type StoredSearchEngine } from "./searchEngineStore.js";
export { FaviconStore, type StoredFavicon } from "./faviconStore.js";
export { PermissionStore, type StoredPermission } from "./permissionStore.js";
export { ImportLogStore, type ImportLogEntry, type StoredImportLog } from "./importLogStore.js";

export class BrowserDataStore {
  readonly bookmarks: BookmarkStore;
  readonly history: HistoryStore;
  readonly passwords: PasswordStore;
  readonly cookies: CookieStore;
  readonly autofill: AutofillStore;
  readonly searchEngines: SearchEngineStore;
  readonly favicons: FaviconStore;
  readonly permissions: PermissionStore;
  readonly importLog: ImportLogStore;

  private db: Database.Database;

  constructor(configDir: string) {
    fs.mkdirSync(configDir, { recursive: true });

    const dbPath = path.join(configDir, "browser-data.db");
    this.db = new Database(dbPath);

    // Enable WAL mode and foreign keys
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");

    // Run schema
    this.db.exec(BROWSER_DATA_SCHEMA);

    // Initialize sub-stores
    this.bookmarks = new BookmarkStore(this.db);
    this.history = new HistoryStore(this.db);
    this.passwords = new PasswordStore(this.db, configDir);
    this.cookies = new CookieStore(this.db);
    this.autofill = new AutofillStore(this.db);
    this.searchEngines = new SearchEngineStore(this.db);
    this.favicons = new FaviconStore(this.db);
    this.permissions = new PermissionStore(this.db);
    this.importLog = new ImportLogStore(this.db);
  }

  close(): void {
    this.db.close();
  }
}
