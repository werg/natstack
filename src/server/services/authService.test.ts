import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TokenManager } from "@natstack/shared/tokenManager";
import { createVerifiedCaller, ServiceDispatcher } from "@natstack/shared/serviceDispatcher";
import { Gateway } from "../gateway.js";
import { RpcServer } from "../rpcServer.js";
import { RouteRegistry } from "../routeRegistry.js";
import { createAuthService } from "./authService.js";
import { DeviceAuthStore } from "./deviceAuthStore.js";
import { EntityCache } from "@natstack/shared/runtime/entityCache";
import type { EntityRecord } from "@natstack/shared/runtime/entitySpec";
import { ConnectionGrantService } from "@natstack/shared/connectionGrants";
import type { CredentialAuditEvent } from "@natstack/shared/credentials/types";
import type { PendingUnitBatchApproval } from "@natstack/shared/approvals";

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

function makeAppRecord(id: string): EntityRecord {
  return {
    id,
    kind: "app",
    source: { repoPath: "apps/mobile", effectiveVersion: "mobile-ref" },
    contextId: "",
    key: id,
    createdAt: Date.now(),
    status: "active",
    cleanupComplete: true,
  };
}

type PairingCodeResponse = { code: string; connectUrl: string; deepLink: string };
type ConnectionInfoResponse = { serverUrl: string; connectUrl: string; workspaceId: string };
type IssueDeviceResponse = {
  deviceId: string;
  refreshToken: string;
  shellToken: string;
  callerId: string;
};
type PairingCompleteResponse = {
  deviceId: string;
  refreshToken: string;
  shellToken: string;
  callerId: string;
};
type RefreshAppGrantResponse = { callerId: string; connectionGrant: string };
type MobileAppBootstrapResponse = {
  workspaceId: string;
  bootstrap: {
    appId: string;
    rnHostAbi: string;
    integrity: string;
    artifacts: Array<{ platform?: string; url: string }>;
  };
};
type DevicesResponse = {
  devices: Array<{ deviceId: string; label: string; platform: string }>;
};
type RevokeDeviceResponse = { revoked: boolean };

describe("auth service device credentials", () => {
  let gateway: Gateway;
  let gatewayPort = 0;
  let tokenManager: TokenManager;
  let entityCache: EntityCache;
  let gatewayUrl = "";
  const auditEntries: CredentialAuditEvent[] = [];

  beforeAll(async () => {
    const routeRegistry = new RouteRegistry();
    tokenManager = new TokenManager();
    entityCache = new EntityCache();
    const connectionGrants = new ConnectionGrantService({ entityCache });
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
      getConnectionInfo: () => ({
        serverUrl: gatewayUrl,
        publicUrl: "https://host.tailnet.ts.net",
        protocol: "http",
        externalHost: "127.0.0.1",
        gatewayPort,
      }),
      connectionGrants,
      auditLog: {
        append: async (entry) => {
          auditEntries.push(entry);
        },
      },
      registerMobileAppPrincipal: (deviceId) => {
        const callerId = `app:apps/mobile:${deviceId}`;
        entityCache._onActivate(makeAppRecord(callerId));
        return callerId;
      },
      retireMobileAppPrincipal: (deviceId) => {
        const callerId = `app:apps/mobile:${deviceId}`;
        const existing = entityCache.resolveActive(callerId);
        if (existing) {
          entityCache._onRetire({
            ...existing,
            status: "retired",
            retiredAt: Date.now(),
          });
        }
      },
      getMobileAppBootstrap: () => ({
        appId: "@workspace-apps/mobile",
        buildKey: "rn-key",
        effectiveVersion: "ev-mobile",
        rnHostAbi: "rn-host-1",
        integrity: "sha256-mobile",
        artifacts: [
          {
            path: "index.android.bundle",
            role: "primary",
            contentType: "application/javascript; charset=utf-8",
            encoding: "utf8",
            platform: "android",
            integrity: "sha256-android",
            url: "http://127.0.0.1:0/_a/rn-key/index.android.bundle",
          },
        ],
      }),
    });
    routeRegistry.registerHttpServiceRoutes(authService.routes ?? []);
    gateway = new Gateway({
      externalHost: "127.0.0.1",
      bindHost: "127.0.0.1",
      workerdPort: 9,
      routeRegistry,
      adminToken: "admin-secret",
      tokenManager,
    });
    gatewayPort = await gateway.start(0);
    gatewayUrl = `http://127.0.0.1:${gatewayPort}`;
  });

  afterAll(async () => {
    await gateway.stop();
  });

  it("creates pairing codes, completes pairing, refreshes app tokens, and revokes devices", async () => {
    const pairing = await postJson<PairingCodeResponse>(
      "/_r/s/auth/create-pairing-code",
      {},
      "admin-secret"
    );
    expect(pairing.status).toBe(200);
    expect(pairing.body.code).toMatch(/^[A-Za-z0-9_-]{16,}$/);
    expect(pairing.body.connectUrl).toBe("https://host.tailnet.ts.net");
    expect(pairing.body.deepLink).toBe(
      `natstack://connect?url=https%3A%2F%2Fhost.tailnet.ts.net&code=${pairing.body.code}`
    );

    const issued = await postJson<IssueDeviceResponse>(
      "/_r/s/auth/issue-device",
      { label: "Desktop", platform: "desktop" },
      "admin-secret"
    );
    expect(issued.status).toBe(200);
    expect(issued.body.callerId).toBe(`shell:${issued.body.deviceId}`);
    expect(tokenManager.validateToken(issued.body.shellToken)?.callerKind).toBe("shell-remote");

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

    const refreshed = await postJson<RefreshAppGrantResponse>(
      "/_r/s/auth/refresh-principal-grant",
      {
        deviceId: completed.body.deviceId,
        refreshToken: completed.body.refreshToken,
        principal: "react-native-app",
      }
    );
    expect(refreshed.status).toBe(200);
    expect(refreshed.body.callerId).toBe(`app:apps/mobile:${completed.body.deviceId}`);
    expect(refreshed.body.connectionGrant).toMatch(/^[0-9a-f]{64}$/);

    const unsupportedPrincipal = await postJson<{ error: string; code: string }>(
      "/_r/s/auth/refresh-principal-grant",
      {
        deviceId: completed.body.deviceId,
        refreshToken: completed.body.refreshToken,
        principal: "terminal-client",
      }
    );
    expect(unsupportedPrincipal.status).toBe(400);
    expect(unsupportedPrincipal.body.code).toBe("UNSUPPORTED_PRINCIPAL");

    const bootstrap = await postJson<MobileAppBootstrapResponse>(
      "/_r/s/auth/mobile-app-bootstrap",
      {
        deviceId: completed.body.deviceId,
        refreshToken: completed.body.refreshToken,
      }
    );
    expect(bootstrap.status).toBe(200);
    expect(bootstrap.body.workspaceId).toBe("workspace_test");
    expect(bootstrap.body.bootstrap).toMatchObject({
      appId: "@workspace-apps/mobile",
      rnHostAbi: "rn-host-1",
      integrity: "sha256-mobile",
      artifacts: [expect.objectContaining({ platform: "android" })],
    });

    const devices = await getJson<DevicesResponse>("/_r/s/auth/devices", "admin-secret");
    expect(devices.status).toBe(200);
    expect(JSON.stringify(devices.body)).not.toContain("refreshTokenHash");
    expect(devices.body.devices).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          deviceId: completed.body.deviceId,
          label: "Phone",
          platform: "mobile",
        }),
        expect.objectContaining({
          deviceId: issued.body.deviceId,
          label: "Desktop",
          platform: "desktop",
        }),
      ])
    );

    const revoked = await postJson<RevokeDeviceResponse>(
      "/_r/s/auth/revoke-device",
      { deviceId: completed.body.deviceId },
      "admin-secret"
    );
    expect(revoked.status).toBe(200);
    expect(revoked.body.revoked).toBe(true);
    expect(entityCache.resolveActive(refreshed.body.callerId)).toBeNull();

    const denied = await postJson<{ error: string; code: string }>("/_r/s/auth/refresh-shell", {
      deviceId: completed.body.deviceId,
      refreshToken: completed.body.refreshToken,
    });
    expect(denied.status).toBe(401);
    expect(denied.body.code).toBe("DEVICE_NOT_PAIRED");
    expect(auditEntries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "device_pairing.invite_created", callerId: "admin-token" }),
        expect.objectContaining({
          type: "device_pairing.redeemed",
          callerId: "public-pairing-code",
          deviceId: completed.body.deviceId,
        }),
        expect.objectContaining({
          type: "device_pairing.device_revoked",
          callerId: "admin-token",
          deviceId: completed.body.deviceId,
        }),
      ])
    );
  });

  it("exposes connection info and pairing invites through authenticated RPC", async () => {
    const authService = createAuthService({
      tokenManager: new TokenManager(),
      deviceAuthStore: new DeviceAuthStore(
        path.join(fs.mkdtempSync(path.join(os.tmpdir(), "natstack-auth-rpc-")), "devices.json")
      ),
      getServerBootId: () => "boot_rpc",
      getWorkspaceId: () => "workspace_rpc",
      getConnectionInfo: () => ({
        serverUrl: "http://127.0.0.1:3030",
        protocol: "http",
        externalHost: "127.0.0.1",
        gatewayPort: 3030,
      }),
      hasAppCapability: (callerId, capability) =>
        callerId === "@workspace-apps/remote-cli" && capability === "connection-management",
    });

    await expect(
      authService.definition.handler(
        { caller: createVerifiedCaller("shell:test", "shell") },
        "getConnectionInfo",
        []
      )
    ).resolves.toMatchObject({
      serverUrl: "http://127.0.0.1:3030",
      connectUrl: "http://127.0.0.1:3030",
      workspaceId: "workspace_rpc",
    } satisfies Partial<ConnectionInfoResponse>);

    const invite = (await authService.definition.handler(
      { caller: createVerifiedCaller("shell:test", "shell") },
      "createPairingInvite",
      [{ ttlMs: 30_000 }]
    )) as PairingCodeResponse;
    expect(invite.code).toMatch(/^[A-Za-z0-9_-]{16,}$/);
    expect(invite.connectUrl).toBe("http://127.0.0.1:3030");
    expect(invite.deepLink).toBe(
      `natstack://connect?url=http%3A%2F%2F127.0.0.1%3A3030&code=${invite.code}`
    );

    await expect(
      authService.definition.handler(
        { caller: createVerifiedCaller("@workspace-apps/remote-cli", "app") },
        "createPairingInvite",
        [{}]
      )
    ).resolves.toMatchObject({ connectUrl: "http://127.0.0.1:3030" });
    await expect(
      authService.definition.handler(
        { caller: createVerifiedCaller("@workspace-apps/other", "app") },
        "createPairingInvite",
        [{}]
      )
    ).rejects.toThrow(/connection-management/);
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

  it("allows panel-hosting app callers to issue panel connection grants", async () => {
    const entityCache = new EntityCache();
    entityCache._onActivate(makePanelRecord("panel:mobile"));
    const connectionGrants = new ConnectionGrantService({ entityCache });
    const service = createAuthService({
      tokenManager: new TokenManager(),
      deviceAuthStore: new DeviceAuthStore(
        path.join(fs.mkdtempSync(path.join(os.tmpdir(), "natstack-auth-grant-")), "devices.json")
      ),
      getServerBootId: () => "boot_test",
      getWorkspaceId: () => "workspace_test",
      connectionGrants,
      hasAppCapability: (callerId, capability) =>
        callerId === "app:apps/mobile:device-1" && capability === "panel-hosting",
    });

    expect(service.definition.methods?.["grantConnection"]?.policy).toEqual({
      allowed: ["server", "shell", "shell-remote", "app"],
    });

    const granted = (await service.definition.handler(
      { caller: createVerifiedCaller("app:apps/mobile:device-1", "app") },
      "grantConnection",
      ["panel:mobile"]
    )) as { token: string; expiresAt: number };

    expect(granted.token).toMatch(/^[0-9a-f]{64}$/);
    expect(connectionGrants.redeem(granted.token)).toEqual({
      principalId: "panel:mobile",
      issuedBy: "app:apps/mobile:device-1",
    });
    connectionGrants.stop();
  });

  it("rejects app panel connection grants without panel-hosting capability", async () => {
    const entityCache = new EntityCache();
    entityCache._onActivate(makePanelRecord("panel:mobile"));
    const connectionGrants = new ConnectionGrantService({ entityCache });
    const service = createAuthService({
      tokenManager: new TokenManager(),
      deviceAuthStore: new DeviceAuthStore(
        path.join(fs.mkdtempSync(path.join(os.tmpdir(), "natstack-auth-grant-")), "devices.json")
      ),
      getServerBootId: () => "boot_test",
      getWorkspaceId: () => "workspace_test",
      connectionGrants,
      hasAppCapability: () => false,
    });

    await expect(
      service.definition.handler(
        { caller: createVerifiedCaller("app:apps/other:device-1", "app") },
        "grantConnection",
        ["panel:mobile"]
      )
    ).rejects.toThrow(/panel-hosting/);
    connectionGrants.stop();
  });

  it("returns mobile app approval requirements without blocking bootstrap", async () => {
    const tokenManager = new TokenManager();
    const routeRegistry = new RouteRegistry();
    const authStore = new DeviceAuthStore(
      path.join(
        fs.mkdtempSync(path.join(os.tmpdir(), "natstack-auth-mobile-approval-")),
        "devices.json"
      )
    );
    const approvals = [
      {
        approvalId: "approval-mobile",
        kind: "unit-batch",
        callerId: "system:apps",
        callerKind: "system",
        repoPath: "apps/mobile",
        effectiveVersion: "ev-mobile",
        trigger: "startup",
        title: "Approve workspace apps",
        description: "Approve the mobile app",
        units: [
          {
            unitKind: "app",
            unitName: "@workspace-apps/mobile",
            displayName: "Mobile",
            target: "react-native",
            source: { kind: "workspace-repo", repo: "apps/mobile", ref: "main" },
            ev: "ev-mobile",
            capabilities: ["notifications"],
            dependencyEvs: {},
            externalDeps: {},
          },
        ],
        configWrite: null,
        requestedAt: 1,
      },
    ] satisfies PendingUnitBatchApproval[];
    const authService = createAuthService({
      tokenManager,
      deviceAuthStore: authStore,
      getServerBootId: () => "boot_mobile_approval",
      getWorkspaceId: () => "workspace_mobile_approval",
      ensureMobileAppReady: async () => ({
        ready: false,
        approvalRequired: true,
        approvals,
        reason: "React Native workspace app requires approval",
      }),
      getMobileAppBootstrap: () => null,
    });
    routeRegistry.registerHttpServiceRoutes(authService.routes ?? []);
    const gateway = new Gateway({
      externalHost: "127.0.0.1",
      bindHost: "127.0.0.1",
      workerdPort: 9,
      routeRegistry,
      adminToken: "admin-secret",
      tokenManager,
    });
    try {
      const port = await gateway.start(0);
      const issued = await postLocal<IssueDeviceResponse>(
        port,
        "/_r/s/auth/issue-device",
        { label: "Phone", platform: "mobile" },
        "admin-secret"
      );
      const response = await postLocal<{
        code: string;
        approvals: PendingUnitBatchApproval[];
      }>(port, "/_r/s/auth/mobile-app-bootstrap", {
        deviceId: issued.body.deviceId,
        refreshToken: issued.body.refreshToken,
      });

      expect(response.status).toBe(409);
      expect(response.body.code).toBe("MOBILE_APP_APPROVAL_REQUIRED");
      expect(response.body.approvals).toEqual([
        expect.objectContaining({
          approvalId: "approval-mobile",
          units: [expect.objectContaining({ target: "react-native" })],
        }),
      ]);
    } finally {
      await gateway.stop();
    }
  });
});

describe("auth service pairing invite flow", () => {
  it("pairs a second device from an invite minted by the first paired device over RPC", async () => {
    const tokenManager = new TokenManager();
    const entityCache = new EntityCache();
    const routeRegistry = new RouteRegistry();
    const dispatcher = new ServiceDispatcher();
    let gatewayPort = 0;
    const authStore = new DeviceAuthStore(
      path.join(fs.mkdtempSync(path.join(os.tmpdir(), "natstack-auth-e2e-")), "devices.json")
    );
    const authService = createAuthService({
      tokenManager,
      deviceAuthStore: authStore,
      getServerBootId: () => "boot_e2e",
      getWorkspaceId: () => "workspace_e2e",
      getConnectionInfo: () => ({
        serverUrl: `http://127.0.0.1:${gatewayPort}`,
        protocol: "http",
        externalHost: "127.0.0.1",
        gatewayPort,
      }),
    });
    dispatcher.registerService(authService.definition);
    dispatcher.markInitialized();
    routeRegistry.registerHttpServiceRoutes(authService.routes ?? []);
    const rpcServer = new RpcServer({ tokenManager, dispatcher, entityCache });
    rpcServer.initHandlers();
    const gateway = new Gateway({
      tokenManager,
      routeRegistry,
      getRpcHandler: () => rpcServer,
      externalHost: "127.0.0.1",
      bindHost: "127.0.0.1",
      workerdPort: 9,
      adminToken: "admin-secret",
    });
    try {
      gatewayPort = await gateway.start(0);

      const firstCode = await postLocal<PairingCodeResponse>(
        gatewayPort,
        "/_r/s/auth/create-pairing-code",
        {},
        "admin-secret"
      );
      const firstDevice = await postLocal<PairingCompleteResponse>(
        gatewayPort,
        "/_r/s/auth/complete-pairing",
        {
          code: firstCode.body.code,
          label: "First laptop",
          platform: "desktop",
        }
      );
      const refreshed = await postLocal<{ shellToken: string }>(
        gatewayPort,
        "/_r/s/auth/refresh-shell",
        {
          deviceId: firstDevice.body.deviceId,
          refreshToken: firstDevice.body.refreshToken,
        }
      );

      const inviteResponse = await fetch(`http://127.0.0.1:${gatewayPort}/rpc`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${refreshed.body.shellToken}`,
        },
        body: JSON.stringify({ method: "auth.createPairingInvite", args: [{}] }),
      });
      expect(inviteResponse.status).toBe(200);
      const inviteBody = (await inviteResponse.json()) as {
        result?: PairingCodeResponse;
        error?: string;
      };
      expect(inviteBody.error).toBeUndefined();
      expect(inviteBody.result).toBeDefined();
      const invite = inviteBody.result!;
      expect(invite.deepLink).toContain("natstack://connect");

      const secondDevice = await postLocal<PairingCompleteResponse>(
        gatewayPort,
        "/_r/s/auth/complete-pairing",
        {
          code: invite.code,
          label: "Phone",
          platform: "mobile",
        }
      );
      expect(secondDevice.status).toBe(200);
      expect(secondDevice.body.deviceId).toMatch(/^dev_/);
      expect(secondDevice.body.deviceId).not.toBe(firstDevice.body.deviceId);
    } finally {
      await gateway.stop();
      await rpcServer.stop();
    }
  });
});

async function postLocal<T>(
  port: number,
  pathname: string,
  body: unknown,
  bearer?: string
): Promise<{ status: number; body: T }> {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
    },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as T };
}
