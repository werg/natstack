import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { BROWSER_DATA_SCHEMA } from "../storage/schema.js";
import { BookmarkStore } from "../storage/bookmarkStore.js";
import { HistoryStore } from "../storage/historyStore.js";
import { PasswordStore } from "../storage/passwordStore.js";
import { CookieStore } from "../storage/cookieStore.js";
import { AutofillStore } from "../storage/autofillStore.js";
import { SearchEngineStore } from "../storage/searchEngineStore.js";
import { FaviconStore } from "../storage/faviconStore.js";
import { PermissionStore } from "../storage/permissionStore.js";
import { ImportLogStore } from "../storage/importLogStore.js";
import { BrowserDataStore } from "../storage/index.js";

function createInMemoryDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(BROWSER_DATA_SCHEMA);
  return db;
}

describe("BookmarkStore", () => {
  let db: Database.Database;
  let store: BookmarkStore;

  beforeEach(() => {
    db = createInMemoryDb();
    store = new BookmarkStore(db);
  });
  afterEach(() => db.close());

  it("adds and retrieves a bookmark", () => {
    const id = store.add({ title: "Test", url: "https://example.com" });
    const bm = store.get(id);
    expect(bm).toBeDefined();
    expect(bm!.title).toBe("Test");
    expect(bm!.url).toBe("https://example.com");
    expect(bm!.folder_path).toBe("/");
  });

  it("updates a bookmark", () => {
    const id = store.add({ title: "Old", url: "https://old.com" });
    store.update(id, { title: "New", url: "https://new.com" });
    const bm = store.get(id);
    expect(bm!.title).toBe("New");
    expect(bm!.url).toBe("https://new.com");
    expect(bm!.date_modified).toBeGreaterThan(0);
  });

  it("deletes a bookmark", () => {
    const id = store.add({ title: "Delete me", url: "https://del.com" });
    store.delete(id);
    expect(store.get(id)).toBeUndefined();
  });

  it("gets bookmarks by folder", () => {
    store.add({ title: "A", url: "https://a.com", folderPath: "/work" });
    store.add({ title: "B", url: "https://b.com", folderPath: "/work" });
    store.add({ title: "C", url: "https://c.com", folderPath: "/personal" });

    const work = store.getByFolder("/work");
    expect(work).toHaveLength(2);

    const personal = store.getByFolder("/personal");
    expect(personal).toHaveLength(1);
  });

  it("moves a bookmark", () => {
    const id = store.add({ title: "Move me", folderPath: "/old" });
    store.move(id, "/new", 5);
    const bm = store.get(id);
    expect(bm!.folder_path).toBe("/new");
    expect(bm!.position).toBe(5);
  });

  it("searches bookmarks by title and url", () => {
    store.add({ title: "TypeScript Docs", url: "https://typescriptlang.org" });
    store.add({ title: "Rust Book", url: "https://rust-lang.org" });

    const results = store.search("TypeScript");
    expect(results).toHaveLength(1);
    expect(results[0]!.title).toBe("TypeScript Docs");

    const urlResults = store.search("rust-lang");
    expect(urlResults).toHaveLength(1);
  });

  it("batch inserts bookmarks", () => {
    const count = store.addBatch([
      {
        title: "A",
        url: "https://a.com",
        dateAdded: Date.now(),
        folder: ["Toolbar", "Dev"],
      },
      {
        title: "B",
        url: "https://b.com",
        dateAdded: Date.now(),
        folder: ["Other"],
      },
    ]);
    expect(count).toBe(2);

    const folderA = store.getByFolder("/Toolbar/Dev");
    expect(folderA).toHaveLength(1);
    expect(folderA[0]!.title).toBe("A");
  });
});

describe("HistoryStore", () => {
  let db: Database.Database;
  let store: HistoryStore;

  beforeEach(() => {
    db = createInMemoryDb();
    store = new HistoryStore(db);
  });
  afterEach(() => db.close());

  it("adds and deduplicates history entries", () => {
    const id1 = store.add({ url: "https://example.com", title: "Example", lastVisit: 1000 });
    const id2 = store.add({ url: "https://example.com", title: "Example Updated", lastVisit: 2000 });

    // Should return same id due to UPSERT
    expect(id1).toBe(id2);

    // Check aggregated visit count
    const rows = store.query({});
    expect(rows).toHaveLength(1);
    expect(rows[0]!.visit_count).toBe(2);
    expect(rows[0]!.last_visit).toBe(2000);
  });

  it("adds visits", () => {
    const historyId = store.add({ url: "https://test.com", lastVisit: 1000 });
    const visitId = store.addVisit(historyId, 2000, "typed");
    expect(visitId).toBeGreaterThan(0);
  });

  it("deletes a history entry", () => {
    const id = store.add({ url: "https://del.com", lastVisit: 1000 });
    store.delete(id);
    const results = store.query({});
    expect(results).toHaveLength(0);
  });

  it("deletes by range", () => {
    store.add({ url: "https://a.com", lastVisit: 100 });
    store.add({ url: "https://b.com", lastVisit: 200 });
    store.add({ url: "https://c.com", lastVisit: 300 });

    const deleted = store.deleteRange(150, 250);
    expect(deleted).toBe(1);

    const remaining = store.query({});
    expect(remaining).toHaveLength(2);
  });

  it("clears all history", () => {
    store.add({ url: "https://a.com", lastVisit: 100 });
    store.add({ url: "https://b.com", lastVisit: 200 });
    store.clearAll();
    expect(store.query({})).toHaveLength(0);
  });

  it("searches history using FTS", () => {
    store.add({ url: "https://github.com", title: "GitHub", lastVisit: 1000 });
    store.add({ url: "https://gitlab.com", title: "GitLab", lastVisit: 2000 });
    store.add({ url: "https://example.com", title: "Example", lastVisit: 3000 });

    const results = store.search("git*");
    expect(results).toHaveLength(2);
  });

  it("queries with time range and limit", () => {
    store.add({ url: "https://a.com", lastVisit: 100 });
    store.add({ url: "https://b.com", lastVisit: 200 });
    store.add({ url: "https://c.com", lastVisit: 300 });

    const results = store.query({ startTime: 150, endTime: 350, limit: 10 });
    expect(results).toHaveLength(2);
  });

  it("batch inserts history entries", () => {
    const count = store.addBatch([
      { url: "https://a.com", title: "A", visitCount: 3, lastVisitTime: 1000 },
      { url: "https://b.com", title: "B", visitCount: 1, lastVisitTime: 2000 },
    ]);
    expect(count).toBe(2);
    expect(store.query({})).toHaveLength(2);
  });
});

describe("PasswordStore", () => {
  let db: Database.Database;
  let store: PasswordStore;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pw-test-"));
    db = createInMemoryDb();
    store = new PasswordStore(db, tmpDir);
  });
  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates a key file on first use", () => {
    expect(fs.existsSync(path.join(tmpDir, "browser-data.key"))).toBe(true);
  });

  it("encrypts and decrypts passwords", () => {
    const id = store.add({
      url: "https://example.com",
      username: "alice",
      password: "s3cret!",
    });

    const all = store.getAll();
    expect(all).toHaveLength(1);
    expect(all[0]!.username).toBe("alice");
    expect(all[0]!.password).toBe("s3cret!");
    expect(all[0]!.origin_url).toBe("https://example.com");
  });

  it("stores encrypted data in the db", () => {
    store.add({
      url: "https://example.com",
      username: "alice",
      password: "s3cret!",
    });

    // Read raw data - it should be encrypted buffers, not plaintext
    const raw = db.prepare("SELECT username_encrypted, password_encrypted FROM passwords").get() as {
      username_encrypted: Buffer;
      password_encrypted: Buffer;
    };
    expect(Buffer.isBuffer(raw.username_encrypted)).toBe(true);
    expect(Buffer.isBuffer(raw.password_encrypted)).toBe(true);
    // The encrypted data should not contain the plaintext
    expect(raw.username_encrypted.toString("utf8")).not.toBe("alice");
    expect(raw.password_encrypted.toString("utf8")).not.toBe("s3cret!");
  });

  it("updates password", () => {
    const id = store.add({
      url: "https://example.com",
      username: "alice",
      password: "old",
    });

    store.update(id, { password: "new" });
    const all = store.getAll();
    expect(all[0]!.password).toBe("new");
  });

  it("updates username", () => {
    const id = store.add({
      url: "https://example.com",
      username: "old_user",
      password: "pass",
    });

    store.update(id, { username: "new_user" });
    const all = store.getAll();
    expect(all[0]!.username).toBe("new_user");
  });

  it("deletes a password", () => {
    const id = store.add({
      url: "https://example.com",
      username: "alice",
      password: "pass",
    });
    store.delete(id);
    expect(store.getAll()).toHaveLength(0);
  });

  it("gets passwords for a site", () => {
    store.add({ url: "https://a.com", username: "u1", password: "p1" });
    store.add({ url: "https://b.com", username: "u2", password: "p2" });
    store.add({ url: "https://a.com", username: "u3", password: "p3" });

    const forA = store.getForSite("https://a.com");
    expect(forA).toHaveLength(2);
    expect(forA.map((p) => p.username).sort()).toEqual(["u1", "u3"]);
  });

  it("batch inserts passwords with dedup", () => {
    const count = store.addBatch([
      { url: "https://a.com", username: "u1", password: "p1" },
      { url: "https://b.com", username: "u2", password: "p2" },
    ]);
    expect(count).toBe(2);

    // Insert same username/url again - should update
    store.addBatch([
      { url: "https://a.com", username: "u1", password: "p1_updated" },
    ]);

    const all = store.getAll();
    expect(all).toHaveLength(2);
    const a = all.find((p) => p.origin_url === "https://a.com");
    expect(a!.password).toBe("p1_updated");
  });

  it("reloads with same key file", () => {
    store.add({ url: "https://example.com", username: "alice", password: "s3cret!" });

    // Create a new store pointing at same dir and db
    const store2 = new PasswordStore(db, tmpDir);
    const all = store2.getAll();
    expect(all).toHaveLength(1);
    expect(all[0]!.password).toBe("s3cret!");
  });
});

describe("CookieStore", () => {
  let db: Database.Database;
  let store: CookieStore;

  beforeEach(() => {
    db = createInMemoryDb();
    store = new CookieStore(db);
  });
  afterEach(() => db.close());

  it("adds and retrieves cookies", () => {
    store.add({ name: "session", value: "abc123", domain: "example.com" });
    const cookies = store.getByDomain("example.com");
    expect(cookies).toHaveLength(1);
    expect(cookies[0]!.name).toBe("session");
    expect(cookies[0]!.value).toBe("abc123");
  });

  it("matches dot-prefixed domains", () => {
    store.add({ name: "a", value: "1", domain: ".example.com" });
    const cookies = store.getByDomain("example.com");
    expect(cookies).toHaveLength(1);
  });

  it("deletes a cookie", () => {
    const id = store.add({ name: "x", value: "y", domain: "d.com" });
    store.delete(id);
    expect(store.getByDomain("d.com")).toHaveLength(0);
  });

  it("clears by domain", () => {
    store.add({ name: "a", value: "1", domain: "a.com" });
    store.add({ name: "b", value: "2", domain: "b.com" });
    store.clearByDomain("a.com");
    expect(store.getByDomain("a.com")).toHaveLength(0);
    expect(store.getByDomain("b.com")).toHaveLength(1);
  });

  it("clears all cookies", () => {
    store.add({ name: "a", value: "1", domain: "a.com" });
    store.add({ name: "b", value: "2", domain: "b.com" });
    store.clearAll();
    expect(store.getByDomain()).toHaveLength(0);
  });

  it("batch inserts cookies with dedup", () => {
    const count = store.addBatch([
      {
        name: "s",
        value: "v1",
        domain: "d.com",
        hostOnly: false,
        path: "/",
        secure: true,
        httpOnly: false,
        sameSite: "lax",
        sourceScheme: "secure",
        sourcePort: 443,
      },
      {
        name: "t",
        value: "v2",
        domain: "d.com",
        hostOnly: false,
        path: "/",
        secure: false,
        httpOnly: true,
        sameSite: "strict",
        sourceScheme: "non_secure",
        sourcePort: 80,
      },
    ]);
    expect(count).toBe(2);
    expect(store.getByDomain("d.com")).toHaveLength(2);
  });
});

describe("AutofillStore", () => {
  let db: Database.Database;
  let store: AutofillStore;

  beforeEach(() => {
    db = createInMemoryDb();
    store = new AutofillStore(db);
  });
  afterEach(() => db.close());

  it("adds and retrieves suggestions", () => {
    store.add({ fieldName: "email", value: "alice@example.com" });
    store.add({ fieldName: "email", value: "bob@example.com" });

    const suggestions = store.getSuggestions("email");
    expect(suggestions).toHaveLength(2);
  });

  it("filters suggestions by prefix", () => {
    store.add({ fieldName: "name", value: "Alice" });
    store.add({ fieldName: "name", value: "Albert" });
    store.add({ fieldName: "name", value: "Bob" });

    const suggestions = store.getSuggestions("name", "Al");
    expect(suggestions).toHaveLength(2);
  });

  it("increments usage on duplicate add", () => {
    store.add({ fieldName: "email", value: "test@test.com" });
    store.add({ fieldName: "email", value: "test@test.com" });

    const suggestions = store.getSuggestions("email");
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]!.times_used).toBe(2);
  });

  it("batch inserts autofill entries", () => {
    const count = store.addBatch([
      { fieldName: "email", value: "a@b.com", timesUsed: 5 },
      { fieldName: "phone", value: "555-1234", timesUsed: 2 },
    ]);
    expect(count).toBe(2);
  });
});

describe("SearchEngineStore", () => {
  let db: Database.Database;
  let store: SearchEngineStore;

  beforeEach(() => {
    db = createInMemoryDb();
    store = new SearchEngineStore(db);
  });
  afterEach(() => db.close());

  it("adds and retrieves engines", () => {
    store.add({ name: "Google", searchUrl: "https://google.com/search?q=%s", isDefault: true });
    store.add({ name: "DDG", searchUrl: "https://duckduckgo.com/?q=%s" });

    const all = store.getAll();
    expect(all).toHaveLength(2);
    expect(all[0]!.is_default).toBe(1); // default first
  });

  it("sets default engine", () => {
    const id1 = store.add({ name: "Google", searchUrl: "https://google.com/search?q=%s", isDefault: true });
    const id2 = store.add({ name: "DDG", searchUrl: "https://duckduckgo.com/?q=%s" });

    store.setDefault(id2);
    const all = store.getAll();
    const google = all.find((e) => e.name === "Google")!;
    const ddg = all.find((e) => e.name === "DDG")!;
    expect(google.is_default).toBe(0);
    expect(ddg.is_default).toBe(1);
  });

  it("deletes an engine", () => {
    const id = store.add({ name: "Test", searchUrl: "https://test.com?q=%s" });
    store.delete(id);
    expect(store.getAll()).toHaveLength(0);
  });

  it("batch inserts engines", () => {
    const count = store.addBatch([
      { name: "A", searchUrl: "https://a.com?q=%s", isDefault: true },
      { name: "B", searchUrl: "https://b.com?q=%s", isDefault: false },
    ]);
    expect(count).toBe(2);
  });
});

describe("FaviconStore", () => {
  let db: Database.Database;
  let store: FaviconStore;

  beforeEach(() => {
    db = createInMemoryDb();
    store = new FaviconStore(db);
  });
  afterEach(() => db.close());

  it("adds and retrieves a favicon by url", () => {
    const data = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    store.add("https://example.com/favicon.ico", data, "image/x-icon");

    const fav = store.get("https://example.com/favicon.ico");
    expect(fav).toBeDefined();
    expect(fav!.mime_type).toBe("image/x-icon");
    expect(Buffer.compare(fav!.data!, data)).toBe(0);
  });

  it("retrieves a favicon by id", () => {
    const data = Buffer.from([1, 2, 3]);
    const id = store.add("https://test.com/icon.png", data);
    const fav = store.getById(id);
    expect(fav).toBeDefined();
    expect(fav!.url).toBe("https://test.com/icon.png");
  });

  it("upserts on duplicate url", () => {
    const data1 = Buffer.from([1]);
    const data2 = Buffer.from([2]);
    store.add("https://test.com/icon.png", data1);
    store.add("https://test.com/icon.png", data2);

    const fav = store.get("https://test.com/icon.png");
    expect(Buffer.compare(fav!.data!, data2)).toBe(0);
  });

  it("batch inserts favicons", () => {
    const count = store.addBatch([
      { url: "https://a.com/icon.png", data: Buffer.from([1]), mimeType: "image/png" },
      { url: "https://b.com/icon.png", data: Buffer.from([2]), mimeType: "image/png" },
    ]);
    expect(count).toBe(2);
  });
});

describe("PermissionStore", () => {
  let db: Database.Database;
  let store: PermissionStore;

  beforeEach(() => {
    db = createInMemoryDb();
    store = new PermissionStore(db);
  });
  afterEach(() => db.close());

  it("sets and gets permissions", () => {
    store.set("https://example.com", "camera", "allow");
    store.set("https://example.com", "microphone", "block");

    const perms = store.get("https://example.com");
    expect(perms).toHaveLength(2);
  });

  it("upserts on conflict", () => {
    store.set("https://example.com", "camera", "allow");
    store.set("https://example.com", "camera", "block");

    const perms = store.get("https://example.com");
    expect(perms).toHaveLength(1);
    expect(perms[0]!.setting).toBe("block");
  });

  it("deletes a permission", () => {
    store.set("https://example.com", "camera", "allow");
    store.delete("https://example.com", "camera");
    expect(store.get("https://example.com")).toHaveLength(0);
  });

  it("gets all permissions", () => {
    store.set("https://a.com", "camera", "allow");
    store.set("https://b.com", "mic", "block");

    const all = store.get();
    expect(all).toHaveLength(2);
  });

  it("batch inserts permissions", () => {
    const count = store.addBatch([
      { origin: "https://a.com", permission: "camera", setting: "allow" },
      { origin: "https://b.com", permission: "location", setting: "block" },
    ]);
    expect(count).toBe(2);
  });
});

describe("ImportLogStore", () => {
  let db: Database.Database;
  let store: ImportLogStore;

  beforeEach(() => {
    db = createInMemoryDb();
    store = new ImportLogStore(db);
  });
  afterEach(() => db.close());

  it("logs and retrieves import entries", () => {
    store.log({
      browser: "chrome",
      profilePath: "/home/user/.config/google-chrome/Default",
      dataType: "bookmarks",
      itemsImported: 100,
      itemsSkipped: 5,
      warnings: ["Some warning"],
    });

    const all = store.getAll();
    expect(all).toHaveLength(1);
    expect(all[0]!.browser).toBe("chrome");
    expect(all[0]!.items_imported).toBe(100);
    expect(all[0]!.warnings).toBe('["Some warning"]');
  });

  it("returns entries in reverse chronological order", () => {
    store.log({
      browser: "chrome",
      profilePath: "/path",
      dataType: "bookmarks",
      itemsImported: 10,
      itemsSkipped: 0,
    });
    store.log({
      browser: "firefox",
      profilePath: "/path2",
      dataType: "history",
      itemsImported: 20,
      itemsSkipped: 1,
    });

    const all = store.getAll();
    expect(all).toHaveLength(2);
    // Most recent first
    expect(all[0]!.imported_at).toBeGreaterThanOrEqual(all[1]!.imported_at);
  });
});

describe("BrowserDataStore integration", () => {
  let tmpDir: string;
  let store: BrowserDataStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bds-test-"));
    store = new BrowserDataStore(tmpDir);
  });
  afterEach(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates the database file", () => {
    expect(fs.existsSync(path.join(tmpDir, "browser-data.db"))).toBe(true);
  });

  it("has all sub-stores available", () => {
    expect(store.bookmarks).toBeDefined();
    expect(store.history).toBeDefined();
    expect(store.passwords).toBeDefined();
    expect(store.cookies).toBeDefined();
    expect(store.autofill).toBeDefined();
    expect(store.searchEngines).toBeDefined();
    expect(store.favicons).toBeDefined();
    expect(store.permissions).toBeDefined();
    expect(store.importLog).toBeDefined();
  });

  it("works end-to-end across stores", () => {
    // Add a favicon
    const favId = store.favicons.add(
      "https://example.com/favicon.ico",
      Buffer.from([1, 2, 3]),
      "image/x-icon",
    );

    // Add a bookmark with that favicon
    const bmId = store.bookmarks.add({
      title: "Example",
      url: "https://example.com",
      faviconId: favId,
    });

    const bm = store.bookmarks.get(bmId);
    expect(bm!.favicon_id).toBe(favId);

    // Add history
    const hId = store.history.add({
      url: "https://example.com",
      title: "Example",
      lastVisit: Date.now(),
    });
    store.history.addVisit(hId, Date.now(), "typed");

    // Add a password
    store.passwords.add({
      url: "https://example.com",
      username: "user",
      password: "pass",
    });

    // Log the import
    store.importLog.log({
      browser: "chrome",
      profilePath: "/path",
      dataType: "bookmarks",
      itemsImported: 1,
      itemsSkipped: 0,
    });

    const logs = store.importLog.getAll();
    expect(logs).toHaveLength(1);
  });

  it("can reopen the same database", () => {
    store.bookmarks.add({ title: "Persist", url: "https://persist.com" });
    store.close();

    const store2 = new BrowserDataStore(tmpDir);
    const results = store2.bookmarks.search("Persist");
    expect(results).toHaveLength(1);
    store2.close();
  });
});
