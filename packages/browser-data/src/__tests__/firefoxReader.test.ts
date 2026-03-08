import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import Database from "better-sqlite3";
import { FirefoxReader, parsePrefsJs, decompressMozLz4 } from "../readers/firefoxReader.js";

describe("FirefoxReader", () => {
  let tmpDir: string;
  let reader: FirefoxReader;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "natstack-test-firefox-reader-"));
    reader = new FirefoxReader();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // Helper to create a places.sqlite with test data
  function createPlacesDb(): string {
    const dbPath = path.join(tmpDir, "places.sqlite");
    const db = new Database(dbPath);

    db.exec(`
      CREATE TABLE moz_places (
        id INTEGER PRIMARY KEY,
        url TEXT,
        title TEXT,
        visit_count INTEGER DEFAULT 0,
        typed INTEGER DEFAULT 0
      );

      CREATE TABLE moz_bookmarks (
        id INTEGER PRIMARY KEY,
        type INTEGER,
        fk INTEGER,
        parent INTEGER,
        title TEXT,
        dateAdded INTEGER,
        lastModified INTEGER,
        keyword_id INTEGER
      );

      CREATE TABLE moz_historyvisits (
        id INTEGER PRIMARY KEY,
        place_id INTEGER,
        visit_date INTEGER
      );

      CREATE TABLE moz_keywords (
        id INTEGER PRIMARY KEY,
        keyword TEXT
      );
    `);

    // Insert root bookmark folders (Firefox built-in)
    db.prepare(`INSERT INTO moz_bookmarks (id, type, parent, title, dateAdded, lastModified) VALUES (?, ?, ?, ?, ?, ?)`).run(1, 2, 0, "Root", 0, 0);
    db.prepare(`INSERT INTO moz_bookmarks (id, type, parent, title, dateAdded, lastModified) VALUES (?, ?, ?, ?, ?, ?)`).run(2, 2, 1, "Bookmarks Menu", 0, 0);
    db.prepare(`INSERT INTO moz_bookmarks (id, type, parent, title, dateAdded, lastModified) VALUES (?, ?, ?, ?, ?, ?)`).run(3, 2, 1, "Bookmarks Toolbar", 0, 0);
    db.prepare(`INSERT INTO moz_bookmarks (id, type, parent, title, dateAdded, lastModified) VALUES (?, ?, ?, ?, ?, ?)`).run(4, 2, 1, "Tags", 0, 0);
    db.prepare(`INSERT INTO moz_bookmarks (id, type, parent, title, dateAdded, lastModified) VALUES (?, ?, ?, ?, ?, ?)`).run(5, 2, 1, "Other Bookmarks", 0, 0);

    db.close();
    return dbPath;
  }

  describe("readBookmarks", () => {
    it("reads bookmarks from places.sqlite", async () => {
      createPlacesDb();
      const db = new Database(path.join(tmpDir, "places.sqlite"));

      // Add a place
      db.prepare("INSERT INTO moz_places (id, url, title) VALUES (?, ?, ?)").run(1, "https://example.com", "Example");

      // Add a subfolder under Bookmarks Menu
      db.prepare("INSERT INTO moz_bookmarks (id, type, parent, title, dateAdded, lastModified) VALUES (?, ?, ?, ?, ?, ?)").run(
        10, 2, 2, "Dev", 1000000000000, 1000000000000,
      );

      // Add a bookmark in the subfolder
      db.prepare("INSERT INTO moz_bookmarks (id, type, fk, parent, title, dateAdded, lastModified) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
        11, 1, 1, 10, "Example Site", 1609459200000000, 1609459200000000,
      );

      db.close();

      const bookmarks = await reader.readBookmarks(tmpDir);
      expect(bookmarks).toHaveLength(1);
      expect(bookmarks[0]!.title).toBe("Example Site");
      expect(bookmarks[0]!.url).toBe("https://example.com");
      expect(bookmarks[0]!.folder).toEqual(["Dev"]);
      // 1609459200000000 microseconds = 1609459200000 ms
      expect(bookmarks[0]!.dateAdded).toBe(1609459200000);
    });

    it("excludes place: URLs", async () => {
      createPlacesDb();
      const db = new Database(path.join(tmpDir, "places.sqlite"));

      db.prepare("INSERT INTO moz_places (id, url, title) VALUES (?, ?, ?)").run(1, "place:sort=8&maxResults=10", "Recent Tags");
      db.prepare("INSERT INTO moz_bookmarks (id, type, fk, parent, title, dateAdded, lastModified) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
        10, 1, 1, 2, "Recent Tags", 1000000000000, null,
      );

      db.close();

      const bookmarks = await reader.readBookmarks(tmpDir);
      expect(bookmarks).toHaveLength(0);
    });

    it("handles keywords", async () => {
      createPlacesDb();
      const db = new Database(path.join(tmpDir, "places.sqlite"));

      db.prepare("INSERT INTO moz_places (id, url, title) VALUES (?, ?, ?)").run(1, "https://example.com/search?q=%s", "Search");
      db.prepare("INSERT INTO moz_keywords (id, keyword) VALUES (?, ?)").run(1, "ex");
      db.prepare("INSERT INTO moz_bookmarks (id, type, fk, parent, title, dateAdded, lastModified, keyword_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
        10, 1, 1, 3, "Search Example", 1000000000000, null, 1,
      );

      db.close();

      const bookmarks = await reader.readBookmarks(tmpDir);
      expect(bookmarks).toHaveLength(1);
      expect(bookmarks[0]!.keyword).toBe("ex");
    });
  });

  describe("readHistory", () => {
    it("reads history from places.sqlite", async () => {
      createPlacesDb();
      const db = new Database(path.join(tmpDir, "places.sqlite"));

      db.prepare("INSERT INTO moz_places (id, url, title, visit_count, typed) VALUES (?, ?, ?, ?, ?)").run(
        1, "https://example.com", "Example", 5, 2,
      );
      // Two visits: timestamps in microseconds
      db.prepare("INSERT INTO moz_historyvisits (id, place_id, visit_date) VALUES (?, ?, ?)").run(1, 1, 1609459200000000);
      db.prepare("INSERT INTO moz_historyvisits (id, place_id, visit_date) VALUES (?, ?, ?)").run(2, 1, 1609545600000000);

      db.close();

      const history = await reader.readHistory(tmpDir);
      expect(history).toHaveLength(1);
      expect(history[0]!.url).toBe("https://example.com");
      expect(history[0]!.title).toBe("Example");
      expect(history[0]!.visitCount).toBe(5);
      expect(history[0]!.lastVisitTime).toBe(1609545600000);
      expect(history[0]!.firstVisitTime).toBe(1609459200000);
      expect(history[0]!.typedCount).toBe(2);
    });

    it("returns empty for no visits", async () => {
      createPlacesDb();
      const history = await reader.readHistory(tmpDir);
      expect(history).toHaveLength(0);
    });
  });

  describe("readCookies", () => {
    it("reads cookies from cookies.sqlite", async () => {
      const dbPath = path.join(tmpDir, "cookies.sqlite");
      const db = new Database(dbPath);

      db.exec(`
        CREATE TABLE moz_cookies (
          id INTEGER PRIMARY KEY,
          name TEXT,
          value TEXT,
          host TEXT,
          path TEXT,
          expiry INTEGER,
          isSecure INTEGER,
          isHttpOnly INTEGER,
          sameSite INTEGER,
          originAttributes TEXT DEFAULT ''
        )
      `);

      db.prepare(`INSERT INTO moz_cookies (name, value, host, path, expiry, isSecure, isHttpOnly, sameSite) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
        "session_id", "abc123", ".example.com", "/", 1735689600, 1, 1, 1,
      );

      db.prepare(`INSERT INTO moz_cookies (name, value, host, path, expiry, isSecure, isHttpOnly, sameSite) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
        "pref", "dark", "example.com", "/settings", 1735689600, 0, 0, 0,
      );

      db.close();

      const cookies = await reader.readCookies(tmpDir);
      expect(cookies).toHaveLength(2);

      // First cookie: domain cookie (leading dot)
      expect(cookies[0]!.name).toBe("session_id");
      expect(cookies[0]!.domain).toBe(".example.com");
      expect(cookies[0]!.hostOnly).toBe(false);
      expect(cookies[0]!.secure).toBe(true);
      expect(cookies[0]!.httpOnly).toBe(true);
      expect(cookies[0]!.sameSite).toBe("lax");
      expect(cookies[0]!.sourceScheme).toBe("secure");

      // Second cookie: host-only
      expect(cookies[1]!.name).toBe("pref");
      expect(cookies[1]!.hostOnly).toBe(true);
      expect(cookies[1]!.secure).toBe(false);
      expect(cookies[1]!.sameSite).toBe("no_restriction");
      expect(cookies[1]!.sourceScheme).toBe("non_secure");
    });
  });

  describe("readPasswords", () => {
    it("reads logins.json", async () => {
      const logins = {
        logins: [
          {
            hostname: "https://example.com",
            formSubmitURL: "https://example.com/login",
            encryptedUsername: "base64encodeduser",
            encryptedPassword: "base64encodedpass",
            timeCreated: 1609459200000,
            timesUsed: 3,
          },
        ],
      };
      fs.writeFileSync(path.join(tmpDir, "logins.json"), JSON.stringify(logins));

      const passwords = await reader.readPasswords(tmpDir);
      expect(passwords).toHaveLength(1);
      expect(passwords[0]!.url).toBe("https://example.com");
      expect(passwords[0]!.actionUrl).toBe("https://example.com/login");
      expect(passwords[0]!.username).toBe("base64encodeduser");
      expect(passwords[0]!.password).toBe("base64encodedpass");
      expect(passwords[0]!.dateCreated).toBe(1609459200000);
      expect(passwords[0]!.timesUsed).toBe(3);
    });

    it("returns empty array when logins.json is missing", async () => {
      const passwords = await reader.readPasswords(tmpDir);
      expect(passwords).toHaveLength(0);
    });

    it("returns empty array for logins.json with no logins array", async () => {
      fs.writeFileSync(path.join(tmpDir, "logins.json"), JSON.stringify({ version: 1 }));
      const passwords = await reader.readPasswords(tmpDir);
      expect(passwords).toHaveLength(0);
    });
  });

  describe("readAutofill", () => {
    it("reads autofill from formhistory.sqlite", async () => {
      const dbPath = path.join(tmpDir, "formhistory.sqlite");
      const db = new Database(dbPath);

      db.exec(`
        CREATE TABLE moz_formhistory (
          id INTEGER PRIMARY KEY,
          fieldname TEXT,
          value TEXT,
          timesUsed INTEGER,
          firstUsed INTEGER,
          lastUsed INTEGER
        )
      `);

      db.prepare("INSERT INTO moz_formhistory (fieldname, value, timesUsed, firstUsed, lastUsed) VALUES (?, ?, ?, ?, ?)").run(
        "email", "user@example.com", 10, 1609459200000000, 1609545600000000,
      );

      db.close();

      const entries = await reader.readAutofill(tmpDir);
      expect(entries).toHaveLength(1);
      expect(entries[0]!.fieldName).toBe("email");
      expect(entries[0]!.value).toBe("user@example.com");
      expect(entries[0]!.timesUsed).toBe(10);
      expect(entries[0]!.dateCreated).toBe(1609459200000);
      expect(entries[0]!.dateLastUsed).toBe(1609545600000);
    });

    it("returns empty when formhistory.sqlite is missing", async () => {
      const entries = await reader.readAutofill(tmpDir);
      expect(entries).toHaveLength(0);
    });
  });

  describe("readExtensions", () => {
    it("reads extensions from extensions.json", async () => {
      const extensions = {
        addons: [
          {
            id: "ublock@example.com",
            name: "uBlock Origin",
            version: "1.50.0",
            type: "extension",
            description: "An efficient blocker",
            active: true,
            userDisabled: false,
          },
          {
            id: "theme@example.com",
            name: "Dark Theme",
            version: "1.0",
            type: "theme",
            active: true,
          },
        ],
      };
      fs.writeFileSync(path.join(tmpDir, "extensions.json"), JSON.stringify(extensions));

      const exts = await reader.readExtensions(tmpDir);
      // Only the extension type, not themes
      expect(exts).toHaveLength(1);
      expect(exts[0]!.id).toBe("ublock@example.com");
      expect(exts[0]!.name).toBe("uBlock Origin");
      expect(exts[0]!.version).toBe("1.50.0");
      expect(exts[0]!.enabled).toBe(true);
      expect(exts[0]!.description).toBe("An efficient blocker");
    });

    it("returns empty when extensions.json is missing", async () => {
      const exts = await reader.readExtensions(tmpDir);
      expect(exts).toHaveLength(0);
    });
  });

  describe("readPermissions", () => {
    it("reads permissions from permissions.sqlite", async () => {
      const dbPath = path.join(tmpDir, "permissions.sqlite");
      const db = new Database(dbPath);

      db.exec(`
        CREATE TABLE moz_perms (
          id INTEGER PRIMARY KEY,
          origin TEXT,
          type TEXT,
          permission INTEGER
        )
      `);

      db.prepare("INSERT INTO moz_perms (origin, type, permission) VALUES (?, ?, ?)").run(
        "https://example.com", "desktop-notification", 1,
      );
      db.prepare("INSERT INTO moz_perms (origin, type, permission) VALUES (?, ?, ?)").run(
        "https://evil.com", "geo", 2,
      );

      db.close();

      const perms = await reader.readPermissions(tmpDir);
      expect(perms).toHaveLength(2);
      expect(perms[0]!.origin).toBe("https://example.com");
      expect(perms[0]!.permission).toBe("notifications");
      expect(perms[0]!.setting).toBe("allow");
      expect(perms[1]!.origin).toBe("https://evil.com");
      expect(perms[1]!.permission).toBe("geolocation");
      expect(perms[1]!.setting).toBe("block");
    });

    it("returns empty when permissions.sqlite is missing", async () => {
      const perms = await reader.readPermissions(tmpDir);
      expect(perms).toHaveLength(0);
    });
  });

  describe("readSettings", () => {
    it("reads settings from prefs.js", async () => {
      const prefsContent = `
// Mozilla User Preferences
user_pref("browser.startup.homepage", "https://example.com");
user_pref("browser.urlbar.placeholderName", "DuckDuckGo");
user_pref("browser.toolbars.bookmarks.visibility", "always");
user_pref("browser.tabs.warnOnClose", true);
`;
      fs.writeFileSync(path.join(tmpDir, "prefs.js"), prefsContent);

      const settings = await reader.readSettings(tmpDir);
      expect(settings.homepage).toBe("https://example.com");
      expect(settings.defaultSearchEngine).toBe("DuckDuckGo");
      expect(settings.showBookmarksBar).toBe(true);
    });

    it("returns empty settings when prefs.js is missing", async () => {
      const settings = await reader.readSettings(tmpDir);
      expect(settings).toEqual({});
    });
  });

  describe("readFavicons", () => {
    it("reads favicons from favicons.sqlite", async () => {
      const dbPath = path.join(tmpDir, "favicons.sqlite");
      const db = new Database(dbPath);

      db.exec(`
        CREATE TABLE moz_icons (
          id INTEGER PRIMARY KEY,
          icon_url TEXT,
          data BLOB,
          width INTEGER
        );

        CREATE TABLE moz_pages_w_icons (
          id INTEGER PRIMARY KEY,
          page_url TEXT
        );

        CREATE TABLE moz_icons_to_pages (
          icon_id INTEGER,
          page_id INTEGER
        );
      `);

      const iconData = Buffer.from([0x89, 0x50, 0x4e, 0x47]); // PNG magic bytes
      db.prepare("INSERT INTO moz_icons (id, icon_url, data, width) VALUES (?, ?, ?, ?)").run(
        1, "https://example.com/favicon.png", iconData, 16,
      );
      db.prepare("INSERT INTO moz_pages_w_icons (id, page_url) VALUES (?, ?)").run(
        1, "https://example.com",
      );
      db.prepare("INSERT INTO moz_icons_to_pages (icon_id, page_id) VALUES (?, ?)").run(1, 1);

      db.close();

      const favicons = await reader.readFavicons(tmpDir);
      expect(favicons).toHaveLength(1);
      expect(favicons[0]!.url).toBe("https://example.com");
      expect(favicons[0]!.mimeType).toBe("image/png");
      expect(Buffer.isBuffer(favicons[0]!.data)).toBe(true);
      expect(favicons[0]!.data.length).toBe(4);
    });

    it("returns empty when favicons.sqlite is missing", async () => {
      const favicons = await reader.readFavicons(tmpDir);
      expect(favicons).toHaveLength(0);
    });
  });
});

describe("parsePrefsJs", () => {
  it("parses string values", () => {
    const prefs = parsePrefsJs('user_pref("browser.startup.homepage", "https://example.com");');
    expect(prefs.get("browser.startup.homepage")).toBe("https://example.com");
  });

  it("parses boolean values", () => {
    const prefs = parsePrefsJs('user_pref("browser.tabs.warnOnClose", true);');
    expect(prefs.get("browser.tabs.warnOnClose")).toBe(true);
  });

  it("parses false boolean values", () => {
    const prefs = parsePrefsJs('user_pref("browser.tabs.warnOnClose", false);');
    expect(prefs.get("browser.tabs.warnOnClose")).toBe(false);
  });

  it("parses integer values", () => {
    const prefs = parsePrefsJs('user_pref("some.int.pref", 42);');
    expect(prefs.get("some.int.pref")).toBe(42);
  });

  it("ignores comments and blank lines", () => {
    const content = `
// This is a comment
# Another comment

user_pref("key", "value");
    `;
    const prefs = parsePrefsJs(content);
    expect(prefs.size).toBe(1);
    expect(prefs.get("key")).toBe("value");
  });

  it("handles escaped quotes in strings", () => {
    const prefs = parsePrefsJs('user_pref("key", "value \\"with\\" quotes");');
    expect(prefs.get("key")).toBe('value "with" quotes');
  });

  it("parses multiple preferences", () => {
    const content = `
user_pref("a", "one");
user_pref("b", 2);
user_pref("c", true);
    `;
    const prefs = parsePrefsJs(content);
    expect(prefs.size).toBe(3);
    expect(prefs.get("a")).toBe("one");
    expect(prefs.get("b")).toBe(2);
    expect(prefs.get("c")).toBe(true);
  });
});

describe("decompressMozLz4", () => {
  it("rejects invalid magic header", () => {
    const buf = Buffer.alloc(20);
    buf.write("invalid!", 0, "ascii");
    expect(() => decompressMozLz4(buf)).toThrow("Invalid mozLz4 magic header");
  });

  it("decompresses a simple literal-only block", () => {
    // Build a valid mozLz4 buffer with only literals (no matches)
    const payload = Buffer.from("Hello, World!");
    const payloadLen = payload.length;

    // Header: "mozLz40\0" + 4-byte LE uncompressed size
    const header = Buffer.alloc(12);
    header.write("mozLz40\0", 0, "ascii");
    header.writeUInt32LE(payloadLen, 8);

    // LZ4 block: single sequence with literals only, no match
    // Token: high nibble = literal length (13, which is < 15 so no extra bytes)
    // Then the literal bytes. Since it's the last sequence, no match follows.
    const token = (payloadLen << 4) & 0xf0; // literal length in high nibble
    let lz4Block: Buffer;

    if (payloadLen < 15) {
      lz4Block = Buffer.concat([Buffer.from([token]), payload]);
    } else {
      // Literal length >= 15: token high nibble = 15, then extra bytes
      const extra = payloadLen - 15;
      const tokenByte = 0xf0; // 15 in high nibble
      const extraBytes: number[] = [];
      let remaining = extra;
      while (remaining >= 255) {
        extraBytes.push(255);
        remaining -= 255;
      }
      extraBytes.push(remaining);
      lz4Block = Buffer.concat([
        Buffer.from([tokenByte, ...extraBytes]),
        payload,
      ]);
    }

    const fullBuffer = Buffer.concat([header, lz4Block]);
    const result = decompressMozLz4(fullBuffer);
    expect(result.toString("utf-8")).toBe("Hello, World!");
  });

  it("decompresses a block with literal + match", () => {
    // We'll construct an LZ4 block that encodes "ABCDABCD"
    // First sequence: 4 literals "ABCD", then match of length 4 at offset 4
    // Token: high nibble=4 (literal len), low nibble=0 (match len - 4 = 0)
    const uncompressed = "ABCDABCD";
    const header = Buffer.alloc(12);
    header.write("mozLz40\0", 0, "ascii");
    header.writeUInt32LE(uncompressed.length, 8);

    const token = (4 << 4) | 0; // 4 literals, match length 4 (0 + minmatch 4)
    const literals = Buffer.from("ABCD");
    const offset = Buffer.alloc(2);
    offset.writeUInt16LE(4, 0); // offset = 4 bytes back

    const lz4Block = Buffer.concat([Buffer.from([token]), literals, offset]);
    const fullBuffer = Buffer.concat([header, lz4Block]);

    const result = decompressMozLz4(fullBuffer);
    expect(result.toString("utf-8")).toBe("ABCDABCD");
  });
});
