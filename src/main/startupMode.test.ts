/**
 * startupMode — priority tests for `parseRemoteStartupMode`.
 *
 * Order: env vars > safeStorage-backed store > legacy config.yml.
 * Covered here: each "wins" case, missing-data → null, invalid-URL throws,
 * fingerprint normalization.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

// Mocks must be set up before the startupMode module is imported, so we
// resetModules + re-import in each test.

const mockLoadCentralConfig = vi.fn();
const mockLoadRemoteCredentials = vi.fn();

vi.mock("@natstack/shared/workspace/loader", () => ({
  loadCentralConfig: () => mockLoadCentralConfig(),
  resolveWorkspaceName: () => null,
  resolveOrCreateWorkspace: () => { throw new Error("not used in these tests"); },
}));

vi.mock("./remoteCredentialStore.js", () => ({
  loadRemoteCredentials: () => mockLoadRemoteCredentials(),
}));

vi.mock("./paths.js", () => ({
  getAppRoot: () => "/tmp",
  getCentralConfigDirectory: () => "/tmp",
}));

vi.mock("./utils.js", () => ({ isDev: () => false }));

// Keep env clean per test.
const ENV_KEYS = [
  "NATSTACK_REMOTE_URL",
  "NATSTACK_REMOTE_TOKEN",
  "NATSTACK_REMOTE_CA",
  "NATSTACK_REMOTE_FINGERPRINT",
];
function clearEnv() {
  for (const k of ENV_KEYS) delete process.env[k];
}

describe("parseRemoteStartupMode priority", () => {
  let mod: typeof import("./startupMode.js");

  beforeEach(async () => {
    clearEnv();
    mockLoadCentralConfig.mockReset();
    mockLoadRemoteCredentials.mockReset();
    mockLoadCentralConfig.mockReturnValue({});
    mockLoadRemoteCredentials.mockReturnValue(null);
    vi.resetModules();
    mod = await import("./startupMode.js");
  });

  it("returns null when nothing is configured", () => {
    expect(mod.parseRemoteStartupMode()).toBeNull();
  });

  it("env vars win over store and config", () => {
    process.env["NATSTACK_REMOTE_URL"] = "https://env:1";
    process.env["NATSTACK_REMOTE_TOKEN"] = "env-token";
    mockLoadRemoteCredentials.mockReturnValue({ url: "https://store:1", token: "store-token" });
    mockLoadCentralConfig.mockReturnValue({ remote: { url: "https://cfg:1", token: "cfg-token" } });
    const result = mod.parseRemoteStartupMode()!;
    expect(result.remoteUrl.href).toBe("https://env:1/");
    expect(result.adminToken).toBe("env-token");
  });

  it("store wins over config when env is unset", () => {
    mockLoadRemoteCredentials.mockReturnValue({ url: "https://store:1", token: "store-token" });
    mockLoadCentralConfig.mockReturnValue({ remote: { url: "https://cfg:1", token: "cfg-token" } });
    const result = mod.parseRemoteStartupMode()!;
    expect(result.remoteUrl.href).toBe("https://store:1/");
    expect(result.adminToken).toBe("store-token");
  });

  it("falls back to config when neither env nor store is set", () => {
    mockLoadCentralConfig.mockReturnValue({ remote: { url: "https://cfg:1", token: "cfg-token" } });
    const result = mod.parseRemoteStartupMode()!;
    expect(result.remoteUrl.href).toBe("https://cfg:1/");
    expect(result.adminToken).toBe("cfg-token");
  });

  it("throws on malformed URL", () => {
    process.env["NATSTACK_REMOTE_URL"] = "not a url";
    process.env["NATSTACK_REMOTE_TOKEN"] = "t";
    expect(() => mod.parseRemoteStartupMode()).toThrow(/Invalid/i);
  });

  it("rejects unsupported protocols", () => {
    process.env["NATSTACK_REMOTE_URL"] = "ftp://x";
    process.env["NATSTACK_REMOTE_TOKEN"] = "t";
    expect(() => mod.parseRemoteStartupMode()).toThrow(/http or https/i);
  });

  it("returns null if URL or token is partially set", () => {
    process.env["NATSTACK_REMOTE_URL"] = "https://a:1";
    // no token
    expect(mod.parseRemoteStartupMode()).toBeNull();
    clearEnv();
    process.env["NATSTACK_REMOTE_TOKEN"] = "t";
    // no URL
    expect(mod.parseRemoteStartupMode()).toBeNull();
  });

  it("normalizes a 64-hex-no-separator fingerprint to colon form", () => {
    process.env["NATSTACK_REMOTE_URL"] = "https://a:1";
    process.env["NATSTACK_REMOTE_TOKEN"] = "t";
    process.env["NATSTACK_REMOTE_FINGERPRINT"] = "a".repeat(64);
    const result = mod.parseRemoteStartupMode()!;
    expect(result.tls?.fingerprint).toMatch(/^AA(:AA){31}$/);
  });

  it("env fingerprint overrides store fingerprint", () => {
    process.env["NATSTACK_REMOTE_URL"] = "https://a:1";
    process.env["NATSTACK_REMOTE_TOKEN"] = "t";
    process.env["NATSTACK_REMOTE_FINGERPRINT"] = "AB:CD:EF";
    mockLoadRemoteCredentials.mockReturnValue({ url: "https://s:1", token: "t", fingerprint: "00:11:22" });
    const result = mod.parseRemoteStartupMode()!;
    expect(result.tls?.fingerprint).toBe("AB:CD:EF");
  });
});
