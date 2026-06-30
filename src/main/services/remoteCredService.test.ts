import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createVerifiedCaller, type ServiceContext } from "@natstack/shared/serviceDispatcher";
import type { StoredRemote } from "./remoteCredStore.js";

const mocks = vi.hoisted(() => ({
  app: {
    relaunch: vi.fn(),
    exit: vi.fn(),
    getPath: vi.fn(() => "/tmp/natstack-remote-cred-test"),
  },
  safeStorage: {
    encryptString: vi.fn((s: string) => Buffer.from(s, "utf8")),
    decryptString: vi.fn((b: Buffer) => b.toString("utf8")),
    isEncryptionAvailable: vi.fn(() => false),
  },
  // In-memory backing for the (mocked) remoteCredStore so tests can drive the
  // persisted-pairing state without touching disk or safeStorage.
  store: { value: null as StoredRemote | null },
}));

vi.mock("electron", () => ({ app: mocks.app, safeStorage: mocks.safeStorage }));

vi.mock("./remoteCredStore.js", () => ({
  createRemoteCredStore: () => ({
    load: () => mocks.store.value,
    save: (value: StoredRemote) => {
      mocks.store.value = value;
    },
    clear: () => {
      mocks.store.value = null;
    },
  }),
}));

const shellCtx: ServiceContext = { caller: createVerifiedCaller("shell", "shell") };

const localStartupMode = {
  kind: "local" as const,
  wsDir: "/tmp/ws",
  workspaceName: "ws",
  workspaceId: "ws",
  isEphemeral: false,
  autoApproveStartupUnits: false,
};

const sampleStored: StoredRemote = {
  pairing: { room: "room-abc", fp: "AA".repeat(32), sig: "wss://sig.example/" },
  deviceId: "dev_self",
  refreshToken: "refresh-secret",
  workspaceName: "main",
  pairedAt: 123,
};

describe("remoteCredService", () => {
  beforeEach(() => {
    mocks.app.relaunch.mockClear();
    mocks.app.exit.mockClear();
    mocks.store.value = null;
  });

  afterEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
  });

  it("reports no configured remote when nothing is stored", async () => {
    const { createRemoteCredService } = await import("./remoteCredService.js");
    const service = createRemoteCredService({ startupMode: localStartupMode });
    await expect(service.handler(shellCtx, "getCurrent", [])).resolves.toEqual({
      configured: false,
      isActive: false,
      bootstrap: "none",
    });
  });

  it("reflects a stored pairing as a configured device, active when the pipe is up", async () => {
    mocks.store.value = sampleStored;
    const { createRemoteCredService } = await import("./remoteCredService.js");
    const service = createRemoteCredService({
      startupMode: localStartupMode,
      getServerClient: () => ({ isConnected: () => true, call: vi.fn() }) as never,
    });
    await expect(service.handler(shellCtx, "getCurrent", [])).resolves.toMatchObject({
      configured: true,
      isActive: true,
      bootstrap: "device",
      deviceId: "dev_self",
      workspaceName: "main",
    });
  });

  it("reports a stored pairing as configured but inactive without a live client", async () => {
    mocks.store.value = sampleStored;
    const { createRemoteCredService } = await import("./remoteCredService.js");
    const service = createRemoteCredService({ startupMode: localStartupMode });
    await expect(service.handler(shellCtx, "getCurrent", [])).resolves.toMatchObject({
      configured: true,
      isActive: false,
      bootstrap: "device",
    });
  });

  it("saveStoredRemote persists the fresh pairing + device credential", async () => {
    // The throwaway exchangePairingCode redeem was removed; the fresh-pair session
    // now persists the issued credential through saveStoredRemote (serverSession's
    // establishFreshPairSession onPaired) so the next launch reconnects via refresh.
    const { saveStoredRemote } = await import("./remoteCredService.js");
    expect(mocks.store.value).toBeNull();
    saveStoredRemote(sampleStored);
    expect(mocks.store.value).toEqual(sampleStored);
  });

  it("can disable remote credential persistence for the dev WebRTC harness", async () => {
    vi.stubEnv("NATSTACK_DISABLE_REMOTE_CRED_PERSISTENCE", "1");
    const { persistRotatedRemoteCredential, saveStoredRemote } =
      await import("./remoteCredService.js");

    saveStoredRemote(sampleStored);
    expect(mocks.store.value).toBeNull();

    mocks.store.value = sampleStored;
    persistRotatedRemoteCredential({ deviceId: "dev_next", refreshToken: "next-refresh" });
    expect(mocks.store.value).toEqual(sampleStored);
  });

  it("fails loud when asked to persist an admin-token remote (replaced by WebRTC pairing)", async () => {
    const { createRemoteCredService } = await import("./remoteCredService.js");
    const service = createRemoteCredService({ startupMode: localStartupMode });
    await expect(
      service.handler(shellCtx, "save", [
        { url: "http://127.0.0.1:3030/_workspace/dev", token: "t" },
      ])
    ).rejects.toThrow(/removed/i);
  });

  it("rejects a non-loopback cleartext URL in testConnection", async () => {
    const { createRemoteCredService } = await import("./remoteCredService.js");
    const service = createRemoteCredService({ startupMode: localStartupMode });
    await expect(
      service.handler(shellCtx, "testConnection", [
        { url: "http://server.example.com:3030/_workspace/dev", token: "t" },
      ])
    ).resolves.toMatchObject({ ok: false, error: "invalid-url" });
  });

  it("rejects a URL without a selected workspace in testConnection", async () => {
    const { createRemoteCredService } = await import("./remoteCredService.js");
    const service = createRemoteCredService({ startupMode: localStartupMode });
    await expect(
      service.handler(shellCtx, "testConnection", [{ url: "http://127.0.0.1:3030", token: "t" }])
    ).resolves.toMatchObject({ ok: false, error: "invalid-url" });
  });

  it("proxies pairing invite creation through the active server client", async () => {
    const call = vi.fn(async (_service: string, method: string, args: unknown[]) => {
      expect(method).toBe("createPairingInvite");
      expect(args).toEqual([{ ttlMs: 60_000 }]);
      return {
        code: "A".repeat(24),
        deepLink: null,
        serverUrl: "http://127.0.0.1:3030",
        expiresAt: 123,
        expiresInMs: 60_000,
        serverId: "srv",
        serverBootId: "boot",
        workspaceId: "ws",
      };
    });

    const { createRemoteCredService } = await import("./remoteCredService.js");
    const service = createRemoteCredService({
      startupMode: localStartupMode,
      getServerClient: () => ({ call }) as never,
    });

    await expect(
      service.handler(shellCtx, "createPairingInvite", [{ ttlMs: 60_000 }])
    ).resolves.toMatchObject({ code: "A".repeat(24), serverUrl: "http://127.0.0.1:3030" });
    expect(call).toHaveBeenCalledWith("auth", "createPairingInvite", [{ ttlMs: 60_000 }]);
  });

  it("lists devices via the active server client and is empty without one", async () => {
    const call = vi.fn(async (_service: string, method: string) => {
      if (method === "listDevices") {
        return { devices: [{ deviceId: "dev_self", label: "This", createdAt: 1 }] };
      }
      throw new Error(method);
    });

    const { createRemoteCredService } = await import("./remoteCredService.js");

    const connected = createRemoteCredService({
      startupMode: localStartupMode,
      getServerClient: () => ({ call }) as never,
    });
    await expect(connected.handler(shellCtx, "listDevices", [])).resolves.toEqual([
      { deviceId: "dev_self", label: "This", createdAt: 1 },
    ]);

    const offline = createRemoteCredService({ startupMode: localStartupMode });
    await expect(offline.handler(shellCtx, "listDevices", [])).resolves.toEqual([]);
  });

  it("revokes a device via the active server client and throws without one", async () => {
    const call = vi.fn(async (_service: string, method: string) => {
      if (method === "revokeDevice") return { revoked: true };
      throw new Error(method);
    });

    const { createRemoteCredService } = await import("./remoteCredService.js");

    const connected = createRemoteCredService({
      startupMode: localStartupMode,
      getServerClient: () => ({ call }) as never,
    });
    await expect(connected.handler(shellCtx, "revokeDevice", ["dev_self"])).resolves.toEqual({
      revoked: true,
    });
    expect(call).toHaveBeenCalledWith("auth", "revokeDevice", ["dev_self"]);

    const offline = createRemoteCredService({ startupMode: localStartupMode });
    await expect(offline.handler(shellCtx, "revokeDevice", ["dev_self"])).rejects.toThrow(
      /Not connected to a server/
    );
  });

  it("clears the persisted pairing", async () => {
    mocks.store.value = sampleStored;
    const { createRemoteCredService } = await import("./remoteCredService.js");
    const service = createRemoteCredService({ startupMode: localStartupMode });
    await expect(service.handler(shellCtx, "clear", [])).resolves.toEqual({ ok: true });
    expect(mocks.store.value).toBeNull();
  });

  it("loadStoredRemotePairing reflects the store", async () => {
    mocks.store.value = sampleStored;
    const { loadStoredRemotePairing } = await import("./remoteCredService.js");
    expect(loadStoredRemotePairing()).toEqual(sampleStored);
  });
});
