import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { pickMobileHost, printConnectBanner } from "./connect-utils.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function parsePort(value, label) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${label} must be an integer from 1 to 65535`);
  }
  return port;
}

export function parsePairArgs(argv, config) {
  const options = {
    host: firstDefined(config.hostEnv.map((key) => process.env[key])) ?? "vpn",
    port: parsePort(
      firstDefined(config.portEnv.map((key) => process.env[key])) ?? "3030",
      config.portEnv[0] ?? "NATSTACK_PAIR_PORT"
    ),
    protocol: process.env.NATSTACK_PROTOCOL ?? "http",
    workspace: null,
    workspaceDir: null,
    appRoot: null,
    publicUrl: process.env.NATSTACK_PUBLIC_URL ?? null,
    dev: process.env[config.devEnv] === "1",
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
    "--dev",
    "--ephemeral",
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
    } else if (arg === "--dev" || arg === "--ephemeral") {
      options.dev = true;
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
  if (options.dev && (options.workspace || options.workspaceDir)) {
    throw new Error("--dev cannot be combined with --workspace or --workspace-dir");
  }
  if (options.dev && options.noInit) {
    throw new Error("--dev cannot be combined with --no-init");
  }

  return options;
}

export function printPairHelp(config) {
  console.log(`${config.commandName}

If Tailscale is running and \`tailscale serve\` is configured (or can be configured —
the server attempts it automatically), the QR/deep link points at the MagicDNS
HTTPS URL and OAuth, panel chrome, and pairing all use the same URL. Otherwise
it falls back to the IP+HTTP gateway address.

Usage:
${config.usage.map((line) => `  ${line}`).join("\n")}

Options:
  --host <host|lan|tailscale|vpn>
      External hostname or address the device can reach. Defaults through:
      ${config.hostEnv.join(", ")}.
  --port, --gateway-port <port>
      Stable gateway port for HTTP/WS traffic. Defaults through ${config.portEnv.join(", ")} or 3030.
  --protocol <http|https>
      URL protocol advertised to the client. Defaults to http.
  --workspace <name>
      Workspace name to open or initialize.
  --workspace-dir <path>
      Explicit workspace directory.
  --app-root <path>
      Application root passed to the server.
  --public-url <url>
      Override the externally reachable URL used by OAuth/webhook routes.
  --dev, --ephemeral
      Use a disposable dev workspace copied fresh from the template and deleted
      when the server exits.
  --no-init
      Do not auto-create the workspace from the template.
  --help
      Show this help message.

When invoking the script directly with node, everything after '--' is forwarded
to dist/server.mjs.
`);
}

export function runPairServer(config, argv = process.argv.slice(2)) {
  const options = parsePairArgs(argv, config);
  if (options.help) {
    printPairHelp(config);
    return;
  }

  const selectedHost = pickMobileHost(options.host, {
    defaultPreference: "vpn",
    includeTunnel: true,
  });
  const serverArgs = buildServerArgs(options, selectedHost.address);

  console.log(
    `[${config.logPrefix}] Host: ${selectedHost.address}${selectedHost.interfaceName ? ` (${selectedHost.interfaceName})` : ""}`
  );
  console.log(`[${config.logPrefix}] Gateway port: ${options.port}`);
  if (options.dev) {
    console.log(`[${config.logPrefix}] Dev workspace: fresh template copy, deleted on exit`);
  }
  if (config.startupHint) console.log(`${config.startupHint}\n`);

  const child = spawn(process.execPath, serverArgs, {
    cwd: repoRoot,
    stdio: ["inherit", "pipe", "inherit"],
    env: {
      ...process.env,
      NATSTACK_HOST: selectedHost.address,
      NATSTACK_GATEWAY_PORT: String(options.port),
      NATSTACK_PROTOCOL: options.protocol,
      ...(options.dev ? { NODE_ENV: "development", NATSTACK_WORKSPACE_EPHEMERAL: "1" } : {}),
    },
  });

  let gatewayUrl = null;
  let mobileUrl = null;
  let pairingCode = null;
  let bannerPrinted = false;
  let buffer = "";
  let pendingServeActivationUrl = null;
  let publicUrlNotReachable = null;
  const serveActionLines = [];
  let pendingTimer = null;
  let waitElapsed = false;

  const printServeActionFollowup = () => {
    if (!pendingServeActivationUrl && !publicUrlNotReachable && serveActionLines.length === 0) {
      return;
    }
    const divider = "=".repeat(72);
    console.log(`\n${divider}`);
    console.log("  ACTION NEEDED — HTTPS pairing URL is not ready");
    console.log(divider);
    if (publicUrlNotReachable) console.log(`  Public URL: ${publicUrlNotReachable}`);
    if (pendingServeActivationUrl) {
      console.log("  Enable Tailscale Serve here:");
      console.log(`    ${pendingServeActivationUrl}`);
    }
    if (serveActionLines.length > 0) {
      for (const actionLine of serveActionLines) console.log(actionLine ? `  ${actionLine}` : "");
    } else {
      console.log("  NatStack found a Tailscale HTTPS name, but it is not usable yet.");
      console.log("  The QR above used the HTTP fallback instead.");
      console.log("");
      console.log("  Basic pairing may work, but mobile OAuth/browser redirects need");
      console.log("  the HTTPS Tailscale URL.");
    }
    console.log("");
    console.log(`  Then restart \`${config.restartCommand}\` to pick up the HTTPS URL.`);
    console.log(`${divider}\n`);
  };

  const tryPrintBanner = () => {
    if (bannerPrinted || !pairingCode || (!gatewayUrl && !mobileUrl)) return;
    if (!mobileUrl && !waitElapsed && pendingTimer === null) {
      pendingTimer = setTimeout(() => {
        pendingTimer = null;
        waitElapsed = true;
        tryPrintBanner();
      }, 500);
      return;
    }
    bannerPrinted = true;
    if (pendingTimer !== null) {
      clearTimeout(pendingTimer);
      pendingTimer = null;
    }
    printConnectBanner({
      title: config.bannerTitle,
      gatewayUrl: mobileUrl ?? gatewayUrl,
      pairingCode,
      deepLinkLabel: config.deepLinkLabel,
      instructions: config.instructions,
    });
    printServeActionFollowup();
  };

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    process.stdout.write(chunk);
    buffer += chunk;
    let newlineIdx;
    while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newlineIdx);
      buffer = buffer.slice(newlineIdx + 1);

      const mobileMatch = line.match(/Mobile URL:\s+(\S+)/);
      if (mobileMatch) mobileUrl = mobileMatch[1];
      const gatewayMatch = line.match(/Gateway:\s+(\S+)/);
      if (gatewayMatch) gatewayUrl = gatewayMatch[1];
      const publicUrlMatch = line.match(/Public URL:\s+(\S+).*\(not yet reachable/);
      if (publicUrlMatch) publicUrlNotReachable = publicUrlMatch[1];
      const pairingMatch = line.match(
        /(?:NATSTACK_PAIRING_CODE=|Pairing code:\s+)([A-Za-z0-9_-]+)/
      );
      if (pairingMatch) pairingCode = pairingMatch[1];
      const serveActivationMatch = line.match(/(https:\/\/login\.tailscale\.com\/f\/serve\?\S+)/);
      if (serveActivationMatch) pendingServeActivationUrl = serveActivationMatch[1];
      if (isServeActionLine(line)) {
        const cleaned = line.trim();
        if (
          cleaned &&
          !cleaned.startsWith("Tailscale:") &&
          !cleaned.startsWith("Persistent across reboots") &&
          !serveActionLines.includes(cleaned)
        ) {
          serveActionLines.push(cleaned);
        }
      }

      tryPrintBanner();
    }
  });

  child.on("exit", (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exit(code ?? 0);
  });

  for (const sig of ["SIGINT", "SIGTERM"]) {
    process.on(sig, () => child.kill(sig));
  }
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
    "--print-credentials",
  ];

  if (!options.noInit) args.push("--init");
  if (options.dev) args.push("--ephemeral");
  if (options.workspace) args.push("--workspace", options.workspace);
  if (options.workspaceDir) args.push("--workspace-dir", options.workspaceDir);
  if (options.appRoot) args.push("--app-root", options.appRoot);
  if (options.publicUrl) args.push("--public-url", options.publicUrl);
  args.push(...options.serverArgs);
  return args;
}

function firstDefined(values) {
  return values.find((value) => value !== undefined && value !== "");
}

function isServeActionLine(line) {
  return (
    line.includes("sudo tailscale") ||
    line.includes("tailscale serve reset") ||
    line.includes("tailscale serve status") ||
    line.includes("Tailscale Serve") ||
    line.includes("HTTPS Certificates") ||
    line.includes("HTTP fallback") ||
    line.includes("mobile OAuth") ||
    line.includes("configured but not reachable") ||
    line.includes("Last check:") ||
    line.includes("stale Serve target") ||
    line.includes("curl http://127.0.0.1")
  );
}
