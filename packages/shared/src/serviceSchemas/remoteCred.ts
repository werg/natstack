/**
 * remoteCred service method schemas.
 */

import { z } from "zod";
import { CreatePairingInviteArgsSchema } from "./auth.js";
import { defineServiceMethods } from "../typedServiceClient.js";
import type { DiscoveredServer } from "../tailscaleDiscovery.js";

export const RemoteCredSaveArgsSchema = z.object({
  url: z.string(),
  token: z.string(),
  caPath: z.string().optional(),
  fingerprint: z.string().optional(),
});
export type RemoteCredSaveArgs = z.infer<typeof RemoteCredSaveArgsSchema>;

export const RemoteCredPairingCodeArgsSchema = z.object({
  url: z.string(),
  code: z.string(),
  caPath: z.string().optional(),
  fingerprint: z.string().optional(),
  label: z.string().optional(),
});
export type RemoteCredPairingCodeArgs = z.infer<typeof RemoteCredPairingCodeArgsSchema>;

export const RemoteCredCurrentSchema = z.object({
  configured: z.boolean(),
  isActive: z.boolean(),
  bootstrap: z.enum(["device", "admin-token", "hybrid", "none"]),
  url: z.string().optional(),
  caPath: z.string().optional(),
  fingerprint: z.string().optional(),
  tokenPreview: z.string().optional(),
  deviceId: z.string().optional(),
});
export type RemoteCredCurrent = z.infer<typeof RemoteCredCurrentSchema>;

export const RemoteCredTestConnectionResultSchema = z.object({
  ok: z.boolean(),
  error: z.enum(["invalid-url", "unreachable", "tls-mismatch", "unauthorized", "unknown"]).optional(),
  message: z.string().optional(),
  observedFingerprint: z.string().optional(),
  serverVersion: z.string().optional(),
  serverId: z.string().optional(),
  workspaceId: z.string().optional(),
});
export type RemoteCredTestConnectionResult = z.infer<typeof RemoteCredTestConnectionResultSchema>;

export const RemoteCredDeviceRecordSchema = z.object({
  deviceId: z.string(),
  label: z.string(),
  platform: z.string().optional(),
  createdAt: z.number(),
  lastUsedAt: z.number().optional(),
  revokedAt: z.number().optional(),
});
export type RemoteCredDeviceRecord = z.infer<typeof RemoteCredDeviceRecordSchema>;

export const RemoteCredPairingInviteSchema = z.object({
  code: z.string(),
  deepLink: z.string().nullable(),
  connectUrl: z.string(),
  serverUrl: z.string(),
  publicUrl: z.string().nullable().optional(),
  protocol: z.enum(["http", "https"]).optional(),
  externalHost: z.string().optional(),
  gatewayPort: z.number().nullable().optional(),
  expiresAt: z.number(),
  expiresInMs: z.number(),
  serverId: z.string(),
  serverBootId: z.string(),
  workspaceId: z.string(),
});
export type RemoteCredPairingInvite = z.infer<typeof RemoteCredPairingInviteSchema>;

export const RemoteCredDiscoveredServerSchema = z.custom<DiscoveredServer>();

const OkResultSchema = z.object({ ok: z.boolean() });

export const remoteCredMethods = defineServiceMethods({
  getCurrent: { args: z.tuple([]), returns: RemoteCredCurrentSchema },
  save: { args: z.tuple([RemoteCredSaveArgsSchema]), returns: OkResultSchema },
  testConnection: {
    args: z.tuple([RemoteCredSaveArgsSchema]),
    returns: RemoteCredTestConnectionResultSchema,
  },
  exchangePairingCode: {
    args: z.tuple([RemoteCredPairingCodeArgsSchema]),
    returns: RemoteCredTestConnectionResultSchema,
  },
  discoverServers: {
    args: z.tuple([]),
    returns: z.array(RemoteCredDiscoveredServerSchema),
  },
  createPairingInvite: {
    args: z.tuple([CreatePairingInviteArgsSchema.optional()]),
    returns: RemoteCredPairingInviteSchema,
  },
  listDevices: { args: z.tuple([]), returns: z.array(RemoteCredDeviceRecordSchema) },
  revokeDevice: {
    args: z.tuple([z.string()]),
    returns: z.object({ revoked: z.boolean() }),
  },
  fetchPeerFingerprint: { args: z.tuple([z.string()]), returns: z.string() },
  pickCaFile: { args: z.tuple([]), returns: z.string().nullable() },
  clear: { args: z.tuple([]), returns: OkResultSchema },
  relaunch: { args: z.tuple([]), returns: OkResultSchema },
});
