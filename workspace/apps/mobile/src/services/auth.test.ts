import { NativeModules } from "react-native";
import {
  activatePreparedAppBundle,
  clearCredentials,
  completePairing,
  getCredentials,
  issueConnectionGrant,
  prepareAppBundle,
  StoredCredentialsNeedRepairError,
} from "./auth";

const nativeHost = NativeModules["NatStackMobileHost"] as {
  clearCredentials: jest.Mock;
  completePairing: jest.Mock;
  getCredentials: jest.Mock;
  issueConnectionGrant: jest.Mock;
  prepareAppBundle: jest.Mock;
  activatePreparedAppBundle: jest.Mock;
};

describe("native-held mobile credentials", () => {
  beforeEach(() => {
    nativeHost.clearCredentials.mockReset().mockResolvedValue(undefined);
    nativeHost.completePairing.mockReset().mockResolvedValue({
      serverUrl: "https://server.example",
      deviceId: "dev_123",
      callerId: "app:apps/mobile:dev_123",
      connectionGrant: "grant_123",
      serverId: "srv_123",
      workspaceId: "workspace_123",
    });
    nativeHost.getCredentials.mockReset().mockResolvedValue({
      serverUrl: "https://server.example",
      deviceId: "dev_123",
      serverId: "srv_123",
      workspaceId: "workspace_123",
    });
    nativeHost.issueConnectionGrant.mockReset().mockResolvedValue({
      deviceId: "dev_123",
      callerId: "app:apps/mobile:dev_123",
      connectionGrant: "grant_123",
      serverId: "srv_123",
      workspaceId: "workspace_123",
    });
    nativeHost.prepareAppBundle.mockReset().mockResolvedValue({
      appId: "@workspace-apps/mobile",
      buildKey: "rn-key",
      effectiveVersion: "ev-mobile",
      capabilities: ["notifications", "keychain"],
      rnHostAbi: "rn-host-1",
      integrity: "sha256-mobile",
      platform: "ios",
      url: "https://server.example/_a/rn-key/index.ios.bundle",
      path: "index.ios.bundle",
      localPath: "/cache/natstack-rn/rn-key/index.ios.bundle",
    });
    nativeHost.activatePreparedAppBundle.mockReset().mockResolvedValue({ activated: false });
  });

  it("loads only non-secret credential metadata from native storage", async () => {
    await expect(getCredentials()).resolves.toEqual({
      serverUrl: "https://server.example",
      deviceId: "dev_123",
      serverId: "srv_123",
      workspaceId: "workspace_123",
    });
  });

  it("completes pairing inside the native host and returns a connection grant handle", async () => {
    await expect(completePairing("https://server.example", "pairing-code")).resolves.toMatchObject({
      deviceId: "dev_123",
      connectionGrant: "grant_123",
    });
    expect(nativeHost.completePairing).toHaveBeenCalledWith(
      "https://server.example",
      "pairing-code"
    );
  });

  it("issues one-time app connection grants without exposing the refresh token", async () => {
    await expect(issueConnectionGrant()).resolves.toMatchObject({
      callerId: "app:apps/mobile:dev_123",
      connectionGrant: "grant_123",
    });
  });

  it("accepts native grants for the selected workspace mobile app principal", async () => {
    nativeHost.issueConnectionGrant.mockResolvedValueOnce({
      deviceId: "dev_123",
      callerId: "app:apps/field-mobile:dev_123",
      connectionGrant: "grant_123",
      serverId: "srv_123",
      workspaceId: "workspace_123",
    });

    await expect(issueConnectionGrant()).resolves.toMatchObject({
      callerId: "app:apps/field-mobile:dev_123",
    });
  });

  it("rejects native grants that are not workspace mobile app principals", async () => {
    nativeHost.issueConnectionGrant.mockResolvedValueOnce({
      deviceId: "dev_123",
      callerId: "app:other-app:dev_123",
      connectionGrant: "grant_123",
      serverId: "srv_123",
      workspaceId: "workspace_123",
    });

    await expect(issueConnectionGrant()).rejects.toThrow(/valid native app connection grant/);
  });

  it("rejects native pairing responses without a workspace mobile app principal grant", async () => {
    nativeHost.completePairing.mockResolvedValueOnce({
      serverUrl: "https://server.example",
      deviceId: "dev_123",
      callerId: "app:other-app:dev_123",
      connectionGrant: "grant_123",
      serverId: "srv_123",
      workspaceId: "workspace_123",
    });

    await expect(completePairing("https://server.example", "pairing-code")).rejects.toThrow(
      /valid native app connection grant/
    );
  });

  it("rejects native grants without server and workspace identity", async () => {
    nativeHost.issueConnectionGrant.mockResolvedValueOnce({
      deviceId: "dev_123",
      callerId: "app:apps/mobile:dev_123",
      connectionGrant: "grant_123",
    });

    await expect(issueConnectionGrant()).rejects.toThrow(/valid native app connection grant/);
  });

  it("prepares approved app bundles through native ABI and integrity checks", async () => {
    await expect(prepareAppBundle("rn-host-1", "ios")).resolves.toMatchObject({
      appId: "@workspace-apps/mobile",
      buildKey: "rn-key",
      capabilities: ["notifications", "keychain"],
      rnHostAbi: "rn-host-1",
      integrity: "sha256-mobile",
      localPath: "/cache/natstack-rn/rn-key/index.ios.bundle",
    });
    expect(nativeHost.prepareAppBundle).toHaveBeenCalledWith("rn-host-1", "ios", null);
  });

  it("passes an explicit selected app source to the native bundle bootstrap", async () => {
    await prepareAppBundle("rn-host-1", "ios", "apps/field-mobile");

    expect(nativeHost.prepareAppBundle).toHaveBeenCalledWith(
      "rn-host-1",
      "ios",
      "apps/field-mobile"
    );
  });

  it("activates prepared app bundles through the native host", async () => {
    await expect(
      activatePreparedAppBundle({
        buildKey: "rn-key",
        integrity: "sha256-mobile",
        localPath: "/cache/natstack-rn/rn-key/index.ios.bundle",
      })
    ).resolves.toEqual({ activated: false });
    expect(nativeHost.activatePreparedAppBundle).toHaveBeenCalledWith(
      "/cache/natstack-rn/rn-key/index.ios.bundle",
      "rn-key",
      "sha256-mobile"
    );
  });

  it("rejects invalid native activation responses", async () => {
    nativeHost.activatePreparedAppBundle.mockResolvedValueOnce({});

    await expect(
      activatePreparedAppBundle({
        buildKey: "rn-key",
        integrity: "sha256-mobile",
        localPath: "/cache/natstack-rn/rn-key/index.ios.bundle",
      })
    ).rejects.toThrow(/invalid app bundle activation result/);
  });

  it("rejects invalid native prepared bundle responses", async () => {
    nativeHost.prepareAppBundle.mockResolvedValueOnce({ appId: "@workspace-apps/mobile" });

    await expect(prepareAppBundle("rn-host-1", "ios")).rejects.toThrow(
      /invalid prepared app bundle/
    );
  });

  it("clears native credentials that need repair", async () => {
    nativeHost.getCredentials.mockRejectedValueOnce({ code: "needs_repair" });

    await expect(getCredentials()).rejects.toBeInstanceOf(StoredCredentialsNeedRepairError);
    expect(nativeHost.clearCredentials).toHaveBeenCalled();
  });

  it("clears credentials through the native host", async () => {
    await clearCredentials();
    expect(nativeHost.clearCredentials).toHaveBeenCalled();
  });
});
