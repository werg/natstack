import { NativeModules } from "react-native";
import {
  activatePreparedAppBundle,
  clearCredentials,
  getCredentials,
  issueConnectionGrant,
  listWorkspaces,
  pairServer,
  prepareAppBundle,
  resetToNativeBootstrap,
  selectWorkspace,
  StoredCredentialsNeedRepairError,
} from "./auth";

const nativeHost = NativeModules["NatStackMobileHost"] as {
  clearCredentials: jest.Mock;
  getCredentials: jest.Mock;
  issueConnectionGrant: jest.Mock;
  listWorkspaces: jest.Mock;
  pairServer: jest.Mock;
  prepareAppBundle: jest.Mock;
  resetToNativeBootstrap: jest.Mock;
  selectWorkspace: jest.Mock;
  activatePreparedAppBundle: jest.Mock;
};

describe("native-held mobile credentials", () => {
  beforeEach(() => {
    nativeHost.clearCredentials.mockReset().mockResolvedValue(undefined);
    nativeHost.resetToNativeBootstrap.mockReset().mockResolvedValue({ reloading: true });
    nativeHost.pairServer.mockReset().mockResolvedValue({
      deviceId: "dev_123",
      serverId: "srv_123",
    });
    nativeHost.listWorkspaces.mockReset().mockResolvedValue({
      workspaces: [{ name: "dev", lastOpened: 123, running: true }],
    });
    nativeHost.selectWorkspace.mockReset().mockResolvedValue({
      workspaceName: "dev",
      deviceId: "dev_123",
      callerId: "shell:dev_123",
      connectionGrant: "grant_123",
      serverId: "srv_123",
      workspaceId: "workspace_123",
    });
    nativeHost.getCredentials.mockReset().mockResolvedValue({
      workspaceName: "dev",
      deviceId: "dev_123",
      serverId: "srv_123",
      workspaceId: "workspace_123",
    });
    nativeHost.issueConnectionGrant.mockReset().mockResolvedValue({
      deviceId: "dev_123",
      callerId: "shell:dev_123",
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
      workspaceName: "dev",
      deviceId: "dev_123",
      serverId: "srv_123",
      workspaceId: "workspace_123",
    });
  });

  it("pairs a server inside the native host without selecting a workspace", async () => {
    await expect(pairServer("https://server.example", "pairing-code")).resolves.toMatchObject({
      deviceId: "dev_123",
      serverId: "srv_123",
    });
    expect(nativeHost.pairServer).toHaveBeenCalledWith("https://server.example", "pairing-code");
  });

  it("accepts identity-only credentials before a workspace is selected", async () => {
    nativeHost.getCredentials.mockResolvedValueOnce({
      deviceId: "dev_123",
      serverId: "srv_123",
    });

    await expect(getCredentials()).resolves.toMatchObject({
      deviceId: "dev_123",
      serverId: "srv_123",
    });
  });

  it("lists workspaces from the paired server", async () => {
    await expect(listWorkspaces()).resolves.toEqual([
      { name: "dev", lastOpened: 123, running: true },
    ]);
  });

  it("passes an explicit selected app source while selecting a workspace", async () => {
    nativeHost.selectWorkspace.mockResolvedValueOnce({
      workspaceName: "dev",
      deviceId: "dev_123",
      callerId: "shell:dev_123",
      connectionGrant: "grant_123",
      serverId: "srv_123",
      workspaceId: "workspace_123",
    });

    await expect(
      selectWorkspace("dev", "apps/field-mobile")
    ).resolves.toMatchObject({
      callerId: "shell:dev_123",
    });

    expect(nativeHost.selectWorkspace).toHaveBeenCalledWith("dev", "apps/field-mobile");
  });

  it("issues one-time mobile host connection grants without exposing the refresh token", async () => {
    await expect(issueConnectionGrant()).resolves.toMatchObject({
      callerId: "shell:dev_123",
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

  it("rejects native grants that are not mobile host principals", async () => {
    nativeHost.issueConnectionGrant.mockResolvedValueOnce({
      deviceId: "dev_123",
      callerId: "app:other-app:dev_123",
      connectionGrant: "grant_123",
      serverId: "srv_123",
      workspaceId: "workspace_123",
    });

    await expect(issueConnectionGrant()).rejects.toThrow(/valid mobile host connection grant/);
  });

  it("rejects native workspace selection responses without a mobile host principal grant", async () => {
    nativeHost.selectWorkspace.mockResolvedValueOnce({
      deviceId: "dev_123",
      callerId: "app:other-app:dev_123",
      connectionGrant: "grant_123",
      serverId: "srv_123",
      workspaceId: "workspace_123",
    });

    await expect(selectWorkspace("dev")).rejects.toThrow(/valid mobile host connection grant/);
  });

  it("rejects native grants without server and workspace identity", async () => {
    nativeHost.issueConnectionGrant.mockResolvedValueOnce({
      deviceId: "dev_123",
      callerId: "shell:dev_123",
      connectionGrant: "grant_123",
    });

    await expect(issueConnectionGrant()).rejects.toThrow(/valid mobile host connection grant/);
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

  it("resets to the native bootstrap", async () => {
    await expect(resetToNativeBootstrap()).resolves.toEqual({ reloading: true });
    expect(nativeHost.resetToNativeBootstrap).toHaveBeenCalled();
  });
});
