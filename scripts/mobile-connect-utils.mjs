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

export function createConnectDeepLink(gatewayUrl, shellToken) {
  return `natstack://connect?url=${encodeURIComponent(gatewayUrl)}&token=${encodeURIComponent(shellToken)}`;
}

function isTailscaleAddress(address, name) {
  return /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(address) || /^tailscale/i.test(name);
}

function isVpnInterface(name) {
  return /^tailscale/i.test(name) || tunnelInterfacePattern.test(name);
}

function isLanAddress(address) {
  return /^192\.168\./.test(address)
    || /^10\./.test(address)
    || /^172\.(1[6-9]|2\d|3[01])\./.test(address);
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

  const effectivePreference = requested === "auto" ? (options.defaultPreference ?? "lan") : requested;
  const candidates = listIPv4Interfaces()
    .filter(({ name }) => !ignoredInterfacePattern.test(name))
    .filter(({ name }) => options.includeTunnel || !tunnelInterfacePattern.test(name))
    .map((iface) => ({
      ...iface,
      priority: scoreInterface(iface, effectivePreference),
    }))
    .sort((a, b) => a.priority - b.priority);

  if (candidates.length === 0) {
    throw new Error("Could not detect any non-internal IPv4 interface. Pass --host <vpn-ip-or-hostname>.");
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
  shellToken,
  instructions = "Open the QR code with the Android camera. NatStack will confirm and save the connection.",
}) {
  const deepLink = createConnectDeepLink(gatewayUrl, shellToken);
  const divider = "=".repeat(72);
  console.log(`\n${divider}`);
  console.log(`  ${title}`);
  console.log(divider);
  console.log(`  Gateway:    ${gatewayUrl}`);
  console.log(`  Shell tok:  ${shellToken}`);
  console.log(`  Deep link:  ${deepLink}`);
  console.log();
  qrcode.generate(deepLink, { small: true });
  console.log(divider);
  console.log(`  ${instructions}`);
  console.log(`${divider}\n`);
}
