#!/usr/bin/env node
// End-to-end desktop pairing smoke over WebRTC. Spawns the signaling worker
// (`wrangler dev apps/signaling`), starts a disposable server as a WebRTC
// answerer, parses the `natstack://connect` pairing link it logs, then launches
// Electron with that deep link so the desktop shell connects to the server over
// the encrypted WebRTC pipe (no Tailscale, no remote HTTP origin). It then
// approves the Electron host-target launch gate and verifies the hosted desktop
// shell loads and a panel works.
//
// The app pairs and connects IN-PROCESS — the chooser no longer relaunches — so
// the entire flow is observed through a SINGLE Electron launch handle. Cleanup is
// crash-proof: it never assumes app.process()/app.close() succeed and always
// SIGKILLs the Electron pid + child server/wrangler so no orphan process survives
// a pass or a failure.
//
// The server answerer loads the native node-datachannel module lazily; run
// `pnpm rebuild node-datachannel` once before this smoke.

import fsp from "node:fs/promises";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "@playwright/test";
import { createServerInvocation, serverEntryArg } from "./cli/lib/server-entry.mjs";
import { createConnectDeepLink, parseConnectLink } from "./cli/lib/connect-utils.mjs";
import { resolveElectronExecutableForNatStack } from "./branded-electron.mjs";

const electronBinary = resolveElectronExecutableForNatStack();

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const mainPath = path.join(repoRoot, "dist", "main.cjs");
const wranglerBin = path.join(repoRoot, "node_modules", ".bin", "wrangler");
const signalingDir = path.join(repoRoot, "apps", "signaling");
const defaultReadyFile = path.join(os.tmpdir(), `natstack-desktop-smoke-ready-${process.pid}.json`);
const screenshotDir = path.join(repoRoot, "test-results", "desktop-pairing-smoke");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseArgs(argv) {
  const options = {
    timeoutMs: 420_000,
    launchTimeoutMs: 180_000,
    readyFile: defaultReadyFile,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") {
      throw new Error("Forwarding raw server flags is no longer supported");
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
  node scripts/desktop-pairing-smoke.mjs [options]

Runner options:
  --timeout-ms <ms>         Time to wait for server readiness. Defaults to 420000.
  --launch-timeout-ms <ms>  Time to wait for Electron launch and shell load.
                            Defaults to 180000.
  --ready-file <path>       Server ready-file path. Defaults to an OS temp path.
  --help                    Show this help message.

The smoke spawns the signaling worker (wrangler dev apps/signaling), starts a
disposable server as a WebRTC answerer, parses the natstack://connect pairing
link it logs, and launches Electron with that deep link so the desktop shell
connects over the encrypted WebRTC pipe. It then clicks the bootstrap launch
approval and asserts the hosted shell loads.

Requires the native node-datachannel module: run \`pnpm rebuild node-datachannel\`
once before this smoke.
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

function createServerArgs(readyFilePath) {
  // Loopback-only: the gateway binds 127.0.0.1; remote reach is the WebRTC pipe
  // attached to the same RpcServer when NATSTACK_WEBRTC_SIGNAL_URL is set.
  return [
    serverEntryArg(),
    "--app-root",
    repoRoot,
    "--ready-file",
    readyFilePath,
    "--ephemeral",
    "--serve-panels",
    "--print-credentials",
    "--host",
    "127.0.0.1",
    "--bind-host",
    "127.0.0.1",
  ];
}

function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

// Cloudflare's local runtime (Miniflare) hosting the real SignalingRoom DO, the
// WebRTC rendezvous — exactly as tests/webrtc-system.e2e.test.ts drives it.
async function startSignaling(port) {
  const child = spawnManaged(
    wranglerBin,
    ["dev", "--port", String(port), "--local", "--var", "ENVIRONMENT:test"],
    { cwd: signalingDir, label: "signaling" }
  );
  for (let i = 0; i < 90; i++) {
    if (child.exitCode != null) {
      throw new Error(`wrangler dev (signaling) exited before healthy (code ${child.exitCode})`);
    }
    try {
      const res = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (res.ok) return child;
    } catch {
      // Not up yet.
    }
    await sleep(1_000);
  }
  throw new Error("wrangler dev (signaling) did not become healthy");
}

// Watch the answerer's stdout for the `[webrtc-answerer] pairing link:
// natstack://connect?...` line it logs once it has joined the signaling room and
// computed its DTLS fingerprint. Attach this BEFORE the link can be printed so no
// chunk is missed.
function waitForPairingLink(serverChild, timeoutMs) {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const onData = (chunk) => {
      buffer += chunk.toString();
      const match = buffer.match(/natstack:\/\/connect\?\S+/);
      if (match) {
        cleanup();
        resolve(match[0]);
      }
    };
    const cleanup = () => {
      clearTimeout(timer);
      serverChild.stdout?.off("data", onData);
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(
        new Error(
          "Timed out waiting for the server's [webrtc-answerer] pairing link. " +
            "Is node-datachannel built? Run `pnpm rebuild node-datachannel`."
        )
      );
    }, timeoutMs);
    serverChild.stdout?.on("data", onData);
  });
}

function hasElectronDisplay() {
  if (process.platform !== "linux") return true;
  return Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
}

async function launchDesktopApp(deepLink, tempRoot, launchTimeoutMs) {
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
    ELECTRON_DISABLE_GPU: "1",
    ELECTRON_DISABLE_SANDBOX: "1",
    HOME: path.join(tempRoot, "home"),
    XDG_CONFIG_HOME: path.join(tempRoot, "xdg"),
  };

  await fsp.mkdir(env.HOME, { recursive: true });
  await fsp.mkdir(env.XDG_CONFIG_HOME, { recursive: true });

  const userDataDir = path.join(tempRoot, "electron-user-data");
  console.log(`[desktop-smoke] Launching Electron with WebRTC pairing deep link`);
  // The desktop shell ingests the pairing material via the natstack://connect
  // deep link passed as an argv: protocolHandler.enqueueFirstArgvLink(process.argv)
  // (src/main/index.ts) scans argv on first launch, the bootstrap chooser drains
  // it (natstack:drain-pair-link), and the shell dials the server over the WebRTC
  // pipe (serverSession.connectRemoteViaWebRtc with {room,fp,code,sig}).
  const app = await electron.launch({
    executablePath: electronBinary,
    args: ["--no-sandbox", `--user-data-dir=${userDataDir}`, mainPath, deepLink],
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
  // Capture the pid up front: app.process() can THROW if Playwright's underlying
  // _object was already torn down (the failure mode that left orphan windows).
  let pid;
  try {
    pid = app.process()?.pid;
  } catch {
    pid = undefined;
  }
  try {
    await Promise.race([
      app.close(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("close timed out")), 5_000)),
    ]);
  } catch {
    // app.close() threw or timed out — fall through to the pid kill below.
  }
  // Final safety net: SIGKILL the Electron process by pid so no orphan window
  // survives a pass OR a failure. ESRCH (already exited) is fine.
  if (typeof pid === "number") {
    try {
      process.kill(pid, "SIGKILL");
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
    // closeElectron is crash-proof, but wrap anyway so a throw can never strand
    // the child server/wrangler killed below.
    try {
      await closeElectron(electronApp);
    } catch {
      // ignore — children are still killed below.
    }
    for (const child of children.reverse()) {
      try {
        if (child.exitCode == null && !child.killed) child.kill("SIGTERM");
      } catch {
        // Already gone.
      }
    }
    await Promise.all(children.map((child) => waitForChildExit(child)));
    // Escalate any survivor (server / wrangler) to SIGKILL so nothing lingers.
    for (const child of children) {
      try {
        if (child.exitCode == null) child.kill("SIGKILL");
      } catch {
        // Already gone.
      }
    }
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

    // 1. Local signaling (Cloudflare local runtime) — the WebRTC rendezvous.
    const signalPort = await findFreePort();
    const signalingChild = await startSignaling(signalPort);
    children.push(signalingChild);
    const signalUrl = `ws://127.0.0.1:${signalPort}`;

    // 2. The disposable server, as a WebRTC answerer. We pick the room + pairing
    //    code; the server presents its persistent DTLS cert and logs the
    //    natstack://connect link whose `fp` pins that cert.
    const room = randomUUID();
    const pairingCode = randomBytes(18).toString("base64url");
    const serverArgs = createServerArgs(options.readyFile);
    const serverInvocation = createServerInvocation(serverArgs);
    const serverChild = spawnManaged(serverInvocation.command, serverInvocation.args, {
      cwd: repoRoot,
      env: {
        ...process.env,
        NODE_ENV: process.env.NODE_ENV ?? "development",
        // Run a single ephemeral workspace server (not the public hub): the WebRTC
        // answerer is the per-workspace pipe (hubServer.ts:820 "remote reach is the
        // per-workspace WebRTC pipe"), so the thing a client pairs with is a
        // workspace server. The hub→workspace remote-selection flow is separate.
        NATSTACK_FORCE_WORKSPACE_SERVER: "1",
        NATSTACK_WEBRTC_SIGNAL_URL: signalUrl,
        NATSTACK_WEBRTC_ROOM: room,
        NATSTACK_PAIRING_CODE: pairingCode,
      },
      label: "server",
    });
    await waitForSpawn(serverChild, serverInvocation.command, serverInvocation.args);
    children.push(serverChild);
    // Start scanning stdout for the pairing link now, before readiness, so the
    // line is never missed.
    const pairingLinkPromise = waitForPairingLink(
      serverChild,
      Math.max(1_000, deadlineMs - Date.now())
    );

    const ready = await waitForServerReady(
      options.readyFile,
      serverChild,
      Math.max(1_000, deadlineMs - Date.now())
    );
    readyInfo = ready;

    // 3. Parse the answerer's pairing link and rebuild the deep link with the
    //    canonical builder (the server contributed `fp`; we own room/code/sig).
    const loggedLink = await pairingLinkPromise;
    const parsed = parseConnectLink(loggedLink);
    if (parsed.kind !== "ok") {
      throw new Error(`Server logged an invalid pairing link: ${parsed.reason}`);
    }
    const deepLink = createConnectDeepLink({
      room: parsed.room,
      fp: parsed.fp,
      code: parsed.code,
      sig: parsed.sig,
      ice: parsed.ice,
    });
    console.log(`[desktop-smoke] WebRTC pairing: room=${parsed.room} fp=${parsed.fp}`);
    console.log(`[desktop-smoke] Deep link: ${deepLink}`);

    electronApp = await launchDesktopApp(deepLink, tempRoot, options.launchTimeoutMs);
    const result = await waitForDesktopShell(electronApp, options.launchTimeoutMs);
    const hostView = result.hostView;
    const hostedShellUrl = String(hostView?.hostedShellUrl ?? "");
    const panels = await getPanelTree(electronApp).catch(() => []);
    const screenshotPath = await saveScreenshot(electronApp).catch(() => null);
    console.log(
      `[desktop-smoke] PASS paired desktop app over WebRTC; ` +
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
