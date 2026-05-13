import * as Keychain from "react-native-keychain";
import {
  getCredentials,
  saveCredentials,
  StoredCredentialsNeedRepairError,
} from "./auth";

const keychain = Keychain as unknown as {
  getGenericPassword: jest.Mock;
  resetGenericPassword: jest.Mock;
  setGenericPassword: jest.Mock;
};

describe("auth credential storage", () => {
  beforeEach(() => {
    keychain.getGenericPassword.mockReset();
    keychain.resetGenericPassword.mockReset();
    keychain.setGenericPassword.mockReset();
    keychain.resetGenericPassword.mockResolvedValue(true);
    keychain.setGenericPassword.mockResolvedValue(true);
  });

  it("loads stored device refresh credentials", async () => {
    keychain.getGenericPassword.mockResolvedValue({
      username: "https://server.example",
      password: JSON.stringify({
        deviceId: "dev_123",
        refreshToken: "refresh_123",
        serverId: "srv_123",
        workspaceId: "workspace_123",
      }),
    });

    await expect(getCredentials()).resolves.toEqual({
      serverUrl: "https://server.example",
      deviceId: "dev_123",
      refreshToken: "refresh_123",
      serverId: "srv_123",
      workspaceId: "workspace_123",
    });
  });

  it("clears legacy shell-token credentials and asks the user to re-pair", async () => {
    keychain.getGenericPassword.mockResolvedValue({
      username: "https://server.example",
      password: "legacy-shell-token",
    });

    await expect(getCredentials()).rejects.toBeInstanceOf(StoredCredentialsNeedRepairError);
    expect(keychain.resetGenericPassword).toHaveBeenCalledWith({
      service: "com.natstack.mobile",
    });
  });

  it("clears incomplete credential payloads", async () => {
    keychain.getGenericPassword.mockResolvedValue({
      username: "https://server.example",
      password: JSON.stringify({ deviceId: "dev_123" }),
    });

    await expect(getCredentials()).rejects.toThrow(/incomplete/i);
    expect(keychain.resetGenericPassword).toHaveBeenCalledWith({
      service: "com.natstack.mobile",
    });
  });

  it("saves only the device secret payload as the keychain password", async () => {
    await saveCredentials({
      serverUrl: "https://server.example",
      deviceId: "dev_123",
      refreshToken: "refresh_123",
    });

    expect(keychain.setGenericPassword).toHaveBeenCalledWith(
      "https://server.example",
      JSON.stringify({ deviceId: "dev_123", refreshToken: "refresh_123" }),
      expect.objectContaining({ service: "com.natstack.mobile" }),
    );
  });
});
