import type { IncomingMessage, ServerResponse } from "http";
import { z } from "zod";
import type { ServiceDefinition } from "@natstack/shared/serviceDefinition";
import { authMethods, CreatePairingInviteArgsSchema } from "@natstack/shared/serviceSchemas/auth";
import type { TokenManager } from "@natstack/shared/tokenManager";
import type { ServiceRouteDecl } from "../routeRegistry.js";
import type { ServiceWithRoutes } from "../serviceWithHttpRoutes.js";
import type { DeviceAuthStore } from "./deviceAuthStore.js";
import type { ConnectionGrantService } from "@natstack/shared/connectionGrants";
import type { AuditLog } from "@natstack/shared/credentials/audit";
import type { PendingUnitBatchApproval } from "@natstack/shared/approvals";
import type { AppCapability } from "@natstack/shared/unitManifest";
import { isPanelSlotId } from "@natstack/shared/panel/ids";
import {
  connectionInfoResponse,
  createPairingInviteResponse,
  responseForCredential,
  shellCallerId,
  type AuthConnectionInfo,
} from "./auth/model.js";
import { auditPairingEvent } from "./auth/audit.js";
import { refreshPrincipalGrantResponse } from "./auth/principalGrants.js";
import { sendAuthError } from "./auth/httpErrors.js";
import { createCapabilityAuthorizer, type CapabilityAuthorizer } from "./capabilityAuthorizer.js";

const IssueDeviceBodySchema = z.object({
  label: z.string().min(1).max(128).optional(),
  platform: z.string().min(1).max(64).optional(),
});

const CreatePairingCodeBodySchema = z.object({
  ttlMs: z
    .number()
    .int()
    .min(30_000)
    .max(60 * 60 * 1000)
    .optional(),
});

const CompletePairingBodySchema = z.object({
  code: z.string().min(16).max(512),
  label: z.string().min(1).max(128).optional(),
  platform: z.string().min(1).max(64).optional(),
});

const RefreshShellBodySchema = z.object({
  deviceId: z.string().min(1).max(128),
  refreshToken: z.string().min(16).max(512),
});

const RefreshPrincipalGrantBodySchema = RefreshShellBodySchema.extend({
  principal: z.string().min(1).max(128).optional(),
  source: z.string().min(1).max(256).optional(),
});
const MobileAppBootstrapBodySchema = RefreshShellBodySchema.extend({
  source: z.string().min(1).max(256).optional(),
});

const RevokeDeviceBodySchema = z.object({
  deviceId: z.string().min(1).max(128),
});

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function sendJson(
  res: ServerResponse,
  status: number,
  payload: unknown,
  headers: Record<string, string> = {}
): void {
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(JSON.stringify(payload));
}

/**
 * Redeem a device-pairing credential presented as a session token — the
 * over-the-pipe equivalent of the loopback HTTP `/complete-pairing` +
 * `/refresh-shell` endpoints (which a remote WebRTC client cannot reach):
 *   - a QR pairing `code` (fresh device) → `completePairing` → a newly issued
 *     device credential (returned so the auth-result hands it to the client to
 *     persist), or
 *   - `refresh:<deviceId>:<refreshToken>` (returning device) → `validateRefresh`.
 * Both resolve to the device's `shell:<deviceId>` principal. Returns null when
 * the token is neither (handleAuth then rejects it as an invalid token). Wired
 * into `RpcServer`'s `redeemPairingCredential` dep so it runs ONLY after the
 * grant/bearer checks miss.
 */
export function createPairingRedeemer(deps: {
  deviceAuthStore: DeviceAuthStore;
  tokenManager: TokenManager;
}) {
  const REFRESH_PREFIX = "refresh:";
  return (token: string, ctx: { clientLabel?: string; clientPlatform?: string }) => {
    if (token.startsWith(REFRESH_PREFIX)) {
      const rest = token.slice(REFRESH_PREFIX.length);
      const sep = rest.indexOf(":");
      if (sep <= 0) return null;
      const deviceId = rest.slice(0, sep);
      const refreshToken = rest.slice(sep + 1);
      if (!refreshToken) return null;
      try {
        deps.deviceAuthStore.validateRefresh(deviceId, refreshToken);
      } catch {
        return null;
      }
      deps.tokenManager.ensureToken(shellCallerId(deviceId), "shell");
      return { callerId: shellCallerId(deviceId), callerKind: "shell" as const };
    }
    if (!deps.deviceAuthStore.hasPendingPairingCode(token)) return null;
    let credential;
    try {
      credential = deps.deviceAuthStore.completePairing({
        code: token,
        label: ctx.clientLabel,
        platform: ctx.clientPlatform,
      });
    } catch {
      return null;
    }
    deps.tokenManager.ensureToken(shellCallerId(credential.deviceId), "shell");
    return {
      callerId: shellCallerId(credential.deviceId),
      callerKind: "shell" as const,
      deviceCredential: { deviceId: credential.deviceId, refreshToken: credential.refreshToken },
    };
  };
}

export function createAuthService(deps: {
  tokenManager: TokenManager;
  deviceAuthStore: DeviceAuthStore;
  getServerBootId: () => string;
  getWorkspaceId: () => string;
  getConnectionInfo?: () => AuthConnectionInfo;
  connectionGrants?: ConnectionGrantService;
  auditLog?: Pick<AuditLog, "append">;
  hasAppCapability?: (callerId: string, capability: AppCapability) => boolean;
  capabilityAuthorizer?: CapabilityAuthorizer;
  ensureMobileAppReady?: (source?: string | null) => Promise<{
    ready: boolean;
    reason?: string;
    details?: string[];
    approvalRequired?: boolean;
    approvals?: PendingUnitBatchApproval[];
  }>;
  getMobileAppBootstrap?: (source?: string | null) => unknown | null | Promise<unknown | null>;
  registerMobileAppPrincipal?: (
    deviceId: string,
    source?: string | null
  ) => string | null | Promise<string | null>;
  retireMobileAppPrincipal?: (deviceId: string) => void;
}): ServiceWithRoutes {
  const capabilityAuthorizer =
    deps.capabilityAuthorizer ??
    createCapabilityAuthorizer({ hasAppCapability: deps.hasAppCapability });
  const definition: ServiceDefinition = {
    name: "auth",
    description: "Gateway authentication bootstrap routes",
    policy: { allowed: ["server", "shell"] },
    methods: authMethods,
    handler: async (ctx, method, args) => {
      if (method === "grantConnection") {
        capabilityAuthorizer.require(ctx.caller, "panel-hosting");
        if (!deps.connectionGrants) throw new Error("Connection grants are not configured");
        const principalId = args[0] as string;
        // Boundary defense at the RPC ingress: a slot id ("panel:tree/…") names a
        // tree position, not a connectable principal. Reject it loudly here so a
        // slot/entity mix-up by ANY caller fails at the grant rather than minting a
        // grant that can never satisfy authorizePanelConnection (leases are keyed
        // by the panel ENTITY id "panel:nav-…").
        if (isPanelSlotId(principalId)) {
          throw new Error(
            `grantConnection: "${principalId}" is a panel SLOT id; connection grants require a ` +
              `runtime principal (the panel ENTITY id "panel:nav-…"), not a tree slot.`
          );
        }
        return deps.connectionGrants.grant(principalId, ctx.caller.runtime.id);
      }
      if (method === "getConnectionInfo") {
        return connectionInfoResponse(deps);
      }
      if (method === "createPairingInvite") {
        capabilityAuthorizer.require(ctx.caller, "connection-management");
        const body = CreatePairingInviteArgsSchema.parse(args[0] ?? {});
        const response = createPairingInviteResponse(deps, body.ttlMs);
        await auditPairingEvent(deps, {
          type: "device_pairing.invite_created",
          callerId: ctx.caller.runtime.id,
          expiresAt: typeof response["expiresAt"] === "number" ? response["expiresAt"] : undefined,
          method: "rpc",
        });
        return response;
      }
      if (method === "listDevices") {
        return {
          serverId: deps.deviceAuthStore.getServerId(),
          devices: deps.deviceAuthStore
            .listDevices()
            .map(({ refreshTokenHash: _secret, ...device }) => device),
        };
      }
      if (method === "revokeDevice") {
        const deviceId = args[0] as string;
        const revoked = deps.deviceAuthStore.revokeDevice(deviceId);
        deps.tokenManager.revokeToken(shellCallerId(deviceId));
        deps.retireMobileAppPrincipal?.(deviceId);
        if (revoked) {
          await auditPairingEvent(deps, {
            type: "device_pairing.device_revoked",
            callerId: ctx.caller.runtime.id,
            deviceId,
            method: "rpc",
          });
        }
        return { revoked };
      }
      throw new Error(`Unknown auth method: ${method}`);
    },
  };

  const routes: ServiceRouteDecl[] = [
    {
      serviceName: "auth",
      path: "/issue-device",
      methods: ["POST"],
      auth: "admin-token",
      handler: async (req, res) => {
        try {
          const body = IssueDeviceBodySchema.parse(await readJson(req));
          const credential = deps.deviceAuthStore.issueDevice({
            label: body.label ?? "NatStack client",
            platform: body.platform,
          });
          sendJson(res, 200, responseForCredential(deps, credential, { includeShellToken: true }));
        } catch (error) {
          sendAuthError(res, error, 400);
        }
      },
    },
    {
      serviceName: "auth",
      path: "/create-pairing-code",
      methods: ["POST"],
      auth: "admin-token",
      handler: async (req, res) => {
        try {
          const body = CreatePairingCodeBodySchema.parse(await readJson(req));
          const response = createPairingInviteResponse(deps, body.ttlMs);
          await auditPairingEvent(deps, {
            type: "device_pairing.invite_created",
            callerId: "admin-token",
            expiresAt:
              typeof response["expiresAt"] === "number" ? response["expiresAt"] : undefined,
            method: "http-admin",
          });
          sendJson(res, 200, response);
        } catch (error) {
          sendAuthError(res, error, 400);
        }
      },
    },
    {
      serviceName: "auth",
      path: "/complete-pairing",
      methods: ["POST"],
      auth: "public",
      handler: async (req, res) => {
        try {
          const body = CompletePairingBodySchema.parse(await readJson(req));
          const credential = deps.deviceAuthStore.completePairing({
            code: body.code,
            label: body.label,
            platform: body.platform,
          });
          await auditPairingEvent(deps, {
            type: "device_pairing.redeemed",
            callerId: "public-pairing-code",
            deviceId: credential.deviceId,
            label: credential.label,
            platform: credential.platform,
            method: "http-public",
          });
          sendJson(res, 200, responseForCredential(deps, credential, { includeShellToken: true }));
        } catch (error) {
          sendAuthError(res, error, 401);
        }
      },
    },
    {
      serviceName: "auth",
      path: "/refresh-shell",
      methods: ["POST"],
      auth: "public",
      handler: async (req, res) => {
        try {
          const body = RefreshShellBodySchema.parse(await readJson(req));
          const device = deps.deviceAuthStore.validateRefresh(body.deviceId, body.refreshToken);
          const shellToken = deps.tokenManager.ensureToken(shellCallerId(body.deviceId), "shell");
          sendJson(res, 200, {
            shellToken,
            callerId: shellCallerId(body.deviceId),
            deviceId: body.deviceId,
            label: device.label,
            serverId: deps.deviceAuthStore.getServerId(),
            serverBootId: deps.getServerBootId(),
            workspaceId: deps.getWorkspaceId(),
          });
        } catch (error) {
          sendAuthError(res, error, 401);
        }
      },
    },
    {
      serviceName: "auth",
      path: "/refresh-principal-grant",
      methods: ["POST"],
      auth: "public",
      handler: async (req, res) => {
        try {
          const body = RefreshPrincipalGrantBodySchema.parse(await readJson(req));
          sendJson(res, 200, await refreshPrincipalGrantResponse(deps, body));
        } catch (error) {
          sendAuthError(res, error, 401);
        }
      },
    },
    {
      serviceName: "auth",
      path: "/mobile-app-bootstrap",
      methods: ["POST"],
      auth: "public",
      handler: async (req, res) => {
        try {
          if (!deps.getMobileAppBootstrap) {
            sendJson(res, 503, {
              error: "Mobile app bootstrap is not configured",
              code: "MOBILE_BOOTSTRAP_UNAVAILABLE",
            });
            return;
          }
          const body = MobileAppBootstrapBodySchema.parse(await readJson(req));
          deps.deviceAuthStore.validateRefresh(body.deviceId, body.refreshToken);
          const readiness = await deps.ensureMobileAppReady?.(body.source ?? null);
          if (readiness && !readiness.ready) {
            const approvalRequired = readiness.approvalRequired === true;
            sendJson(res, approvalRequired ? 409 : 503, {
              error: [
                readiness.reason ?? "No approved React Native workspace app is available",
                ...(readiness.details?.length ? readiness.details : []),
              ].join(": "),
              code: approvalRequired ? "MOBILE_APP_APPROVAL_REQUIRED" : "MOBILE_APP_UNAVAILABLE",
              ...(approvalRequired ? { approvals: readiness.approvals ?? [] } : {}),
            });
            return;
          }
          const bootstrap = await deps.getMobileAppBootstrap(body.source ?? null);
          if (!bootstrap) {
            sendJson(res, 404, {
              error: "No approved React Native workspace app is available",
              code: "MOBILE_APP_UNAVAILABLE",
            });
            return;
          }
          sendJson(res, 200, {
            serverId: deps.deviceAuthStore.getServerId(),
            serverBootId: deps.getServerBootId(),
            workspaceId: deps.getWorkspaceId(),
            bootstrap,
          });
        } catch (error) {
          sendAuthError(res, error, 401);
        }
      },
    },
    {
      serviceName: "auth",
      path: "/devices",
      methods: ["GET"],
      auth: "admin-token",
      handler: async (_req, res) => {
        sendJson(res, 200, {
          serverId: deps.deviceAuthStore.getServerId(),
          devices: deps.deviceAuthStore
            .listDevices()
            .map(({ refreshTokenHash: _secret, ...device }) => device),
        });
      },
    },
    {
      serviceName: "auth",
      path: "/revoke-device",
      methods: ["POST"],
      auth: "admin-token",
      handler: async (req, res) => {
        try {
          const body = RevokeDeviceBodySchema.parse(await readJson(req));
          const revoked = deps.deviceAuthStore.revokeDevice(body.deviceId);
          deps.tokenManager.revokeToken(shellCallerId(body.deviceId));
          deps.retireMobileAppPrincipal?.(body.deviceId);
          if (revoked) {
            await auditPairingEvent(deps, {
              type: "device_pairing.device_revoked",
              callerId: "admin-token",
              deviceId: body.deviceId,
              method: "http-admin",
            });
          }
          sendJson(res, 200, { revoked });
        } catch (error) {
          sendAuthError(res, error, 400);
        }
      },
    },
  ];

  return { definition, routes };
}
