import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import initSqlJs from "sql.js";
import { ChromiumReader } from "../readers/chromiumReader.js";
import { readOpenTabs } from "../readers/openTabs.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "natstack-open-tabs-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("readOpenTabs", () => {
  it("reads the active entries from Firefox recovery.jsonlz4", () => {
    const profilePath = path.join(tmpDir, "firefox-profile");
    fs.mkdirSync(path.join(profilePath, "sessionstore-backups"), { recursive: true });
    writeMozLz4Json(path.join(profilePath, "sessionstore-backups", "recovery.jsonlz4"), {
      windows: [
        {
          selected: 2,
          tabs: [
            {
              index: 1,
              entries: [{ url: "https://example.com/", title: "Example" }],
            },
            {
              index: 2,
              entries: [
                { url: "https://old.example/", title: "Old" },
                { url: "https://active.example/path", title: "Active" },
              ],
              pinned: true,
              lastAccessed: 1700000000000,
            },
          ],
        },
      ],
    });

    const tabs = readOpenTabs({ browser: "firefox", profile: profilePath });

    expect(tabs).toEqual([
      expect.objectContaining({
        url: "https://example.com/",
        title: "Example",
        windowIndex: 0,
        tabIndex: 0,
        active: false,
      }),
      expect.objectContaining({
        url: "https://active.example/path",
        title: "Active",
        windowIndex: 0,
        tabIndex: 1,
        active: true,
        pinned: true,
        lastAccessed: 1700000000000,
      }),
    ]);
  });

  it("reads Chromium SNSS session files and selects each tab current navigation", () => {
    const profilePath = path.join(tmpDir, "chrome-profile");
    const sessionsPath = path.join(profilePath, "Sessions");
    fs.mkdirSync(sessionsPath, { recursive: true });
    fs.writeFileSync(
      path.join(sessionsPath, "Session_123"),
      buildChromiumSessionFile([
        fixedCommand(0, int32Payload(10, 101)),
        fixedCommand(2, int32Payload(101, 1)),
        navigationCommand(101, 0, "https://old.example/", "Old"),
        navigationCommand(101, 1, "https://current.example/a", "Current"),
        fixedCommand(7, int32Payload(101, 1)),
        fixedCommand(0, int32Payload(10, 102)),
        fixedCommand(2, int32Payload(102, 0)),
        navigationCommand(102, 0, "chrome://settings/", "Settings"),
        fixedCommand(8, int32Payload(10, 0)),
      ]),
    );

    const tabs = readOpenTabs({ browser: "chrome", profile: profilePath });

    expect(tabs).toEqual([
      expect.objectContaining({
        url: "chrome://settings/",
        title: "Settings",
        windowIndex: 0,
        tabIndex: 0,
        active: true,
      }),
      expect.objectContaining({
        url: "https://current.example/a",
        title: "Current",
        windowIndex: 0,
        tabIndex: 1,
        active: false,
      }),
    ]);
  });
});

describe("ChromiumReader cookie import", () => {
  it("reads cookies from modern Network/Cookies profile databases", async () => {
    const profilePath = path.join(tmpDir, "chrome-profile");
    fs.mkdirSync(path.join(profilePath, "Network"), { recursive: true });
    await writeChromiumCookiesDb(path.join(profilePath, "Network", "Cookies"));

    const cookies = await new ChromiumReader().readCookies(profilePath);

    expect(cookies).toEqual([
      expect.objectContaining({
        name: "sid",
        value: "abc123",
        domain: ".example.com",
        hostOnly: false,
        path: "/",
        secure: true,
        httpOnly: true,
        sameSite: "lax",
        sourceScheme: "secure",
        sourcePort: 443,
      }),
    ]);
  });
});

function writeMozLz4Json(filePath: string, value: unknown): void {
  const json = Buffer.from(JSON.stringify(value), "utf-8");
  fs.writeFileSync(filePath, Buffer.concat([
    Buffer.from("mozLz40\0", "ascii"),
    uint32(json.length),
    lz4LiteralBlock(json),
  ]));
}

function lz4LiteralBlock(data: Buffer): Buffer {
  const extraLengthBytes: number[] = [];
  let remaining = data.length - 15;
  const literalNibble = data.length >= 15 ? 15 : data.length;
  while (remaining >= 255) {
    extraLengthBytes.push(255);
    remaining -= 255;
  }
  if (data.length >= 15) extraLengthBytes.push(remaining);
  return Buffer.concat([Buffer.from([literalNibble << 4, ...extraLengthBytes]), data]);
}

function buildChromiumSessionFile(commands: Buffer[]): Buffer {
  const header = Buffer.alloc(8);
  header.writeInt32LE(0x53534e53, 0);
  header.writeInt32LE(3, 4);
  return Buffer.concat([header, ...commands]);
}

function fixedCommand(id: number, contents: Buffer): Buffer {
  return command(id, contents);
}

function navigationCommand(tabId: number, index: number, url: string, title: string): Buffer {
  return command(
    6,
    pickle([
      int32(tabId),
      int32(index),
      pickleString(url),
      pickleString16(title),
      pickleString(""),
      int32(0),
    ]),
  );
}

function command(id: number, contents: Buffer): Buffer {
  const header = Buffer.alloc(3);
  header.writeUInt16LE(contents.length + 1, 0);
  header.writeUInt8(id, 2);
  return Buffer.concat([header, contents]);
}

function pickle(fields: Buffer[]): Buffer {
  const payload = Buffer.concat(fields);
  return Buffer.concat([uint32(payload.length), payload]);
}

function int32Payload(...values: number[]): Buffer {
  return Buffer.concat(values.map(int32));
}

function int32(value: number): Buffer {
  const buffer = Buffer.alloc(4);
  buffer.writeInt32LE(value, 0);
  return buffer;
}

function uint32(value: number): Buffer {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(value, 0);
  return buffer;
}

function pickleString(value: string): Buffer {
  const bytes = Buffer.from(value, "utf-8");
  return Buffer.concat([int32(bytes.length), bytes, padding(bytes.length)]);
}

function pickleString16(value: string): Buffer {
  const bytes = Buffer.from(value, "utf16le");
  return Buffer.concat([int32(value.length), bytes, padding(bytes.length)]);
}

function padding(length: number): Buffer {
  const size = (4 - (length % 4)) % 4;
  return Buffer.alloc(size);
}

async function writeChromiumCookiesDb(filePath: string): Promise<void> {
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  db.exec(`
    CREATE TABLE cookies (
      host_key TEXT,
      name TEXT,
      value TEXT,
      encrypted_value BLOB,
      path TEXT,
      expires_utc INTEGER,
      is_secure INTEGER,
      is_httponly INTEGER,
      samesite INTEGER,
      source_scheme INTEGER,
      source_port INTEGER
    );
    INSERT INTO cookies VALUES (
      '.example.com',
      'sid',
      'abc123',
      X'',
      '/',
      0,
      1,
      1,
      1,
      2,
      443
    );
  `);
  fs.writeFileSync(filePath, Buffer.from(db.export()));
  db.close();
}
