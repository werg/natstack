/**
 * remoteCredentialStore tests — encrypt/decrypt round-trip, safeStorage-
 * unavailable fallback, file mode 0o600, dir mode 0o700.
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
  isEncryptionAvailable(): boolean { return this._available; },
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
      url: "https://example:3000",
      token: "secret-token",
      caPath: "/ca.pem",
      fingerprint: "AA:BB",
    });
    const loaded = storeMod.loadRemoteCredentials();
    expect(loaded).toEqual({
      url: "https://example:3000",
      token: "secret-token",
      caPath: "/ca.pem",
      fingerprint: "AA:BB",
    });
  });

  it("falls back to plaintext storage when safeStorage is unavailable", () => {
    mockSafeStorage._available = false;
    storeMod.saveRemoteCredentials({ url: "http://x:1", token: "plain" });
    const raw = fs.readFileSync(path.join(tmpDir, "remote-credentials.json"), "utf-8");
    const parsed = JSON.parse(raw);
    expect(parsed.encrypted).toBe(false);
    expect(parsed.token).toBe("plain");

    // Re-enable → refuses to decrypt a plaintext-marked token, but the
    // unencrypted branch handles it correctly.
    const loaded = storeMod.loadRemoteCredentials();
    expect(loaded?.token).toBe("plain");
  });

  it("returns null when safeStorage becomes unavailable mid-lifetime", () => {
    storeMod.saveRemoteCredentials({ url: "https://x:1", token: "s" });
    mockSafeStorage._available = false;
    const loaded = storeMod.loadRemoteCredentials();
    expect(loaded).toBeNull();
  });

  it("writes file mode 0o600", () => {
    if (process.platform === "win32") return; // no POSIX perms
    storeMod.saveRemoteCredentials({ url: "https://x:1", token: "s" });
    const stat = fs.statSync(path.join(tmpDir, "remote-credentials.json"));
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it("creates the parent directory with mode 0o700", () => {
    if (process.platform === "win32") return;
    // Nuke the dir that the beforeEach created, then save — this exercises
    // the ensureCentralConfigDir mkdir path.
    fs.rmSync(tmpDir, { recursive: true, force: true });
    storeMod.saveRemoteCredentials({ url: "https://x:1", token: "s" });
    const stat = fs.statSync(tmpDir);
    expect(stat.mode & 0o777).toBe(0o700);
  });

  it("clearRemoteCredentials removes the file", () => {
    storeMod.saveRemoteCredentials({ url: "https://x:1", token: "s" });
    storeMod.clearRemoteCredentials();
    expect(fs.existsSync(path.join(tmpDir, "remote-credentials.json"))).toBe(false);
  });

  it("loadRemoteCredentials returns null when no file is present", () => {
    expect(storeMod.loadRemoteCredentials()).toBeNull();
  });
});
