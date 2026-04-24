#!/usr/bin/env node
// Start a dev server bound to the LAN so a phone on the same Wi-Fi can reach
// it, then print a `natstack://connect?url=…&token=…` deep link as a QR code
// that the mobile client picks up via its URL-scheme intent filter.
//
// Usage:
//   pnpm dev:mobile-server
//   NATSTACK_DEV_HOST=<ip> pnpm dev:mobile-server    # override auto-detected IP
//   NATSTACK_DEV_HOST=tailscale pnpm dev:mobile-server  # prefer tailscale IP

import os from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const qrcode = require("qrcode-terminal");

function listIPv4Interfaces() {
  const out = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces() ?? {})) {
    for (const addr of addrs ?? []) {
      if (addr.family !== "IPv4" || addr.internal) continue;
      out.push({ name, address: addr.address });
    }
  }
  return out;
}

function pickHost() {
  const override = process.env.NATSTACK_DEV_HOST;
  const ifaces = listIPv4Interfaces();

  if (override && override !== "tailscale" && override !== "lan") {
    return override;
  }

  const scored = ifaces
    .filter(({ name }) => !/^(docker|br-|veth|virbr|tun\d|tap\d)/i.test(name))
    .map(({ name, address }) => {
      // Lower score wins.
      let priority = 9;
      const isTailscale = /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(address)
        || /^tailscale/i.test(name);
      const isLan = /^192\.168\./.test(address)
        || /^10\./.test(address)
        || /^172\.(1[6-9]|2\d|3[01])\./.test(address);

      if (override === "tailscale") {
        priority = isTailscale ? 0 : 5;
      } else {
        // Default: prefer LAN (192.168 > 10.x > 172.16), tailscale as fallback.
        if (/^192\.168\./.test(address)) priority = 1;
        else if (/^10\./.test(address)) priority = 2;
        else if (/^172\.(1[6-9]|2\d|3[01])\./.test(address)) priority = 3;
        else if (isTailscale) priority = 4;
      }
      return { name, address, priority, isTailscale, isLan };
    })
    .sort((a, b) => a.priority - b.priority);

  if (scored.length === 0) {
    throw new Error("Could not detect any non-internal IPv4 interface. Set NATSTACK_DEV_HOST=<ip>.");
  }
  return scored[0].address;
}

function printBanner(gatewayUrl, shellToken) {
  const deepLink = `natstack://connect?url=${encodeURIComponent(gatewayUrl)}&token=${encodeURIComponent(shellToken)}`;
  const divider = "=".repeat(66);
  console.log(`\n${divider}`);
  console.log("  NatStack mobile dev server");
  console.log(divider);
  console.log(`  Gateway:    ${gatewayUrl}`);
  console.log(`  Shell tok:  ${shellToken}`);
  console.log(`  Deep link:  ${deepLink}`);
  console.log();
  qrcode.generate(deepLink, { small: true });
  console.log(divider);
  console.log("  Point the Pixel camera at the QR code above, tap the");
  console.log("  notification, and the app will auto-connect.");
  console.log(`${divider}\n`);
}

function main() {
  const host = pickHost();
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

  console.log(`[dev-mobile-server] Binding server to ${host}`);
  console.log("[dev-mobile-server] Override with NATSTACK_DEV_HOST=<ip|tailscale>\n");

  const child = spawn(
    process.execPath,
    ["dist/server.mjs", "--host", host, "--serve-panels", "--init", "--print-token"],
    {
      cwd: repoRoot,
      stdio: ["inherit", "pipe", "inherit"],
      env: { ...process.env, NODE_ENV: "development" },
    },
  );

  let gatewayUrl = null;
  let shellToken = null;
  let bannerPrinted = false;
  let buffer = "";

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    process.stdout.write(chunk);
    buffer += chunk;
    let newlineIdx;
    while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newlineIdx);
      buffer = buffer.slice(newlineIdx + 1);

      const gMatch = line.match(/Gateway:\s+(\S+)/);
      if (gMatch) gatewayUrl = gMatch[1];
      const tMatch = line.match(/(?:NATSTACK_SHELL_TOKEN=|Shell token:\s+)([A-Za-z0-9_-]+)/);
      if (tMatch) shellToken = tMatch[1];

      if (!bannerPrinted && gatewayUrl && shellToken) {
        bannerPrinted = true;
        printBanner(gatewayUrl, shellToken);
      }
    }
  });

  child.on("exit", (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exit(code ?? 0);
  });

  const forward = (sig) => {
    process.on(sig, () => {
      child.kill(sig);
    });
  };
  forward("SIGINT");
  forward("SIGTERM");
}

main();
