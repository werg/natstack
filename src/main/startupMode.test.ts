/**
 * startupMode — priority tests for `parseRemoteStartupMode`.
 *
 * Order: env vars > safeStorage-backed store.
 * Covered here: each "wins" case, missing-data -> null, invalid-URL throws,
 * fingerprint normalization.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { assertPresent, deleteDynamicProperty } from "../lintHelpers";

// Mocks must be set up before the startupMode module is imported, so we
// resetModules + re-import in each test.

const mockLoadRemoteCredentials = vi.fn();

vi.mock("@natstack/shared/workspace/loader", () => ({
  resolveWorkspaceName: () => null,
  resolveOrCreateWorkspace: () => {
    throw new Error("not used in these tests");
  },
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
  "NATSTACK_REMOTE_DEVICE_ID",
  "NATSTACK_REMOTE_REFRESH_TOKEN",
  "NATSTACK_REMOTE_CA",
  "NATSTACK_REMOTE_FINGERPRINT",
];
function clearEnv() {
  for (const k of ENV_KEYS) deleteDynamicProperty(process.env, k);
}

describe("parseRemoteStartupMode priority", () => {
  let mod: typeof import("./startupMode.js");

  beforeEach(async () => {
    clearEnv();
    mockLoadRemoteCredentials.mockReset();
    mockLoadRemoteCredentials.mockReturnValue(null);
    vi.resetModules();
    mod = await import("./startupMode.js");
  });

  it("returns null when nothing is configured", () => {
    expect(mod.parseRemoteStartupMode()).toBeNull();
  });

  it("env vars win over store", () => {
    process.env["NATSTACK_REMOTE_URL"] = "https://env:1";
    process.env["NATSTACK_REMOTE_TOKEN"] = "env-token";
    mockLoadRemoteCredentials.mockReturnValue({
      kind: "admin-token",
      url: "https://store:1",
      adminToken: "store-token",
    });
    const result = assertPresent(mod.parseRemoteStartupMode());
    expect(result.remoteUrl.href).toBe("https://env:1/");
    expect(result.adminToken).toBe("env-token");
  });

  it("uses store when env is unset", () => {
    mockLoadRemoteCredentials.mockReturnValue({
      kind: "hybrid",
      url: "https://store:1",
      adminToken: "store-token",
      deviceId: "dev_store",
      refreshToken: "refresh-store",
    });
    const result = assertPresent(mod.parseRemoteStartupMode());
    expect(result.remoteUrl.href).toBe("https://store:1/");
    expect(result.adminToken).toBe("store-token");
    expect(result.bootstrap).toBe("hybrid");
    expect(result.deviceId).toBe("dev_store");
    expect(result.refreshToken).toBe("refresh-store");
  });

  it("preserves remote URL path prefixes from stored supervisor tenant credentials", () => {
    mockLoadRemoteCredentials.mockReturnValue({
      kind: "device",
      url: "https://store:1/base/w/alpha",
      deviceId: "dev_store",
      refreshToken: "refresh-store",
    });
    const result = assertPresent(mod.parseRemoteStartupMode());
    expect(result.remoteUrl.href).toBe("https://store:1/base/w/alpha");
  });

  it("uses device-only store credentials", () => {
    mockLoadRemoteCredentials.mockReturnValue({
      kind: "device",
      url: "https://store:1",
      deviceId: "dev_store",
      refreshToken: "refresh-store",
    });
    const result = assertPresent(mod.parseRemoteStartupMode());
    expect(result.bootstrap).toBe("device");
    expect(result.adminToken).toBeUndefined();
    expect(result.deviceId).toBe("dev_store");
  });

  it("env device credential overrides store device credential", () => {
    process.env["NATSTACK_REMOTE_URL"] = "https://env:1";
    process.env["NATSTACK_REMOTE_TOKEN"] = "env-token";
    process.env["NATSTACK_REMOTE_DEVICE_ID"] = "dev_env";
    process.env["NATSTACK_REMOTE_REFRESH_TOKEN"] = "refresh-env";
    mockLoadRemoteCredentials.mockReturnValue({
      kind: "hybrid",
      url: "https://store:1",
      adminToken: "store-token",
      deviceId: "dev_store",
      refreshToken: "refresh-store",
    });
    const result = assertPresent(mod.parseRemoteStartupMode());
    expect(result.deviceId).toBe("dev_env");
    expect(result.refreshToken).toBe("refresh-env");
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

  it("accepts loopback HTTP origins", () => {
    process.env["NATSTACK_REMOTE_URL"] = "http://localhost:1455";
    process.env["NATSTACK_REMOTE_TOKEN"] = "t";
    const result = assertPresent(mod.parseRemoteStartupMode());
    expect(result.remoteUrl.href).toBe("http://localhost:1455/");
  });

  it("accepts trusted cleartext HTTP origins used by pairing", () => {
    for (const url of [
      "http://192.168.1.20:3030",
      "http://100.64.1.20:3030",
      "http://server.local:3030",
      "http://server:3030",
    ]) {
      clearEnv();
      process.env["NATSTACK_REMOTE_URL"] = url;
      process.env["NATSTACK_REMOTE_TOKEN"] = "t";
      const result = assertPresent(mod.parseRemoteStartupMode());
      expect(result.remoteUrl.href).toBe(`${url}/`);
    }
  });

  it("rejects untrusted cleartext HTTP origins", () => {
    process.env["NATSTACK_REMOTE_URL"] = "http://server.example.com:1455";
    process.env["NATSTACK_REMOTE_TOKEN"] = "t";
    expect(() => mod.parseRemoteStartupMode()).toThrow(
      /requires HTTPS, or trusted cleartext HTTP/i
    );
  });

  it("rejects localhost subdomains for HTTP remote origins", () => {
    process.env["NATSTACK_REMOTE_URL"] = "http://panel.localhost:1455";
    process.env["NATSTACK_REMOTE_TOKEN"] = "t";
    expect(() => mod.parseRemoteStartupMode()).toThrow(
      /requires HTTPS, or trusted cleartext HTTP/i
    );
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
    const result = assertPresent(mod.parseRemoteStartupMode());
    expect(result.tls?.fingerprint).toMatch(/^AA(:AA){31}$/);
  });

  it("env fingerprint overrides store fingerprint", () => {
    process.env["NATSTACK_REMOTE_URL"] = "https://a:1";
    process.env["NATSTACK_REMOTE_TOKEN"] = "t";
    process.env["NATSTACK_REMOTE_FINGERPRINT"] = "AB:CD:EF";
    mockLoadRemoteCredentials.mockReturnValue({
      kind: "admin-token",
      url: "https://s:1",
      adminToken: "t",
      fingerprint: "00:11:22",
    });
    const result = assertPresent(mod.parseRemoteStartupMode());
    expect(result.tls?.fingerprint).toBe("AB:CD:EF");
  });
});
