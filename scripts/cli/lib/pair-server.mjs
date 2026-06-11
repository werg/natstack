import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pickMobileHost, printConnectBanner } from "./connect-utils.mjs";
import { createServerInvocation, serverEntryArg, serverEntryDescription } from "./server-entry.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

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
    requirePublicUrl: false,
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
    "--require-public-url",
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
    } else if (arg === "--require-public-url") {
      options.requirePublicUrl = true;
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

If Tailscale is running and \`tailscale serve --bg <port>\` has been configured
on the server, the QR/deep link points at the MagicDNS HTTPS URL and OAuth,
panel chrome, and pairing all use the same URL. Otherwise it falls back to the
IP+HTTP gateway address. Explicit \`--host tailscale\` requires the Tailscale
HTTPS URL and exits if it cannot be verified.

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
  --require-public-url
      Exit nonzero unless the server can advertise a verified public URL.
      This is implied by --host tailscale.
  --dev, --ephemeral
      Use a disposable dev workspace copied fresh from the template and deleted
      when the server exits.
  --no-init
      Do not auto-create the workspace from the template.
  --help
      Show this help message.

${config.additionalHelp ? `${config.additionalHelp}\n\n` : ""}\
When invoking the script directly with node, everything after '--' is forwarded
to ${serverEntryDescription()}.
`);
}

export function runPairServer(config, argv = process.argv.slice(2), hooks = {}) {
  const options = parsePairArgs(argv, config);
  if (options.help) {
    printPairHelp(config);
    return;
  }

  const selectedHost = pickMobileHost(options.host, {
    defaultPreference: "vpn",
    includeTunnel: true,
  });
  const requirePublicUrl = options.requirePublicUrl || options.host === "tailscale";
  let serverArgs = hooks.buildServerArgs
    ? hooks.buildServerArgs(options, selectedHost.address)
    : buildServerArgs(options, selectedHost.address, config);
  let ownedReadyDir = null;
  let readyFile = readyFileFromServerArgs(serverArgs);
  if (!readyFile) {
    ownedReadyDir = fs.mkdtempSync(path.join(os.tmpdir(), "natstack-pair-"));
    readyFile = path.join(ownedReadyDir, "ready.json");
    serverArgs = [...serverArgs, "--ready-file", readyFile];
  }

  hooks.beforeStart?.({ options, selectedHost, requirePublicUrl, serverArgs });

  console.log(
    `[${config.logPrefix}] Host: ${selectedHost.address}${selectedHost.interfaceName ? ` (${selectedHost.interfaceName})` : ""}`
  );
  console.log(`[${config.logPrefix}] Gateway port: ${options.port}`);
  if (requirePublicUrl) {
    console.log(`[${config.logPrefix}] Tailscale HTTPS pairing URL required`);
  }
  if (options.dev) {
    console.log(`[${config.logPrefix}] Dev workspace: fresh template copy, deleted on exit`);
  }
  if (config.startupHint) console.log(`${config.startupHint}\n`);

  let child = null;
  let restarting = false;
  let buffer = "";
  let stderrBuffer = "";
  const stderrLines = [];
  let strictPublicUrlFailure = false;
  let hasSpawned = false;
  const baseEnv = {
    ...process.env,
    NATSTACK_HOST: selectedHost.address,
    NATSTACK_GATEWAY_PORT: String(options.port),
    NATSTACK_PROTOCOL: options.protocol,
    ...(requirePublicUrl ? { NATSTACK_REQUIRE_PUBLIC_URL: "1" } : {}),
    ...(options.dev ? { NODE_ENV: "development", NATSTACK_WORKSPACE_EPHEMERAL: "1" } : {}),
  };
  const env = hooks.buildEnv
    ? hooks.buildEnv(baseEnv, { options, selectedHost, requirePublicUrl, serverArgs })
    : baseEnv;

  let gatewayUrl = null;
  let mobileUrl = null;
  let pairingCode = null;
  let qrPairingCode = null;
  let bannerPrinted = false;
  let pendingServeActivationUrl = null;
  let publicUrlNotReachable = null;
  const serveActionLines = [];
  let pendingTimer = null;
  let qrPendingTimer = null;
  let waitElapsed = false;
  let qrWaitElapsed = false;
  let readyPoll = null;
  let readyPollStartedAt = 0;

  const cleanupReadyState = () => {
    if (readyPoll !== null) {
      clearInterval(readyPoll);
      readyPoll = null;
    }
    if (pendingTimer !== null) {
      clearTimeout(pendingTimer);
      pendingTimer = null;
    }
    if (qrPendingTimer !== null) {
      clearTimeout(qrPendingTimer);
      qrPendingTimer = null;
    }
    if (ownedReadyDir) {
      try {
        fs.rmSync(ownedReadyDir, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup only.
      }
    }
  };

  const spawnChild = () => {
    buffer = "";
    stderrBuffer = "";
    if (hasSpawned) {
      gatewayUrl = null;
      mobileUrl = null;
      pairingCode = null;
      qrPairingCode = null;
      bannerPrinted = false;
      waitElapsed = false;
      qrWaitElapsed = false;
      if (ownedReadyDir) {
        try {
          fs.unlinkSync(readyFile);
        } catch {
          // It may not have been written yet.
        }
      }
      if (pendingTimer !== null) {
        clearTimeout(pendingTimer);
        pendingTimer = null;
      }
      if (qrPendingTimer !== null) {
        clearTimeout(qrPendingTimer);
        qrPendingTimer = null;
      }
    }
    hasSpawned = true;
    const invocation = createServerInvocation(serverArgs);
    child = hooks.spawnServer
      ? hooks.spawnServer({ serverArgs, env, repoRoot, invocation })
      : spawn(invocation.command, invocation.args, {
          cwd: repoRoot,
          stdio: ["inherit", "pipe", "inherit"],
          env,
        });
    wireChild(child);
    startReadyPoll();
    return child;
  };

  const applyReadyPayload = (payload) => {
    if (typeof payload?.connectUrl === "string" && payload.connectUrl) {
      mobileUrl = payload.connectUrl;
    } else if (typeof payload?.publicUrl === "string" && payload.publicUrl) {
      mobileUrl = payload.publicUrl;
    } else if (typeof payload?.gatewayUrl === "string" && payload.gatewayUrl) {
      gatewayUrl = payload.gatewayUrl;
    }
    if (typeof payload?.pairingCode === "string" && payload.pairingCode) {
      pairingCode = payload.pairingCode;
    }
    if (typeof payload?.qrPairingCode === "string" && payload.qrPairingCode) {
      qrPairingCode = payload.qrPairingCode;
    } else if (typeof payload?.pairingCodes?.qr === "string" && payload.pairingCodes.qr) {
      qrPairingCode = payload.pairingCodes.qr;
    } else if (typeof payload?.pairingCodes?.mobile === "string" && payload.pairingCodes.mobile) {
      qrPairingCode = payload.pairingCodes.mobile;
    }
    tryPrintBanner();
  };

  const startReadyPoll = () => {
    if (readyPoll !== null) clearInterval(readyPoll);
    readyPollStartedAt = Date.now();
    readyPoll = setInterval(() => {
      try {
        const stat = fs.statSync(readyFile);
        if (stat.mtimeMs < readyPollStartedAt - 1) return;
        const text = fs.readFileSync(readyFile, "utf8");
        applyReadyPayload(JSON.parse(text));
        if (bannerPrinted) {
          clearInterval(readyPoll);
          readyPoll = null;
        }
      } catch {
        // The server writes readiness after startup settles; stdout remains a fallback.
      }
    }, 100);
  };

  const printServeActionFollowup = () => {
    if (
      requirePublicUrl ||
      (!pendingServeActivationUrl && !publicUrlNotReachable && serveActionLines.length === 0)
    ) {
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
    if (!qrPairingCode && !qrWaitElapsed && qrPendingTimer === null) {
      qrPendingTimer = setTimeout(() => {
        qrPendingTimer = null;
        qrWaitElapsed = true;
        tryPrintBanner();
      }, 100);
      return;
    }
    if (requirePublicUrl && !mobileUrl) {
      strictPublicUrlFailure = true;
      const divider = "=".repeat(72);
      console.error(`\n${divider}`);
      console.error("  ERROR — Required Tailscale HTTPS pairing URL is not ready");
      console.error(divider);
      if (publicUrlNotReachable) console.error(`  Public URL: ${publicUrlNotReachable}`);
      console.error("  Refusing to print an HTTP fallback pairing QR for --host tailscale.");
      console.error("");
      console.error("  Fix Tailscale Serve, then restart this command:");
      console.error(`    ${config.restartCommand}`);
      console.error(`${divider}\n`);
      child?.kill("SIGTERM");
      return;
    }
    bannerPrinted = true;
    if (pendingTimer !== null) {
      clearTimeout(pendingTimer);
      pendingTimer = null;
    }
    if (qrPendingTimer !== null) {
      clearTimeout(qrPendingTimer);
      qrPendingTimer = null;
    }
    printConnectBanner({
      title: config.bannerTitle,
      gatewayUrl: mobileUrl ?? gatewayUrl,
      pairingCode,
      qrPairingCode,
      deepLinkLabel: config.deepLinkLabel,
      clientCommandLabel: config.clientCommandLabel,
      instructions: config.instructions,
    });
    printServeActionFollowup();
  };

  const control = {
    get child() {
      return child;
    },
    get options() {
      return options;
    },
    get selectedHost() {
      return selectedHost;
    },
    get requirePublicUrl() {
      return requirePublicUrl;
    },
    get serverArgs() {
      return serverArgs;
    },
    get env() {
      return env;
    },
    async restart(beforeRestart) {
      if (restarting) return false;
      restarting = true;
      try {
        await beforeRestart?.();
        await new Promise((resolve) => {
          const current = child;
          if (!current || current.killed) {
            resolve(undefined);
            return;
          }
          let done = false;
          const finish = () => {
            if (done) return;
            done = true;
            clearTimeout(termTimer);
            clearTimeout(killTimer);
            resolve(undefined);
          };
          const termTimer = setTimeout(() => {
            current.kill("SIGKILL");
          }, hooks.shutdownTimeoutMs ?? 5_000);
          const killTimer = setTimeout(finish, (hooks.shutdownTimeoutMs ?? 5_000) + 2_000);
          current.once("exit", finish);
          current.kill("SIGTERM");
        });
        restarting = false;
        spawnChild();
        return true;
      } catch (error) {
        restarting = false;
        hooks.onRestartError?.(error, control);
        return false;
      }
    },
  };

  const handleLine = (line) => {
    const handled = hooks.onServerLine?.(line, control);
    if (handled) return;
    if (hooks.onServerLine) process.stdout.write(`${line}\n`);

    const mobileMatch = line.match(/Mobile URL:\s+(\S+)/);
    if (mobileMatch) mobileUrl = mobileMatch[1];
    const gatewayMatch = line.match(/Gateway:\s+(\S+)/);
    if (gatewayMatch) gatewayUrl = gatewayMatch[1];
    const publicUrlMatch = line.match(/Public URL:\s+(\S+).*\(not yet reachable/);
    if (publicUrlMatch) publicUrlNotReachable = publicUrlMatch[1];
    const pairingMatch = line.match(/(?:NATSTACK_PAIRING_CODE=|Pairing code:\s+)([A-Za-z0-9_-]+)/);
    if (pairingMatch) pairingCode = pairingMatch[1];
    const qrPairingMatch = line.match(
      /(?:NATSTACK_QR_PAIRING_CODE=|QR pairing code:\s+)([A-Za-z0-9_-]+)/
    );
    if (qrPairingMatch) qrPairingCode = qrPairingMatch[1];
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
  };

  const wireChild = (childProcess) => {
    childProcess.stdout?.setEncoding("utf8");
    childProcess.stdout?.on("data", (chunk) => {
      if (!hooks.onServerLine) process.stdout.write(chunk);
      buffer += chunk;
      let newlineIdx;
      while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newlineIdx);
        buffer = buffer.slice(newlineIdx + 1);
        handleLine(line);
      }
    });
    childProcess.stderr?.on("data", (chunk) => {
      process.stderr.write(chunk);
      stderrBuffer += chunk;
      let newlineIdx;
      while ((newlineIdx = stderrBuffer.indexOf("\n")) !== -1) {
        const line = stderrBuffer.slice(0, newlineIdx);
        stderrBuffer = stderrBuffer.slice(newlineIdx + 1);
        stderrLines.push(line);
        if (stderrLines.length > 50) stderrLines.shift();
      }
    });

    childProcess.on("exit", (code, signal) => {
      if (restarting) return;
      cleanupReadyState();
      if (stderrBuffer) stderrLines.push(stderrBuffer);
      if (hooks.onChildExit?.({ code, signal, strictPublicUrlFailure, stderrLines }, control))
        return;
      if (strictPublicUrlFailure) process.exit(1);
      if (signal) process.kill(process.pid, signal);
      else process.exit(code ?? 0);
    });
  };

  spawnChild();

  for (const sig of ["SIGINT", "SIGTERM"]) {
    process.on(sig, () => {
      cleanupReadyState();
      child?.kill(sig);
    });
  }
}

function buildServerArgs(options, host, config = {}) {
  const args = [
    serverEntryArg(),
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
  if (config.interactiveStartupApproval) args.push("--interactive-startup-approval");
  if (config.requireMobileReady) args.push("--require-mobile-ready");
  if (config.requireElectronReady) args.push("--require-electron-ready");
  args.push(...options.serverArgs);
  return args;
}

function readyFileFromServerArgs(args) {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--ready-file") return args[i + 1] ?? null;
    if (arg.startsWith("--ready-file=")) return arg.slice("--ready-file=".length) || null;
  }
  return null;
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
