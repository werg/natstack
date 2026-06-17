#!/usr/bin/env node
// End-to-end desktop pairing smoke. Starts a disposable server, redeems the
// pairing code as a desktop device, launches Electron against the paired remote
// server, approves the Electron host-target launch gate, and verifies that the
// hosted desktop shell loads over the selected network path.

import fsp from "node:fs/promises";
import fs from "node:fs";
import net from "node:net";
import tls from "node:tls";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "@playwright/test";
import {
  createServerInvocation,
  serverEntryArg,
  serverEntryDescription,
} from "./cli/lib/server-entry.mjs";
import { createConnectDeepLink, pickMobileHost } from "./cli/lib/connect-utils.mjs";

const require = createRequire(import.meta.url);
const electronBinary = require("electron");

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const mainPath = path.join(repoRoot, "dist", "main.cjs");
const defaultReadyFile = path.join(os.tmpdir(), `natstack-desktop-smoke-ready-${process.pid}.json`);
const screenshotDir = path.join(repoRoot, "test-results", "desktop-pairing-smoke");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseArgs(argv) {
  const options = {
    network: "tailscale",
    timeoutMs: 420_000,
    launchTimeoutMs: 180_000,
    readyFile: defaultReadyFile,
    serverArgs: [],
    help: false,
  };

  let passthrough = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (passthrough) {
      options.serverArgs.push(arg);
    } else if (arg === "--") {
      passthrough = true;
    } else if (arg === "--network") {
      options.network = parseNetwork(argv[++i]);
    } else if (arg === "--tailscale") {
      options.network = "tailscale";
    } else if (arg === "--timeout-ms") {
      options.timeoutMs = parsePositiveInt(argv[++i], "--timeout-ms");
    } else if (arg === "--launch-timeout-ms") {
      options.launchTimeoutMs = parsePositiveInt(argv[++i], "--launch-timeout-ms");
    } else if (arg === "--ready-file") {
      options.readyFile = path.resolve(argv[++i] ?? "");
    } else if (arg === "--help") {
      options.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function parseNetwork(value) {
  if (value === "local" || value === "tailscale") return value;
  throw new Error("--network must be local or tailscale");
}

function parsePositiveInt(value, label) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
}

function printHelp() {
  console.log(`natstack desktop pairing smoke

Usage:
  node scripts/desktop-pairing-smoke.mjs [runner options] [-- server options]

Runner options:
  --network <mode>          Pair and launch through local HTTP or Tailscale HTTPS.
                            Values: local, tailscale. Defaults to tailscale.
  --tailscale               Alias for --network tailscale.
  --timeout-ms <ms>         Time to wait for server readiness. Defaults to 420000.
  --launch-timeout-ms <ms>  Time to wait for Electron launch and shell load.
                            Defaults to 180000.
  --ready-file <path>       Server ready-file path. Defaults to an OS temp path.
  --help                    Show this help message.

Everything after '--' is forwarded to ${serverEntryDescription()}.

The smoke starts a disposable server, redeems its pairing code as a desktop
device, launches Electron with NATSTACK_REMOTE_URL/DEVICE_ID/REFRESH_TOKEN, then
clicks the bootstrap launch approval and asserts the hosted shell loads.
`);
}

function prefixAndWrite(prefix, text, stream) {
  for (const line of text.split(/\r?\n/)) {
    if (!line) continue;
    stream.write(`[${prefix}] ${line}\n`);
  }
}

function spawnManaged(command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: options.cwd ?? repoRoot,
    env: options.env ?? process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (chunk) =>
    prefixAndWrite(options.label ?? command, chunk.toString(), process.stdout)
  );
  child.stderr?.on("data", (chunk) =>
    prefixAndWrite(options.label ?? command, chunk.toString(), process.stderr)
  );
  child.once("error", (error) => {
    prefixAndWrite(
      options.label ?? command,
      `Failed to start ${command}: ${error.message}`,
      process.stderr
    );
  });
  return child;
}

function waitForSpawn(child, command, args, timeoutMs = 1_000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off("spawn", onSpawn);
      child.off("error", onError);
      if (error) reject(error);
      else resolve();
    };
    const onSpawn = () => finish();
    const onError = (error) => finish(error);
    const timer = setTimeout(() => finish(), timeoutMs);
    child.once("spawn", onSpawn);
    child.once("error", onError);
    if (child.pid) finish();
    if (child.exitCode != null)
      finish(new Error(`${command} ${args.join(" ")} exited before startup`));
  });
}

function waitForChildExit(child, timeoutMs = 8_000) {
  if (!child || child.exitCode != null) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function waitForServerReady(readyFile, serverChild, timeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (serverChild.exitCode != null) {
      throw new Error(`Server exited before readiness (code ${serverChild.exitCode})`);
    }
    try {
      const content = await fsp.readFile(readyFile, "utf8");
      return JSON.parse(content);
    } catch {
      await sleep(250);
    }
  }
  throw new Error(`Timed out waiting for server ready file: ${readyFile}`);
}

function createServerArgs(options, readyFilePath) {
  const args = [
    serverEntryArg(),
    "--app-root",
    repoRoot,
    "--ready-file",
    readyFilePath,
    "--ephemeral",
    "--serve-panels",
    "--print-credentials",
  ];

  if (options.network === "tailscale") {
    const selectedHost = pickMobileHost("tailscale", { includeTunnel: true });
    console.log(
      `[desktop-smoke] Tailscale host: ${selectedHost.address}` +
        (selectedHost.interfaceName ? ` (${selectedHost.interfaceName})` : "")
    );
    args.push("--host", selectedHost.address, "--gateway-port", "3030", "--require-public-url");
  } else {
    args.push("--host", "127.0.0.1", "--bind-host", "127.0.0.1", "--no-vpn-detect");
  }

  args.push(...options.serverArgs);
  return args;
}

function assertTailscaleReady(ready) {
  const connectUrl = ready.connectUrl || "";
  if (!connectUrl.startsWith("https://")) {
    throw new Error(
      `Tailscale smoke requires an HTTPS connectUrl, but server advertised: ` +
        `${connectUrl || "(none)"}`
    );
  }
}

async function waitForTcpReachable(rawUrl, timeoutMs = 45_000) {
  const endpoint = tcpEndpointForUrl(rawUrl);
  const deadlineMs = Date.now() + timeoutMs;
  let lastError = "not attempted";
  while (Date.now() < deadlineMs) {
    try {
      await openTcp(endpoint);
      console.log(
        `[desktop-smoke] Desktop can open ${endpoint.host}:${endpoint.port} over ${endpoint.protocol}`
      );
      return;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      await sleep(1_000);
    }
  }
  throw new Error(
    `Desktop could not open ${endpoint.host}:${endpoint.port} for ${rawUrl}. ` +
      `Check Tailscale Serve, DNS, Tailnet ACLs, and host firewall rules. ` +
      `Last TCP error: ${lastError}`
  );
}

function tcpEndpointForUrl(rawUrl) {
  const parsed = new URL(rawUrl);
  const protocol = parsed.protocol.replace(/:$/, "");
  const port = parsed.port
    ? Number(parsed.port)
    : parsed.protocol === "https:"
      ? 443
      : parsed.protocol === "http:"
        ? 80
        : null;
  if (!parsed.hostname || !port) {
    throw new Error(`Cannot derive TCP endpoint from URL: ${rawUrl}`);
  }
  return { protocol, host: parsed.hostname, port };
}

function openTcp(endpoint) {
  return new Promise((resolve, reject) => {
    const socket =
      endpoint.protocol === "https"
        ? tls.connect({
            host: endpoint.host,
            port: endpoint.port,
            servername: endpoint.host,
            rejectUnauthorized: false,
          })
        : net.connect({ host: endpoint.host, port: endpoint.port });
    const timer = setTimeout(() => {
      socket.destroy(new Error("TCP connect timed out"));
    }, 5_000);
    socket.once(endpoint.protocol === "https" ? "secureConnect" : "connect", () => {
      clearTimeout(timer);
      socket.end();
      resolve();
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function postJson(url, pathName, body, token) {
  const res = await fetch(`${url}${pathName}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`${pathName} failed ${res.status}: ${JSON.stringify(json)}`);
  return json;
}

async function pairDesktopDevice(ready) {
  const url = ready.connectUrl || ready.gatewayUrl;
  const code = ready.pairingCode || ready.pairingCodes?.desktop;
  if (!url) throw new Error("Server ready file did not include a pairing URL");
  if (!code) throw new Error("Server ready file did not include a desktop pairing code");
  const deepLink = createConnectDeepLink(url, code);
  console.log(`[desktop-smoke] Pair URL: ${deepLink}`);
  const issued = await postJson(url, "/_r/s/auth/complete-pairing", {
    code,
    label: `Desktop smoke on ${os.hostname()}`,
    platform: "desktop",
  });
  if (typeof issued.deviceId !== "string" || typeof issued.refreshToken !== "string") {
    throw new Error("Pairing response did not include a device refresh credential");
  }
  console.log(`[desktop-smoke] Paired desktop device ${issued.deviceId}`);
  return { url, deviceId: issued.deviceId, refreshToken: issued.refreshToken };
}

function hasElectronDisplay() {
  if (process.platform !== "linux") return true;
  return Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
}

async function launchDesktopApp(creds, tempRoot, launchTimeoutMs) {
  if (!fs.existsSync(mainPath)) {
    throw new Error(`Electron main entry not found at ${mainPath}. Run pnpm build first.`);
  }
  if (!hasElectronDisplay()) {
    throw new Error(
      "Desktop pairing smoke requires an X11 or Wayland display. Run it from a desktop session or under xvfb-run."
    );
  }

  const env = {
    ...process.env,
    NODE_ENV: "development",
    NATSTACK_TEST_MODE: "1",
    NATSTACK_REMOTE_URL: creds.url,
    NATSTACK_REMOTE_DEVICE_ID: creds.deviceId,
    NATSTACK_REMOTE_REFRESH_TOKEN: creds.refreshToken,
    ELECTRON_DISABLE_GPU: "1",
    ELECTRON_DISABLE_SANDBOX: "1",
    HOME: path.join(tempRoot, "home"),
    XDG_CONFIG_HOME: path.join(tempRoot, "xdg"),
  };
  delete env.NATSTACK_REMOTE_TOKEN;
  delete env.NATSTACK_REMOTE_CA;
  delete env.NATSTACK_REMOTE_FINGERPRINT;

  await fsp.mkdir(env.HOME, { recursive: true });
  await fsp.mkdir(env.XDG_CONFIG_HOME, { recursive: true });

  const userDataDir = path.join(tempRoot, "electron-user-data");
  console.log(`[desktop-smoke] Launching Electron against ${creds.url}`);
  const app = await electron.launch({
    executablePath: electronBinary,
    args: ["--no-sandbox", `--user-data-dir=${userDataDir}`, mainPath],
    env,
    timeout: launchTimeoutMs,
  });
  const child = app.process();
  child.stdout?.on("data", (chunk) => prefixAndWrite("electron", chunk.toString(), process.stdout));
  child.stderr?.on("data", (chunk) => prefixAndWrite("electron", chunk.toString(), process.stderr));
  await app.firstWindow({ timeout: launchTimeoutMs });
  return app;
}

async function waitForDesktopShell(app, timeoutMs) {
  const deadlineMs = Date.now() + timeoutMs;
  let lastSnapshots = [];
  let clickedApprovals = 0;
  while (Date.now() < deadlineMs) {
    const snapshots = await collectShellSnapshots(app);
    lastSnapshots = snapshots;
    const errorText = snapshots
      .map((snapshot) => snapshot.text)
      .find((text) =>
        /\b(Connection error|Launch gate could not|Failed to initialize|Remote server disconnected|Cannot continue|Recovery failed)\b/i.test(
          text
        )
      );
    if (errorText) {
      throw new Error(`Desktop shell surfaced an error: ${summarizeText(errorText)}`);
    }

    if (snapshots.some((snapshot) => snapshot.hasHostedShellChrome)) {
      const hostView = await getHostViewDebugInfo(app).catch(() => null);
      if (hostView?.visibleHostChromeAppId === "@workspace-apps/shell") {
        return { snapshots, hostView, clickedApprovals };
      }
    }

    if (snapshots.some((snapshot) => snapshot.hasLaunchGateApproval)) {
      const clicked = await clickDesktopButton(app, /^(Trust and start|Approve and start)$/i);
      if (clicked) {
        clickedApprovals += 1;
        console.log("[desktop-smoke] Approved desktop workspace app launch gate");
        await sleep(1_000);
        continue;
      }
    }

    await sleep(500);
  }
  throw new Error(
    `Timed out waiting for hosted desktop shell. Last snapshots:\n${JSON.stringify(
      lastSnapshots,
      null,
      2
    )}`
  );
}

async function collectShellSnapshots(app) {
  return app.evaluate(async ({ webContents }) => {
    const snapshots = [];
    for (const contents of webContents.getAllWebContents()) {
      if (contents.isDestroyed()) continue;
      const url = contents.getURL();
      try {
        const dom = await contents.executeJavaScript(
          `(() => {
            const text = document.body?.innerText ?? "";
            const buttons = Array.from(document.querySelectorAll("button"))
              .map((button) => button.textContent?.trim() ?? "")
              .filter(Boolean);
            const hasLaunchGateApproval = Boolean(document.querySelector('[data-bootstrap-launch-gate="true"]'))
              && buttons.some((label) => /^(Trust and start|Approve and start|Deny)$/i.test(label));
            const hasHostedShellChrome = Boolean(
              document.querySelector(".titlebar-breadcrumb-scroll")
                || document.querySelector('[aria-label="Menu"]')
            );
            return {
              text: text.slice(0, 3000),
              buttons,
              hasLaunchGateApproval,
              hasHostedShellChrome,
            };
          })()`,
          true
        );
        snapshots.push({
          id: contents.id,
          url,
          title: contents.getTitle(),
          ...dom,
        });
      } catch {
        // Ignore non-DOM webContents.
      }
    }
    return snapshots;
  });
}

async function clickDesktopButton(app, label) {
  return app.evaluate(async ({ webContents }, labelSource) => {
    const label = new RegExp(labelSource, "i");
    const candidates = [];
    for (const contents of webContents.getAllWebContents()) {
      if (contents.isDestroyed()) continue;
      try {
        const priority = await contents.executeJavaScript(
          `(() => {
              const hasLaunchGateApproval = Boolean(document.querySelector('[data-bootstrap-launch-gate="true"]'));
              const hasHostedShellChrome = Boolean(
                document.querySelector(".titlebar-breadcrumb-scroll")
                  || document.querySelector('[aria-label="Menu"]')
              );
              if (hasLaunchGateApproval) return 0;
              if (hasHostedShellChrome) return 2;
              return 3;
            })()`,
          true
        );
        candidates.push({ contents, priority });
      } catch {
        // Ignore non-DOM webContents.
      }
    }
    candidates.sort((a, b) => a.priority - b.priority);
    for (const { contents } of candidates) {
      if (contents.isDestroyed()) continue;
      try {
        const clicked = await contents.executeJavaScript(
          `(() => {
              const label = new RegExp(${JSON.stringify(labelSource)}, "i");
              const button = Array.from(document.querySelectorAll("button"))
                .find((item) => label.test(item.textContent?.trim() ?? ""));
              if (!(button instanceof HTMLButtonElement)) return false;
              button.click();
              return true;
            })()`,
          true
        );
        if (clicked) return true;
      } catch {
        // Ignore non-DOM webContents.
      }
    }
    return false;
  }, label.source);
}

async function getHostViewDebugInfo(app) {
  return app.evaluate(() => {
    const testApi = globalThis.__testApi;
    return testApi?.getHostViewDebugInfo?.() ?? null;
  });
}

async function getPanelTree(app) {
  return app.evaluate(() => {
    const testApi = globalThis.__testApi;
    return testApi?.getPanelTree?.() ?? [];
  });
}

async function saveScreenshot(app) {
  const pages = app.windows();
  const page = pages[0] ?? (await app.firstWindow({ timeout: 5_000 }));
  await fsp.mkdir(screenshotDir, { recursive: true });
  const screenshotPath = path.join(
    screenshotDir,
    `desktop-${new Date().toISOString().replace(/[:.]/g, "-")}.png`
  );
  await page.screenshot({ path: screenshotPath, fullPage: false });
  return screenshotPath;
}

function summarizeText(text) {
  return text.replace(/\s+/g, " ").trim().slice(0, 800);
}

async function closeElectron(app) {
  if (!app) return;
  const child = app.process();
  try {
    await Promise.race([
      app.close(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("close timed out")), 5_000)),
    ]);
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      // Already exited.
    }
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const children = [];
  let electronApp = null;
  let cleanedUp = false;
  let tempRoot = "";
  let readyInfo = null;
  const deadlineMs = Date.now() + options.timeoutMs;

  const cleanup = async () => {
    if (cleanedUp) return;
    cleanedUp = true;
    await closeElectron(electronApp);
    for (const child of children.reverse()) {
      if (child.exitCode == null && !child.killed) child.kill("SIGTERM");
    }
    await Promise.all(children.map((child) => waitForChildExit(child)));
    try {
      await fsp.unlink(options.readyFile);
    } catch {}
    if (tempRoot) {
      await fsp.rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
    }
    if (readyInfo?.isEphemeral && readyInfo.workspaceDir) {
      try {
        await fsp.access(readyInfo.workspaceDir);
        console.warn(
          `[desktop-smoke] Ephemeral workspace still present after shutdown: ${readyInfo.workspaceDir}`
        );
      } catch {}
    }
  };

  process.on("SIGINT", () => {
    void cleanup().then(() => process.exit(130));
  });
  process.on("SIGTERM", () => {
    void cleanup().then(() => process.exit(143));
  });

  try {
    try {
      await fsp.unlink(options.readyFile);
    } catch {}
    tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "natstack-desktop-smoke-"));

    const serverArgs = createServerArgs(options, options.readyFile);
    const serverInvocation = createServerInvocation(serverArgs);
    const serverChild = spawnManaged(serverInvocation.command, serverInvocation.args, {
      cwd: repoRoot,
      env: {
        ...process.env,
        NODE_ENV: process.env.NODE_ENV ?? "development",
      },
      label: "server",
    });
    await waitForSpawn(serverChild, serverInvocation.command, serverInvocation.args);
    children.push(serverChild);

    const ready = await waitForServerReady(
      options.readyFile,
      serverChild,
      Math.max(1_000, deadlineMs - Date.now())
    );
    readyInfo = ready;
    if (options.network === "tailscale") {
      assertTailscaleReady(ready);
      await waitForTcpReachable(ready.connectUrl);
    }

    const creds = await pairDesktopDevice(ready);
    electronApp = await launchDesktopApp(creds, tempRoot, options.launchTimeoutMs);
    const result = await waitForDesktopShell(electronApp, options.launchTimeoutMs);
    const hostView = result.hostView;
    const hostedShellUrl = String(hostView?.hostedShellUrl ?? "");
    if (options.network === "tailscale" && !hostedShellUrl.startsWith(`${creds.url}/`)) {
      throw new Error(
        `Hosted desktop shell did not load from the paired Tailscale URL. ` +
          `Expected prefix ${creds.url}/, got ${hostedShellUrl || "(none)"}`
      );
    }
    const panels = await getPanelTree(electronApp).catch(() => []);
    const screenshotPath = await saveScreenshot(electronApp).catch(() => null);
    console.log(
      `[desktop-smoke] PASS paired desktop app over ${options.network}; ` +
        `approvals=${result.clickedApprovals}; hostedShell=${hostedShellUrl}; ` +
        `panels=${Array.isArray(panels) ? panels.length : "unknown"}` +
        (screenshotPath ? `; screenshot=${path.relative(repoRoot, screenshotPath)}` : "")
    );
    await cleanup();
  } catch (error) {
    console.error(`[desktop-smoke] ${error instanceof Error ? error.message : String(error)}`);
    await cleanup();
    process.exit(1);
  }
}

await main();
