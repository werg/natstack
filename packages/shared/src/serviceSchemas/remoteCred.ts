/**
 * remoteCred service method schemas.
 */

import { z } from "zod";
import { CreatePairingInviteArgsSchema } from "./auth.js";
import type { MethodAccessDescriptor } from "../servicePolicy.js";
import { defineServiceMethods } from "../typedServiceClient.js";

// Access descriptors shared across the remoteCred method groups. These manage
// the Electron-side remote-server credential store, so reads are 'read' and the
// mutators that persist credentials / pair / relaunch are 'admin'.
const REMOTE_CRED_READ_ACCESS: MethodAccessDescriptor = {
  sensitivity: "read",
};
const REMOTE_CRED_SAVE_ACCESS: MethodAccessDescriptor = {
  sensitivity: "admin",
};
const REMOTE_CRED_PAIR_ACCESS: MethodAccessDescriptor = {
  sensitivity: "admin",
};
const REMOTE_CRED_INVITE_ACCESS: MethodAccessDescriptor = {
  sensitivity: "admin",
};
const REMOTE_CRED_REVOKE_ACCESS: MethodAccessDescriptor = {
  sensitivity: "admin",
};
const REMOTE_CRED_CLEAR_ACCESS: MethodAccessDescriptor = {
  sensitivity: "admin",
};
const REMOTE_CRED_RELAUNCH_ACCESS: MethodAccessDescriptor = {
  sensitivity: "admin",
};

export const RemoteCredSaveArgsSchema = z.object({
  url: z.string().describe("Selected-workspace server URL (http/https) to connect to."),
  token: z.string().describe("Admin token used to authenticate against the remote server."),
});
export type RemoteCredSaveArgs = z.infer<typeof RemoteCredSaveArgsSchema>;

export const RemoteCredPairingCodeArgsSchema = z.object({
  link: z
    .string()
    .describe("A `natstack://connect?...` pairing link carrying the WebRTC pairing material."),
  label: z.string().optional().describe("Human-readable label for the new device credential."),
});
export type RemoteCredPairingCodeArgs = z.infer<typeof RemoteCredPairingCodeArgsSchema>;

export const RemoteCredCurrentSchema = z.object({
  configured: z.boolean(),
  isActive: z.boolean(),
  bootstrap: z.enum(["device", "admin-token", "hybrid", "none"]),
  url: z.string().optional(),
  tokenPreview: z.string().optional(),
  deviceId: z.string().optional(),
  hubUrl: z.string().optional(),
  workspaceName: z.string().optional(),
});
export type RemoteCredCurrent = z.infer<typeof RemoteCredCurrentSchema>;

export const RemoteCredTestConnectionResultSchema = z.object({
  ok: z.boolean(),
  error: z.enum(["invalid-url", "unreachable", "unauthorized", "unknown"]).optional(),
  message: z.string().optional(),
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
  // NOTE: no `connectUrl` — the producer (createPairingInviteResponse) emits
  // `serverUrl` (the connection origin); consumers derive the rest from the code.
  serverUrl: z.string(),
  publicUrl: z.string().nullable().optional(),
  protocol: z.enum(["http", "https"]).optional(),
  externalHost: z.string().optional(),
  gatewayPort: z.number().nullable().optional(),
  expiresAt: z.number(),
  expiresInMs: z.number(),
  serverId: z.string(),
  serverBootId: z.string(),
  workspaceId: z.string().nullable().optional(),
});
export type RemoteCredPairingInvite = z.infer<typeof RemoteCredPairingInviteSchema>;

const OkResultSchema = z.object({ ok: z.boolean() });

export const remoteCredMethods = defineServiceMethods({
  getCurrent: {
    description:
      "Report the locally stored remote-server credential: whether it's configured/active, bootstrap kind, URL, workspace, and a masked token preview.",
    args: z.tuple([]),
    returns: RemoteCredCurrentSchema,
    access: REMOTE_CRED_READ_ACCESS,
  },
  save: {
    description:
      "Persist an admin-token credential for the selected remote workspace URL (replaces any existing stored credential).",
    args: z.tuple([RemoteCredSaveArgsSchema]),
    returns: OkResultSchema,
    access: REMOTE_CRED_SAVE_ACCESS,
    examples: [{ args: [{ url: "https://hub.example/ws/main", token: "admin-secret" }] }],
  },
  testConnection: {
    description:
      "Probe the remote server's admin-token auth without saving anything; reports reachability and server identity.",
    args: z.tuple([RemoteCredSaveArgsSchema]),
    returns: RemoteCredTestConnectionResultSchema,
    access: REMOTE_CRED_READ_ACCESS,
  },
  exchangePairingCode: {
    description:
      "Redeem a `natstack://connect` pairing link over WebRTC for a durable device credential and persist it locally for auto-reconnect.",
    args: z.tuple([RemoteCredPairingCodeArgsSchema]),
    returns: RemoteCredTestConnectionResultSchema,
    access: REMOTE_CRED_PAIR_ACCESS,
  },
  createPairingInvite: {
    description:
      "Create a device-pairing invite on the connected remote server (only available while running in remote mode).",
    args: z.tuple([CreatePairingInviteArgsSchema.optional()]),
    returns: RemoteCredPairingInviteSchema,
    access: REMOTE_CRED_INVITE_ACCESS,
    examples: [{ args: [{ ttlMs: 300_000 }] }],
  },
  listDevices: {
    description:
      "List devices paired with the connected remote server; returns an empty list when not in remote mode.",
    args: z.tuple([]),
    returns: z.array(RemoteCredDeviceRecordSchema),
    access: REMOTE_CRED_READ_ACCESS,
  },
  revokeDevice: {
    description:
      "Revoke a paired device on the remote server; if it is this client's own device the local credential is cleared and the app relaunches.",
    args: z.tuple([z.string()]),
    returns: z.object({ revoked: z.boolean() }),
    access: REMOTE_CRED_REVOKE_ACCESS,
  },
  clear: {
    description: "Delete the locally stored remote-server credential.",
    args: z.tuple([]),
    returns: OkResultSchema,
    access: REMOTE_CRED_CLEAR_ACCESS,
  },
  relaunch: {
    description: "Relaunch the Electron app (e.g. to apply a changed remote credential).",
    args: z.tuple([]),
    returns: OkResultSchema,
    access: REMOTE_CRED_RELAUNCH_ACCESS,
  },
});
