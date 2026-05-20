import os from "node:os";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const qrcode = require("qrcode-terminal");

const ignoredInterfacePattern = /^(docker|br-|veth|virbr)/i;
const tunnelInterfacePattern = /^(tun\d|tap\d|wg\d|utun\d)/i;

export function listIPv4Interfaces() {
  const out = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces() ?? {})) {
    for (const addr of addrs ?? []) {
      if (addr.family !== "IPv4" || addr.internal) continue;
      out.push({ name, address: addr.address });
    }
  }
  return out;
}

export function createConnectDeepLink(gatewayUrl, pairingCode) {
  return `natstack://connect?url=${encodeURIComponent(gatewayUrl)}&code=${encodeURIComponent(pairingCode)}`;
}

export function parseConnectLink(rawUrl) {
  if (typeof rawUrl !== "string") return { kind: "error", reason: "Deep link must be a string" };
  let deepLink;
  try {
    deepLink = new URL(rawUrl);
  } catch {
    return { kind: "error", reason: "Deep link is not a valid URL" };
  }
  if (deepLink.protocol !== "natstack:" || deepLink.hostname !== "connect") {
    return { kind: "error", reason: "Not a natstack://connect link" };
  }
  const serverUrlRaw = deepLink.searchParams.get("url");
  const code = deepLink.searchParams.get("code");
  if (!serverUrlRaw || !code) {
    return { kind: "error", reason: "Deep link is missing `url` or `code`" };
  }
  const parsedUrl = parseConnectServerUrl(serverUrlRaw);
  if (parsedUrl.kind === "error") return parsedUrl;
  if (!/^[A-Za-z0-9_-]{16,512}$/.test(code)) {
    return { kind: "error", reason: "Pairing code has an unexpected format" };
  }
  return { kind: "ok", url: parsedUrl.url, code };
}

function parseConnectServerUrl(rawUrl) {
  let server;
  try {
    server = new URL(rawUrl);
  } catch {
    return { kind: "error", reason: `Server URL is not parseable: ${rawUrl}` };
  }
  if (server.protocol !== "http:" && server.protocol !== "https:") {
    return {
      kind: "error",
      reason: `Server URL must use http:// or https:// (got ${server.protocol || "no scheme"})`,
    };
  }
  if (!server.hostname) return { kind: "error", reason: "Server URL is missing a hostname" };
  if (server.protocol === "http:" && !isTrustedCleartextHost(server.hostname)) {
    return {
      kind: "error",
      reason: `Cleartext HTTP is only allowed for loopback, private LAN, Tailscale, or local hostnames. Use https:// for ${server.hostname}.`,
    };
  }
  return { kind: "ok", url: `${server.protocol}//${server.host}` };
}

function isTrustedCleartextHost(host) {
  const lower = host.toLowerCase();
  if (lower === "localhost" || lower === "10.0.2.2") return true;
  if (/^127\./.test(lower)) return true;
  if (/^10\./.test(lower)) return true;
  const m172 = lower.match(/^172\.(\d+)\./);
  if (m172) {
    const octet = Number(m172[1]);
    if (octet >= 16 && octet <= 31) return true;
  }
  if (/^192\.168\./.test(lower)) return true;
  const m100 = lower.match(/^100\.(\d+)\./);
  if (m100) {
    const octet = Number(m100[1]);
    if (octet >= 64 && octet <= 127) return true;
  }
  if (lower === "ts.net" || lower.endsWith(".ts.net")) return true;
  if (/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(lower)) return true;
  return lower.endsWith(".local");
}

function isTailscaleAddress(address, name) {
  return /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(address) || /^tailscale/i.test(name);
}

function isVpnInterface(name) {
  return /^tailscale/i.test(name) || tunnelInterfacePattern.test(name);
}

function isLanAddress(address) {
  return (
    /^192\.168\./.test(address) ||
    /^10\./.test(address) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(address)
  );
}

function scoreInterface({ name, address }, preference) {
  const isTailscale = isTailscaleAddress(address, name);
  const isVpn = isVpnInterface(name);
  const isLan = isLanAddress(address);

  if (preference === "tailscale" || preference === "vpn") {
    if (isTailscale || (preference === "vpn" && isVpn)) return 0;
    if (isLan) return /^192\.168\./.test(address) ? 3 : 4;
    return 8;
  }

  if (/^192\.168\./.test(address)) return 1;
  if (/^10\./.test(address)) return 2;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(address)) return 3;
  if (isTailscale) return 4;
  return 8;
}

export function pickMobileHost(preference, options = {}) {
  const requested = preference ?? options.defaultPreference ?? "lan";
  if (!["auto", "lan", "tailscale", "vpn"].includes(requested)) {
    return { address: requested, source: "explicit", interfaceName: null, candidates: [] };
  }

  const effectivePreference =
    requested === "auto" ? (options.defaultPreference ?? "lan") : requested;
  const candidates = listIPv4Interfaces()
    .filter(({ name }) => !ignoredInterfacePattern.test(name))
    .filter(({ name }) => options.includeTunnel || !tunnelInterfacePattern.test(name))
    .map((iface) => ({
      ...iface,
      priority: scoreInterface(iface, effectivePreference),
    }))
    .sort((a, b) => a.priority - b.priority);

  if (candidates.length === 0) {
    throw new Error(
      "Could not detect any non-internal IPv4 interface. Pass --host <vpn-ip-or-hostname>."
    );
  }

  const selected = candidates[0];
  return {
    address: selected.address,
    source: effectivePreference,
    interfaceName: selected.name,
    candidates,
  };
}

export function printConnectBanner({
  title,
  gatewayUrl,
  pairingCode,
  deepLinkLabel = "Deep link",
  instructions = "Open the QR code with the Android camera. NatStack will confirm and save the connection.",
}) {
  const deepLink = createConnectDeepLink(gatewayUrl, pairingCode);
  const divider = "=".repeat(72);
  console.log(`\n${divider}`);
  console.log(`  ${title}`);
  console.log(divider);
  console.log(`  Gateway:    ${gatewayUrl}`);
  console.log(`  Pair code:  ${pairingCode}`);
  console.log(`  ${deepLinkLabel}:  ${deepLink}`);
  console.log();
  qrcode.generate(deepLink, { small: true });
  console.log(divider);
  console.log(`  ${instructions}`);
  console.log(`${divider}\n`);
}
