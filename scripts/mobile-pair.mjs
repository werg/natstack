#!/usr/bin/env node
// Start a standalone NatStack server on a stable VPN/LAN-reachable gateway
// port and print a natstack://connect QR code for the Android app.

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { pickMobileHost, printConnectBanner } from "./mobile-connect-utils.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function parsePort(value, label) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${label} must be an integer from 1 to 65535`);
  }
  return port;
}

function parseArgs(argv) {
  const options = {
    host: process.env.NATSTACK_MOBILE_HOST ?? process.env.NATSTACK_DEV_HOST ?? "vpn",
    port: parsePort(process.env.NATSTACK_MOBILE_PORT ?? "3030", "NATSTACK_MOBILE_PORT"),
    protocol: process.env.NATSTACK_PROTOCOL ?? "http",
    workspace: null,
    workspaceDir: null,
    appRoot: null,
    publicUrl: process.env.NATSTACK_PUBLIC_URL ?? null,
    noInit: false,
    help: false,
    serverArgs: [],
  };

  const runnerFlags = new Set([
    "--host",
    "--port",
    "--gateway-port",
    "--protocol",
    "--workspace",
    "--workspace-dir",
    "--app-root",
    "--public-url",
    "--no-init",
    "--help",
  ]);

  let passthrough = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (passthrough) {
      options.serverArgs.push(arg);
      continue;
    }

    if (arg === "--") {
      if (runnerFlags.has(argv[i + 1])) continue;
      passthrough = true;
    } else if (arg === "--host") {
      options.host = argv[++i] ?? "";
    } else if (arg === "--port" || arg === "--gateway-port") {
      options.port = parsePort(argv[++i], arg);
    } else if (arg === "--protocol") {
      options.protocol = argv[++i] ?? "";
    } else if (arg === "--workspace") {
      options.workspace = argv[++i] ?? "";
    } else if (arg === "--workspace-dir") {
      options.workspaceDir = argv[++i] ?? "";
    } else if (arg === "--app-root") {
      options.appRoot = argv[++i] ?? "";
    } else if (arg === "--public-url") {
      options.publicUrl = argv[++i] ?? "";
    } else if (arg === "--no-init") {
      options.noInit = true;
    } else if (arg === "--help") {
      options.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (options.protocol !== "http" && options.protocol !== "https") {
    throw new Error("--protocol must be http or https");
  }

  return options;
}

function printHelp() {
  console.log(`mobile-pair

Usage:
  pnpm mobile:pair
  pnpm mobile:pair --host tailscale --port 3030
  pnpm mobile:pair --host 100.x.y.z --workspace my-workspace
  pnpm mobile:pair --host server.tailnet.ts.net --public-url http://server.tailnet.ts.net:3030

Options:
  --host <host|lan|tailscale|vpn>
      External hostname or address the phone can reach. Defaults to NATSTACK_MOBILE_HOST,
      then NATSTACK_DEV_HOST, then a VPN/Tailscale interface when available.
  --port, --gateway-port <port>
      Stable gateway port for HTTP/WS traffic. Defaults to NATSTACK_MOBILE_PORT or 3030.
  --protocol <http|https>
      URL protocol advertised to the phone. Defaults to http.
  --workspace <name>
      Workspace name to open or initialize.
  --workspace-dir <path>
      Explicit workspace directory.
  --app-root <path>
      Application root passed to the server.
  --public-url <url>
      Override the externally reachable URL used by OAuth/webhook routes.
  --no-init
      Do not auto-create the workspace from the template.
  --help
      Show this help message.

When invoking the script directly with node, everything after '--' is forwarded
to dist/server.mjs.
`);
}

function buildServerArgs(options, host) {
  const args = [
    "dist/server.mjs",
    "--host",
    host,
    "--gateway-port",
    String(options.port),
    "--protocol",
    options.protocol,
    "--serve-panels",
    "--print-token",
  ];

  if (!options.noInit) args.push("--init");
  if (options.workspace) args.push("--workspace", options.workspace);
  if (options.workspaceDir) args.push("--workspace-dir", options.workspaceDir);
  if (options.appRoot) args.push("--app-root", options.appRoot);
  if (options.publicUrl) args.push("--public-url", options.publicUrl);
  args.push(...options.serverArgs);
  return args;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const selectedHost = pickMobileHost(options.host, { defaultPreference: "vpn", includeTunnel: true });
  const serverArgs = buildServerArgs(options, selectedHost.address);

  console.log(`[mobile-pair] Host: ${selectedHost.address}${selectedHost.interfaceName ? ` (${selectedHost.interfaceName})` : ""}`);
  console.log(`[mobile-pair] Gateway port: ${options.port}`);
  console.log("[mobile-pair] Install the internal APK with: pnpm mobile:install:internal --launch\n");

  const child = spawn(process.execPath, serverArgs, {
    cwd: repoRoot,
    stdio: ["inherit", "pipe", "inherit"],
    env: {
      ...process.env,
      NATSTACK_HOST: selectedHost.address,
      NATSTACK_GATEWAY_PORT: String(options.port),
      NATSTACK_PROTOCOL: options.protocol,
    },
  });

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

      const gatewayMatch = line.match(/Gateway:\s+(\S+)/);
      if (gatewayMatch) gatewayUrl = gatewayMatch[1];
      const tokenMatch = line.match(/(?:NATSTACK_SHELL_TOKEN=|Shell token:\s+)([A-Za-z0-9_-]+)/);
      if (tokenMatch) shellToken = tokenMatch[1];

      if (!bannerPrinted && gatewayUrl && shellToken) {
        bannerPrinted = true;
        printConnectBanner({
          title: "NatStack Android pairing",
          gatewayUrl,
          shellToken,
        });
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

try {
  main();
} catch (error) {
  console.error(`[mobile-pair] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
