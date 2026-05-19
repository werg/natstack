import type { IncomingMessage, ServerResponse } from "http";
import { z } from "zod";
import type { ServiceDefinition } from "@natstack/shared/serviceDefinition";
import type { TokenManager } from "@natstack/shared/tokenManager";
import type { ServiceRouteDecl } from "../routeRegistry.js";
import type { ServiceWithRoutes } from "../rpcServiceWithRoutes.js";
import type { DeviceAuthStore } from "./deviceAuthStore.js";
import type { ConnectionGrantService } from "@natstack/shared/connectionGrants";

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

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
}

export function createAuthService(deps: {
  tokenManager: TokenManager;
  deviceAuthStore: DeviceAuthStore;
  getServerBootId: () => string;
  getWorkspaceId: () => string;
  connectionGrants?: ConnectionGrantService;
}): ServiceWithRoutes {
  const definition: ServiceDefinition = {
    name: "auth",
    description: "Gateway authentication bootstrap routes",
    policy: { allowed: ["server", "shell"] },
    methods: {
      grantConnection: { args: z.tuple([z.string()]) },
    },
    handler: async (ctx, method, args) => {
      if (method !== "grantConnection") throw new Error(`Unknown auth method: ${method}`);
      if (!deps.connectionGrants) throw new Error("Connection grants are not configured");
      return deps.connectionGrants.grant(args[0] as string, ctx.caller.runtime.id);
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
          sendJson(res, 200, responseForCredential(deps, credential));
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          sendJson(res, 400, { error: message });
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
          const expiresInMs = body.ttlMs ?? 10 * 60 * 1000;
          const code = deps.deviceAuthStore.createPairingCode(expiresInMs);
          sendJson(res, 200, {
            code,
            expiresInMs,
            serverId: deps.deviceAuthStore.getServerId(),
            serverBootId: deps.getServerBootId(),
            workspaceId: deps.getWorkspaceId(),
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          sendJson(res, 400, { error: message });
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
          sendJson(res, 200, responseForCredential(deps, credential));
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          sendJson(res, 401, { error: message });
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
          const shellToken = deps.tokenManager.ensureToken(
            shellCallerId(body.deviceId),
            "shell-remote"
          );
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
          const message = error instanceof Error ? error.message : String(error);
          sendJson(res, 401, { error: message });
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
          sendJson(res, 200, { revoked });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          sendJson(res, 400, { error: message });
        }
      },
    },
  ];

  return { definition, routes };
}

function shellCallerId(deviceId: string): string {
  return `shell:${deviceId}`;
}

function responseForCredential(
  deps: {
    tokenManager: TokenManager;
    deviceAuthStore: DeviceAuthStore;
    getServerBootId: () => string;
    getWorkspaceId: () => string;
  },
  credential: { deviceId: string; refreshToken: string; label: string; platform?: string }
): Record<string, unknown> {
  const shellToken = deps.tokenManager.ensureToken(
    shellCallerId(credential.deviceId),
    "shell-remote"
  );
  return {
    ...credential,
    shellToken,
    callerId: shellCallerId(credential.deviceId),
    serverId: deps.deviceAuthStore.getServerId(),
    serverBootId: deps.getServerBootId(),
    workspaceId: deps.getWorkspaceId(),
  };
}
