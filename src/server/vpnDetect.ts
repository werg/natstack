/**
 * VPN auto-detection for picking a sensible public URL.
 *
 * Personal-server natstack installations almost always sit behind a VPN
 * (Tailscale, Headscale, less commonly WireGuard / Cloudflare Tunnel). Asking
 * users to figure out their MagicDNS hostname and pass --public-url manually
 * is the kind of friction that derails OAuth setup.
 *
 * This module probes the local environment for a VPN system that gives us:
 *   - a stable hostname (so the URL doesn't change between sessions),
 *   - HTTPS (required by every OAuth provider for non-loopback redirects).
 *
 * Today we detect Tailscale via its CLI. Other VPN systems can be added by
 * implementing additional probes in `detectVpn()`.
 */

import { spawn } from "node:child_process";

export interface DetectedVpnPublicUrl {
  vendor: "tailscale";
  /** Human-readable hostname (e.g., "pop-os.tailnet-xyz.ts.net"). */
  hostname: string;
  /** Suggested public URL. Always HTTPS. */
  url: string;
  /**
   * Whether the operator still has setup work to do before the URL is
   * actually serving HTTPS — e.g., needs to run `tailscale serve` or
   * provision a cert. We surface this so the bootstrap banner can guide them.
   */
  setupHint?: string;
  /** Raw fields kept for diagnostics / logging. */
  raw: Record<string, unknown>;
}

interface TailscaleStatus {
  Self?: {
    HostName?: string;
    DNSName?: string;
    TailscaleIPs?: string[];
    Online?: boolean;
  };
  /** Modern (1.50+) location of the suffix. */
  MagicDNSSuffix?: string;
  /** Older releases nested it inside MagicDNS object. */
  MagicDNS?: {
    Suffix?: string;
    Enabled?: boolean;
  };
  CurrentTailnet?: {
    Name?: string;
    MagicDNSEnabled?: boolean;
    MagicDNSSuffix?: string;
  };
  BackendState?: string;
}

const TAILSCALE_CANDIDATES = [
  "tailscale",
  "/usr/bin/tailscale",
  "/usr/local/bin/tailscale",
  "/opt/homebrew/bin/tailscale",
  "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
];

/**
 * Try each known Tailscale CLI location until one succeeds. Returns parsed
 * status JSON, or `null` if Tailscale is not installed / not running / not
 * logged in.
 *
 * Total budget is bounded by `timeoutMs` across all candidates so we never
 * stall server startup.
 */
export async function detectTailscale(
  options: { timeoutMs?: number } = {}
): Promise<DetectedVpnPublicUrl | null> {
  const timeoutMs = options.timeoutMs ?? 1500;
  const deadline = Date.now() + timeoutMs;
  for (const cmd of TAILSCALE_CANDIDATES) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return null;
    const status = await runTailscaleStatus(cmd, remaining);
    if (!status) continue;
    const result = interpretTailscaleStatus(status);
    if (result) return result;
    // Found CLI but not in a usable state — no point trying other paths.
    return null;
  }
  return null;
}

export function interpretTailscaleStatus(status: TailscaleStatus): DetectedVpnPublicUrl | null {
  if (status.BackendState && status.BackendState !== "Running") return null;
  const self = status.Self;
  if (!self) return null;
  // Newer CLIs surface `Self.Online`. Older releases omitted it; treat
  // missing as "trust the BackendState=Running signal we already checked".
  if (self.Online === false) return null;
  const dnsName = self.DNSName?.replace(/\.$/, "");
  const magicSuffix = (
    status.MagicDNSSuffix ??
    status.CurrentTailnet?.MagicDNSSuffix ??
    status.MagicDNS?.Suffix ??
    ""
  ).replace(/^\.+|\.+$/g, "");
  const magicEnabled =
    status.CurrentTailnet?.MagicDNSEnabled !== false && status.MagicDNS?.Enabled !== false;
  const hostname =
    magicEnabled && dnsName && (!magicSuffix || dnsName.endsWith(magicSuffix)) ? dnsName : null;
  if (!hostname) return null;
  return {
    vendor: "tailscale",
    hostname,
    url: `https://${hostname}`,
    setupHint:
      "Make this hostname serve HTTPS — easiest is `sudo tailscale serve --bg https / " +
      "http://127.0.0.1:<gateway-port>` (run once, persists across reboots). " +
      "Requires the HTTPS feature in your tailnet admin console.",
    raw: {
      tailscaleIPs: self.TailscaleIPs,
      tailnet: status.CurrentTailnet?.Name,
      magicDNSEnabled: magicEnabled,
    },
  };
}

function runTailscaleStatus(cmd: string, timeoutMs: number): Promise<TailscaleStatus | null> {
  return new Promise((resolve) => {
    let stdout = "";
    let settled = false;
    const child = spawn(cmd, ["status", "--json"], {
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      resolve(null);
    }, timeoutMs);
    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.on("error", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(null);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        resolve(null);
        return;
      }
      try {
        const parsed = JSON.parse(stdout) as TailscaleStatus;
        resolve(parsed);
      } catch {
        resolve(null);
      }
    });
  });
}

/**
 * Top-level entry point: returns the first usable VPN public-URL candidate,
 * or null. Today this is just Tailscale. Add more probes (Cloudflare Tunnel,
 * Headscale, etc.) as further branches.
 */
export async function detectVpnPublicUrl(
  options: { timeoutMs?: number } = {}
): Promise<DetectedVpnPublicUrl | null> {
  return detectTailscale(options);
}
