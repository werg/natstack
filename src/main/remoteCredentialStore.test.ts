/**
 * remoteCredentialStore tests — encrypt/decrypt round-trip, fail-closed
 * safeStorage handling, file mode 0o600, dir mode 0o700.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// Mock electron BEFORE importing the store module so the store's
// `import { safeStorage } from "electron"` picks up our fake.
const mockSafeStorage = {
  _available: true,
  _passthrough: true, // encryptString → base64(input); decryptString → reverses
  isEncryptionAvailable(): boolean {
    return this._available;
  },
  encryptString(s: string): Buffer {
    if (!this._available) throw new Error("unavailable");
    if (this._passthrough) return Buffer.from(s, "utf-8");
    throw new Error("not passthrough");
  },
  decryptString(buf: Buffer): string {
    if (!this._available) throw new Error("unavailable");
    if (this._passthrough) return buf.toString("utf-8");
    throw new Error("not passthrough");
  },
};

vi.mock("electron", () => ({ safeStorage: mockSafeStorage }));

// Redirect central-config dir to a tmp dir per test.
let tmpDir = "";
vi.mock("./paths.js", () => ({
  getCentralConfigDirectory: () => tmpDir,
  getAppRoot: () => "/tmp",
}));
vi.mock("@natstack/env-paths", () => ({
  getCentralDataPath: () => tmpDir,
  getWorkspacesDir: () => path.join(tmpDir, "workspaces"),
  getWorkspaceDir: (name: string) => path.join(tmpDir, "workspaces", name),
}));

describe("remoteCredentialStore", () => {
  let storeMod: typeof import("./remoteCredentialStore.js");

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "natstack-remotecreds-"));
    mockSafeStorage._available = true;
    mockSafeStorage._passthrough = true;
    vi.resetModules();
    storeMod = await import("./remoteCredentialStore.js");
  });

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("round-trips credentials through safeStorage", () => {
    storeMod.saveRemoteCredentials({
      kind: "hybrid",
      url: "https://example:3000",
      adminToken: "secret-token",
      deviceId: "dev_123",
      refreshToken: "refresh-secret",
      caPath: "/ca.pem",
      fingerprint: "AA:BB",
    });
    const loaded = storeMod.loadRemoteCredentials();
    expect(loaded).toEqual({
      kind: "hybrid",
      url: "https://example:3000",
      adminToken: "secret-token",
      deviceId: "dev_123",
      refreshToken: "refresh-secret",
      caPath: "/ca.pem",
      fingerprint: "AA:BB",
    });
  });

  it.each([
    {
      name: "admin-token",
      creds: {
        kind: "admin-token" as const,
        url: "https://admin.example",
        adminToken: "admin-secret",
      },
    },
    {
      name: "device",
      creds: {
        kind: "device" as const,
        url: "https://device.example",
        deviceId: "dev_123",
        refreshToken: "refresh-secret",
      },
    },
    {
      name: "hybrid",
      creds: {
        kind: "hybrid" as const,
        url: "https://hybrid.example",
        adminToken: "admin-secret",
        deviceId: "dev_123",
        refreshToken: "refresh-secret",
      },
    },
  ])("round-trips v2 $name credentials", ({ creds }) => {
    storeMod.saveRemoteCredentials(creds);
    expect(storeMod.loadRemoteCredentials()).toEqual(creds);
  });

  it("rejects pre-cutover credential schemas", () => {
    writeRawStore({
      url: "https://old-admin.example",
      token: Buffer.from("admin-secret", "utf-8").toString("base64"),
      encrypted: true,
    });
    expect(storeMod.loadRemoteCredentials()).toBeNull();
  });

  it("refuses to persist credentials when safeStorage is unavailable", () => {
    mockSafeStorage._available = false;
    expect(() =>
      storeMod.saveRemoteCredentials({
        kind: "admin-token",
        url: "http://x:1",
        adminToken: "plain",
      })
    ).toThrow(/safeStorage encryption is unavailable/);
    expect(fs.existsSync(path.join(tmpDir, "remote-credentials.json"))).toBe(false);
  });

  it("rejects unencrypted v2 credential secrets", () => {
    writeRawStore({
      schemaVersion: 2,
      kind: "admin-token",
      url: "https://plain.example",
      adminToken: { value: "plain", encrypted: false },
    });

    expect(storeMod.loadRemoteCredentials()).toBeNull();
  });

  it("returns null when safeStorage becomes unavailable mid-lifetime", () => {
    storeMod.saveRemoteCredentials({ kind: "admin-token", url: "https://x:1", adminToken: "s" });
    mockSafeStorage._available = false;
    const loaded = storeMod.loadRemoteCredentials();
    expect(loaded).toBeNull();
  });

  it("writes file mode 0o600", () => {
    if (process.platform === "win32") return; // no POSIX perms
    storeMod.saveRemoteCredentials({ kind: "admin-token", url: "https://x:1", adminToken: "s" });
    const stat = fs.statSync(path.join(tmpDir, "remote-credentials.json"));
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it("tightens an existing credential file back to mode 0o600", () => {
    if (process.platform === "win32") return;
    const p = path.join(tmpDir, "remote-credentials.json");
    fs.writeFileSync(p, "{}", { mode: 0o644 });
    storeMod.saveRemoteCredentials({ kind: "admin-token", url: "https://x:1", adminToken: "s" });
    const stat = fs.statSync(p);
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it("creates the parent directory with mode 0o700", () => {
    if (process.platform === "win32") return;
    // Nuke the dir that the beforeEach created, then save — this exercises
    // the ensureCentralConfigDir mkdir path.
    fs.rmSync(tmpDir, { recursive: true, force: true });
    storeMod.saveRemoteCredentials({ kind: "admin-token", url: "https://x:1", adminToken: "s" });
    const stat = fs.statSync(tmpDir);
    expect(stat.mode & 0o777).toBe(0o700);
  });

  it("clearRemoteCredentials removes the file", () => {
    storeMod.saveRemoteCredentials({ kind: "admin-token", url: "https://x:1", adminToken: "s" });
    storeMod.clearRemoteCredentials();
    expect(fs.existsSync(path.join(tmpDir, "remote-credentials.json"))).toBe(false);
  });

  it("loadRemoteCredentials returns null when no file is present", () => {
    expect(storeMod.loadRemoteCredentials()).toBeNull();
  });
});

function writeRawStore(raw: unknown): void {
  fs.mkdirSync(tmpDir, { recursive: true });
  fs.writeFileSync(path.join(tmpDir, "remote-credentials.json"), JSON.stringify(raw), {
    mode: 0o600,
  });
}
