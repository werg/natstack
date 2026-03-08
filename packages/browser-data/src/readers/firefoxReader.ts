import * as fs from "fs";
import * as path from "path";
import Database from "better-sqlite3";
import type {
  BrowserDataReader,
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
  SameSiteValue,
} from "../types.js";
import { BrowserDataError } from "../errors.js";
import { copyDatabaseToTemp, cleanupTempCopy } from "../import/fileCopier.js";
import { buildFolderPath, normalizeTitle } from "../normalize/bookmarks.js";
import { firefoxTimestampToMs } from "../normalize/history.js";
import { isHostOnlyCookie, normalizeCookieExpiry } from "../normalize/cookies.js";
import { normalizeFieldName } from "../normalize/autofill.js";
import { normalizeFirefoxSearchUrl } from "../normalize/searchEngines.js";
import { parseFirefoxExtension } from "../normalize/extensions.js";
import { firefoxPermissionToSetting, mapFirefoxPermissionType } from "../normalize/permissions.js";
import { extractFirefoxSettings } from "../normalize/settings.js";

// Firefox root bookmark folder IDs
const FIREFOX_ROOT_IDS = new Set([1, 2, 3, 4, 5]);
// 1=root, 2=menu, 3=toolbar, 4=tags, 5=other/unsorted

/**
 * Parse Firefox prefs.js content into a Map of key->value.
 * Lines look like: user_pref("key", value);
 */
export function parsePrefsJs(content: string): Map<string, unknown> {
  const prefs = new Map<string, unknown>();
  const lines = content.split("\n");

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("user_pref(")) continue;

    // Match: user_pref("key", value);
    const match = trimmed.match(/^user_pref\("([^"]+)",\s*(.*)\);$/);
    if (!match) continue;

    const key = match[1]!;
    const rawValue = match[2]!.trim();

    let value: unknown;
    if (rawValue === "true") {
      value = true;
    } else if (rawValue === "false") {
      value = false;
    } else if (rawValue.startsWith('"') && rawValue.endsWith('"')) {
      // String value - unescape basic escapes
      value = rawValue.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
    } else if (!isNaN(Number(rawValue))) {
      value = Number(rawValue);
    } else {
      value = rawValue;
    }

    prefs.set(key, value);
  }

  return prefs;
}

/**
 * Decompress Mozilla LZ4 block format (mozLz4).
 * File format: 8-byte magic "mozLz40\0", 4-byte LE uncompressed size, then LZ4 block data.
 */
export function decompressMozLz4(data: Buffer): Buffer {
  const MAGIC = "mozLz40\0";
  const magicBytes = data.subarray(0, 8).toString("ascii");
  if (magicBytes !== MAGIC) {
    throw new BrowserDataError(
      "LZ4_DECOMPRESS_FAILED",
      "Invalid mozLz4 magic header",
    );
  }

  const uncompressedSize = data.readUInt32LE(8);
  const compressed = data.subarray(12);
  const output = Buffer.alloc(uncompressedSize);

  let srcPos = 0;
  let dstPos = 0;

  while (srcPos < compressed.length && dstPos < uncompressedSize) {
    const token = compressed[srcPos++]!;

    // Literal length
    let literalLength = (token >> 4) & 0x0f;
    if (literalLength === 15) {
      let extra: number;
      do {
        extra = compressed[srcPos++]!;
        literalLength += extra;
      } while (extra === 0xff);
    }

    // Copy literals
    if (literalLength > 0) {
      compressed.copy(output, dstPos, srcPos, srcPos + literalLength);
      srcPos += literalLength;
      dstPos += literalLength;
    }

    // Check if we're done (last sequence may have no match)
    if (dstPos >= uncompressedSize || srcPos >= compressed.length) break;

    // Match offset (2 bytes little-endian)
    const offset = compressed[srcPos]! | (compressed[srcPos + 1]! << 8);
    srcPos += 2;

    if (offset === 0) {
      throw new BrowserDataError(
        "LZ4_DECOMPRESS_FAILED",
        "Invalid LZ4 offset of 0",
      );
    }

    // Match length (minimum match is 4)
    let matchLength = token & 0x0f;
    if (matchLength === 15) {
      let extra: number;
      do {
        extra = compressed[srcPos++]!;
        matchLength += extra;
      } while (extra === 0xff);
    }
    matchLength += 4; // LZ4 minimum match length

    // Copy match bytes (may overlap, so copy byte-by-byte)
    const matchStart = dstPos - offset;
    for (let i = 0; i < matchLength && dstPos < uncompressedSize; i++) {
      output[dstPos++] = output[matchStart + i]!;
    }
  }

  return output.subarray(0, dstPos);
}

/**
 * Helper to open a SQLite database from the profile, copying to temp first.
 * Returns [db, tempPath] so caller can clean up.
 */
async function openProfileDb(
  profilePath: string,
  dbName: string,
): Promise<[Database.Database, string]> {
  const dbPath = path.join(profilePath, dbName);
  const tempPath = await copyDatabaseToTemp(dbPath);
  try {
    const db = new Database(tempPath, { readonly: true });
    return [db, tempPath];
  } catch (err: unknown) {
    cleanupTempCopy(tempPath);
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("not a database") || message.includes("malformed")) {
      throw new BrowserDataError("DB_CORRUPT", `Database is corrupt: ${dbName}`, message);
    }
    throw new BrowserDataError("DB_LOCKED", `Failed to open database: ${dbName}`, message);
  }
}

/**
 * Map Firefox sameSite integer to our SameSiteValue.
 * Firefox uses: 0=none, 1=lax, 2=strict
 */
function firefoxSameSite(value: number): SameSiteValue {
  switch (value) {
    case 0: return "no_restriction";
    case 1: return "lax";
    case 2: return "strict";
    default: return "unspecified";
  }
}

/**
 * Reader for Firefox-family browsers (Firefox, Zen).
 * Reads data from places.sqlite, cookies.sqlite, formhistory.sqlite,
 * logins.json, prefs.js, search.json.mozlz4, extensions.json, etc.
 */
export class FirefoxReader implements BrowserDataReader {
  async readBookmarks(profilePath: string): Promise<ImportedBookmark[]> {
    const [db, tempPath] = await openProfileDb(profilePath, "places.sqlite");
    try {
      // First, build folder map from all folders
      const folderRows = db.prepare(`
        SELECT b.id, b.title, b.parent
        FROM moz_bookmarks b
        WHERE b.type = 2
      `).all() as Array<{ id: number; title: string; parent: number }>;

      const parentMap = new Map<number, { title: string; parentId: number }>();
      for (const row of folderRows) {
        parentMap.set(row.id, { title: row.title || "", parentId: row.parent });
      }

      // Query actual bookmarks (type=1)
      const rows = db.prepare(`
        SELECT b.id, b.title, b.parent, b.dateAdded, b.lastModified, b.keyword_id,
               p.url
        FROM moz_bookmarks b
        JOIN moz_places p ON b.fk = p.id
        WHERE b.type = 1
          AND p.url IS NOT NULL
          AND p.url NOT LIKE 'place:%'
      `).all() as Array<{
        id: number;
        title: string | null;
        parent: number;
        dateAdded: number;
        lastModified: number | null;
        keyword_id: number | null;
        url: string;
      }>;

      // Try to get keywords
      let keywordMap = new Map<number, string>();
      try {
        const keywordRows = db.prepare(
          "SELECT id, keyword FROM moz_keywords",
        ).all() as Array<{ id: number; keyword: string }>;
        for (const kw of keywordRows) {
          keywordMap.set(kw.id, kw.keyword);
        }
      } catch {
        // moz_keywords may not exist in older Firefox versions
      }

      const bookmarks: ImportedBookmark[] = [];
      for (const row of rows) {
        const folder = buildFolderPath(row.parent, parentMap, FIREFOX_ROOT_IDS);
        const keyword = row.keyword_id ? keywordMap.get(row.keyword_id) : undefined;

        bookmarks.push({
          title: normalizeTitle(row.title),
          url: row.url,
          dateAdded: firefoxTimestampToMs(row.dateAdded),
          dateModified: row.lastModified
            ? firefoxTimestampToMs(row.lastModified)
            : undefined,
          folder,
          keyword,
        });
      }

      return bookmarks;
    } finally {
      db.close();
      cleanupTempCopy(tempPath);
    }
  }

  async readHistory(profilePath: string): Promise<ImportedHistoryEntry[]> {
    const [db, tempPath] = await openProfileDb(profilePath, "places.sqlite");
    try {
      const rows = db.prepare(`
        SELECT p.url, p.title, p.visit_count, p.typed,
               MAX(v.visit_date) as last_visit,
               MIN(v.visit_date) as first_visit
        FROM moz_places p
        JOIN moz_historyvisits v ON p.id = v.place_id
        WHERE p.url IS NOT NULL
          AND p.url NOT LIKE 'place:%'
        GROUP BY p.id
        ORDER BY last_visit DESC
      `).all() as Array<{
        url: string;
        title: string | null;
        visit_count: number;
        typed: number;
        last_visit: number;
        first_visit: number;
      }>;

      return rows.map((row) => ({
        url: row.url,
        title: row.title || "",
        visitCount: row.visit_count,
        lastVisitTime: firefoxTimestampToMs(row.last_visit),
        firstVisitTime: firefoxTimestampToMs(row.first_visit),
        typedCount: row.typed || undefined,
      }));
    } finally {
      db.close();
      cleanupTempCopy(tempPath);
    }
  }

  async readCookies(profilePath: string): Promise<ImportedCookie[]> {
    const [db, tempPath] = await openProfileDb(profilePath, "cookies.sqlite");
    try {
      const rows = db.prepare(`
        SELECT name, value, host, path, expiry, isSecure, isHttpOnly, sameSite,
               originAttributes
        FROM moz_cookies
      `).all() as Array<{
        name: string;
        value: string;
        host: string;
        path: string;
        expiry: number;
        isSecure: number;
        isHttpOnly: number;
        sameSite: number;
        originAttributes: string;
      }>;

      return rows.map((row) => {
        const domain = row.host;
        const secure = row.isSecure === 1;
        return {
          name: row.name,
          value: row.value,
          domain,
          hostOnly: isHostOnlyCookie(domain),
          path: row.path,
          expirationDate: normalizeCookieExpiry(row.expiry, false),
          secure,
          httpOnly: row.isHttpOnly === 1,
          sameSite: firefoxSameSite(row.sameSite),
          sourceScheme: secure ? "secure" as const : "non_secure" as const,
          sourcePort: secure ? 443 : 80,
        };
      });
    } finally {
      db.close();
      cleanupTempCopy(tempPath);
    }
  }

  async readPasswords(profilePath: string): Promise<ImportedPassword[]> {
    const loginsPath = path.join(profilePath, "logins.json");
    if (!fs.existsSync(loginsPath)) {
      return [];
    }

    try {
      const content = fs.readFileSync(loginsPath, "utf-8");
      const data = JSON.parse(content) as {
        logins: Array<{
          hostname: string;
          formSubmitURL?: string;
          httpRealm?: string;
          encryptedUsername: string;
          encryptedPassword: string;
          timeCreated?: number;
          timeLastUsed?: number;
          timePasswordChanged?: number;
          timesUsed?: number;
        }>;
      };

      if (!data.logins || !Array.isArray(data.logins)) {
        return [];
      }

      return data.logins.map((login) => ({
        url: login.hostname,
        actionUrl: login.formSubmitURL || undefined,
        username: login.encryptedUsername,
        password: login.encryptedPassword,
        realm: login.httpRealm || undefined,
        dateCreated: login.timeCreated,
        dateLastUsed: login.timeLastUsed,
        datePasswordChanged: login.timePasswordChanged,
        timesUsed: login.timesUsed,
      }));
    } catch (err: unknown) {
      if (err instanceof BrowserDataError) throw err;
      const message = err instanceof Error ? err.message : String(err);
      throw new BrowserDataError(
        "SCHEMA_MISMATCH",
        "Failed to parse logins.json",
        message,
      );
    }
  }

  async readAutofill(profilePath: string): Promise<ImportedAutofillEntry[]> {
    const dbPath = path.join(profilePath, "formhistory.sqlite");
    if (!fs.existsSync(dbPath)) {
      return [];
    }

    const [db, tempPath] = await openProfileDb(profilePath, "formhistory.sqlite");
    try {
      const rows = db.prepare(`
        SELECT fieldname, value, timesUsed, firstUsed, lastUsed
        FROM moz_formhistory
      `).all() as Array<{
        fieldname: string;
        value: string;
        timesUsed: number;
        firstUsed: number;
        lastUsed: number;
      }>;

      return rows.map((row) => ({
        fieldName: normalizeFieldName(row.fieldname),
        value: row.value,
        dateCreated: row.firstUsed ? firefoxTimestampToMs(row.firstUsed) : undefined,
        dateLastUsed: row.lastUsed ? firefoxTimestampToMs(row.lastUsed) : undefined,
        timesUsed: row.timesUsed,
      }));
    } finally {
      db.close();
      cleanupTempCopy(tempPath);
    }
  }

  async readSearchEngines(profilePath: string): Promise<ImportedSearchEngine[]> {
    const searchJsonPath = path.join(profilePath, "search.json.mozlz4");
    if (!fs.existsSync(searchJsonPath)) {
      return [];
    }

    try {
      const compressedData = fs.readFileSync(searchJsonPath);
      const decompressed = decompressMozLz4(compressedData);
      const jsonStr = decompressed.toString("utf-8");
      const data = JSON.parse(jsonStr) as {
        engines?: Array<{
          _name: string;
          _urls?: Array<{
            template: string;
            type?: string;
            params?: Array<{ name: string; value: string }>;
          }>;
          _iconURL?: string;
          _isDefault?: boolean;
        }>;
        defaultEngineId?: string;
      };

      if (!data.engines || !Array.isArray(data.engines)) {
        return [];
      }

      const defaultName = data.defaultEngineId;

      return data.engines
        .filter((engine) => {
          // Must have at least one search URL
          return engine._urls && engine._urls.length > 0;
        })
        .map((engine) => {
          const searchUrlEntry = engine._urls!.find(
            (u) => !u.type || u.type === "text/html",
          ) || engine._urls![0];

          const suggestUrlEntry = engine._urls!.find(
            (u) => u.type === "application/x-suggestions+json",
          );

          let searchUrl = normalizeFirefoxSearchUrl(searchUrlEntry!.template);
          // Append params if present
          if (searchUrlEntry!.params && searchUrlEntry!.params.length > 0) {
            const params = searchUrlEntry!.params
              .map((p) => `${p.name}=${p.value}`)
              .join("&");
            searchUrl += (searchUrl.includes("?") ? "&" : "?") + params;
          }

          return {
            name: engine._name,
            searchUrl,
            suggestUrl: suggestUrlEntry
              ? normalizeFirefoxSearchUrl(suggestUrlEntry.template)
              : undefined,
            faviconUrl: engine._iconURL || undefined,
            isDefault: engine._name === defaultName || engine._isDefault === true,
          };
        });
    } catch (err: unknown) {
      if (err instanceof BrowserDataError) throw err;
      const message = err instanceof Error ? err.message : String(err);
      throw new BrowserDataError(
        "LZ4_DECOMPRESS_FAILED",
        "Failed to read search engines",
        message,
      );
    }
  }

  async readExtensions(profilePath: string): Promise<ImportedExtension[]> {
    const extensionsPath = path.join(profilePath, "extensions.json");
    if (!fs.existsSync(extensionsPath)) {
      return [];
    }

    try {
      const content = fs.readFileSync(extensionsPath, "utf-8");
      const data = JSON.parse(content) as {
        addons?: Array<Record<string, unknown>>;
      };

      if (!data.addons || !Array.isArray(data.addons)) {
        return [];
      }

      return data.addons
        .filter((addon) => {
          // Skip system/built-in addons and themes
          const type = addon["type"] as string | undefined;
          return type === "extension";
        })
        .map((addon) => parseFirefoxExtension(addon));
    } catch (err: unknown) {
      if (err instanceof BrowserDataError) throw err;
      const message = err instanceof Error ? err.message : String(err);
      throw new BrowserDataError(
        "SCHEMA_MISMATCH",
        "Failed to parse extensions.json",
        message,
      );
    }
  }

  async readPermissions(profilePath: string): Promise<ImportedPermission[]> {
    const dbPath = path.join(profilePath, "permissions.sqlite");
    if (!fs.existsSync(dbPath)) {
      return [];
    }

    const [db, tempPath] = await openProfileDb(profilePath, "permissions.sqlite");
    try {
      const rows = db.prepare(`
        SELECT origin, type, permission
        FROM moz_perms
      `).all() as Array<{
        origin: string;
        type: string;
        permission: number;
      }>;

      return rows.map((row) => ({
        origin: row.origin,
        permission: mapFirefoxPermissionType(row.type),
        setting: firefoxPermissionToSetting(row.permission),
      }));
    } finally {
      db.close();
      cleanupTempCopy(tempPath);
    }
  }

  async readSettings(profilePath: string): Promise<ImportedSettings> {
    const prefsPath = path.join(profilePath, "prefs.js");
    if (!fs.existsSync(prefsPath)) {
      return {};
    }

    try {
      const content = fs.readFileSync(prefsPath, "utf-8");
      const prefsMap = parsePrefsJs(content);
      return extractFirefoxSettings(prefsMap);
    } catch (err: unknown) {
      if (err instanceof BrowserDataError) throw err;
      const message = err instanceof Error ? err.message : String(err);
      throw new BrowserDataError(
        "SCHEMA_MISMATCH",
        "Failed to parse prefs.js",
        message,
      );
    }
  }

  async readFavicons(profilePath: string): Promise<ImportedFavicon[]> {
    const dbPath = path.join(profilePath, "favicons.sqlite");
    if (!fs.existsSync(dbPath)) {
      return [];
    }

    const [db, tempPath] = await openProfileDb(profilePath, "favicons.sqlite");
    try {
      const rows = db.prepare(`
        SELECT DISTINCT i.icon_url, i.data, i.width,
               p.page_url
        FROM moz_icons i
        JOIN moz_icons_to_pages ip ON i.id = ip.icon_id
        JOIN moz_pages_w_icons p ON ip.page_id = p.id
        WHERE i.data IS NOT NULL
          AND length(i.data) > 0
      `).all() as Array<{
        icon_url: string;
        data: Buffer;
        width: number;
        page_url: string;
      }>;

      return rows.map((row) => {
        // Determine mime type from icon_url or data
        let mimeType = "image/png"; // default
        const iconUrl = row.icon_url || "";
        if (iconUrl.includes(".svg")) {
          mimeType = "image/svg+xml";
        } else if (iconUrl.includes(".ico")) {
          mimeType = "image/x-icon";
        } else if (iconUrl.includes(".jpg") || iconUrl.includes(".jpeg")) {
          mimeType = "image/jpeg";
        }

        return {
          url: row.page_url,
          data: Buffer.from(row.data),
          mimeType,
        };
      });
    } finally {
      db.close();
      cleanupTempCopy(tempPath);
    }
  }
}
