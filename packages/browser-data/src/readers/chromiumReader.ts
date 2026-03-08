import * as fs from "fs";
import * as path from "path";
import Database from "better-sqlite3";
import type {
  BrowserDataReader,
  BrowserName,
  CryptoProvider,
  ImportedBookmark,
  ImportedHistoryEntry,
  ImportedCookie,
  ImportedPassword,
  ImportedAutofillEntry,
  ImportedSearchEngine,
  ImportedExtension,
  ImportedPermission,
  ImportedSettings,
  ImportedFavicon,
  HistoryTransition,
} from "../types.js";
import { BrowserDataError } from "../errors.js";
import { copyDatabaseToTemp, cleanupTempCopy } from "../import/fileCopier.js";
import { chromeTimestampToMs } from "../normalize/history.js";
import { chromiumSameSite, chromiumSourceScheme, isHostOnlyCookie } from "../normalize/cookies.js";
import { normalizeFieldName } from "../normalize/autofill.js";
import { normalizeSearchUrl } from "../normalize/searchEngines.js";
import { parseChromiumManifest } from "../normalize/extensions.js";
import { chromiumSettingToPermission, mapChromiumPermissionName } from "../normalize/permissions.js";
import { extractChromiumSettings } from "../normalize/settings.js";
import { normalizeTitle } from "../normalize/bookmarks.js";

// Chrome transition types by core value (lower 8 bits)
const CHROME_TRANSITION_MAP: Record<number, HistoryTransition> = {
  0: "link",
  1: "typed",
  2: "auto_bookmark",
  3: "auto_subframe",
  4: "manual_subframe",
  5: "generated",
  6: "auto_toplevel",
  7: "form_submit",
  8: "reload",
  9: "keyword",
  10: "keyword_generated",
};

function chromeTransitionType(raw: number): HistoryTransition {
  const core = raw & 0xff;
  return CHROME_TRANSITION_MAP[core] || "link";
}

function readJsonFile(filePath: string): unknown {
  if (!fs.existsSync(filePath)) return null;
  const content = fs.readFileSync(filePath, "utf-8");
  return JSON.parse(content);
}

function tableExists(db: Database.Database, tableName: string): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
    .get(tableName) as { name: string } | undefined;
  return !!row;
}

async function withDatabase<T>(
  dbPath: string,
  fn: (db: Database.Database) => T,
): Promise<T> {
  const tempPath = await copyDatabaseToTemp(dbPath);
  try {
    const db = new Database(tempPath, { readonly: true });
    try {
      return fn(db);
    } finally {
      db.close();
    }
  } catch (err) {
    if (err instanceof BrowserDataError) throw err;
    const error = err as Error;
    if (error.message?.includes("SQLITE_CORRUPT") || error.message?.includes("database disk image is malformed")) {
      throw new BrowserDataError("DB_CORRUPT", `Database is corrupt: ${dbPath}`, error.message);
    }
    if (error.message?.includes("SQLITE_BUSY") || error.message?.includes("database is locked")) {
      throw new BrowserDataError("DB_LOCKED", `Database is locked: ${dbPath}`, error.message);
    }
    throw new BrowserDataError("SCHEMA_MISMATCH", `Failed to read database: ${dbPath}`, error.message);
  } finally {
    cleanupTempCopy(tempPath);
  }
}

/**
 * Reader for Chromium-family browsers (Chrome, Edge, Brave, Vivaldi, Opera, Arc).
 * Reads data from Bookmarks JSON, History/Cookies/Login Data/Web Data SQLite,
 * Preferences JSON, Extensions/ directory, etc.
 */
export class ChromiumReader implements BrowserDataReader {
  private cryptoProvider?: CryptoProvider;
  private browser?: BrowserName;

  constructor(options?: { cryptoProvider?: CryptoProvider; browser?: BrowserName }) {
    this.cryptoProvider = options?.cryptoProvider;
    this.browser = options?.browser;
  }

  async readBookmarks(profilePath: string): Promise<ImportedBookmark[]> {
    const bookmarksPath = path.join(profilePath, "Bookmarks");
    const data = readJsonFile(bookmarksPath);
    if (!data) return [];

    const roots = (data as Record<string, unknown>)["roots"] as Record<string, unknown> | undefined;
    if (!roots) return [];

    const bookmarks: ImportedBookmark[] = [];
    const rootKeys = ["bookmark_bar", "other", "synced"];

    for (const key of rootKeys) {
      const root = roots[key] as Record<string, unknown> | undefined;
      if (!root) continue;
      this.traverseBookmarkNode(root, [], bookmarks);
    }

    return bookmarks;
  }

  private traverseBookmarkNode(
    node: Record<string, unknown>,
    folderPath: string[],
    results: ImportedBookmark[],
  ): void {
    const type = node["type"] as string;
    const name = normalizeTitle(node["name"] as string);

    if (type === "url") {
      const url = node["url"] as string;
      if (!url) return;

      const dateAdded = node["date_added"] as string | undefined;
      const dateModified = node["date_modified"] as string | undefined;

      results.push({
        title: name,
        url,
        dateAdded: dateAdded ? chromeTimestampToMs(BigInt(dateAdded)) : 0,
        dateModified: dateModified ? chromeTimestampToMs(BigInt(dateModified)) : undefined,
        folder: folderPath,
      });
    } else if (type === "folder") {
      const children = node["children"] as Record<string, unknown>[] | undefined;
      if (!children) return;

      const newPath = name ? [...folderPath, name] : folderPath;
      for (const child of children) {
        this.traverseBookmarkNode(child, newPath, results);
      }
    }
  }

  async readHistory(profilePath: string): Promise<ImportedHistoryEntry[]> {
    const dbPath = path.join(profilePath, "History");
    if (!fs.existsSync(dbPath)) return [];

    return withDatabase(dbPath, (db) => {
      if (!tableExists(db, "urls") || !tableExists(db, "visits")) return [];

      const rows = db
        .prepare(
          `SELECT u.url, u.title, u.visit_count, u.typed_count, u.last_visit_time,
                  v.visit_time, v.transition
           FROM urls u
           LEFT JOIN visits v ON v.url = u.id
           ORDER BY v.visit_time DESC`,
        )
        .all() as Array<{
        url: string;
        title: string;
        visit_count: number;
        typed_count: number;
        last_visit_time: number | bigint;
        visit_time: number | bigint | null;
        transition: number | null;
      }>;

      // Group by URL, keeping earliest and latest visit times
      const byUrl = new Map<string, ImportedHistoryEntry>();
      for (const row of rows) {
        const existing = byUrl.get(row.url);
        const visitTime = row.visit_time ? chromeTimestampToMs(row.visit_time) : 0;
        const lastVisit = chromeTimestampToMs(row.last_visit_time);

        if (!existing) {
          byUrl.set(row.url, {
            url: row.url,
            title: row.title || "",
            visitCount: row.visit_count,
            lastVisitTime: lastVisit,
            firstVisitTime: visitTime || undefined,
            typedCount: row.typed_count || undefined,
            transition: row.transition != null ? chromeTransitionType(row.transition) : undefined,
          });
        } else {
          // Track earliest visit time
          if (visitTime && (!existing.firstVisitTime || visitTime < existing.firstVisitTime)) {
            existing.firstVisitTime = visitTime;
          }
        }
      }

      return Array.from(byUrl.values());
    });
  }

  async readCookies(profilePath: string): Promise<ImportedCookie[]> {
    const dbPath = path.join(profilePath, "Cookies");
    if (!fs.existsSync(dbPath)) return [];

    // Collect rows synchronously from the database
    const rawRows = await withDatabase(dbPath, (db) => {
      if (!tableExists(db, "cookies")) return [];

      return db
        .prepare(
          `SELECT host_key, name, value, encrypted_value, path,
                  expires_utc, is_secure, is_httponly, samesite,
                  source_scheme, source_port
           FROM cookies`,
        )
        .all() as Array<{
        host_key: string;
        name: string;
        value: string;
        encrypted_value: Buffer | null;
        path: string;
        expires_utc: number | bigint;
        is_secure: number;
        is_httponly: number;
        samesite: number;
        source_scheme: number;
        source_port: number;
      }>;
    });

    // Decrypt encrypted values (async) after DB is closed
    const localStatePath = path.join(path.dirname(profilePath), "Local State");
    const cookies: ImportedCookie[] = [];

    for (const row of rawRows) {
      const hasEncrypted = row.encrypted_value && row.encrypted_value.length > 0;
      let cookieValue = hasEncrypted ? "" : (row.value || "");

      if (hasEncrypted && this.cryptoProvider && this.browser) {
        try {
          cookieValue = await this.cryptoProvider.decryptChromiumValue(
            row.encrypted_value!, this.browser, localStatePath,
          );
        } catch {
          // Decryption failed — value stays empty
        }
      }

      const expiresUtc = Number(row.expires_utc);
      const expirationDate = expiresUtc > 0 ? chromeTimestampToMs(row.expires_utc) / 1000 : undefined;

      cookies.push({
        name: row.name,
        value: cookieValue,
        domain: row.host_key,
        hostOnly: isHostOnlyCookie(row.host_key),
        path: row.path,
        expirationDate,
        secure: row.is_secure === 1,
        httpOnly: row.is_httponly === 1,
        sameSite: chromiumSameSite(row.samesite),
        sourceScheme: chromiumSourceScheme(row.source_scheme),
        sourcePort: row.source_port || 0,
      });
    }

    return cookies;
  }

  async readPasswords(profilePath: string): Promise<ImportedPassword[]> {
    const dbPath = path.join(profilePath, "Login Data");
    if (!fs.existsSync(dbPath)) return [];

    // Collect rows synchronously from the database
    const rawRows = await withDatabase(dbPath, (db) => {
      if (!tableExists(db, "logins")) return [];

      return db
        .prepare(
          `SELECT origin_url, action_url, username_value, password_value,
                  date_created, date_last_used, date_password_modified, times_used
           FROM logins`,
        )
        .all() as Array<{
        origin_url: string;
        action_url: string;
        username_value: string;
        password_value: Buffer | null;
        date_created: number | bigint;
        date_last_used: number | bigint;
        date_password_modified: number | bigint;
        times_used: number;
      }>;
    });

    // Decrypt password values (async) after DB is closed
    const localStatePath = path.join(path.dirname(profilePath), "Local State");
    const passwords: ImportedPassword[] = [];

    for (const row of rawRows) {
      const dateCreated = Number(row.date_created);
      const dateLastUsed = Number(row.date_last_used);
      const datePasswordChanged = Number(row.date_password_modified);

      let decryptedPassword = "";
      if (row.password_value && row.password_value.length > 0 && this.cryptoProvider && this.browser) {
        try {
          decryptedPassword = await this.cryptoProvider.decryptChromiumValue(
            row.password_value, this.browser, localStatePath,
          );
        } catch {
          // Decryption failed — password stays empty
        }
      }

      passwords.push({
        url: row.origin_url,
        actionUrl: row.action_url || undefined,
        username: row.username_value || "",
        password: decryptedPassword,
        dateCreated: dateCreated > 0 ? chromeTimestampToMs(row.date_created) : undefined,
        dateLastUsed: dateLastUsed > 0 ? chromeTimestampToMs(row.date_last_used) : undefined,
        datePasswordChanged: datePasswordChanged > 0 ? chromeTimestampToMs(row.date_password_modified) : undefined,
        timesUsed: row.times_used || undefined,
      });
    }

    return passwords;
  }

  async readAutofill(profilePath: string): Promise<ImportedAutofillEntry[]> {
    const dbPath = path.join(profilePath, "Web Data");
    if (!fs.existsSync(dbPath)) return [];

    return withDatabase(dbPath, (db) => {
      if (!tableExists(db, "autofill")) return [];

      const rows = db
        .prepare(
          `SELECT name, value, date_created, date_last_used, count
           FROM autofill`,
        )
        .all() as Array<{
        name: string;
        value: string;
        date_created: number | bigint;
        date_last_used: number | bigint;
        count: number;
      }>;

      return rows.map((row) => {
        const dateCreated = Number(row.date_created);
        const dateLastUsed = Number(row.date_last_used);

        return {
          fieldName: normalizeFieldName(row.name),
          value: row.value,
          dateCreated: dateCreated > 0 ? chromeTimestampToMs(row.date_created) : undefined,
          dateLastUsed: dateLastUsed > 0 ? chromeTimestampToMs(row.date_last_used) : undefined,
          timesUsed: row.count || 0,
        };
      });
    });
  }

  async readSearchEngines(profilePath: string): Promise<ImportedSearchEngine[]> {
    const dbPath = path.join(profilePath, "Web Data");
    if (!fs.existsSync(dbPath)) return [];

    return withDatabase(dbPath, (db) => {
      if (!tableExists(db, "keywords")) return [];

      const rows = db
        .prepare(
          `SELECT short_name, keyword, url, suggestions_url, favicon_url, is_active
           FROM keywords`,
        )
        .all() as Array<{
        short_name: string;
        keyword: string;
        url: string;
        suggestions_url: string;
        favicon_url: string;
        is_active: number;
      }>;

      return rows.map((row) => ({
        name: row.short_name || "",
        keyword: row.keyword || undefined,
        searchUrl: normalizeSearchUrl(row.url || ""),
        suggestUrl: row.suggestions_url ? normalizeSearchUrl(row.suggestions_url) : undefined,
        faviconUrl: row.favicon_url || undefined,
        isDefault: row.is_active === 1,
      }));
    });
  }

  async readExtensions(profilePath: string): Promise<ImportedExtension[]> {
    const extensionsDir = path.join(profilePath, "Extensions");
    const prefsPath = path.join(profilePath, "Preferences");

    // Read enabled states from Preferences
    const enabledStates = new Map<string, boolean>();
    const prefs = readJsonFile(prefsPath) as Record<string, unknown> | null;
    if (prefs) {
      const extensions = prefs["extensions"] as Record<string, unknown> | undefined;
      const settings = extensions?.["settings"] as Record<string, Record<string, unknown>> | undefined;
      if (settings) {
        for (const [id, extSettings] of Object.entries(settings)) {
          const state = extSettings["state"] as number | undefined;
          // state: 0=disabled, 1=enabled, undefined=enabled
          enabledStates.set(id, state !== 0);
        }
      }
    }

    if (!fs.existsSync(extensionsDir)) return [];

    const results: ImportedExtension[] = [];

    let extDirs: string[];
    try {
      extDirs = fs.readdirSync(extensionsDir);
    } catch {
      return [];
    }

    for (const extId of extDirs) {
      const extPath = path.join(extensionsDir, extId);
      let stat: fs.Stats;
      try {
        stat = fs.statSync(extPath);
      } catch {
        continue;
      }
      if (!stat.isDirectory()) continue;

      // Find the latest version directory
      let versionDirs: string[];
      try {
        versionDirs = fs.readdirSync(extPath);
      } catch {
        continue;
      }

      // Sort version directories descending to get the latest
      versionDirs.sort().reverse();

      for (const version of versionDirs) {
        const manifestPath = path.join(extPath, version, "manifest.json");
        if (!fs.existsSync(manifestPath)) continue;

        try {
          const manifest = readJsonFile(manifestPath) as Record<string, unknown>;
          if (!manifest) continue;

          const enabled = enabledStates.get(extId) ?? true;
          results.push(parseChromiumManifest(manifest, extId, enabled));
        } catch {
          // Skip extensions with unreadable manifests
        }
        break; // Only process latest version
      }
    }

    return results;
  }

  async readPermissions(profilePath: string): Promise<ImportedPermission[]> {
    const prefsPath = path.join(profilePath, "Preferences");
    const prefs = readJsonFile(prefsPath) as Record<string, unknown> | null;
    if (!prefs) return [];

    const profile = prefs["profile"] as Record<string, unknown> | undefined;
    const contentSettings = profile?.["content_settings"] as Record<string, unknown> | undefined;
    const exceptions = contentSettings?.["exceptions"] as Record<string, Record<string, Record<string, unknown>>> | undefined;
    if (!exceptions) return [];

    const results: ImportedPermission[] = [];

    for (const [permType, origins] of Object.entries(exceptions)) {
      const permissionName = mapChromiumPermissionName(permType);

      for (const [origin, settingObj] of Object.entries(origins)) {
        if (!settingObj || typeof settingObj !== "object") continue;

        const settingValue = settingObj["setting"] as number | string | undefined;
        if (settingValue === undefined) continue;

        // Strip trailing comma and wildcards that Chrome adds to origins
        const cleanOrigin = origin.replace(/,\*$/, "").replace(/,\s*$/, "");

        results.push({
          origin: cleanOrigin,
          permission: permissionName,
          setting: chromiumSettingToPermission(settingValue),
        });
      }
    }

    return results;
  }

  async readSettings(profilePath: string): Promise<ImportedSettings> {
    const prefsPath = path.join(profilePath, "Preferences");
    const prefs = readJsonFile(prefsPath) as Record<string, unknown> | null;
    if (!prefs) return {};

    return extractChromiumSettings(prefs);
  }

  async readFavicons(profilePath: string): Promise<ImportedFavicon[]> {
    const dbPath = path.join(profilePath, "Favicons");
    if (!fs.existsSync(dbPath)) return [];

    return withDatabase(dbPath, (db) => {
      if (
        !tableExists(db, "favicons") ||
        !tableExists(db, "favicon_bitmaps") ||
        !tableExists(db, "icon_mapping")
      ) {
        return [];
      }

      const rows = db
        .prepare(
          `SELECT im.page_url, fb.image_data, f.icon_type
           FROM icon_mapping im
           JOIN favicons f ON f.id = im.icon_id
           JOIN favicon_bitmaps fb ON fb.icon_id = f.id
           WHERE fb.image_data IS NOT NULL AND length(fb.image_data) > 0`,
        )
        .all() as Array<{
        page_url: string;
        image_data: Buffer;
        icon_type: number;
      }>;

      return rows.map((row) => ({
        url: row.page_url,
        data: Buffer.from(row.image_data),
        mimeType: row.icon_type === 2 ? "image/x-icon" : "image/png",
      }));
    });
  }
}
