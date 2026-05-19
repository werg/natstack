import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TokenManager } from "@natstack/shared/tokenManager";
import { createVerifiedCaller } from "@natstack/shared/serviceDispatcher";
import { Gateway } from "../gateway.js";
import { RouteRegistry } from "../routeRegistry.js";
import { createAuthService } from "./authService.js";
import { DeviceAuthStore } from "./deviceAuthStore.js";
import { EntityCache } from "@natstack/shared/runtime/entityCache";
import type { EntityRecord } from "@natstack/shared/runtime/entitySpec";
import { ConnectionGrantService } from "@natstack/shared/connectionGrants";

function makePanelRecord(id: string): EntityRecord {
  return {
    id,
    kind: "panel",
    source: { repoPath: "", effectiveVersion: "" },
    contextId: "",
    key: id,
    createdAt: Date.now(),
    status: "active",
    cleanupComplete: true,
  };
}

type PairingCodeResponse = { code: string };
type PairingCompleteResponse = {
  deviceId: string;
  refreshToken: string;
  callerId: string;
  shellToken: string;
};
type RefreshShellResponse = { callerId: string };
type DevicesResponse = {
  devices: Array<{ deviceId: string; label: string; platform: string }>;
};
type RevokeDeviceResponse = { revoked: boolean };

describe("auth service device credentials", () => {
  let gateway: Gateway;
  let gatewayPort = 0;
  let tokenManager: TokenManager;

  beforeAll(async () => {
    const routeRegistry = new RouteRegistry();
    tokenManager = new TokenManager();
    const authStore = new DeviceAuthStore(
      path.join(
        fs.mkdtempSync(path.join(os.tmpdir(), "natstack-auth-service-")),
        "auth",
        "devices.json"
      ),
      () => 1234
    );
    const authService = createAuthService({
      tokenManager,
      deviceAuthStore: authStore,
      getServerBootId: () => "boot_test",
      getWorkspaceId: () => "workspace_test",
    });
    routeRegistry.registerService(authService.routes ?? []);
    gateway = new Gateway({
      externalHost: "127.0.0.1",
      bindHost: "127.0.0.1",
      workerdPort: 9,
      routeRegistry,
      adminToken: "admin-secret",
      tokenManager,
    });
    gatewayPort = await gateway.start(0);
  });

  afterAll(async () => {
    await gateway.stop();
  });

  it("creates pairing codes, completes pairing, refreshes shell tokens, and revokes devices", async () => {
    const pairing = await postJson<PairingCodeResponse>(
      "/_r/s/auth/create-pairing-code",
      {},
      "admin-secret"
    );
    expect(pairing.status).toBe(200);
    expect(pairing.body.code).toMatch(/^[A-Za-z0-9_-]{16,}$/);

    const completed = await postJson<PairingCompleteResponse>("/_r/s/auth/complete-pairing", {
      code: pairing.body.code,
      label: "Phone",
      platform: "mobile",
    });
    expect(completed.status).toBe(200);
    expect(completed.body.deviceId).toMatch(/^dev_/);
    expect(completed.body.refreshToken).toBeTruthy();
    expect(completed.body.callerId).toBe(`shell:${completed.body.deviceId}`);
    expect(tokenManager.validateToken(completed.body.shellToken)?.callerKind).toBe("shell-remote");

    const refreshed = await postJson<RefreshShellResponse>("/_r/s/auth/refresh-shell", {
      deviceId: completed.body.deviceId,
      refreshToken: completed.body.refreshToken,
    });
    expect(refreshed.status).toBe(200);
    expect(refreshed.body.callerId).toBe(completed.body.callerId);

    const devices = await getJson<DevicesResponse>("/_r/s/auth/devices", "admin-secret");
    expect(devices.status).toBe(200);
    expect(JSON.stringify(devices.body)).not.toContain("refreshTokenHash");
    expect(devices.body.devices).toMatchObject([
      { deviceId: completed.body.deviceId, label: "Phone", platform: "mobile" },
    ]);

    const revoked = await postJson<RevokeDeviceResponse>(
      "/_r/s/auth/revoke-device",
      { deviceId: completed.body.deviceId },
      "admin-secret"
    );
    expect(revoked.status).toBe(200);
    expect(revoked.body.revoked).toBe(true);

    const denied = await postJson<unknown>("/_r/s/auth/refresh-shell", {
      deviceId: completed.body.deviceId,
      refreshToken: completed.body.refreshToken,
    });
    expect(denied.status).toBe(401);
  });

  async function postJson<T>(
    pathname: string,
    body: unknown,
    bearer?: string
  ): Promise<{ status: number; body: T }> {
    return requestJson<T>(pathname, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
      },
      body: JSON.stringify(body),
    });
  }

  async function getJson<T>(
    pathname: string,
    bearer?: string
  ): Promise<{ status: number; body: T }> {
    return requestJson<T>(pathname, {
      headers: bearer ? { Authorization: `Bearer ${bearer}` } : undefined,
    });
  }

  async function requestJson<T>(
    pathname: string,
    init?: RequestInit
  ): Promise<{ status: number; body: T }> {
    const response = await fetch(`http://127.0.0.1:${gatewayPort}${pathname}`, init);
    return {
      status: response.status,
      body: (await response.json()) as T,
    };
  }
});

describe("auth service connection grants", () => {
  it("rejects grants for unregistered principals", async () => {
    const entityCache = new EntityCache();
    const connectionGrants = new ConnectionGrantService({ entityCache });
    const service = createAuthService({
      tokenManager: new TokenManager(),
      deviceAuthStore: new DeviceAuthStore(
        path.join(fs.mkdtempSync(path.join(os.tmpdir(), "natstack-auth-grant-")), "devices.json")
      ),
      getServerBootId: () => "boot_test",
      getWorkspaceId: () => "workspace_test",
      connectionGrants,
    });

    await expect(
      service.definition.handler(
        { caller: createVerifiedCaller("shell:test", "shell") },
        "grantConnection",
        ["panel:missing"]
      )
    ).rejects.toThrow(/unregistered/);
    connectionGrants.stop();
  });

  it("issues redeemable grants for registered principals", async () => {
    const entityCache = new EntityCache();
    entityCache._onActivate(makePanelRecord("panel:one"));
    const connectionGrants = new ConnectionGrantService({ entityCache });
    const service = createAuthService({
      tokenManager: new TokenManager(),
      deviceAuthStore: new DeviceAuthStore(
        path.join(fs.mkdtempSync(path.join(os.tmpdir(), "natstack-auth-grant-")), "devices.json")
      ),
      getServerBootId: () => "boot_test",
      getWorkspaceId: () => "workspace_test",
      connectionGrants,
    });

    const granted = (await service.definition.handler(
      { caller: createVerifiedCaller("shell:test", "shell") },
      "grantConnection",
      ["panel:one"]
    )) as { token: string; expiresAt: number };

    expect(granted.token).toMatch(/^[0-9a-f]{64}$/);
    expect(connectionGrants.redeem(granted.token)).toEqual({
      principalId: "panel:one",
      issuedBy: "shell:test",
    });
    connectionGrants.stop();
  });
});
