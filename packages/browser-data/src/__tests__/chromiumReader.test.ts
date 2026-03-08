import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import Database from "better-sqlite3";
import { ChromiumReader } from "../readers/chromiumReader.js";

describe("ChromiumReader", () => {
  let tmpDir: string;
  let reader: ChromiumReader;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "natstack-test-chromium-"));
    reader = new ChromiumReader();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ---- Helper: Chrome timestamp from Unix ms ----
  // Chrome epoch: 1601-01-01; Unix epoch: 1970-01-01
  // Offset in microseconds: 11644473600000000
  const CHROME_EPOCH_OFFSET = 11644473600000000n;
  function msToChromeTimestamp(unixMs: number): string {
    return String(BigInt(unixMs) * 1000n + CHROME_EPOCH_OFFSET);
  }

  // ---- Bookmarks ----

  describe("readBookmarks", () => {
    it("reads bookmarks from Bookmarks JSON", async () => {
      const dateAdded = msToChromeTimestamp(1700000000000);

      const bookmarksData = {
        roots: {
          bookmark_bar: {
            type: "folder",
            name: "Bookmarks bar",
            children: [
              {
                type: "url",
                name: "Example",
                url: "https://example.com",
                date_added: dateAdded,
              },
              {
                type: "folder",
                name: "Dev",
                children: [
                  {
                    type: "url",
                    name: "GitHub",
                    url: "https://github.com",
                    date_added: dateAdded,
                  },
                ],
              },
            ],
          },
          other: {
            type: "folder",
            name: "Other bookmarks",
            children: [
              {
                type: "url",
                name: "Other Site",
                url: "https://other.com",
                date_added: dateAdded,
              },
            ],
          },
          synced: {
            type: "folder",
            name: "Mobile bookmarks",
            children: [],
          },
        },
      };

      fs.writeFileSync(
        path.join(tmpDir, "Bookmarks"),
        JSON.stringify(bookmarksData),
      );

      const bookmarks = await reader.readBookmarks(tmpDir);

      expect(bookmarks).toHaveLength(3);

      const example = bookmarks.find((b) => b.url === "https://example.com")!;
      expect(example.title).toBe("Example");
      expect(example.folder).toEqual(["Bookmarks bar"]);
      expect(example.dateAdded).toBe(1700000000000);

      const github = bookmarks.find((b) => b.url === "https://github.com")!;
      expect(github.title).toBe("GitHub");
      expect(github.folder).toEqual(["Bookmarks bar", "Dev"]);

      const other = bookmarks.find((b) => b.url === "https://other.com")!;
      expect(other.folder).toEqual(["Other bookmarks"]);
    });

    it("returns empty array when Bookmarks file is missing", async () => {
      const bookmarks = await reader.readBookmarks(tmpDir);
      expect(bookmarks).toEqual([]);
    });

    it("handles bookmarks with null bytes in title", async () => {
      const bookmarksData = {
        roots: {
          bookmark_bar: {
            type: "folder",
            name: "Bookmarks bar",
            children: [
              {
                type: "url",
                name: "Test\0Page",
                url: "https://test.com",
                date_added: msToChromeTimestamp(1700000000000),
              },
            ],
          },
        },
      };

      fs.writeFileSync(
        path.join(tmpDir, "Bookmarks"),
        JSON.stringify(bookmarksData),
      );

      const bookmarks = await reader.readBookmarks(tmpDir);
      expect(bookmarks[0]!.title).toBe("TestPage");
    });
  });

  // ---- History ----

  describe("readHistory", () => {
    function createHistoryDb(profileDir: string) {
      const dbPath = path.join(profileDir, "History");
      const db = new Database(dbPath);
      db.exec(`
        CREATE TABLE urls (
          id INTEGER PRIMARY KEY,
          url TEXT NOT NULL,
          title TEXT,
          visit_count INTEGER DEFAULT 0,
          typed_count INTEGER DEFAULT 0,
          last_visit_time INTEGER DEFAULT 0
        );
        CREATE TABLE visits (
          id INTEGER PRIMARY KEY,
          url INTEGER NOT NULL,
          visit_time INTEGER DEFAULT 0,
          transition INTEGER DEFAULT 0
        );
      `);
      return db;
    }

    it("reads history entries", async () => {
      const db = createHistoryDb(tmpDir);
      const lastVisit = msToChromeTimestamp(1700000000000);
      const visitTime = msToChromeTimestamp(1699999000000);

      db.prepare(
        "INSERT INTO urls (id, url, title, visit_count, typed_count, last_visit_time) VALUES (?, ?, ?, ?, ?, ?)",
      ).run(1, "https://example.com", "Example", 5, 2, lastVisit);

      db.prepare(
        "INSERT INTO visits (id, url, visit_time, transition) VALUES (?, ?, ?, ?)",
      ).run(1, 1, visitTime, 1); // typed transition

      db.close();

      const entries = await reader.readHistory(tmpDir);
      expect(entries).toHaveLength(1);
      expect(entries[0]!.url).toBe("https://example.com");
      expect(entries[0]!.title).toBe("Example");
      expect(entries[0]!.visitCount).toBe(5);
      expect(entries[0]!.typedCount).toBe(2);
      expect(entries[0]!.lastVisitTime).toBe(1700000000000);
      expect(entries[0]!.transition).toBe("typed");
    });

    it("returns empty array when History file is missing", async () => {
      const entries = await reader.readHistory(tmpDir);
      expect(entries).toEqual([]);
    });

    it("deduplicates multiple visits for same URL", async () => {
      const db = createHistoryDb(tmpDir);
      const lastVisit = msToChromeTimestamp(1700000000000);
      const visit1 = msToChromeTimestamp(1699990000000);
      const visit2 = msToChromeTimestamp(1700000000000);

      db.prepare(
        "INSERT INTO urls (id, url, title, visit_count, typed_count, last_visit_time) VALUES (?, ?, ?, ?, ?, ?)",
      ).run(1, "https://example.com", "Example", 2, 0, lastVisit);

      db.prepare(
        "INSERT INTO visits (id, url, visit_time, transition) VALUES (?, ?, ?, ?)",
      ).run(1, 1, visit2, 0);
      db.prepare(
        "INSERT INTO visits (id, url, visit_time, transition) VALUES (?, ?, ?, ?)",
      ).run(2, 1, visit1, 0);

      db.close();

      const entries = await reader.readHistory(tmpDir);
      expect(entries).toHaveLength(1);
      expect(entries[0]!.firstVisitTime).toBe(1699990000000);
    });
  });

  // ---- Cookies ----

  describe("readCookies", () => {
    function createCookieDb(profileDir: string) {
      const dbPath = path.join(profileDir, "Cookies");
      const db = new Database(dbPath);
      db.exec(`
        CREATE TABLE cookies (
          host_key TEXT NOT NULL,
          name TEXT NOT NULL,
          value TEXT NOT NULL DEFAULT '',
          encrypted_value BLOB DEFAULT X'',
          path TEXT NOT NULL DEFAULT '/',
          expires_utc INTEGER DEFAULT 0,
          is_secure INTEGER DEFAULT 0,
          is_httponly INTEGER DEFAULT 0,
          samesite INTEGER DEFAULT -1,
          source_scheme INTEGER DEFAULT 0,
          source_port INTEGER DEFAULT -1
        );
      `);
      return db;
    }

    it("reads plain text cookies", async () => {
      const db = createCookieDb(tmpDir);
      const expiresUtc = msToChromeTimestamp(1800000000000);

      db.prepare(
        `INSERT INTO cookies (host_key, name, value, path, expires_utc, is_secure, is_httponly, samesite, source_scheme, source_port)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(".example.com", "session_id", "abc123", "/", expiresUtc, 1, 1, 1, 2, 443);

      db.close();

      const cookies = await reader.readCookies(tmpDir);
      expect(cookies).toHaveLength(1);

      const cookie = cookies[0]!;
      expect(cookie.name).toBe("session_id");
      expect(cookie.value).toBe("abc123");
      expect(cookie.domain).toBe(".example.com");
      expect(cookie.hostOnly).toBe(false);
      expect(cookie.path).toBe("/");
      expect(cookie.secure).toBe(true);
      expect(cookie.httpOnly).toBe(true);
      expect(cookie.sameSite).toBe("lax");
      expect(cookie.sourceScheme).toBe("secure");
      expect(cookie.sourcePort).toBe(443);
      expect(cookie.expirationDate).toBeDefined();
    });

    it("returns empty string value for encrypted cookies", async () => {
      const db = createCookieDb(tmpDir);
      db.prepare(
        `INSERT INTO cookies (host_key, name, value, encrypted_value, path, expires_utc, is_secure, is_httponly, samesite, source_scheme, source_port)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run("example.com", "auth", "", Buffer.from([0x76, 0x31, 0x00, 0x01]), "/", 0, 1, 0, 2, 2, 443);

      db.close();

      const cookies = await reader.readCookies(tmpDir);
      expect(cookies).toHaveLength(1);
      expect(cookies[0]!.value).toBe("");
      expect(cookies[0]!.hostOnly).toBe(true);
    });

    it("returns empty array when Cookies file is missing", async () => {
      const cookies = await reader.readCookies(tmpDir);
      expect(cookies).toEqual([]);
    });
  });

  // ---- Passwords ----

  describe("readPasswords", () => {
    function createLoginDb(profileDir: string) {
      const dbPath = path.join(profileDir, "Login Data");
      const db = new Database(dbPath);
      db.exec(`
        CREATE TABLE logins (
          origin_url TEXT NOT NULL,
          action_url TEXT,
          username_value TEXT,
          password_value BLOB,
          date_created INTEGER DEFAULT 0,
          date_last_used INTEGER DEFAULT 0,
          date_password_modified INTEGER DEFAULT 0,
          times_used INTEGER DEFAULT 0
        );
      `);
      return db;
    }

    it("reads password entries with encrypted values as empty strings", async () => {
      const db = createLoginDb(tmpDir);
      const dateCreated = msToChromeTimestamp(1700000000000);

      db.prepare(
        `INSERT INTO logins (origin_url, action_url, username_value, password_value, date_created, times_used)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run("https://example.com", "https://example.com/login", "user@test.com", Buffer.from([0x76, 0x31]), dateCreated, 3);

      db.close();

      const passwords = await reader.readPasswords(tmpDir);
      expect(passwords).toHaveLength(1);
      expect(passwords[0]!.url).toBe("https://example.com");
      expect(passwords[0]!.actionUrl).toBe("https://example.com/login");
      expect(passwords[0]!.username).toBe("user@test.com");
      expect(passwords[0]!.password).toBe("");
      expect(passwords[0]!.dateCreated).toBe(1700000000000);
      expect(passwords[0]!.timesUsed).toBe(3);
    });

    it("returns empty array when Login Data is missing", async () => {
      const passwords = await reader.readPasswords(tmpDir);
      expect(passwords).toEqual([]);
    });
  });

  // ---- Autofill ----

  describe("readAutofill", () => {
    function createWebDataDb(profileDir: string) {
      const dbPath = path.join(profileDir, "Web Data");
      const db = new Database(dbPath);
      db.exec(`
        CREATE TABLE autofill (
          name TEXT NOT NULL,
          value TEXT NOT NULL,
          date_created INTEGER DEFAULT 0,
          date_last_used INTEGER DEFAULT 0,
          count INTEGER DEFAULT 0
        );
        CREATE TABLE keywords (
          short_name TEXT,
          keyword TEXT,
          url TEXT,
          suggestions_url TEXT,
          favicon_url TEXT,
          is_active INTEGER DEFAULT 0
        );
      `);
      return db;
    }

    it("reads autofill entries and normalizes field names", async () => {
      const db = createWebDataDb(tmpDir);
      const dateCreated = msToChromeTimestamp(1700000000000);

      db.prepare(
        "INSERT INTO autofill (name, value, date_created, date_last_used, count) VALUES (?, ?, ?, ?, ?)",
      ).run("emailaddress", "user@test.com", dateCreated, dateCreated, 5);

      db.prepare(
        "INSERT INTO autofill (name, value, date_created, date_last_used, count) VALUES (?, ?, ?, ?, ?)",
      ).run("firstname", "John", dateCreated, dateCreated, 3);

      db.close();

      const entries = await reader.readAutofill(tmpDir);
      expect(entries).toHaveLength(2);

      const email = entries.find((e) => e.value === "user@test.com")!;
      expect(email.fieldName).toBe("email");
      expect(email.timesUsed).toBe(5);

      const name = entries.find((e) => e.value === "John")!;
      expect(name.fieldName).toBe("given-name");
    });

    it("returns empty array when Web Data is missing", async () => {
      const entries = await reader.readAutofill(tmpDir);
      expect(entries).toEqual([]);
    });
  });

  // ---- Search Engines ----

  describe("readSearchEngines", () => {
    function createWebDataDbWithKeywords(profileDir: string) {
      const dbPath = path.join(profileDir, "Web Data");
      const db = new Database(dbPath);
      db.exec(`
        CREATE TABLE autofill (
          name TEXT, value TEXT, date_created INTEGER, date_last_used INTEGER, count INTEGER
        );
        CREATE TABLE keywords (
          short_name TEXT,
          keyword TEXT,
          url TEXT,
          suggestions_url TEXT,
          favicon_url TEXT,
          is_active INTEGER DEFAULT 0
        );
      `);
      return db;
    }

    it("reads search engines and normalizes URL templates", async () => {
      const db = createWebDataDbWithKeywords(tmpDir);

      db.prepare(
        "INSERT INTO keywords (short_name, keyword, url, suggestions_url, favicon_url, is_active) VALUES (?, ?, ?, ?, ?, ?)",
      ).run("Google", "google.com", "https://google.com/search?q=%s", "https://google.com/complete?q=%s", "https://google.com/favicon.ico", 1);

      db.prepare(
        "INSERT INTO keywords (short_name, keyword, url, suggestions_url, favicon_url, is_active) VALUES (?, ?, ?, ?, ?, ?)",
      ).run("DuckDuckGo", "duckduckgo.com", "https://duckduckgo.com/?q=%s", "", "", 0);

      db.close();

      const engines = await reader.readSearchEngines(tmpDir);
      expect(engines).toHaveLength(2);

      const google = engines.find((e) => e.name === "Google")!;
      expect(google.searchUrl).toBe("https://google.com/search?q={searchTerms}");
      expect(google.suggestUrl).toBe("https://google.com/complete?q={searchTerms}");
      expect(google.isDefault).toBe(true);

      const ddg = engines.find((e) => e.name === "DuckDuckGo")!;
      expect(ddg.isDefault).toBe(false);
    });
  });

  // ---- Extensions ----

  describe("readExtensions", () => {
    it("reads extensions from Extensions directory and Preferences", async () => {
      // Create extension directory structure
      const extId = "abcdefghijklmnop";
      const extDir = path.join(tmpDir, "Extensions", extId, "1.0.0");
      fs.mkdirSync(extDir, { recursive: true });

      const manifest = {
        name: "Test Extension",
        version: "1.0.0",
        description: "A test extension",
        homepage_url: "https://test-ext.com",
      };
      fs.writeFileSync(path.join(extDir, "manifest.json"), JSON.stringify(manifest));

      // Create Preferences with extension settings
      const prefs = {
        extensions: {
          settings: {
            [extId]: { state: 1 },
          },
        },
      };
      fs.writeFileSync(path.join(tmpDir, "Preferences"), JSON.stringify(prefs));

      const extensions = await reader.readExtensions(tmpDir);
      expect(extensions).toHaveLength(1);
      expect(extensions[0]!.id).toBe(extId);
      expect(extensions[0]!.name).toBe("Test Extension");
      expect(extensions[0]!.version).toBe("1.0.0");
      expect(extensions[0]!.description).toBe("A test extension");
      expect(extensions[0]!.enabled).toBe(true);
    });

    it("marks disabled extensions correctly", async () => {
      const extId = "disabledext";
      const extDir = path.join(tmpDir, "Extensions", extId, "2.0.0");
      fs.mkdirSync(extDir, { recursive: true });

      fs.writeFileSync(
        path.join(extDir, "manifest.json"),
        JSON.stringify({ name: "Disabled Ext", version: "2.0.0" }),
      );

      const prefs = {
        extensions: { settings: { [extId]: { state: 0 } } },
      };
      fs.writeFileSync(path.join(tmpDir, "Preferences"), JSON.stringify(prefs));

      const extensions = await reader.readExtensions(tmpDir);
      expect(extensions).toHaveLength(1);
      expect(extensions[0]!.enabled).toBe(false);
    });

    it("returns empty array when Extensions dir is missing", async () => {
      const extensions = await reader.readExtensions(tmpDir);
      expect(extensions).toEqual([]);
    });
  });

  // ---- Permissions ----

  describe("readPermissions", () => {
    it("reads permissions from Preferences JSON", async () => {
      const prefs = {
        profile: {
          content_settings: {
            exceptions: {
              notifications: {
                "https://example.com,*": { setting: 1 },
                "https://blocked.com,*": { setting: 2 },
              },
              geolocation: {
                "https://maps.com,*": { setting: 1 },
              },
              media_stream_camera: {
                "https://meet.com,*": { setting: 1 },
              },
            },
          },
        },
      };

      fs.writeFileSync(path.join(tmpDir, "Preferences"), JSON.stringify(prefs));

      const permissions = await reader.readPermissions(tmpDir);
      expect(permissions.length).toBe(4);

      const notifAllow = permissions.find(
        (p) => p.permission === "notifications" && p.setting === "allow",
      )!;
      expect(notifAllow.origin).toBe("https://example.com");

      const notifBlock = permissions.find(
        (p) => p.permission === "notifications" && p.setting === "block",
      )!;
      expect(notifBlock.origin).toBe("https://blocked.com");

      const camera = permissions.find((p) => p.permission === "camera")!;
      expect(camera.origin).toBe("https://meet.com");
      expect(camera.setting).toBe("allow");
    });

    it("returns empty array when Preferences is missing", async () => {
      const permissions = await reader.readPermissions(tmpDir);
      expect(permissions).toEqual([]);
    });
  });

  // ---- Settings ----

  describe("readSettings", () => {
    it("reads settings from Preferences JSON", async () => {
      const prefs = {
        homepage: "https://example.com",
        default_search_provider_data: {
          template_url_data: {
            keyword: "google.com",
            short_name: "Google",
          },
        },
        bookmark_bar: {
          show_on_all_tabs: true,
        },
      };

      fs.writeFileSync(path.join(tmpDir, "Preferences"), JSON.stringify(prefs));

      const settings = await reader.readSettings(tmpDir);
      expect(settings.homepage).toBe("https://example.com");
      expect(settings.defaultSearchEngine).toBe("google.com");
      expect(settings.showBookmarksBar).toBe(true);
    });

    it("returns empty settings when Preferences is missing", async () => {
      const settings = await reader.readSettings(tmpDir);
      expect(settings).toEqual({});
    });
  });

  // ---- Favicons ----

  describe("readFavicons", () => {
    function createFaviconsDb(profileDir: string) {
      const dbPath = path.join(profileDir, "Favicons");
      const db = new Database(dbPath);
      db.exec(`
        CREATE TABLE favicons (
          id INTEGER PRIMARY KEY,
          url TEXT NOT NULL,
          icon_type INTEGER DEFAULT 1
        );
        CREATE TABLE favicon_bitmaps (
          id INTEGER PRIMARY KEY,
          icon_id INTEGER NOT NULL,
          image_data BLOB
        );
        CREATE TABLE icon_mapping (
          id INTEGER PRIMARY KEY,
          page_url TEXT NOT NULL,
          icon_id INTEGER NOT NULL
        );
      `);
      return db;
    }

    it("reads favicons from database", async () => {
      const db = createFaviconsDb(tmpDir);
      const pngData = Buffer.from([0x89, 0x50, 0x4e, 0x47]); // PNG magic bytes

      db.prepare("INSERT INTO favicons (id, url, icon_type) VALUES (?, ?, ?)").run(
        1, "https://example.com/favicon.png", 1,
      );
      db.prepare("INSERT INTO favicon_bitmaps (id, icon_id, image_data) VALUES (?, ?, ?)").run(
        1, 1, pngData,
      );
      db.prepare("INSERT INTO icon_mapping (id, page_url, icon_id) VALUES (?, ?, ?)").run(
        1, "https://example.com/", 1,
      );

      db.close();

      const favicons = await reader.readFavicons(tmpDir);
      expect(favicons).toHaveLength(1);
      expect(favicons[0]!.url).toBe("https://example.com/");
      expect(favicons[0]!.mimeType).toBe("image/png");
      expect(Buffer.isBuffer(favicons[0]!.data)).toBe(true);
    });

    it("returns empty array when Favicons db is missing", async () => {
      const favicons = await reader.readFavicons(tmpDir);
      expect(favicons).toEqual([]);
    });
  });
});
