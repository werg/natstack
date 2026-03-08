import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import Database from "better-sqlite3";
import {
  parseBinaryCookies,
  parseSafariPasswordCsv,
  SafariReader,
} from "../readers/safariReader.js";

// ---- Binary cookies parser tests ----

describe("parseBinaryCookies", () => {
  function buildBinaryCookiesFile(
    cookies: Array<{
      name: string;
      value: string;
      domain: string;
      path: string;
      flags: number;
      expiry: number;
      creation: number;
    }>,
  ): Buffer {
    // Build a single-page binary cookies file
    const cookieBuffers: Buffer[] = [];

    for (const c of cookies) {
      // Encode strings as null-terminated
      const nameBytes = Buffer.from(c.name + "\0", "utf-8");
      const valueBytes = Buffer.from(c.value + "\0", "utf-8");
      const domainBytes = Buffer.from(c.domain + "\0", "utf-8");
      const pathBytes = Buffer.from(c.path + "\0", "utf-8");

      // Fixed header: 48 bytes before strings
      // size(4) + flags(4) + domainOff(4) + nameOff(4) + pathOff(4) + valueOff(4) + comment(8) + expiry(8) + creation(8) = 48
      const headerSize = 48;
      const domainOffset = headerSize;
      const nameOffset = domainOffset + domainBytes.length;
      const pathOffset = nameOffset + nameBytes.length;
      const valueOffset = pathOffset + pathBytes.length;
      const totalSize =
        headerSize +
        domainBytes.length +
        nameBytes.length +
        pathBytes.length +
        valueBytes.length;

      const buf = Buffer.alloc(totalSize);
      buf.writeUInt32LE(totalSize, 0); // size
      buf.writeUInt32LE(c.flags, 4); // flags
      buf.writeUInt32LE(domainOffset, 8); // domain offset
      buf.writeUInt32LE(nameOffset, 12); // name offset
      buf.writeUInt32LE(pathOffset, 16); // path offset
      buf.writeUInt32LE(valueOffset, 20); // value offset
      // comment: 8 bytes at offset 24, leave as zeros
      buf.writeDoubleLE(c.expiry, 32); // expiry (Mac epoch seconds)
      buf.writeDoubleLE(c.creation, 40); // creation (Mac epoch seconds)
      domainBytes.copy(buf, domainOffset);
      nameBytes.copy(buf, nameOffset);
      pathBytes.copy(buf, pathOffset);
      valueBytes.copy(buf, valueOffset);

      cookieBuffers.push(buf);
    }

    // Build page
    const numCookies = cookieBuffers.length;
    // Page header: magic(4) + numCookies(4) + offsets(4*n) + cookies
    const pageHeaderSize = 4 + 4 + numCookies * 4;

    let cookieDataSize = 0;
    for (const cb of cookieBuffers) {
      cookieDataSize += cb.length;
    }
    const pageSize = pageHeaderSize + cookieDataSize;
    const pageData = Buffer.alloc(pageSize);

    // Page magic: 0x00000100
    pageData.writeUInt32BE(0x00000100, 0);
    pageData.writeUInt32LE(numCookies, 4);

    // Write cookie offsets
    let cookieOffset = pageHeaderSize;
    for (let i = 0; i < numCookies; i++) {
      pageData.writeUInt32LE(cookieOffset, 8 + i * 4);
      cookieOffset += cookieBuffers[i]!.length;
    }

    // Write cookie data
    let pos = pageHeaderSize;
    for (const cb of cookieBuffers) {
      cb.copy(pageData, pos);
      pos += cb.length;
    }

    // Build file
    // Header: "cook"(4) + numPages(4) + pageSizes(4*1) + pageData
    const fileSize = 4 + 4 + 4 + pageSize;
    const file = Buffer.alloc(fileSize);
    file.write("cook", 0, "ascii");
    file.writeUInt32BE(1, 4); // 1 page
    file.writeUInt32BE(pageSize, 8); // page size
    pageData.copy(file, 12);

    return file;
  }

  it("parses a file with one cookie", () => {
    const data = buildBinaryCookiesFile([
      {
        name: "session_id",
        value: "abc123",
        domain: ".example.com",
        path: "/",
        flags: 0x1, // secure
        expiry: 700000000, // some Mac epoch time
        creation: 699000000,
      },
    ]);

    const cookies = parseBinaryCookies(data);
    expect(cookies).toHaveLength(1);
    expect(cookies[0]!.name).toBe("session_id");
    expect(cookies[0]!.value).toBe("abc123");
    expect(cookies[0]!.domain).toBe(".example.com");
    expect(cookies[0]!.path).toBe("/");
    expect(cookies[0]!.flags & 0x1).toBe(1); // secure
    expect(cookies[0]!.expirationDate).toBe(700000000);
    expect(cookies[0]!.creationDate).toBe(699000000);
  });

  it("parses a file with multiple cookies", () => {
    const data = buildBinaryCookiesFile([
      {
        name: "cookie1",
        value: "val1",
        domain: ".foo.com",
        path: "/",
        flags: 0x0,
        expiry: 700000000,
        creation: 699000000,
      },
      {
        name: "cookie2",
        value: "val2",
        domain: "bar.com",
        path: "/api",
        flags: 0x5, // secure + httpOnly
        expiry: 800000000,
        creation: 799000000,
      },
    ]);

    const cookies = parseBinaryCookies(data);
    expect(cookies).toHaveLength(2);
    expect(cookies[0]!.name).toBe("cookie1");
    expect(cookies[0]!.domain).toBe(".foo.com");
    expect(cookies[1]!.name).toBe("cookie2");
    expect(cookies[1]!.domain).toBe("bar.com");
    expect(cookies[1]!.path).toBe("/api");
    expect(cookies[1]!.flags & 0x1).toBe(1); // secure
    expect(cookies[1]!.flags & 0x4).toBe(4); // httpOnly
  });

  it("returns empty array for empty buffer", () => {
    expect(parseBinaryCookies(Buffer.alloc(0))).toEqual([]);
  });

  it("throws for invalid magic", () => {
    const data = Buffer.from("notcook\x00\x00\x00\x00");
    expect(() => parseBinaryCookies(data)).toThrow("Not a valid Safari");
  });

  it("handles zero pages", () => {
    const data = Buffer.alloc(8);
    data.write("cook", 0, "ascii");
    data.writeUInt32BE(0, 4);
    expect(parseBinaryCookies(data)).toEqual([]);
  });
});

// ---- CSV password parser tests ----

describe("parseSafariPasswordCsv", () => {
  it("parses standard Safari CSV export", () => {
    const csv = `Title,URL,Username,Password,Notes,OTPAuth
Example Site,https://example.com,user@example.com,s3cret,,
Another Site,https://another.com,admin,pa$$word,some notes,`;

    const passwords = parseSafariPasswordCsv(csv);
    expect(passwords).toHaveLength(2);
    expect(passwords[0]!).toEqual({
      url: "https://example.com",
      username: "user@example.com",
      password: "s3cret",
      realm: "Example Site",
    });
    expect(passwords[1]!).toEqual({
      url: "https://another.com",
      username: "admin",
      password: "pa$$word",
      realm: "Another Site",
    });
  });

  it("handles quoted fields with commas", () => {
    const csv = `Title,URL,Username,Password,Notes,OTPAuth
"Site, Inc.",https://site.com,user,"pass,word",,`;

    const passwords = parseSafariPasswordCsv(csv);
    expect(passwords).toHaveLength(1);
    expect(passwords[0]!.password).toBe("pass,word");
    expect(passwords[0]!.realm).toBe("Site, Inc.");
  });

  it("handles escaped quotes in fields", () => {
    const csv = `Title,URL,Username,Password,Notes,OTPAuth
Test,https://test.com,user,"pa""ss""wd",,`;

    const passwords = parseSafariPasswordCsv(csv);
    expect(passwords).toHaveLength(1);
    expect(passwords[0]!.password).toBe('pa"ss"wd');
  });

  it("returns empty array for empty input", () => {
    expect(parseSafariPasswordCsv("")).toEqual([]);
    expect(parseSafariPasswordCsv("Title,URL,Username,Password")).toEqual([]);
  });

  it("returns empty array for missing required columns", () => {
    const csv = `Name,Website,Notes
Test,https://test.com,some notes`;
    expect(parseSafariPasswordCsv(csv)).toEqual([]);
  });

  it("skips rows with no url and no username", () => {
    const csv = `Title,URL,Username,Password,Notes,OTPAuth
Valid,https://valid.com,user,pass,,
Invalid,,,,,`;

    const passwords = parseSafariPasswordCsv(csv);
    expect(passwords).toHaveLength(1);
    expect(passwords[0]!.url).toBe("https://valid.com");
  });
});

// ---- SafariReader integration tests ----

describe("SafariReader", () => {
  let tmpDir: string;
  let reader: SafariReader;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "natstack-test-safari-"));
    reader = new SafariReader();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("readHistory", () => {
    it("reads history from a synthetic History.db", async () => {
      const dbPath = path.join(tmpDir, "History.db");
      const db = new Database(dbPath);

      db.exec(`
        CREATE TABLE history_items (
          id INTEGER PRIMARY KEY,
          url TEXT NOT NULL,
          domain_expansion TEXT,
          visit_count INTEGER DEFAULT 0
        );
        CREATE TABLE history_visits (
          id INTEGER PRIMARY KEY,
          history_item INTEGER REFERENCES history_items(id),
          visit_time REAL NOT NULL,
          title TEXT
        );
      `);

      // Mac epoch time: seconds since 2001-01-01
      // 2024-01-15 ~= 726969600 seconds since Mac epoch
      const macTime1 = 726969600;
      const macTime2 = 727056000; // ~1 day later

      db.prepare(
        "INSERT INTO history_items (id, url, domain_expansion, visit_count) VALUES (?, ?, ?, ?)",
      ).run(1, "https://example.com", "example.com", 3);

      db.prepare(
        "INSERT INTO history_items (id, url, domain_expansion, visit_count) VALUES (?, ?, ?, ?)",
      ).run(2, "https://apple.com/safari", "apple.com", 1);

      db.prepare(
        "INSERT INTO history_visits (history_item, visit_time, title) VALUES (?, ?, ?)",
      ).run(1, macTime1, "Example Domain");

      db.prepare(
        "INSERT INTO history_visits (history_item, visit_time, title) VALUES (?, ?, ?)",
      ).run(1, macTime2, "Example Domain - Updated");

      db.prepare(
        "INSERT INTO history_visits (history_item, visit_time, title) VALUES (?, ?, ?)",
      ).run(2, macTime1, "Apple - Safari");

      db.close();

      const history = await reader.readHistory(tmpDir);
      expect(history).toHaveLength(2);

      const example = history.find((h) => h.url === "https://example.com")!;
      expect(example).toBeDefined();
      expect(example.visitCount).toBe(3);
      expect(example.title).toBe("Example Domain - Updated"); // latest title
      // lastVisitTime should be macTime2 converted
      expect(example.lastVisitTime).toBeGreaterThan(example.firstVisitTime!);

      const apple = history.find(
        (h) => h.url === "https://apple.com/safari",
      )!;
      expect(apple).toBeDefined();
      expect(apple.visitCount).toBe(1);
      expect(apple.title).toBe("Apple - Safari");
    });

    it("returns empty array if History.db does not exist", async () => {
      const history = await reader.readHistory(tmpDir);
      expect(history).toEqual([]);
    });
  });

  describe("readPermissions", () => {
    it("reads permissions from a synthetic PerSitePreferences.db", async () => {
      const dbPath = path.join(tmpDir, "PerSitePreferences.db");
      const db = new Database(dbPath);

      db.exec(`
        CREATE TABLE preference_values (
          domain TEXT NOT NULL,
          key TEXT NOT NULL,
          value TEXT
        );
      `);

      db.prepare(
        "INSERT INTO preference_values (domain, key, value) VALUES (?, ?, ?)",
      ).run("example.com", "notifications", "1");

      db.prepare(
        "INSERT INTO preference_values (domain, key, value) VALUES (?, ?, ?)",
      ).run("ads.example.com", "popups", "0");

      db.prepare(
        "INSERT INTO preference_values (domain, key, value) VALUES (?, ?, ?)",
      ).run("other.com", "camera", "ask");

      db.close();

      const perms = await reader.readPermissions(tmpDir);
      expect(perms).toHaveLength(3);

      expect(perms[0]!).toEqual({
        origin: "example.com",
        permission: "notifications",
        setting: "allow",
      });
      expect(perms[1]!).toEqual({
        origin: "ads.example.com",
        permission: "popups",
        setting: "block",
      });
      expect(perms[2]!).toEqual({
        origin: "other.com",
        permission: "camera",
        setting: "ask",
      });
    });

    it("returns empty array if PerSitePreferences.db does not exist", async () => {
      const perms = await reader.readPermissions(tmpDir);
      expect(perms).toEqual([]);
    });

    it("returns empty array if preference_values table does not exist", async () => {
      const dbPath = path.join(tmpDir, "PerSitePreferences.db");
      const db = new Database(dbPath);
      db.exec("CREATE TABLE other_table (id INTEGER PRIMARY KEY)");
      db.close();

      const perms = await reader.readPermissions(tmpDir);
      expect(perms).toEqual([]);
    });
  });

  describe("readPasswords", () => {
    it("returns empty array (keychain not accessible)", async () => {
      const passwords = await reader.readPasswords(tmpDir);
      expect(passwords).toEqual([]);
    });
  });

  describe("readPasswordsFromCsv", () => {
    it("reads passwords from a CSV file", async () => {
      const csvPath = path.join(tmpDir, "passwords.csv");
      fs.writeFileSync(
        csvPath,
        `Title,URL,Username,Password,Notes,OTPAuth
Example,https://example.com,user,pass123,,
`,
      );

      const passwords = await reader.readPasswordsFromCsv(csvPath);
      expect(passwords).toHaveLength(1);
      expect(passwords[0]!.url).toBe("https://example.com");
      expect(passwords[0]!.username).toBe("user");
      expect(passwords[0]!.password).toBe("pass123");
    });

    it("returns empty array for non-existent CSV file", async () => {
      const passwords = await reader.readPasswordsFromCsv(
        path.join(tmpDir, "nonexistent.csv"),
      );
      expect(passwords).toEqual([]);
    });
  });

  describe("readBookmarks", () => {
    it("returns empty array if Bookmarks.plist does not exist", async () => {
      const bookmarks = await reader.readBookmarks(tmpDir);
      expect(bookmarks).toEqual([]);
    });
  });

  describe("stub methods", () => {
    it("readAutofill returns empty array", async () => {
      expect(await reader.readAutofill(tmpDir)).toEqual([]);
    });

    it("readSearchEngines returns empty array", async () => {
      expect(await reader.readSearchEngines(tmpDir)).toEqual([]);
    });

    it("readExtensions returns empty array", async () => {
      expect(await reader.readExtensions(tmpDir)).toEqual([]);
    });

    it("readFavicons returns empty array", async () => {
      expect(await reader.readFavicons(tmpDir)).toEqual([]);
    });
  });

  describe("readCookies integration", () => {
    it("converts raw cookies to ImportedCookie format", () => {
      // Test the parseBinaryCookies -> ImportedCookie mapping logic
      // by checking the SafariReader.readCookies would map flags correctly
      // We test the mapping logic indirectly via the public parseBinaryCookies

      const data = buildMinimalCookieFile({
        name: "test",
        value: "v",
        domain: ".example.com",
        path: "/",
        flags: 0x5, // secure + httpOnly
        expiry: 700000000,
        creation: 699000000,
      });

      const raw = parseBinaryCookies(data);
      expect(raw).toHaveLength(1);

      // Simulate the mapping done in readCookies
      const c = raw[0]!;
      const secure = (c.flags & 0x1) !== 0;
      const httpOnly = (c.flags & 0x4) !== 0;
      const hostOnly = !c.domain.startsWith(".");

      expect(secure).toBe(true);
      expect(httpOnly).toBe(true);
      expect(hostOnly).toBe(false); // starts with "."
    });
  });
});

// Helper to build a minimal cookie file for integration tests
function buildMinimalCookieFile(cookie: {
  name: string;
  value: string;
  domain: string;
  path: string;
  flags: number;
  expiry: number;
  creation: number;
}): Buffer {
  const nameBytes = Buffer.from(cookie.name + "\0", "utf-8");
  const valueBytes = Buffer.from(cookie.value + "\0", "utf-8");
  const domainBytes = Buffer.from(cookie.domain + "\0", "utf-8");
  const pathBytes = Buffer.from(cookie.path + "\0", "utf-8");

  const headerSize = 48;
  const domainOffset = headerSize;
  const nameOffset = domainOffset + domainBytes.length;
  const pathOffset = nameOffset + nameBytes.length;
  const valueOffset = pathOffset + pathBytes.length;
  const totalSize =
    headerSize +
    domainBytes.length +
    nameBytes.length +
    pathBytes.length +
    valueBytes.length;

  const cookieBuf = Buffer.alloc(totalSize);
  cookieBuf.writeUInt32LE(totalSize, 0);
  cookieBuf.writeUInt32LE(cookie.flags, 4);
  cookieBuf.writeUInt32LE(domainOffset, 8);
  cookieBuf.writeUInt32LE(nameOffset, 12);
  cookieBuf.writeUInt32LE(pathOffset, 16);
  cookieBuf.writeUInt32LE(valueOffset, 20);
  cookieBuf.writeDoubleLE(cookie.expiry, 32);
  cookieBuf.writeDoubleLE(cookie.creation, 40);
  domainBytes.copy(cookieBuf, domainOffset);
  nameBytes.copy(cookieBuf, nameOffset);
  pathBytes.copy(cookieBuf, pathOffset);
  valueBytes.copy(cookieBuf, valueOffset);

  // Page: header(4) + numCookies(4) + offset(4) + cookieData
  const pageHeaderSize = 4 + 4 + 4;
  const pageSize = pageHeaderSize + totalSize;
  const pageData = Buffer.alloc(pageSize);
  pageData.writeUInt32BE(0x00000100, 0);
  pageData.writeUInt32LE(1, 4);
  pageData.writeUInt32LE(pageHeaderSize, 8);
  cookieBuf.copy(pageData, pageHeaderSize);

  // File: "cook"(4) + numPages(4) + pageSize(4) + pageData
  const fileSize = 4 + 4 + 4 + pageSize;
  const file = Buffer.alloc(fileSize);
  file.write("cook", 0, "ascii");
  file.writeUInt32BE(1, 4);
  file.writeUInt32BE(pageSize, 8);
  pageData.copy(file, 12);

  return file;
}
