import { describe, expect, it } from "vitest";
import { exportNetscapeBookmarks } from "../export/netscapeBookmarks.js";
import { exportChromiumBookmarks } from "../export/chromiumBookmarks.js";
import { exportCsvPasswords } from "../export/csvPasswords.js";
import { exportNetscapeCookies } from "../export/netscapeCookies.js";
import { exportJson } from "../export/jsonExport.js";
import type {
  ImportedBookmark,
  ImportedCookie,
  ImportedPassword,
  ImportedHistoryEntry,
  ImportedAutofillEntry,
  ImportedPermission,
} from "../types.js";

// ---- Fixtures ----

const bookmarks: ImportedBookmark[] = [
  {
    title: "Example",
    url: "https://example.com",
    dateAdded: 1700000000000,
    folder: ["Bookmarks Bar"],
  },
  {
    title: "Nested Page",
    url: "https://nested.example.com",
    dateAdded: 1700001000000,
    dateModified: 1700002000000,
    folder: ["Bookmarks Bar", "Dev"],
  },
  {
    title: "Other Site",
    url: "https://other.com",
    dateAdded: 1700003000000,
    folder: ["Other"],
  },
  {
    title: 'Title with <html> & "quotes"',
    url: "https://special.com?a=1&b=2",
    dateAdded: 1700004000000,
    folder: ["Bookmarks Bar"],
  },
];

const passwords: ImportedPassword[] = [
  {
    url: "https://example.com/login",
    username: "user@example.com",
    password: "p@ss,word",
    realm: "Example Realm",
  },
  {
    url: "https://other.com",
    username: 'user"name',
    password: "has\nnewline",
  },
  {
    url: "https://simple.com",
    username: "admin",
    password: "secret123",
  },
];

const cookies: ImportedCookie[] = [
  {
    name: "session_id",
    value: "abc123",
    domain: ".example.com",
    hostOnly: false,
    path: "/",
    expirationDate: 1700000000000,
    secure: true,
    httpOnly: true,
    sameSite: "lax",
    sourceScheme: "secure",
    sourcePort: 443,
  },
  {
    name: "pref",
    value: "dark",
    domain: "other.com",
    hostOnly: true,
    path: "/settings",
    secure: false,
    httpOnly: false,
    sameSite: "unspecified",
    sourceScheme: "non_secure",
    sourcePort: 80,
  },
];

// ---- Tests ----

describe("exportNetscapeBookmarks", () => {
  it("produces valid Netscape bookmark HTML", () => {
    const html = exportNetscapeBookmarks(bookmarks);
    expect(html).toContain("<!DOCTYPE NETSCAPE-Bookmark-file-1>");
    expect(html).toContain("<TITLE>Bookmarks</TITLE>");
    expect(html).toContain("<H1>Bookmarks</H1>");
  });

  it("nests bookmarks into folders", () => {
    const html = exportNetscapeBookmarks(bookmarks);
    expect(html).toContain("Bookmarks Bar</H3>");
    expect(html).toContain("Dev</H3>");
    expect(html).toContain('HREF="https://nested.example.com"');
  });

  it("escapes HTML entities in titles and URLs", () => {
    const html = exportNetscapeBookmarks(bookmarks);
    expect(html).toContain(
      "Title with &lt;html&gt; &amp; &quot;quotes&quot;",
    );
    expect(html).toContain("https://special.com?a=1&amp;b=2");
  });

  it("uses Unix seconds for ADD_DATE", () => {
    const html = exportNetscapeBookmarks(bookmarks);
    // 1700000000000 ms -> 1700000000 seconds
    expect(html).toContain('ADD_DATE="1700000000"');
  });

  it("handles empty bookmark list", () => {
    const html = exportNetscapeBookmarks([]);
    expect(html).toContain("<!DOCTYPE NETSCAPE-Bookmark-file-1>");
    expect(html).toContain("<DL><p>");
    expect(html).toContain("</DL><p>");
  });
});

describe("exportChromiumBookmarks", () => {
  it("produces valid JSON with correct structure", () => {
    const json = exportChromiumBookmarks(bookmarks);
    const parsed = JSON.parse(json);
    expect(parsed.version).toBe(1);
    expect(parsed.roots).toBeDefined();
    expect(parsed.roots.bookmark_bar).toBeDefined();
    expect(parsed.roots.other).toBeDefined();
    expect(parsed.roots.synced).toBeDefined();
    expect(parsed.checksum).toBeTruthy();
  });

  it("places Bookmarks Bar items under bookmark_bar", () => {
    const json = exportChromiumBookmarks(bookmarks);
    const parsed = JSON.parse(json);
    const bar = parsed.roots.bookmark_bar;
    expect(bar.name).toBe("Bookmarks bar");
    expect(bar.type).toBe("folder");

    // Should have "Example" and the special-char bookmark at top level, plus "Dev" folder
    const topUrls = bar.children
      .filter((c: { type: string }) => c.type === "url")
      .map((c: { name: string }) => c.name);
    expect(topUrls).toContain("Example");
  });

  it("places non-bar items under other", () => {
    const json = exportChromiumBookmarks(bookmarks);
    const parsed = JSON.parse(json);
    const other = parsed.roots.other;

    // "Other Site" has folder ["Other"], so should appear in Other > Other folder
    function findUrls(node: { children?: { type: string; url?: string; name: string; children?: unknown[] }[] }): string[] {
      const urls: string[] = [];
      for (const child of node.children ?? []) {
        if (child.type === "url") urls.push(child.url!);
        else urls.push(...findUrls(child as { children?: { type: string; url?: string; name: string }[] }));
      }
      return urls;
    }
    expect(findUrls(other)).toContain("https://other.com");
  });

  it("uses Chrome timestamp format", () => {
    const json = exportChromiumBookmarks(bookmarks);
    const parsed = JSON.parse(json);
    const firstBookmark = parsed.roots.bookmark_bar.children.find(
      (c: { type: string }) => c.type === "url",
    );
    const dateAdded = BigInt(firstBookmark.date_added);
    // Should be microseconds since 1601 epoch
    // 1700000000000 ms = 1700000000000000 us + 11644473600000000
    const expected = BigInt(1700000000000) * 1000n + 11644473600000000n;
    expect(dateAdded).toBe(expected);
  });

  it("creates nested folder structures", () => {
    const json = exportChromiumBookmarks(bookmarks);
    const parsed = JSON.parse(json);
    const devFolder = parsed.roots.bookmark_bar.children.find(
      (c: { type: string; name: string }) => c.type === "folder" && c.name === "Dev",
    );
    expect(devFolder).toBeDefined();
    expect(devFolder.children.length).toBe(1);
    expect(devFolder.children[0]!.name).toBe("Nested Page");
  });

  it("synced folder is always empty", () => {
    const json = exportChromiumBookmarks(bookmarks);
    const parsed = JSON.parse(json);
    expect(parsed.roots.synced.children).toEqual([]);
    expect(parsed.roots.synced.name).toBe("Mobile bookmarks");
  });
});

describe("exportCsvPasswords", () => {
  it("exports Chrome format with correct headers", () => {
    const csv = exportCsvPasswords(passwords, "chrome");
    const lines = csv.trimEnd().split("\n");
    expect(lines[0]).toBe("url,username,password,name");
    // 5 lines because one password field contains a newline inside quotes
    expect(lines.length).toBe(5);
  });

  it("exports Firefox format with correct headers", () => {
    const csv = exportCsvPasswords(passwords, "firefox");
    const lines = csv.trimEnd().split("\n");
    expect(lines[0]).toBe("url,username,password,httpRealm");
  });

  it("escapes fields with commas", () => {
    const csv = exportCsvPasswords(passwords, "chrome");
    // password "p@ss,word" should be quoted
    expect(csv).toContain('"p@ss,word"');
  });

  it("escapes fields with quotes using double-quoting", () => {
    const csv = exportCsvPasswords(passwords, "chrome");
    // username 'user"name' -> "user""name"
    expect(csv).toContain('"user""name"');
  });

  it("escapes fields with newlines", () => {
    const csv = exportCsvPasswords(passwords, "chrome");
    expect(csv).toContain('"has\nnewline"');
  });

  it("extracts origin for Chrome name field", () => {
    const csv = exportCsvPasswords(passwords, "chrome");
    expect(csv).toContain("https://example.com");
  });

  it("includes realm for Firefox format", () => {
    const csv = exportCsvPasswords(passwords, "firefox");
    expect(csv).toContain("Example Realm");
  });

  it("handles empty password list", () => {
    const csv = exportCsvPasswords([], "chrome");
    expect(csv.trimEnd()).toBe("url,username,password,name");
  });
});

describe("exportNetscapeCookies", () => {
  it("produces Netscape cookie format with header", () => {
    const txt = exportNetscapeCookies(cookies);
    expect(txt).toContain("# Netscape HTTP Cookie File");
  });

  it("uses tab-separated fields", () => {
    const txt = exportNetscapeCookies(cookies);
    const lines = txt.trimEnd().split("\n");
    // First data line (after header)
    const fields = lines[1]!.split("\t");
    expect(fields.length).toBe(7);
  });

  it("sets flag TRUE when domain starts with dot", () => {
    const txt = exportNetscapeCookies(cookies);
    const lines = txt.trimEnd().split("\n");
    const dotDomainLine = lines.find((l) => l.startsWith(".example.com"));
    expect(dotDomainLine).toBeDefined();
    const fields = dotDomainLine!.split("\t");
    expect(fields[1]).toBe("TRUE");
  });

  it("sets flag FALSE when domain does not start with dot", () => {
    const txt = exportNetscapeCookies(cookies);
    const lines = txt.trimEnd().split("\n");
    const noDotLine = lines.find((l) => l.startsWith("other.com"));
    expect(noDotLine).toBeDefined();
    const fields = noDotLine!.split("\t");
    expect(fields[1]).toBe("FALSE");
  });

  it("sets secure flag correctly", () => {
    const txt = exportNetscapeCookies(cookies);
    const lines = txt.trimEnd().split("\n");
    const secureLine = lines.find((l) => l.includes("session_id"))!;
    const fields = secureLine.split("\t");
    expect(fields[3]).toBe("TRUE"); // secure

    const insecureLine = lines.find((l) => l.includes("pref"))!;
    const insecureFields = insecureLine.split("\t");
    expect(insecureFields[3]).toBe("FALSE");
  });

  it("uses 0 for session cookies without expiry", () => {
    const txt = exportNetscapeCookies(cookies);
    const lines = txt.trimEnd().split("\n");
    const sessionLine = lines.find((l) => l.includes("pref"))!;
    const fields = sessionLine.split("\t");
    expect(fields[4]).toBe("0");
  });

  it("converts expiry to Unix seconds", () => {
    const txt = exportNetscapeCookies(cookies);
    const lines = txt.trimEnd().split("\n");
    const line = lines.find((l) => l.includes("session_id"))!;
    const fields = line.split("\t");
    expect(fields[4]).toBe("1700000000");
  });
});

describe("exportJson", () => {
  it("produces valid JSON with metadata", () => {
    const data = exportJson({
      exportedAt: "2024-01-01T00:00:00.000Z",
      version: 1,
      bookmarks,
    });
    const parsed = JSON.parse(data);
    expect(parsed.exportedAt).toBe("2024-01-01T00:00:00.000Z");
    expect(parsed.version).toBe(1);
  });

  it("includes all data types when provided", () => {
    const history: ImportedHistoryEntry[] = [
      {
        url: "https://example.com",
        title: "Example",
        visitCount: 5,
        lastVisitTime: 1700000000000,
      },
    ];
    const autofill: ImportedAutofillEntry[] = [
      { fieldName: "email", value: "test@test.com", timesUsed: 3 },
    ];
    const permissions: ImportedPermission[] = [
      { origin: "https://example.com", permission: "notifications", setting: "allow" },
    ];

    const data = exportJson({
      exportedAt: "2024-01-01T00:00:00.000Z",
      version: 1,
      bookmarks,
      history,
      cookies,
      passwords,
      autofill,
      permissions,
    });
    const parsed = JSON.parse(data);
    expect(parsed.bookmarks.length).toBe(4);
    expect(parsed.history.length).toBe(1);
    expect(parsed.cookies.length).toBe(2);
    expect(parsed.passwords.length).toBe(3);
    expect(parsed.autofill.length).toBe(1);
    expect(parsed.permissions.length).toBe(1);
  });

  it("converts Buffer fields to base64", () => {
    const bm: ImportedBookmark[] = [
      {
        title: "With Favicon",
        url: "https://example.com",
        dateAdded: 1700000000000,
        folder: [],
        favicon: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      },
    ];
    const data = exportJson({
      exportedAt: "2024-01-01T00:00:00.000Z",
      version: 1,
      bookmarks: bm,
    });
    const parsed = JSON.parse(data);
    // Should be base64 string, not Buffer JSON
    expect(typeof parsed.bookmarks[0]!.favicon).toBe("string");
    expect(Buffer.from(parsed.bookmarks[0]!.favicon, "base64")).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    );
  });

  it("uses 2-space indentation", () => {
    const data = exportJson({
      exportedAt: "2024-01-01T00:00:00.000Z",
      version: 1,
    });
    // Check that lines are indented with 2 spaces
    const lines = data.split("\n");
    const indentedLine = lines.find((l) => l.startsWith("  "));
    expect(indentedLine).toBeDefined();
    // Should not have 4-space indent at top level
    expect(lines.some((l) => l.startsWith('    "exportedAt"'))).toBe(false);
  });
});

describe("round-trip preservation", () => {
  it("Netscape HTML export preserves all URLs and titles", () => {
    const html = exportNetscapeBookmarks(bookmarks);
    for (const bm of bookmarks) {
      // URLs are HTML-escaped in the output
      const escapedUrl = bm.url.replace(/&/g, "&amp;");
      expect(html).toContain(escapedUrl);
      // Titles are HTML-escaped
      const escapedTitle = bm.title
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
      expect(html).toContain(escapedTitle);
    }
  });

  it("Chrome JSON export preserves all URLs and titles", () => {
    const json = exportChromiumBookmarks(bookmarks);
    const parsed = JSON.parse(json);

    function collectUrls(node: { children?: { type: string; url?: string; name: string; children?: unknown[] }[] }): string[] {
      const urls: string[] = [];
      for (const child of node.children ?? []) {
        if (child.type === "url") urls.push(child.url!);
        else urls.push(...collectUrls(child as typeof node));
      }
      return urls;
    }

    const allUrls = [
      ...collectUrls(parsed.roots.bookmark_bar),
      ...collectUrls(parsed.roots.other),
    ];

    for (const bm of bookmarks) {
      expect(allUrls).toContain(bm.url);
    }
  });
});
