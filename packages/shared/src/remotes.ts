import { z } from "zod";

export const RemoteReachKindSchema = z.enum([
  "tailscale-magicdns",
  "tailscale-ip",
  "lan-hostname",
  "lan-ip",
  "dns",
  "explicit",
]);

export const RemoteReachSchema = z.object({
  kind: RemoteReachKindSchema,
  value: z.string().min(1),
  lastVerifiedAt: z.number().int().positive().optional(),
}).strict();

export const RemoteSshSchema = z.object({
  user: z.string().min(1).optional(),
  port: z.number().int().min(1).max(65535).optional(),
  identityRef: z.string().min(1).optional(),
  proxyJump: z.string().min(1).optional(),
  connectTimeoutSec: z.number().int().min(1).max(120).optional(),
  serverAliveIntervalSec: z.number().int().min(1).max(300).optional(),
  compression: z.boolean().optional(),
}).strict();

export const RemoteTrustSchema = z.object({
  sshHostKeyFingerprints: z.array(z.string().min(1)).optional(),
  tlsFingerprint: z.string().min(1).optional(),
  caPath: z.string().min(1).optional(),
  pinnedAt: z.number().int().positive().optional(),
}).strict();

export const RemoteCapabilitySchema = z.object({
  os: z.string().optional(),
  pkgManager: z.string().optional(),
  has: z.object({
    node: z.boolean().optional(),
    pnpm: z.boolean().optional(),
    git: z.boolean().optional(),
    systemd: z.boolean().optional(),
    tmux: z.boolean().optional(),
  }).strict().optional(),
  sudo: z.object({
    version: z.string().optional(),
    gate: z.enum(["none", "shim", "sudoers", "plugin"]),
    passwordless: z.boolean().optional(),
  }).strict().optional(),
  tailscale: z.object({
    state: z.enum(["running", "down", "unauthed", "absent"]),
    magicDns: z.string().optional(),
  }).strict().optional(),
  probedAt: z.number().int().positive().optional(),
}).strict();

export const RemoteServerWorkspaceSchema = z.object({
  name: z.string().min(1),
  lastOpened: z.number().int().nonnegative(),
}).strict();

export const RemoteServerSchema = z.object({
  serverId: z.string().optional(),
  url: z.string().url().optional(),
  hubUrl: z.string().url().optional(),
  unitName: z.string().optional(),
  gatewayPort: z.number().int().min(1).max(65535).optional(),
  publicUrl: z.string().url().optional(),
  deviceCredRef: z.string().optional(),
  workspaces: z.array(RemoteServerWorkspaceSchema).optional(),
}).strict();

export const RemoteSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/),
  label: z.string().min(1).max(120).optional(),
  reach: z.array(RemoteReachSchema).min(1),
  ssh: RemoteSshSchema.optional(),
  trust: RemoteTrustSchema.default({}),
  capability: RemoteCapabilitySchema.optional(),
  server: RemoteServerSchema.optional(),
  source: z.enum(["ssh-added", "agent-deployed", "paired", "discovered"]),
  createdAt: z.number().int().positive(),
  lastUsedAt: z.number().int().positive().optional(),
}).strict();

export const RemoteRosterSchema = z.object({
  schemaVersion: z.literal(1),
  activeRemoteId: z.string().optional(),
  remotes: z.array(RemoteSchema),
}).strict();

export type RemoteReachKind = z.infer<typeof RemoteReachKindSchema>;
export type RemoteReach = z.infer<typeof RemoteReachSchema>;
export type Remote = z.infer<typeof RemoteSchema>;
export type RemoteRoster = z.infer<typeof RemoteRosterSchema>;

export function normalizeRemoteId(raw: string): string {
  const normalized = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[._-]+|[._-]+$/g, "")
    .slice(0, 128);
  return normalized || "remote";
}

export function reachKindForHost(hostname: string): RemoteReachKind {
  const host = hostname.toLowerCase();
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
    if (
      /^10\./.test(host) ||
      /^192\.168\./.test(host) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(host)
    ) return "lan-ip";
    if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(host)) return "tailscale-ip";
    return "explicit";
  }
  if (host.endsWith(".ts.net")) return "tailscale-magicdns";
  if (!host.includes(".")) return "lan-hostname";
  return "dns";
}

export function mergeRemote(existing: Remote | undefined, next: Remote): Remote {
  if (!existing) return RemoteSchema.parse(next);
  return RemoteSchema.parse({
    ...existing,
    ...next,
    reach: mergeReach(existing.reach, next.reach),
    ssh: next.ssh ?? existing.ssh,
    trust: { ...existing.trust, ...next.trust },
    capability: next.capability ?? existing.capability,
    server: next.server ? { ...(existing.server ?? {}), ...next.server } : existing.server,
    createdAt: existing.createdAt,
    lastUsedAt: next.lastUsedAt ?? existing.lastUsedAt,
  });
}

function mergeReach(current: RemoteReach[], incoming: RemoteReach[]): RemoteReach[] {
  const byKey = new Map<string, RemoteReach>();
  for (const reach of current) byKey.set(`${reach.kind}:${reach.value}`, reach);
  for (const reach of incoming) byKey.set(`${reach.kind}:${reach.value}`, reach);
  return Array.from(byKey.values());
}
