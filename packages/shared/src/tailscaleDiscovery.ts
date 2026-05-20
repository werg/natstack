import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface DiscoveredServer {
  url: string;
  hostname: string;
  serverId?: string;
  workspaceId?: string;
  discoveryVersion: number;
}

export interface TailscalePeer {
  DNSName?: string;
  HostName?: string;
  Online?: boolean;
}

export interface TailscaleStatus {
  Self?: TailscalePeer;
  Peer?: Record<string, TailscalePeer>;
}

export async function discoverNatstackServers(opts?: {
  timeoutMs?: number;
  probeKnownPorts?: boolean;
}): Promise<DiscoveredServer[]> {
  let status: TailscaleStatus;
  try {
    const { stdout } = await execFileAsync("tailscale", ["status", "--json"], {
      timeout: opts?.timeoutMs ?? 1500,
      maxBuffer: 2 * 1024 * 1024,
    });
    status = JSON.parse(stdout) as TailscaleStatus;
  } catch {
    return [];
  }

  return discoverNatstackServersFromStatus(status, opts);
}

export async function discoverNatstackServersFromStatus(
  status: TailscaleStatus,
  opts?: {
    timeoutMs?: number;
    probeKnownPorts?: boolean;
    fetcher?: typeof fetch;
  }
): Promise<DiscoveredServer[]> {
  const peers = [status.Self, ...Object.values(status.Peer ?? {})].filter(
    (peer): peer is TailscalePeer => !!peer && peer.Online !== false
  );
  const hostnames = [
    ...new Set(
      peers
        .map((peer) => normalizeDnsName(peer.DNSName) ?? peer.HostName)
        .filter((host): host is string => typeof host === "string" && host.length > 0)
    ),
  ];

  const urls = hostnames.flatMap((hostname) => {
    const base = [`https://${hostname}`];
    return opts?.probeKnownPorts ? [...base, `http://${hostname}:3030`] : base;
  });

  const found = await Promise.all(
    urls.map((url) => probeNatstackHealth(url, opts?.timeoutMs ?? 1500, opts?.fetcher ?? fetch))
  );
  return found.filter((entry): entry is DiscoveredServer => entry !== null);
}

function normalizeDnsName(raw: string | undefined): string | null {
  if (!raw) return null;
  return raw.endsWith(".") ? raw.slice(0, -1) : raw;
}

async function probeNatstackHealth(
  baseUrl: string,
  timeoutMs: number,
  fetcher: typeof fetch
): Promise<DiscoveredServer | null> {
  try {
    const url = new URL("/healthz", baseUrl);
    const response = await fetcher(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) return null;
    const body = (await response.json()) as Record<string, unknown>;
    if (body["product"] !== "natstack") return null;
    const discoveryVersion = body["discoveryVersion"];
    if (typeof discoveryVersion !== "number" || discoveryVersion < 1) return null;
    return {
      url: new URL(baseUrl).origin,
      hostname: new URL(baseUrl).hostname,
      serverId: typeof body["serverId"] === "string" ? body["serverId"] : undefined,
      workspaceId: typeof body["workspaceId"] === "string" ? body["workspaceId"] : undefined,
      discoveryVersion,
    };
  } catch {
    return null;
  }
}
