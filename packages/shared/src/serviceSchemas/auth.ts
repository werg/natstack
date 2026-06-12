/**
 * Wire schema for the server "auth" gateway authentication service.
 */

import { z } from "zod";
import { defineServiceMethods } from "../typedServiceClient.js";

export const CreatePairingInviteArgsSchema = z.object({
  ttlMs: z
    .number()
    .int()
    .min(30_000)
    .max(60 * 60 * 1000)
    .optional(),
});

export const ConnectionInfoResponseSchema = z.object({
  serverUrl: z.string(),
  publicUrl: z.string().nullable(),
  connectUrl: z.string(),
  protocol: z.enum(["http", "https"]).optional(),
  externalHost: z.string().optional(),
  gatewayPort: z.number().nullable().optional(),
  serverId: z.string(),
  serverBootId: z.string(),
  workspaceId: z.string(),
});

export const authMethods = defineServiceMethods({
  grantConnection: {
    args: z.tuple([z.string()]),
    returns: z.object({ token: z.string() }),
    policy: { allowed: ["server", "shell", "shell-remote", "app"] },
  },
  getConnectionInfo: { args: z.tuple([]), returns: ConnectionInfoResponseSchema },
  createPairingInvite: {
    args: z.tuple([CreatePairingInviteArgsSchema.optional()]),
    // Matches PairingInviteResponse (ConnectionInfoResponse + pairing fields)
    // produced by `createPairingInviteResponse` in src/server/services/auth/model.ts.
    returns: ConnectionInfoResponseSchema.extend({
      code: z.string(),
      expiresInMs: z.number(),
      expiresAt: z.number(),
      deepLink: z.string().nullable(),
    }),
    policy: { allowed: ["server", "shell", "shell-remote", "app"] },
  },
  listDevices: {
    args: z.tuple([]),
    // Matches the handler in src/server/services/authService.ts: DeviceRecord
    // rows with `refreshTokenHash` stripped before they cross the wire.
    returns: z.object({
      serverId: z.string(),
      devices: z.array(
        z.object({
          deviceId: z.string(),
          label: z.string(),
          platform: z.string().optional(),
          createdAt: z.number(),
          lastUsedAt: z.number().optional(),
          revokedAt: z.number().optional(),
        })
      ),
    }),
  },
  revokeDevice: {
    args: z.tuple([z.string()]),
    returns: z.object({ revoked: z.boolean() }),
  },
});
