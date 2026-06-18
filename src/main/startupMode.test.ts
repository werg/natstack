/**
 * startupMode — priority tests for `parseRemoteStartupMode`.
 *
 * Order: env vars > safeStorage-backed store.
 * Covered here: each "wins" case, missing-data -> null, invalid-URL throws,
 * fingerprint normalization.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { assertPresent, deleteDynamicProperty } from "../lintHelpers";

// Mocks must be set up before the startupMode module is imported, so we
// resetModules + re-import in each test.

const mockLoadRemoteCredentials = vi.fn();
const mockResolveWorkspaceName = vi.fn(() => null as string | null);
const mockResolveLocalWorkspaceStartup = vi.fn((_opts?: unknown) => ({
  resolved: {
    wsDir: "/tmp/natstack-test-workspace",
    workspace: { config: { id: "test-workspace" } },
    name: "test-workspace",
    created: false,
  },
  isEphemeral: false,
}));

vi.mock("@natstack/shared/workspace/loader", () => ({
  resolveWorkspaceName: () => mockResolveWorkspaceName(),
  resolveOrCreateWorkspace: () => {
    throw new Error("not used in these tests");
  },
}));

vi.mock("@natstack/shared/workspace/startup", () => ({
  resolveLocalWorkspaceStartup: (opts: unknown) => mockResolveLocalWorkspaceStartup(opts),
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
const ORIGINAL_ARGV = process.argv.slice();
function clearEnv() {
  for (const k of ENV_KEYS) deleteDynamicProperty(process.env, k);
}

function setArgv(args: string[]) {
  process.argv = [...ORIGINAL_ARGV.slice(0, 2), ...args];
}

describe("parseRemoteStartupMode priority", () => {
  let mod: typeof import("./startupMode.js");

  beforeEach(async () => {
    clearEnv();
    setArgv([]);
    mockResolveWorkspaceName.mockReset();
    mockResolveWorkspaceName.mockReturnValue(null);
    mockResolveLocalWorkspaceStartup.mockClear();
    mockLoadRemoteCredentials.mockReset();
    mockLoadRemoteCredentials.mockReturnValue(null);
    vi.resetModules();
    mod = await import("./startupMode.js");
  });

  afterEach(() => {
    setArgv([]);
  });

  it("returns null when nothing is configured", () => {
    expect(mod.parseRemoteStartupMode()).toBeNull();
  });

  it("env vars win over store", () => {
    process.env["NATSTACK_REMOTE_URL"] = "https://env:1/_workspace/dev";
    process.env["NATSTACK_REMOTE_TOKEN"] = "env-token";
    mockLoadRemoteCredentials.mockReturnValue({
      kind: "admin-token",
      url: "https://store:1/_workspace/store",
      adminToken: "store-token",
    });
    const result = assertPresent(mod.parseRemoteStartupMode());
    expect(result.remoteUrl.href).toBe("https://env:1/_workspace/dev");
    expect(result.adminToken).toBe("env-token");
  });

  it("uses store when env is unset", () => {
    mockLoadRemoteCredentials.mockReturnValue({
      kind: "hybrid",
      url: "https://store:1/_workspace/dev",
      adminToken: "store-token",
      deviceId: "dev_store",
      refreshToken: "refresh-store",
    });
    const result = assertPresent(mod.parseRemoteStartupMode());
    expect(result.remoteUrl.href).toBe("https://store:1/_workspace/dev");
    expect(result.adminToken).toBe("store-token");
    expect(result.bootstrap).toBe("hybrid");
    expect(result.deviceId).toBe("dev_store");
    expect(result.refreshToken).toBe("refresh-store");
  });

  it("uses device-only store credentials", () => {
    mockLoadRemoteCredentials.mockReturnValue({
      kind: "device",
      url: "https://store:1/_workspace/dev",
      deviceId: "dev_store",
      refreshToken: "refresh-store",
    });
    const result = assertPresent(mod.parseRemoteStartupMode());
    expect(result.bootstrap).toBe("device");
    expect(result.adminToken).toBeUndefined();
    expect(result.deviceId).toBe("dev_store");
  });

  it("env device credential overrides store device credential", () => {
    process.env["NATSTACK_REMOTE_URL"] = "https://env:1/_workspace/dev";
    process.env["NATSTACK_REMOTE_TOKEN"] = "env-token";
    process.env["NATSTACK_REMOTE_DEVICE_ID"] = "dev_env";
    process.env["NATSTACK_REMOTE_REFRESH_TOKEN"] = "refresh-env";
    mockLoadRemoteCredentials.mockReturnValue({
      kind: "hybrid",
      url: "https://store:1/_workspace/store",
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
    process.env["NATSTACK_REMOTE_URL"] = "http://localhost:1455/_workspace/dev";
    process.env["NATSTACK_REMOTE_TOKEN"] = "t";
    const result = assertPresent(mod.parseRemoteStartupMode());
    expect(result.remoteUrl.href).toBe("http://localhost:1455/_workspace/dev");
  });

  it("accepts trusted cleartext HTTP origins used by pairing", () => {
    for (const url of [
      "http://192.168.1.20:3030",
      "http://100.64.1.20:3030",
      "http://server.local:3030",
      "http://server:3030",
    ]) {
      clearEnv();
      process.env["NATSTACK_REMOTE_URL"] = `${url}/_workspace/dev`;
      process.env["NATSTACK_REMOTE_TOKEN"] = "t";
      const result = assertPresent(mod.parseRemoteStartupMode());
      expect(result.remoteUrl.href).toBe(`${url}/_workspace/dev`);
    }
  });

  it("rejects untrusted cleartext HTTP origins", () => {
    process.env["NATSTACK_REMOTE_URL"] = "http://server.example.com:1455/_workspace/dev";
    process.env["NATSTACK_REMOTE_TOKEN"] = "t";
    expect(() => mod.parseRemoteStartupMode()).toThrow(
      /requires HTTPS, or trusted cleartext HTTP/i
    );
  });

  it("rejects localhost subdomains for HTTP remote origins", () => {
    process.env["NATSTACK_REMOTE_URL"] = "http://panel.localhost:1455/_workspace/dev";
    process.env["NATSTACK_REMOTE_TOKEN"] = "t";
    expect(() => mod.parseRemoteStartupMode()).toThrow(
      /requires HTTPS, or trusted cleartext HTTP/i
    );
  });

  it("rejects remote startup URLs that have not selected a workspace", () => {
    process.env["NATSTACK_REMOTE_URL"] = "https://host.tailnet.ts.net";
    process.env["NATSTACK_REMOTE_TOKEN"] = "t";
    expect(() => mod.parseRemoteStartupMode()).toThrow(/selected workspace URL/i);
  });

  it("rejects remote startup URLs below the selected workspace base", () => {
    process.env["NATSTACK_REMOTE_URL"] = "https://host.tailnet.ts.net/_workspace/dev/rpc";
    process.env["NATSTACK_REMOTE_TOKEN"] = "t";
    expect(() => mod.parseRemoteStartupMode()).toThrow(/selected workspace URL/i);
  });

  it("returns null if URL or token is partially set", () => {
    process.env["NATSTACK_REMOTE_URL"] = "https://a:1/_workspace/dev";
    // no token
    expect(mod.parseRemoteStartupMode()).toBeNull();
    clearEnv();
    process.env["NATSTACK_REMOTE_TOKEN"] = "t";
    // no URL
    expect(mod.parseRemoteStartupMode()).toBeNull();
  });

  it("normalizes a 64-hex-no-separator fingerprint to colon form", () => {
    process.env["NATSTACK_REMOTE_URL"] = "https://a:1/_workspace/dev";
    process.env["NATSTACK_REMOTE_TOKEN"] = "t";
    process.env["NATSTACK_REMOTE_FINGERPRINT"] = "a".repeat(64);
    const result = assertPresent(mod.parseRemoteStartupMode());
    expect(result.tls?.fingerprint).toMatch(/^AA(:AA){31}$/);
  });

  it("env fingerprint overrides store fingerprint", () => {
    process.env["NATSTACK_REMOTE_URL"] = "https://a:1/_workspace/dev";
    process.env["NATSTACK_REMOTE_TOKEN"] = "t";
    process.env["NATSTACK_REMOTE_FINGERPRINT"] = "AB:CD:EF";
    mockLoadRemoteCredentials.mockReturnValue({
      kind: "admin-token",
      url: "https://s:1/_workspace/dev",
      adminToken: "t",
      fingerprint: "00:11:22",
    });
    const result = assertPresent(mod.parseRemoteStartupMode());
    expect(result.tls?.fingerprint).toBe("AB:CD:EF");
  });
});

describe("resolveStartupMode interactive desktop policy", () => {
  let mod: typeof import("./startupMode.js");

  beforeEach(async () => {
    clearEnv();
    setArgv([]);
    mockResolveWorkspaceName.mockReset();
    mockResolveWorkspaceName.mockReturnValue(null);
    mockResolveLocalWorkspaceStartup.mockClear();
    mockLoadRemoteCredentials.mockReset();
    mockLoadRemoteCredentials.mockReturnValue(null);
    vi.resetModules();
    mod = await import("./startupMode.js");
  });

  afterEach(() => {
    setArgv([]);
  });

  it("waits for user choice instead of launching a local workspace by default", () => {
    expect(mod.resolveStartupMode({} as never, { interactiveDesktop: true })).toEqual({
      kind: "pending",
    });
  });

  it("does not auto-connect stored credentials in the interactive desktop chooser", () => {
    mockLoadRemoteCredentials.mockReturnValue({
      kind: "device",
      url: "https://store:1/_workspace/dev",
      deviceId: "dev_store",
      refreshToken: "refresh-store",
    });

    expect(mod.resolveStartupMode({} as never, { interactiveDesktop: true })).toEqual({
      kind: "pending",
    });
  });

  it("connects stored credentials when the chooser relaunches into selected remote mode", () => {
    setArgv(["--connect-selected-remote"]);
    mockLoadRemoteCredentials.mockReturnValue({
      kind: "device",
      url: "https://store:1/_workspace/dev",
      deviceId: "dev_store",
      refreshToken: "refresh-store",
    });

    expect(mod.resolveStartupMode({} as never, { interactiveDesktop: true })).toMatchObject({
      kind: "remote",
      bootstrap: "device",
      deviceId: "dev_store",
    });
  });

  it("keeps explicit env remote startup non-interactive for automation", () => {
    process.env["NATSTACK_REMOTE_URL"] = "https://env:1/_workspace/dev";
    process.env["NATSTACK_REMOTE_TOKEN"] = "env-token";

    expect(mod.resolveStartupMode({} as never, { interactiveDesktop: true })).toMatchObject({
      kind: "remote",
      bootstrap: "admin-token",
      adminToken: "env-token",
    });
  });

  it("recovers a paired-but-unselected stored credential as pending instead of crashing (headless)", () => {
    // Hub-only URL: paired via exchangePairingCodeForDeviceCredential but no workspace selected yet.
    mockLoadRemoteCredentials.mockReturnValue({
      kind: "device",
      url: "https://store:1",
      hubUrl: "https://store:1",
      deviceId: "dev_store",
      refreshToken: "refresh-store",
    });

    // A headless host (interactiveDesktop: false) must not throw — it surfaces pending so it can
    // drive workspace selection (auto-select/relaunch) rather than hard-quit at startup.
    expect(mod.resolveStartupMode({} as never, { interactiveDesktop: false })).toEqual({
      kind: "pending",
    });
  });

  it("connects a workspace-scoped stored credential non-interactively (headless)", () => {
    mockLoadRemoteCredentials.mockReturnValue({
      kind: "device",
      url: "https://store:1/_workspace/dev",
      deviceId: "dev_store",
      refreshToken: "refresh-store",
    });

    expect(mod.resolveStartupMode({} as never, { interactiveDesktop: false })).toMatchObject({
      kind: "remote",
      bootstrap: "device",
      deviceId: "dev_store",
    });
  });

  it("still throws on an explicit env URL that has not selected a workspace", () => {
    process.env["NATSTACK_REMOTE_URL"] = "https://env:1";
    process.env["NATSTACK_REMOTE_TOKEN"] = "env-token";

    expect(() => mod.resolveStartupMode({} as never, { interactiveDesktop: false })).toThrow(
      /selected workspace URL/i
    );
  });

  it("marks chooser-launched local workspaces as create-if-missing", () => {
    expect(mod.workspaceRelaunchArgs("default", ["--foo", "--workspace", "old"])).toEqual([
      "--foo",
      "--workspace",
      "default",
      mod.WORKSPACE_CREATE_IF_MISSING_ARG,
    ]);
  });

  it("builds ephemeral-workspace relaunch args that pin the name and tag it disposable", () => {
    expect(
      mod.ephemeralWorkspaceRelaunchArgs("dev-abc123", [
        "--foo",
        "--workspace",
        "old",
        mod.EPHEMERAL_WORKSPACE_ARG,
      ])
    ).toEqual([
      "--foo",
      "--workspace",
      "dev-abc123",
      mod.WORKSPACE_CREATE_IF_MISSING_ARG,
      mod.EPHEMERAL_WORKSPACE_ARG,
    ]);
  });

  it("marks an --ephemeral-workspace launch as ephemeral so will-quit deletes it", () => {
    mockResolveWorkspaceName.mockReturnValue("dev-abc123");
    setArgv([
      "--workspace",
      "dev-abc123",
      mod.WORKSPACE_CREATE_IF_MISSING_ARG,
      mod.EPHEMERAL_WORKSPACE_ARG,
    ]);

    expect(mod.resolveStartupMode({} as never, { interactiveDesktop: true })).toMatchObject({
      kind: "local",
      isEphemeral: true,
    });
  });

  it("passes create-if-missing only for explicitly selected local workspace launches", () => {
    mockResolveWorkspaceName.mockReturnValue("default");
    setArgv(["--workspace", "default", mod.WORKSPACE_CREATE_IF_MISSING_ARG]);

    expect(mod.resolveStartupMode({} as never, { interactiveDesktop: true })).toMatchObject({
      kind: "local",
      wsDir: "/tmp/natstack-test-workspace",
      workspaceId: "test-workspace",
    });
    expect(mockResolveLocalWorkspaceStartup).toHaveBeenLastCalledWith(
      expect.objectContaining({
        name: "default",
        init: true,
      })
    );

    mockResolveLocalWorkspaceStartup.mockClear();
    setArgv(["--workspace", "default"]);
    expect(mod.resolveStartupMode({} as never, { interactiveDesktop: true })).toMatchObject({
      kind: "local",
    });
    expect(mockResolveLocalWorkspaceStartup).toHaveBeenLastCalledWith(
      expect.not.objectContaining({ init: true })
    );
  });
});

describe("shouldRequestSingleInstanceLock", () => {
  it("does not lock local development launches", async () => {
    const mod = await import("./startupMode.js");

    expect(
      mod.shouldRequestSingleInstanceLock(
        {
          kind: "local",
          wsDir: "/workspace",
          workspaceId: "dev",
          isEphemeral: true,
          createdFromTemplate: false,
        },
        { isHeadlessHost: false, isDevelopment: true }
      )
    ).toBe(false);
  });

  it("keeps the lock for packaged local launches", async () => {
    const mod = await import("./startupMode.js");

    expect(
      mod.shouldRequestSingleInstanceLock(
        {
          kind: "local",
          wsDir: "/workspace",
          workspaceId: "default",
          isEphemeral: false,
          createdFromTemplate: false,
        },
        { isHeadlessHost: false, isDevelopment: false }
      )
    ).toBe(true);
  });

  it("keeps the lock for remote development launches so deep links route to the active shell", async () => {
    const mod = await import("./startupMode.js");

    expect(
      mod.shouldRequestSingleInstanceLock(
        {
          kind: "remote",
          remoteUrl: new URL("https://server.example/_workspace/dev"),
          bootstrap: "device",
          deviceId: "device",
          refreshToken: "refresh",
        },
        { isHeadlessHost: false, isDevelopment: true }
      )
    ).toBe(true);
  });

  it("keeps the lock for pending chooser launches", async () => {
    const mod = await import("./startupMode.js");

    expect(
      mod.shouldRequestSingleInstanceLock(
        {
          kind: "pending",
        },
        { isHeadlessHost: false, isDevelopment: true }
      )
    ).toBe(true);
  });

  it("does not lock headless hosts", async () => {
    const mod = await import("./startupMode.js");

    expect(
      mod.shouldRequestSingleInstanceLock(
        {
          kind: "remote",
          remoteUrl: new URL("https://server.example/_workspace/dev"),
          bootstrap: "admin-token",
          adminToken: "token",
        },
        { isHeadlessHost: true, isDevelopment: false }
      )
    ).toBe(false);
  });
});
