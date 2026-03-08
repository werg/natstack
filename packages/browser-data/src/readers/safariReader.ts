import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import Database from "better-sqlite3";
import bplist from "bplist-parser";
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
} from "../types.js";
import { BrowserDataError } from "../errors.js";
import { macTimestampToMs } from "../normalize/history.js";
import { copyDatabaseToTemp, cleanupTempCopy } from "../import/fileCopier.js";

// ---- Binary cookies parser ----

interface RawCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expirationDate: number;
  creationDate: number;
  flags: number;
}

function readNullTerminatedString(buf: Buffer, offset: number): string {
  let end = offset;
  while (end < buf.length && buf[end] !== 0) {
    end++;
  }
  return buf.subarray(offset, end).toString("utf-8");
}

function parseCookieRecord(buf: Buffer): RawCookie {
  // Cookie record layout (all little-endian unless noted):
  // 0: size (4 bytes LE)
  // 4: flags (4 bytes LE)
  // 8: url/domain offset (4 bytes LE)
  // 12: name offset (4 bytes LE)
  // 16: path offset (4 bytes LE)
  // 20: value offset (4 bytes LE)
  // 24: comment (8 bytes, skip)
  // 32: expiry date (8 bytes LE double, Mac epoch)
  // 40: creation date (8 bytes LE double, Mac epoch)
  const flags = buf.readUInt32LE(4);
  const domainOffset = buf.readUInt32LE(8);
  const nameOffset = buf.readUInt32LE(12);
  const pathOffset = buf.readUInt32LE(16);
  const valueOffset = buf.readUInt32LE(20);
  const expirationDate = buf.readDoubleLE(32);
  const creationDate = buf.readDoubleLE(40);

  const domain = readNullTerminatedString(buf, domainOffset);
  const name = readNullTerminatedString(buf, nameOffset);
  const cookiePath = readNullTerminatedString(buf, pathOffset);
  const value = readNullTerminatedString(buf, valueOffset);

  return {
    name,
    value,
    domain,
    path: cookiePath,
    expirationDate,
    creationDate,
    flags,
  };
}

/**
 * Parse Safari's Cookies.binarycookies file format.
 *
 * Format:
 * - Header: "cook" (4 bytes)
 * - Number of pages (4 bytes big-endian)
 * - Page sizes array (4 bytes each, big-endian)
 * - Pages follow contiguously
 * - Each page:
 *   - Page header: 0x00000100 (4 bytes)
 *   - Number of cookies (4 bytes LE)
 *   - Cookie offsets (4 bytes LE each)
 *   - Cookie records at those offsets within the page
 */
export function parseBinaryCookies(data: Buffer): RawCookie[] {
  if (data.length < 8) {
    return [];
  }

  const magic = data.subarray(0, 4).toString("ascii");
  if (magic !== "cook") {
    throw new BrowserDataError(
      "SCHEMA_MISMATCH",
      "Not a valid Safari binary cookies file",
    );
  }

  const numPages = data.readUInt32BE(4);
  const pageSizes: number[] = [];
  let offset = 8;

  for (let i = 0; i < numPages; i++) {
    pageSizes.push(data.readUInt32BE(offset));
    offset += 4;
  }

  const cookies: RawCookie[] = [];

  for (let i = 0; i < numPages; i++) {
    const pageStart = offset;
    const pageData = data.subarray(pageStart, pageStart + pageSizes[i]!);

    // Page header should be 0x00000100
    // const pageHeader = pageData.readUInt32BE(0);
    const numCookies = pageData.readUInt32LE(4);

    const cookieOffsets: number[] = [];
    for (let j = 0; j < numCookies; j++) {
      cookieOffsets.push(pageData.readUInt32LE(8 + j * 4));
    }

    for (const cookieOffset of cookieOffsets) {
      try {
        const cookieData = pageData.subarray(cookieOffset);
        cookies.push(parseCookieRecord(cookieData));
      } catch {
        // Skip malformed cookies
      }
    }

    offset += pageSizes[i]!;
  }

  return cookies;
}

// ---- CSV password parser ----

/**
 * Parse a CSV password export file from Safari.
 * Expected columns: Title,URL,Username,Password,Notes,OTPAuth
 */
export function parseSafariPasswordCsv(content: string): ImportedPassword[] {
  const lines = content.split("\n");
  if (lines.length < 2) return [];

  const header = parseCSVLine(lines[0]!);
  const urlIdx = header.findIndex((h) => h.toLowerCase() === "url");
  const usernameIdx = header.findIndex(
    (h) => h.toLowerCase() === "username",
  );
  const passwordIdx = header.findIndex(
    (h) => h.toLowerCase() === "password",
  );
  const titleIdx = header.findIndex((h) => h.toLowerCase() === "title");

  if (urlIdx === -1 || usernameIdx === -1 || passwordIdx === -1) {
    return [];
  }

  const passwords: ImportedPassword[] = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (!line) continue;

    const fields = parseCSVLine(line);
    const url = fields[urlIdx] ?? "";
    const username = fields[usernameIdx] ?? "";
    const password = fields[passwordIdx] ?? "";

    if (!url && !username) continue;

    passwords.push({
      url,
      username,
      password,
      realm: titleIdx !== -1 ? fields[titleIdx] : undefined,
    });
  }

  return passwords;
}

function parseCSVLine(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;
  let i = 0;

  while (i < line.length) {
    const ch = line[i];

    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < line.length && line[i + 1] === '"') {
          current += '"';
          i += 2;
        } else {
          inQuotes = false;
          i++;
        }
      } else {
        current += ch;
        i++;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
        i++;
      } else if (ch === ",") {
        fields.push(current);
        current = "";
        i++;
      } else {
        current += ch;
        i++;
      }
    }
  }

  fields.push(current);
  return fields;
}

// ---- Bookmark plist traversal ----

interface PlistBookmarkNode {
  WebBookmarkType: string;
  URLString?: string;
  URIDictionary?: { title?: string };
  Title?: string;
  Children?: PlistBookmarkNode[];
  ReadingList?: Record<string, unknown>;
  ReadingListNonSync?: { Title?: string };
}

function extractBookmarks(
  node: PlistBookmarkNode,
  folderPath: string[],
): ImportedBookmark[] {
  const results: ImportedBookmark[] = [];

  if (node.WebBookmarkType === "WebBookmarkTypeLeaf") {
    const url = node.URLString;
    if (url) {
      const title =
        node.URIDictionary?.title ||
        node.ReadingListNonSync?.Title ||
        url;
      results.push({
        title,
        url,
        dateAdded: Date.now(),
        folder: folderPath,
      });
    }
  } else if (
    node.WebBookmarkType === "WebBookmarkTypeList" &&
    node.Children
  ) {
    let currentFolder = folderPath;
    if (node.Title && node.Title !== "") {
      // Map Safari internal folder names to friendlier names
      const folderName =
        node.Title === "com.apple.ReadingList"
          ? "Reading List"
          : node.Title === "BookmarksBar"
            ? "Bookmarks Bar"
            : node.Title === "BookmarksMenu"
              ? "Bookmarks Menu"
              : node.Title;
      currentFolder = [...folderPath, folderName];
    }
    for (const child of node.Children) {
      results.push(...extractBookmarks(child, currentFolder));
    }
  }

  return results;
}

// ---- TCC error helper ----

function handleAccessError(err: unknown, context: string): never {
  const error = err as NodeJS.ErrnoException;
  if (error.code === "EPERM" || error.code === "EACCES") {
    throw new BrowserDataError(
      "TCC_ACCESS_DENIED",
      `macOS denied access to ${context}. Grant Full Disk Access in System Settings > Privacy & Security.`,
      error.code,
    );
  }
  throw err;
}

/**
 * Reader for Safari (macOS only).
 * Reads data from Bookmarks.plist, History.db, Cookies.binarycookies,
 * PerSitePreferences.db, and user-exported CSV for passwords.
 */
export class SafariReader implements BrowserDataReader {
  async readBookmarks(profilePath: string): Promise<ImportedBookmark[]> {
    const plistPath = path.join(profilePath, "Bookmarks.plist");
    if (!fs.existsSync(plistPath)) {
      return [];
    }

    try {
      const result = bplist.parseFileSync(plistPath);
      const root = result[0] as PlistBookmarkNode;
      return extractBookmarks(root, []);
    } catch (err: unknown) {
      const error = err as NodeJS.ErrnoException;
      if (error.code === "EPERM" || error.code === "EACCES") {
        handleAccessError(err, "Safari bookmarks");
      }
      throw err;
    }
  }

  async readHistory(profilePath: string): Promise<ImportedHistoryEntry[]> {
    const dbPath = path.join(profilePath, "History.db");
    if (!fs.existsSync(dbPath)) {
      return [];
    }

    let tempPath: string | undefined;
    try {
      tempPath = await copyDatabaseToTemp(dbPath);
      const db = new Database(tempPath, { readonly: true });

      try {
        const rows = db
          .prepare(
            `SELECT
              hi.url,
              hi.visit_count,
              hv.title,
              hv.visit_time
            FROM history_items hi
            JOIN history_visits hv ON hv.history_item = hi.id
            ORDER BY hv.visit_time DESC`,
          )
          .all() as Array<{
          url: string;
          visit_count: number;
          title: string | null;
          visit_time: number;
        }>;

        // Group by URL, take latest visit time
        const byUrl = new Map<string, ImportedHistoryEntry>();
        for (const row of rows) {
          const visitTimeMs = macTimestampToMs(row.visit_time);
          const existing = byUrl.get(row.url);
          if (!existing) {
            byUrl.set(row.url, {
              url: row.url,
              title: row.title || "",
              visitCount: row.visit_count,
              lastVisitTime: visitTimeMs,
              firstVisitTime: visitTimeMs,
            });
          } else {
            if (visitTimeMs > existing.lastVisitTime) {
              existing.lastVisitTime = visitTimeMs;
              if (row.title) existing.title = row.title;
            }
            if (
              existing.firstVisitTime === undefined ||
              visitTimeMs < existing.firstVisitTime
            ) {
              existing.firstVisitTime = visitTimeMs;
            }
          }
        }

        return Array.from(byUrl.values());
      } finally {
        db.close();
      }
    } catch (err: unknown) {
      const error = err as NodeJS.ErrnoException;
      if (error.code === "EPERM" || error.code === "EACCES") {
        handleAccessError(err, "Safari history");
      }
      if (
        err instanceof BrowserDataError &&
        err.code === "TCC_ACCESS_DENIED"
      ) {
        throw err;
      }
      if (err instanceof BrowserDataError) {
        throw err;
      }
      throw err;
    } finally {
      if (tempPath) cleanupTempCopy(tempPath);
    }
  }

  async readCookies(_profilePath: string): Promise<ImportedCookie[]> {
    // Safari cookies are stored at ~/Library/Cookies/Cookies.binarycookies
    const cookiePath = path.join(
      os.homedir(),
      "Library",
      "Cookies",
      "Cookies.binarycookies",
    );

    if (!fs.existsSync(cookiePath)) {
      return [];
    }

    let data: Buffer;
    try {
      data = fs.readFileSync(cookiePath);
    } catch (err: unknown) {
      const error = err as NodeJS.ErrnoException;
      if (error.code === "EPERM" || error.code === "EACCES") {
        handleAccessError(err, "Safari cookies");
      }
      throw err;
    }

    const rawCookies = parseBinaryCookies(data);

    return rawCookies.map((c) => {
      const secure = (c.flags & 0x1) !== 0;
      const httpOnly = (c.flags & 0x4) !== 0;
      const hostOnly = !c.domain.startsWith(".");

      return {
        name: c.name,
        value: c.value,
        domain: c.domain,
        hostOnly,
        path: c.path,
        expirationDate:
          c.expirationDate > 0
            ? macTimestampToMs(c.expirationDate)
            : undefined,
        secure,
        httpOnly,
        sameSite: "unspecified" as const,
        sourceScheme: secure ? ("secure" as const) : ("non_secure" as const),
        sourcePort: secure ? 443 : 80,
      };
    });
  }

  async readPasswords(_profilePath: string): Promise<ImportedPassword[]> {
    // Safari passwords are stored in the macOS Keychain and cannot be
    // accessed programmatically. Users must export them from Safari as CSV.
    // The import pipeline can provide a csvPasswordFile via ImportRequest.
    return [];
  }

  /**
   * Parse a Safari password CSV export file.
   * Called by the import pipeline when a csvPasswordFile is provided.
   */
  async readPasswordsFromCsv(csvPath: string): Promise<ImportedPassword[]> {
    if (!fs.existsSync(csvPath)) {
      return [];
    }

    try {
      const content = fs.readFileSync(csvPath, "utf-8");
      return parseSafariPasswordCsv(content);
    } catch (err: unknown) {
      const error = err as NodeJS.ErrnoException;
      if (error.code === "EPERM" || error.code === "EACCES") {
        handleAccessError(err, "Safari password CSV");
      }
      throw err;
    }
  }

  async readAutofill(_profilePath: string): Promise<ImportedAutofillEntry[]> {
    // Safari does not expose autofill data
    return [];
  }

  async readSearchEngines(
    _profilePath: string,
  ): Promise<ImportedSearchEngine[]> {
    // Safari does not expose search engine config in a parseable format
    return [];
  }

  async readExtensions(_profilePath: string): Promise<ImportedExtension[]> {
    // Safari extensions are App Store apps, not extractable
    return [];
  }

  async readPermissions(profilePath: string): Promise<ImportedPermission[]> {
    const dbPath = path.join(profilePath, "PerSitePreferences.db");
    if (!fs.existsSync(dbPath)) {
      return [];
    }

    let tempPath: string | undefined;
    try {
      tempPath = await copyDatabaseToTemp(dbPath);
      const db = new Database(tempPath, { readonly: true });

      try {
        // PerSitePreferences.db has a `preference_values` table with
        // columns: domain, key, value
        // Check if the table exists
        const tableCheck = db
          .prepare(
            `SELECT name FROM sqlite_master WHERE type='table' AND name='preference_values'`,
          )
          .get() as { name: string } | undefined;

        if (!tableCheck) {
          return [];
        }

        const rows = db
          .prepare(`SELECT domain, key, value FROM preference_values`)
          .all() as Array<{
          domain: string;
          key: string;
          value: string | number;
        }>;

        const permissions: ImportedPermission[] = [];
        for (const row of rows) {
          let setting: "allow" | "block" | "ask" = "ask";
          if (
            row.value === 1 ||
            row.value === "1" ||
            row.value === "allow"
          ) {
            setting = "allow";
          } else if (
            row.value === 0 ||
            row.value === "0" ||
            row.value === "deny" ||
            row.value === "block"
          ) {
            setting = "block";
          }

          permissions.push({
            origin: row.domain,
            permission: row.key,
            setting,
          });
        }

        return permissions;
      } finally {
        db.close();
      }
    } catch (err: unknown) {
      const error = err as NodeJS.ErrnoException;
      if (error.code === "EPERM" || error.code === "EACCES") {
        handleAccessError(err, "Safari permissions");
      }
      if (err instanceof BrowserDataError) {
        throw err;
      }
      throw err;
    } finally {
      if (tempPath) cleanupTempCopy(tempPath);
    }
  }

  async readSettings(profilePath: string): Promise<ImportedSettings> {
    // Safari preferences are in ~/Library/Preferences/com.apple.Safari.plist
    const prefsPath = path.join(
      os.homedir(),
      "Library",
      "Preferences",
      "com.apple.Safari.plist",
    );

    if (!fs.existsSync(prefsPath)) {
      return {};
    }

    try {
      const result = bplist.parseFileSync(prefsPath);
      const prefs = result[0] as Record<string, unknown>;

      const settings: ImportedSettings = {};

      if (typeof prefs['HomePage'] === "string") {
        settings.homepage = prefs['HomePage'];
      }

      if (typeof prefs['ShowFavoritesBar'] === "boolean") {
        settings.showBookmarksBar = prefs['ShowFavoritesBar'] as boolean;
      }
      // Also check older key name
      if (typeof prefs["ShowFavoritesBar-v2"] === "boolean") {
        settings.showBookmarksBar = prefs["ShowFavoritesBar-v2"] as boolean;
      }

      if (typeof prefs['SearchProviderShortName'] === "string") {
        settings.defaultSearchEngine =
          prefs['SearchProviderShortName'] as string;
      }

      return settings;
    } catch (err: unknown) {
      const error = err as NodeJS.ErrnoException;
      if (error.code === "EPERM" || error.code === "EACCES") {
        handleAccessError(err, "Safari preferences");
      }
      // If the plist is XML format or otherwise unparseable, just return empty
      return {};
    }
  }

  async readFavicons(_profilePath: string): Promise<ImportedFavicon[]> {
    // Safari does not store favicons in a directly accessible format
    return [];
  }
}
