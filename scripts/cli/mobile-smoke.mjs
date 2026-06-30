#!/usr/bin/env node
// End-to-end Android smoke test for a fresh internal app install accepting a
// natstack://connect QR/deep link, activating the served RN bundle, connecting
// the workspace app, and rendering a panel WebView.

import fsp from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { inflateSync } from "node:zlib";
import {
  createServerInvocation,
  serverEntryArg,
} from "./lib/server-entry.mjs";
import { createConnectDeepLink, parseConnectLink } from "./lib/connect-utils.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const wranglerBin = path.join(repoRoot, "node_modules", ".bin", "wrangler");
const signalingDir = path.join(repoRoot, "apps", "signaling");
const androidDir = path.join(repoRoot, "apps", "mobile", "android");
const mobileInstallScript = path.join(repoRoot, "scripts", "cli", "mobile-install.mjs");
const defaultApkPath = path.join(
  androidDir,
  "app",
  "build",
  "outputs",
  "apk",
  "internal",
  "app-internal.apk"
);
const defaultPackage = "com.natstack.mobile.internal";
const defaultActivity = "com.natstack.mobile.MainActivity";
const smokePrefix = "[NatStackMobileSmoke]";
const screenshotDir = path.join(repoRoot, "test-results", "mobile-smoke");
const defaultVisualFallbackAgentProbeMs = 45_000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseArgs(argv) {
  const options = {
    avd: null,
    device: null,
    apkPath: defaultApkPath,
    packageName: defaultPackage,
    activityName: defaultActivity,
    noBuild: false,
    noInstall: false,
    noReset: false,
    noTap: false,
    realModel: false,
    timeoutMs: 420_000,
    pairingTimeoutMs: 180_000,
    agentTimeoutMs: 300_000,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") {
      throw new Error("Forwarding raw server flags is no longer supported");
    } else if (arg === "--avd") {
      options.avd = argv[++i] ?? null;
    } else if (arg === "--device") {
      options.device = argv[++i] ?? null;
    } else if (arg === "--apk") {
      options.apkPath = path.resolve(argv[++i] ?? "");
    } else if (arg === "--package") {
      options.packageName = argv[++i] ?? "";
    } else if (arg === "--activity") {
      options.activityName = argv[++i] ?? "";
    } else if (arg === "--no-build") {
      options.noBuild = true;
    } else if (arg === "--no-install") {
      options.noInstall = true;
    } else if (arg === "--no-reset") {
      options.noReset = true;
    } else if (arg === "--no-tap") {
      options.noTap = true;
    } else if (arg === "--real-model") {
      options.realModel = true;
    } else if (arg === "--timeout-ms") {
      options.timeoutMs = parsePositiveInt(argv[++i], "--timeout-ms");
    } else if (arg === "--pairing-timeout-ms") {
      options.pairingTimeoutMs = parsePositiveInt(argv[++i], "--pairing-timeout-ms");
    } else if (arg === "--agent-timeout-ms") {
      options.agentTimeoutMs = parsePositiveInt(argv[++i], "--agent-timeout-ms");
    } else if (arg === "--help") {
      options.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!options.packageName) throw new Error("--package must not be empty");
  if (!options.activityName) throw new Error("--activity must not be empty");
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
  console.log(`natstack mobile smoke

Usage:
  natstack mobile smoke [options]

Runner options:
  --avd <name>        Start this AVD if no adb device is connected.
  --device <serial>   Target a specific adb device serial.
  --apk <path>        Install a specific APK path.
  --package <id>      App package. Defaults to ${defaultPackage}.
  --activity <class>  Main activity class. Defaults to ${defaultActivity}.
  --no-build          Use the existing internal APK without rebuilding.
  --no-install        Skip APK install; build-only unless --no-build, then launch
                       the already-installed app.
  --no-reset          Do not clear app data before pairing.
  --no-tap            Do not automate the Pair button tap.
  --real-model        Use the real model provider/credential path instead of
                       the deterministic E2E model stub.
  --timeout-ms <ms>   Time to wait for Android boot, build/install, and server
                       readiness. Defaults to 420000.
  --pairing-timeout-ms <ms>
                       Time to wait for pairing and panel WebView load after
                       the server is ready. Defaults to 180000.
  --agent-timeout-ms <ms>
                       Time to wait for the initial agent response after the
                       panel WebView loads. Defaults to 300000.
  --help              Show this help message.

By default, the smoke delegates APK build/install/reset/launcher startup to
natstack mobile install --reset-app --launch. It then spawns the signaling worker
(wrangler dev apps/signaling), starts a disposable local server as a WebRTC
answerer, reverses the signaling and gateway ports through adb, sends a
natstack://connect intent (carrying the signaling room, the server's DTLS
fingerprint, and a pairing code) to the launched internal app, confirms the Pair
screen, then waits for native bundle activation, workspace connection, panel
materialization, panel WebView load log markers, and the initial agent turn.

Remote reach is the encrypted WebRTC pipe (no Tailscale). The server answerer
loads the native node-datachannel module lazily; run \`pnpm rebuild
node-datachannel\` once before this smoke.
`);
}

function prefixAndWrite(prefix, text, stream) {
  for (const line of text.split(/\r?\n/)) {
    if (!line) continue;
    stream.write(`[${prefix}] ${line}\n`);
  }
}

function pipeChildOutput(child, prefix) {
  child.stdout?.on("data", (chunk) => prefixAndWrite(prefix, chunk.toString(), process.stdout));
  child.stderr?.on("data", (chunk) => prefixAndWrite(prefix, chunk.toString(), process.stderr));
}

function spawnManaged(command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: options.cwd ?? repoRoot,
    env: options.env ?? process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  pipeChildOutput(child, options.label ?? command);
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

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? repoRoot,
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => {
      const text = chunk.toString();
      stdout += text;
      if (options.label) prefixAndWrite(options.label, text, process.stdout);
    });
    child.stderr?.on("data", (chunk) => {
      const text = chunk.toString();
      stderr += text;
      if (options.label) prefixAndWrite(options.label, text, process.stderr);
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else
        reject(
          new Error(`${command} ${args.join(" ")} failed with code ${code}\n${stderr || stdout}`)
        );
    });
  });
}

function makeAdbArgs(device, args) {
  return device ? ["-s", device, ...args] : args;
}

async function adb(device, ...args) {
  return runCommand("adb", makeAdbArgs(device, args), { label: "adb" });
}

async function adbCapture(device, ...args) {
  return runCommand("adb", makeAdbArgs(device, args));
}

function runCommandBuffer(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? repoRoot,
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const stdoutChunks = [];
    let stderr = "";
    child.stdout?.on("data", (chunk) => stdoutChunks.push(Buffer.from(chunk)));
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      const stdout = Buffer.concat(stdoutChunks);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${command} ${args.join(" ")} failed with code ${code}\n${stderr}`));
    });
  });
}

async function adbCaptureBuffer(device, ...args) {
  return runCommandBuffer("adb", makeAdbArgs(device, args));
}

async function runMobileInstall(options, { buildOnly = false } = {}) {
  const args = [mobileInstallScript, "--apk", options.apkPath, "--package", options.packageName];
  if (options.device) args.push("--device", options.device);
  if (options.noBuild) args.push("--no-build");
  if (buildOnly) {
    args.push("--build-only");
  } else {
    if (!options.noReset) args.push("--reset-app");
    args.push("--launch");
  }
  await runCommand(process.execPath, args, {
    cwd: repoRoot,
    env: process.env,
    label: "mobile-install",
  });
}

async function launchInstalledApp(device, packageName) {
  await adb(
    device,
    "shell",
    "monkey",
    "-p",
    packageName,
    "-c",
    "android.intent.category.LAUNCHER",
    "1"
  );
}

async function ensureDeviceInteractive(device) {
  await adbCapture(device, "shell", "input", "keyevent", "KEYCODE_WAKEUP").catch(() => null);
  await adbCapture(device, "shell", "wm", "dismiss-keyguard").catch(() => null);
  await adbCapture(device, "shell", "cmd", "statusbar", "collapse").catch(() => null);
}

async function hasAdbDevice(device) {
  try {
    await adbCapture(device, "get-state");
    return true;
  } catch {
    return false;
  }
}

async function waitForAndroidBoot(device, timeoutMs = 180_000) {
  await adb(device, "wait-for-device");
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const { stdout } = await adbCapture(device, "shell", "getprop", "sys.boot_completed");
    if (stdout.trim() === "1") return;
    await sleep(1_000);
  }
  throw new Error("Timed out waiting for Android boot completion");
}

async function waitForServerReady(readyFile, serverChild, timeoutMs = 180_000) {
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

// Parse the WebRTC pairing link the server answerer logs and rebuild it with the
// canonical builder. The phone joins the signaling room over loopback (the
// adb-reversed `sig` port), pins the server's DTLS `fp`, and proves possession
// with `code` — no server URL.
function buildConnectLinkFromLog(loggedLink) {
  const parsed = parseConnectLink(loggedLink);
  if (parsed.kind !== "ok") {
    throw new Error(`Server logged an invalid pairing link: ${parsed.reason}`);
  }
  return createConnectDeepLink({
    room: parsed.room,
    fp: parsed.fp,
    code: parsed.code,
    sig: parsed.sig,
    ice: parsed.ice,
  });
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

// The first non-internal 192.168.x IPv4 — the host LAN address both the emulator
// (via QEMU's NAT) and the server can reach for the TURN relay.
function hostLanIp() {
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === "IPv4" && !a.internal && a.address.startsWith("192.168.")) return a.address;
    }
  }
  return null;
}

// Local coturn relay for testing against an Android EMULATOR: QEMU's user-mode NAT
// cannot hold a direct WebRTC pipe (ICE consent-freshness goes stale ~30-60s in),
// so we relay through coturn and force `NATSTACK_WEBRTC_ICE=relay`. Physical
// devices on the LAN and desktop loopback don't need this. coturn must be on PATH
// (`turnserver`). Returns the iceServer creds the signaling worker advertises to
// BOTH peers, plus the managed child (caller pushes it to `children` for cleanup).
async function startLocalTurn() {
  const lanIp = hostLanIp();
  if (!lanIp) throw new Error("No 192.168.x LAN IP found for the local TURN relay");
  const port = 47000;
  const user = "natstack";
  const pass = "natstackpass";
  const confPath = path.join(os.tmpdir(), `natstack-coturn-${process.pid}.conf`);
  // relay-ip MUST be the LAN IP, not 127.0.0.1 — coturn returns 403 Forbidden on
  // CREATE_PERMISSION for a loopback relay address.
  await fsp.writeFile(
    confPath,
    [
      `listening-port=${port}`,
      `listening-ip=127.0.0.1`,
      `listening-ip=${lanIp}`,
      `relay-ip=${lanIp}`,
      `realm=natstack.local`,
      `lt-cred-mech`,
      `user=${user}:${pass}`,
      `no-tls`,
      `no-dtls`,
      `allowed-peer-ip=${lanIp}`,
      `min-port=48000`,
      `max-port=48100`,
      // Default pidfile is /var/run/turnserver.pid (needs root) — point it at a
      // writable temp path so coturn doesn't log a permission warning.
      `pidfile=${path.join(os.tmpdir(), `natstack-coturn-${process.pid}.pid`)}`,
      "",
    ].join("\n")
  );
  // NOTE: no `-n` flag — `-n` means "ignore the config file", which would make
  // coturn fall back to its defaults (TLS on :3478, clashing with any system
  // coturn). `-c` loads our config; coturn stays in the foreground by default
  // (no `-o`/daemon) so spawnManaged can track + reap it.
  const child = spawnManaged("turnserver", ["-c", confPath], { label: "coturn" });
  await sleep(1_500); // coturn has no health endpoint; let it bind.
  if (child.exitCode != null) {
    throw new Error(`coturn (turnserver) exited before ready (code ${child.exitCode}) — is it installed?`);
  }
  return { child, host: lanIp, port: String(port), user, pass };
}

// Cloudflare's local runtime (Miniflare) hosting the real SignalingRoom DO, the
// WebRTC rendezvous — exactly as tests/webrtc-system.e2e.test.ts drives it.
async function startSignaling(port, turn = null) {
  const vars = ["--var", "ENVIRONMENT:test"];
  if (turn) {
    // The signaling worker's mintIceServers returns this relay to both peers.
    vars.push(
      "--var", `NATSTACK_LOCAL_TURN_HOST:${turn.host}`,
      "--var", `NATSTACK_LOCAL_TURN_PORT:${turn.port}`,
      "--var", `NATSTACK_LOCAL_TURN_USER:${turn.user}`,
      "--var", `NATSTACK_LOCAL_TURN_PASS:${turn.pass}`
    );
  }
  const child = spawnManaged(
    wranglerBin,
    ["dev", "--port", String(port), "--local", ...vars],
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
// natstack://connect?...` line. Attach this BEFORE the link can be printed so no
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

// Pre-warm: wait until the server reports the react-native workspace app BUILT
// (`status=running`/`available` with a real build key) before we pair. Otherwise
// the cold Metro-extension + app build (~1-2 min) burns the emulator's ~2-min
// relay window before the bundle can stream. Best-effort — resolves false on
// timeout so the run still proceeds (and physical devices don't need it).
function waitForReactNativeAppReady(serverChild, timeoutMs) {
  return new Promise((resolve) => {
    let buffer = "";
    const ready =
      /target=react-native\b[^\n]*\bstatus=(?:running|available)\b[^\n]*\bbuild=(?!none\b)[0-9a-f]{6,}/;
    const onData = (chunk) => {
      buffer += chunk.toString();
      if (ready.test(buffer)) {
        cleanup();
        resolve(true);
      }
      if (buffer.length > 1_000_000) buffer = buffer.slice(-200_000);
    };
    const cleanup = () => {
      clearTimeout(timer);
      serverChild.stdout?.off("data", onData);
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve(false);
    }, timeoutMs);
    serverChild.stdout?.on("data", onData);
  });
}

function startLogcat(device, expectedPhases, deadlineMs) {
  const child = spawn("adb", makeAdbArgs(device, ["logcat", "-v", "time"]), {
    cwd: repoRoot,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const phases = new Set();
  const recentLines = [];
  let buffer = "";
  let stderr = "";

  const recordLine = (line) => {
    if (!line) return;
    if (line.includes(smokePrefix)) {
      console.log(`[smoke-log] ${line}`);
      recentLines.push(line);
      if (recentLines.length > 200) recentLines.shift();
      const match = line.match(/\bphase=([A-Za-z0-9._-]+)/);
      if (match) phases.add(match[1]);
    } else if (
      line.includes("AndroidRuntime") ||
      line.includes("ReactNativeJS") ||
      line.includes("NatStackMobileHost")
    ) {
      recentLines.push(line);
      if (recentLines.length > 200) recentLines.shift();
    }
  };

  child.stdout?.on("data", (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) recordLine(line);
  });
  child.stderr?.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  child.once("error", (error) => {
    stderr += `${error.message}\n`;
  });

  const waitForPhase = async (phase) => {
    while (Date.now() < deadlineMs) {
      if (phases.has(phase)) return;
      if (child.exitCode != null) {
        throw new Error(`adb logcat exited before phase ${phase}\n${stderr}`.trim());
      }
      await sleep(250);
    }
    const observed =
      expectedPhases.filter((candidate) => phases.has(candidate)).join(", ") || "(none)";
    const recent = recentLines.length
      ? `\n\nRecent relevant log lines:\n${recentLines.join("\n")}`
      : "";
    throw new Error(`Timed out waiting for smoke phase ${phase}. Observed: ${observed}${recent}`);
  };

  const hasPhase = (phase) => phases.has(phase);

  return { child, waitForPhase, hasPhase };
}

async function waitForLogcatReady(device, logcat) {
  const phase = `logcat-ready-${Date.now()}`;
  await adb(
    device,
    "shell",
    "log",
    "-t",
    "NatStackMobileSmokeProbe",
    `${smokePrefix} phase=${phase}`
  );
  await logcat.waitForPhase(phase);
}

async function waitForPhaseTappingApprovals(device, logcat, phase, deadlineMs) {
  let lastApprovalTap = 0;
  while (Date.now() < deadlineMs) {
    if (logcat.hasPhase(phase)) return;
    if (Date.now() - lastApprovalTap > 2_000) {
      lastApprovalTap = Date.now();
      const approved = await tapOptionalButtonByText(device, "Trust and start", 500);
      if (approved) console.log("[mobile-smoke] Approved mobile workspace app launch gate");
    }
    await sleep(250);
  }
  await logcat.waitForPhase(phase);
}

async function tapButtonByText(device, text, deadlineMs) {
  while (Date.now() < deadlineMs) {
    const xml = await dumpWindowXml(device);
    const bounds = findNodeBounds(xml, text);
    if (bounds) {
      await adb(device, "shell", "input", "tap", String(bounds.x), String(bounds.y));
      return;
    }
    await sleep(500);
  }
  throw new Error(`Timed out waiting for visible Android button "${text}"`);
}

async function tapOptionalButtonByText(device, text, timeoutMs = 6_000) {
  const deadlineMs = Date.now() + timeoutMs;
  while (Date.now() < deadlineMs) {
    const xml = await dumpWindowXml(device);
    const bounds = findNodeBounds(xml, text);
    if (bounds) {
      await adb(device, "shell", "input", "tap", String(bounds.x), String(bounds.y));
      return true;
    }
    await sleep(500);
  }
  return false;
}

async function tapOptionalButtonByLabelPrefix(device, text, timeoutMs = 6_000) {
  const deadlineMs = Date.now() + timeoutMs;
  while (Date.now() < deadlineMs) {
    const xml = await dumpWindowXml(device);
    const bounds = findNodeBounds(xml, text, { labelPrefix: true });
    if (bounds) {
      await adb(device, "shell", "input", "tap", String(bounds.x), String(bounds.y));
      return true;
    }
    await sleep(500);
  }
  return false;
}

async function dumpWindowXml(device) {
  const dumpPath = "/sdcard/natstack-mobile-smoke-window.xml";
  await adbCapture(device, "shell", "uiautomator", "dump", dumpPath).catch(() => null);
  const result = await adbCapture(device, "exec-out", "cat", dumpPath).catch(() => null);
  return result?.stdout ?? "";
}

function findNodeBounds(xml, text, options = {}) {
  const pattern = /<node\b[^>]*>/g;
  let match;
  const expected = text.toLowerCase();
  const candidates = [];
  while ((match = pattern.exec(xml))) {
    const node = match[0];
    const label = readXmlAttribute(node, "text") || readXmlAttribute(node, "content-desc");
    const normalized = label.toLowerCase();
    const matched = options.labelPrefix
      ? normalized === expected || normalized.startsWith(`${expected}.`)
      : normalized === expected;
    if (!matched) continue;
    const boundsMatch = node.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
    if (!boundsMatch) continue;
    const left = Number(boundsMatch[1]);
    const top = Number(boundsMatch[2]);
    const right = Number(boundsMatch[3]);
    const bottom = Number(boundsMatch[4]);
    if ([left, top, right, bottom].every(Number.isFinite) && right > left && bottom > top) {
      candidates.push({
        x: Math.round((left + right) / 2),
        y: Math.round((top + bottom) / 2),
        area: (right - left) * (bottom - top),
        clickable: readXmlAttribute(node, "clickable") === "true",
        button: /\b(?:android\.widget\.Button|android\.view\.ViewGroup)\b/.test(
          readXmlAttribute(node, "class")
        ),
      });
    }
  }
  candidates.sort((left, right) => {
    const leftInteractive = left.clickable || left.button;
    const rightInteractive = right.clickable || right.button;
    if (leftInteractive !== rightInteractive) return leftInteractive ? -1 : 1;
    return right.area - left.area;
  });
  const candidate = candidates[0];
  return candidate ? { x: candidate.x, y: candidate.y } : null;
}

async function tapVisibleNode(device, xml, text, options = {}) {
  const bounds = findNodeBounds(xml, text, options);
  if (!bounds) return false;
  await adb(device, "shell", "input", "tap", String(bounds.x), String(bounds.y));
  return true;
}

function collectWindowLabels(xml) {
  const labels = [];
  const pattern = /<node\b[^>]*>/g;
  let match;
  while ((match = pattern.exec(xml))) {
    const node = match[0];
    const label = readXmlAttribute(node, "text") || readXmlAttribute(node, "content-desc");
    const normalized = label.replace(/\s+/g, " ").trim();
    if (normalized) labels.push(normalized);
  }
  return labels;
}

function readXmlAttribute(node, name) {
  const match = node.match(new RegExp(`\\b${name}="([^"]*)"`));
  return match ? unescapeXmlAttribute(match[1]) : "";
}

function unescapeXmlAttribute(value) {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function createAgentTurnProbe(ready) {
  const workspaceDir = typeof ready?.workspaceDir === "string" ? ready.workspaceDir : "";
  const stateDirCandidates = [
    workspaceDir ? path.join(path.dirname(workspaceDir), "state") : "",
    workspaceDir ? path.join(workspaceDir, "state") : "",
    workspaceDir.endsWith(`${path.sep}state`) ? workspaceDir : "",
  ].filter(Boolean);
  return {
    stateDirCandidates: [...new Set(stateDirCandidates)],
    sqliteFiles: null,
    tableDbs: new Map(),
    warned: false,
  };
}

async function probeInitialAgentTurn(probe) {
  if (!probe?.stateDirCandidates?.length) {
    return { kind: "unavailable", summary: "ready file did not include workspaceDir" };
  }

  const agentRunDbs = await getDatabasesWithTable(probe, "agent_turn_runs");
  if (!agentRunDbs.length) {
    return { kind: "pending", summary: "agent_turn_runs table not found yet" };
  }

  let latest = null;
  for (const dbPath of agentRunDbs) {
    const rows = await sqliteJson(
      dbPath,
      `SELECT turn_id, channel_id, status, failure_code, failure_message, opened_at, updated_at, closed_at
       FROM agent_turn_runs
       ORDER BY opened_at DESC
       LIMIT 1`
    ).catch(() => []);
    for (const row of rows) {
      if (!latest || Number(row.opened_at ?? 0) > Number(latest.opened_at ?? 0)) {
        latest = row;
      }
    }
  }

  if (!latest?.turn_id) {
    return { kind: "pending", summary: "no agent turn run has started yet" };
  }

  if (
    latest.failure_code ||
    latest.failure_message ||
    /\b(?:failed|failure|error|aborted)\b/i.test(String(latest.status ?? ""))
  ) {
    return {
      kind: "failed",
      summary:
        `${latest.turn_id} status=${latest.status}` +
        (latest.failure_code ? ` code=${latest.failure_code}` : "") +
        (latest.failure_message ? ` message=${latest.failure_message}` : ""),
    };
  }

  const messageSummary = await countCompletedAssistantMessages(probe, latest.turn_id);
  const status = String(latest.status ?? "");
  const closed = status === "closed" || latest.closed_at != null;
  if (closed && messageSummary.completedAssistant > 0) {
    return {
      kind: "completed",
      summary: `${latest.turn_id} status=${status} completedAssistant=${messageSummary.completedAssistant}`,
    };
  }

  return {
    kind: "pending",
    summary:
      `${latest.turn_id} status=${status || "(unknown)"} ` +
      `completedAssistant=${messageSummary.completedAssistant}`,
  };
}

async function countCompletedAssistantMessages(probe, turnId) {
  const messageDbs = await getDatabasesWithTable(probe, "trajectory_messages");
  let completedAssistant = 0;
  let failedAssistant = 0;
  for (const dbPath of messageDbs) {
    const rows = await sqliteJson(
      dbPath,
      `SELECT
         SUM(CASE WHEN role = 'assistant' AND status = 'completed' THEN 1 ELSE 0 END) AS completed_assistant,
         SUM(CASE WHEN role = 'assistant' AND status = 'failed' THEN 1 ELSE 0 END) AS failed_assistant
       FROM trajectory_messages
       WHERE turn_id = ${sqlString(turnId)}`
    ).catch(() => []);
    for (const row of rows) {
      completedAssistant += Number(row.completed_assistant ?? 0);
      failedAssistant += Number(row.failed_assistant ?? 0);
    }
  }
  return { completedAssistant, failedAssistant };
}

async function getDatabasesWithTable(probe, table) {
  const cached = probe.tableDbs.get(table);
  if (cached?.length) return cached;
  const files = await getSqliteFiles(probe);
  const matches = [];
  for (const dbPath of files) {
    const rows = await sqliteJson(
      dbPath,
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name = ${sqlString(table)} LIMIT 1`
    ).catch(() => []);
    if (rows.length > 0) matches.push(dbPath);
  }
  if (matches.length) probe.tableDbs.set(table, matches);
  return matches;
}

async function getSqliteFiles(probe) {
  if (probe.sqliteFiles?.length) return probe.sqliteFiles;
  const files = [];
  for (const stateDir of probe.stateDirCandidates) {
    files.push(...(await listSqliteFiles(path.join(stateDir, ".databases")).catch(() => [])));
    if (files.length) break;
    files.push(...(await listSqliteFiles(stateDir).catch(() => [])));
    if (files.length) break;
  }
  probe.sqliteFiles = [...new Set(files)];
  return probe.sqliteFiles;
}

async function listSqliteFiles(root) {
  const files = [];
  const pending = [root];
  while (pending.length) {
    const dir = pending.pop();
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        pending.push(fullPath);
      } else if (entry.isFile() && entry.name.endsWith(".sqlite")) {
        files.push(fullPath);
      }
    }
  }
  return files;
}

async function sqliteJson(dbPath, sql) {
  const { stdout } = await runCommand("sqlite3", ["-json", dbPath, sql]);
  const text = stdout.trim();
  return text ? JSON.parse(text) : [];
}

function sqlString(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

async function waitForInitialAgentTurn(device, deadlineMs, agentProbe, options = {}) {
  const startedAt = Date.now();
  const visualFallbackAfterMs =
    typeof options.visualFallbackAfterMs === "number" ? options.visualFallbackAfterMs : null;
  let lastLabels = [];
  let lastAgentState = "not checked";
  let nextProbeAt = 0;
  let stableVisualAgentFingerprint = "";
  let stableVisualAgentPolls = 0;
  let durableProbeUnavailable = false;
  while (Date.now() < deadlineMs) {
    const xml = await dumpWindowXml(device);
    const labels = collectWindowLabels(xml);
    const text = labels.join("\n");
    lastLabels = labels;

    if (await tapVisibleNode(device, xml, "Approve all")) {
      await sleep(1_000);
      continue;
    }
    if (await tapVisibleNode(device, xml, "Use once", { labelPrefix: true })) {
      await sleep(2_000);
      continue;
    }

    assertNoBlockingPermissionDialog(xml);

    if (
      /\b(Error|Recovery failed)\b/i.test(text) ||
      /Runner (?:prompt|continue) completed without/i.test(text) ||
      /Agent turn failed|Cannot continue|DO RPC relay failed|Connection error/i.test(text)
    ) {
      throw new Error(
        `Initial agent turn surfaced a visible error. Visible labels: ${summarizeLabels(labels)}`
      );
    }

    const visualAgentTurn = visibleAgentTurnState(labels);
    if (options.rejectTestModelResponse && visualAgentTurn.hasTestModelStub) {
      throw new Error(
        "Real-model smoke saw the deterministic E2E model response; " +
          "NATSTACK_TEST_MODE is still reaching the model worker"
      );
    }
    if (options.failOnCredentialSetup && visualAgentTurn.hasCredentialSetupPrompt) {
      throw new Error(
        `Real-model smoke reached the model credential setup UI instead of an agent response. ` +
          `Visible labels: ${summarizeLabels(labels)}`
      );
    }

    if (
      options.requireNoUnresolvedApproval &&
      visualAgentTurn.hasUnresolvedApproval &&
      visualAgentTurn.hasAgentOutput &&
      !visualAgentTurn.isTyping
    ) {
      stableVisualAgentFingerprint = "";
      stableVisualAgentPolls = 0;
    } else if (visualAgentTurn.hasFinalVisibleOutput) {
      if (visualAgentTurn.fingerprint === stableVisualAgentFingerprint) {
        stableVisualAgentPolls += 1;
      } else {
        stableVisualAgentFingerprint = visualAgentTurn.fingerprint;
        stableVisualAgentPolls = 1;
      }
      if (stableVisualAgentPolls >= 3) {
        const suffix = options.requireNoUnresolvedApproval
          ? " with no pending approvals"
          : "";
        console.log(`[mobile-smoke] Initial agent turn completed by stable final visible output${suffix}`);
        return;
      }
    } else {
      stableVisualAgentFingerprint = "";
      stableVisualAgentPolls = 0;
    }

    if (Date.now() >= nextProbeAt) {
      nextProbeAt = Date.now() + 2_000;
      const agentState = await probeInitialAgentTurn(agentProbe).catch((error) => ({
        kind: "unavailable",
        summary: error instanceof Error ? error.message : String(error),
      }));
      lastAgentState = `${agentState.kind}: ${agentState.summary}`;
      if (agentState.kind === "failed") {
        throw new Error(`Initial agent turn failed in durable state: ${agentState.summary}`);
      }
      if (agentState.kind === "completed") {
        if (!options.requireVisibleAgentOutput) {
          console.log(`[mobile-smoke] Initial agent turn completed: ${agentState.summary}`);
          return;
        }
        lastAgentState = `completed but waiting for visible output: ${agentState.summary}`;
      }
      if (
        (agentState.kind === "unavailable" ||
          /agent_turn_runs table not found yet/i.test(agentState.summary)) &&
        !agentProbe.warned
      ) {
        durableProbeUnavailable = true;
        agentProbe.warned = true;
        console.warn(`[mobile-smoke] Durable agent-state probe unavailable: ${agentState.summary}`);
      }
    }

    if (
      durableProbeUnavailable &&
      visualFallbackAfterMs != null &&
      Date.now() - startedAt >= visualFallbackAfterMs
    ) {
      break;
    }

    await sleep(1_000);
  }

  throw new Error(
    `Timed out waiting for the initial onboarding agent turn to finish. ` +
      `Last visible labels: ${summarizeLabels(lastLabels)}. ` +
      `Last durable state: ${lastAgentState}`
  );
}

function visibleAgentTurnState(labels) {
  const text = labels.join("\n");
  const isTyping = /\b(?:AI Chat|Agent) typing\b/i.test(text);
  const agentIndex = labels.findLastIndex((label) => isAgentAttributionLabel(label));
  const agentLabels = agentIndex >= 0 ? labels.slice(agentIndex + 1, agentIndex + 12) : [];
  const agentText = agentLabels.join("\n");
  const hasAgentAttribution =
    agentIndex >= 0 || /(?:^|\n)AI Chat(?:\s*|\n)@(?:agent|ai-chat)(?:\s|\n|$)/i.test(text);
  const hasTestModelStub = /E2E model response:\s*initial agent turn completed/i.test(text);
  const hasCredentialSetupPrompt =
    /Credential (?:required|needs refresh) for/i.test(agentText) ||
    /Connect a URL-bound model credential for/i.test(agentText) ||
    /No built-in setup is available for this model provider/i.test(agentText) ||
    /No provider details available/i.test(agentText);
  const hasUnresolvedApproval = hasVisibleApprovalPrompt(labels);
  const hasSubstantialContent = agentLabels.some(isSubstantialAgentContent);
  const hasAgentOutput =
    hasAgentAttribution && hasSubstantialContent && !hasCredentialSetupPrompt;
  return {
    hasAgentOutput,
    hasFinalVisibleOutput: hasAgentOutput && !isTyping && !hasUnresolvedApproval,
    hasCredentialSetupPrompt,
    hasTestModelStub,
    hasUnresolvedApproval,
    isTyping,
    fingerprint: (agentLabels.length ? agentLabels : labels).filter(Boolean).slice(0, 60).join("|"),
  };
}

function hasVisibleApprovalPrompt(labels) {
  return labels.some((label) => {
    const normalized = label.replace(/\s+/g, " ").trim();
    return (
      /^(?:Approve all|Use once|Trust and start)$/i.test(normalized) ||
      /^Use once\./i.test(normalized) ||
      /Approve workspace extensions/i.test(normalized)
    );
  });
}

function isAgentAttributionLabel(label) {
  const normalized = label.replace(/\s+/g, " ").trim();
  return (
    /^(?:AI Chat\s*)?@(?:agent|ai-chat)$/i.test(normalized) ||
    /^AI Chat\s*@(?:agent|ai-chat)(?:\s|$)/i.test(normalized)
  );
}

function isSubstantialAgentContent(label) {
  const normalized = label.replace(/\s+/g, " ").trim();
  if (normalized.length < 8) return false;
  if (/^(?:AI Chat|AI Chat typing|Agent typing)$/i.test(normalized)) return false;
  if (isAgentAttributionLabel(normalized)) return false;
  if (
    /^(?:Approve all|Use once|Reply|Copy message|Enter API Key|Internal Browser|External Browser)$/i.test(
      normalized
    )
  ) {
    return false;
  }
  return true;
}

function summarizeLabels(labels) {
  const compact = labels.filter(Boolean).slice(0, 40).join(" | ");
  return compact || "(none)";
}

async function captureAndAssertPanelVisible(device, agentTimeoutMs, readyInfo, options = {}) {
  const agentProbe = createAgentTurnProbe(readyInfo);
  await ensureDeviceInteractive(device);
  await sleep(2_000);
  if (await tapOptionalButtonByText(device, "Approve all", 2_000)) {
    await sleep(2_000);
  }
  if (await tapOptionalButtonByLabelPrefix(device, "Use once", 2_000)) {
    await sleep(3_000);
  }
  let agentTurnCompleted = true;
  try {
    const waitOptions = options.realModel
        ? {
          requireVisibleAgentOutput: true,
          rejectTestModelResponse: true,
          failOnCredentialSetup: true,
          requireNoUnresolvedApproval: true,
        }
      : {
          visualFallbackAfterMs: defaultVisualFallbackAgentProbeMs,
        };
    await waitForInitialAgentTurn(device, Date.now() + agentTimeoutMs, agentProbe, waitOptions);
  } catch (error) {
    if (!isInitialAgentProbeTimeout(error)) throw error;
    if (options.realModel) throw error;
    agentTurnCompleted = false;
    console.warn(
      `[mobile-smoke] Initial agent turn probe did not produce an observable completion within ` +
        `${defaultVisualFallbackAgentProbeMs}ms of an unavailable durable probe; ` +
        `continuing with visual panel assertion. ` +
        `${error instanceof Error ? error.message : String(error)}`
    );
  }
  await ensureDeviceInteractive(device);
  assertNoBlockingPermissionDialog(await dumpWindowXml(device));
  await fsp.mkdir(screenshotDir, { recursive: true });
  const screenshotPath = path.join(
    screenshotDir,
    `panel-${new Date().toISOString().replace(/[:.]/g, "-")}.png`
  );
  const { stdout } = await adbCaptureBuffer(device, "exec-out", "screencap", "-p");
  await fsp.writeFile(screenshotPath, stdout);
  const image = decodePng(stdout);
  const stats = samplePanelRegion(image);
  console.log(
    `[mobile-smoke] Visual panel sample: ${JSON.stringify({
      screenshot: path.relative(repoRoot, screenshotPath),
      region: stats.region,
      sampled: stats.sampled,
      uniqueBuckets: stats.uniqueBuckets,
      dominantRatio: Number(stats.dominantRatio.toFixed(3)),
      meanLuma: Number(stats.meanLuma.toFixed(1)),
      lumaStdDev: Number(stats.lumaStdDev.toFixed(1)),
      edgeRatio: Number(stats.edgeRatio.toFixed(3)),
    })}`
  );
  if (
    stats.sampled < 5_000 ||
    stats.uniqueBuckets < 12 ||
    stats.dominantRatio > 0.995 ||
    stats.lumaStdDev < 4 ||
    stats.edgeRatio < 0.003
  ) {
    throw new Error(
      `Panel WebView screenshot looks blank. Saved ${screenshotPath}; stats=${JSON.stringify(stats)}`
    );
  }
  return { agentTurnCompleted };
}

function assertNoBlockingPermissionDialog(xml) {
  const text = unescapeXmlAttribute(xml);
  if (/send you notifications/i.test(text) || /don.?t allow/i.test(text)) {
    throw new Error(
      "Android permission dialog is blocking the panel screenshot; expected the panel content to be visible"
    );
  }
  if (/Approve workspace extensions/i.test(text) || /Approve all/i.test(text)) {
    throw new Error(
      "NatStack approval sheet is blocking the panel screenshot; expected the panel content to be visible"
    );
  }
  if (/Connection error/i.test(text) || /DO RPC relay failed/i.test(text)) {
    throw new Error(
      "Panel rendered an error banner instead of healthy content; expected the panel content to be usable"
    );
  }
}

function isInitialAgentProbeTimeout(error) {
  return (
    error instanceof Error &&
    /Timed out waiting for the initial onboarding agent turn to finish/i.test(error.message)
  );
}

function decodePng(buffer) {
  const signature = "89504e470d0a1a0a";
  if (buffer.subarray(0, 8).toString("hex") !== signature) {
    throw new Error("Android screenshot is not a PNG");
  }
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idatChunks = [];
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.subarray(offset + 4, offset + 8).toString("ascii");
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > buffer.length) throw new Error("PNG chunk exceeds screenshot length");
    const data = buffer.subarray(dataStart, dataEnd);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
    } else if (type === "IDAT") {
      idatChunks.push(data);
    } else if (type === "IEND") {
      break;
    }
    offset = dataEnd + 4;
  }
  if (!width || !height || bitDepth !== 8 || (colorType !== 6 && colorType !== 2)) {
    throw new Error(
      `Unsupported screenshot PNG format: ${width}x${height} bitDepth=${bitDepth} colorType=${colorType}`
    );
  }
  const bytesPerPixel = colorType === 6 ? 4 : 3;
  const stride = width * bytesPerPixel;
  const inflated = inflateSync(Buffer.concat(idatChunks));
  const pixels = Buffer.alloc(width * height * 4);
  let sourceOffset = 0;
  let previous = Buffer.alloc(stride);
  let current = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const filter = inflated[sourceOffset++];
    inflated.copy(current, 0, sourceOffset, sourceOffset + stride);
    sourceOffset += stride;
    unfilterScanline(current, previous, filter, bytesPerPixel);
    for (let x = 0; x < width; x++) {
      const src = x * bytesPerPixel;
      const dst = (y * width + x) * 4;
      pixels[dst] = current[src];
      pixels[dst + 1] = current[src + 1];
      pixels[dst + 2] = current[src + 2];
      pixels[dst + 3] = bytesPerPixel === 4 ? current[src + 3] : 255;
    }
    [previous, current] = [current, previous];
  }
  return { width, height, pixels };
}

function unfilterScanline(line, previous, filter, bytesPerPixel) {
  for (let i = 0; i < line.length; i++) {
    const left = i >= bytesPerPixel ? line[i - bytesPerPixel] : 0;
    const up = previous[i] ?? 0;
    const upLeft = i >= bytesPerPixel ? (previous[i - bytesPerPixel] ?? 0) : 0;
    if (filter === 1) {
      line[i] = (line[i] + left) & 0xff;
    } else if (filter === 2) {
      line[i] = (line[i] + up) & 0xff;
    } else if (filter === 3) {
      line[i] = (line[i] + Math.floor((left + up) / 2)) & 0xff;
    } else if (filter === 4) {
      line[i] = (line[i] + paethPredictor(left, up, upLeft)) & 0xff;
    } else if (filter !== 0) {
      throw new Error(`Unsupported PNG filter: ${filter}`);
    }
  }
}

function paethPredictor(left, up, upLeft) {
  const p = left + up - upLeft;
  const pa = Math.abs(p - left);
  const pb = Math.abs(p - up);
  const pc = Math.abs(p - upLeft);
  if (pa <= pb && pa <= pc) return left;
  if (pb <= pc) return up;
  return upLeft;
}

function samplePanelRegion(image) {
  const left = Math.floor(image.width * 0.24);
  const right = Math.floor(image.width * 0.98);
  const top = Math.floor(image.height * 0.14);
  const bottom = Math.floor(image.height * 0.9);
  const buckets = new Map();
  let sampled = 0;
  let sum = 0;
  let sumSquares = 0;
  let edgeCount = 0;
  let comparisons = 0;
  const step = Math.max(1, Math.floor(Math.min(image.width, image.height) / 240));
  for (let y = top; y < bottom; y += step) {
    for (let x = left; x < right; x += step) {
      const { r, g, b } = readPixel(image, x, y);
      const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      const bucket = `${r >> 4},${g >> 4},${b >> 4}`;
      buckets.set(bucket, (buckets.get(bucket) ?? 0) + 1);
      sampled++;
      sum += luma;
      sumSquares += luma * luma;
      if (x + step < right) {
        const next = readPixel(image, x + step, y);
        const nextLuma = 0.2126 * next.r + 0.7152 * next.g + 0.0722 * next.b;
        if (Math.abs(luma - nextLuma) > 18) edgeCount++;
        comparisons++;
      }
    }
  }
  const dominant = Math.max(0, ...buckets.values());
  const meanLuma = sum / Math.max(1, sampled);
  const variance = sumSquares / Math.max(1, sampled) - meanLuma * meanLuma;
  return {
    region: { left, top, right, bottom, width: right - left, height: bottom - top, step },
    sampled,
    uniqueBuckets: buckets.size,
    dominantRatio: dominant / Math.max(1, sampled),
    meanLuma,
    lumaStdDev: Math.sqrt(Math.max(0, variance)),
    edgeRatio: edgeCount / Math.max(1, comparisons),
  };
}

function readPixel(image, x, y) {
  const offset = (y * image.width + x) * 4;
  return {
    r: image.pixels[offset],
    g: image.pixels[offset + 1],
    b: image.pixels[offset + 2],
  };
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function shellCommand(args) {
  return args.map(shellQuote).join(" ");
}

function routeUrl(baseUrl, pathName) {
  const url = new URL(baseUrl);
  const basePath = url.pathname.replace(/\/+$/, "");
  url.pathname = `${basePath}${pathName}`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

async function postJson(baseUrl, pathName, body, token, timeoutMs = 15_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(routeUrl(baseUrl, pathName), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body ?? {}),
      signal: controller.signal,
    });
    const text = await res.text();
    const json = text ? JSON.parse(text) : {};
    if (!res.ok) {
      throw new Error(`${pathName} failed ${res.status}: ${JSON.stringify(json)}`);
    }
    return json;
  } finally {
    clearTimeout(timer);
  }
}

async function rpcHttp(baseUrl, shellToken, callerId, method, args = [], timeoutMs = 60_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const caller = { callerId, callerKind: "shell" };
  try {
    const res = await fetch(routeUrl(baseUrl, "/rpc"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${shellToken}`,
      },
      body: JSON.stringify({
        from: caller.callerId,
        target: "main",
        delivery: { caller },
        provenance: [caller],
        message: {
          type: "request",
          requestId: randomUUID(),
          fromId: caller.callerId,
          method,
          args,
        },
      }),
      signal: controller.signal,
    });
    const text = await res.text();
    const body = text ? JSON.parse(text) : {};
    const message = (body?.envelope ?? body)?.message;
    if (!res.ok || message?.error) {
      throw new Error(message?.error ?? body?.error ?? `/rpc failed ${res.status}`);
    }
    return message?.result;
  } finally {
    clearTimeout(timer);
  }
}

function describeHostTargetLaunch(result) {
  if (!result || typeof result !== "object") return "unknown launch result";
  const bits = [`status=${result.status ?? "unknown"}`];
  if (result.reason) bits.push(`reason=${result.reason}`);
  if (result.appId) bits.push(`app=${result.appId}`);
  if (result.buildKey) bits.push(`build=${result.buildKey}`);
  return bits.join(" ");
}

async function prewarmReactNativeAppLaunch(ready, timeoutMs) {
  if (!ready?.gatewayUrl || !ready?.adminToken) return false;
  const deadline = Date.now() + timeoutMs;
  let issued = null;
  try {
    issued = await postJson(
      ready.gatewayUrl,
      "/_r/s/auth/issue-device",
      { label: "Mobile smoke pre-warm", platform: "desktop" },
      ready.adminToken,
      Math.min(15_000, Math.max(1_000, deadline - Date.now()))
    );
    const shellToken = issued?.shellToken;
    const callerId = issued?.callerId ?? (issued?.deviceId ? `shell:${issued.deviceId}` : null);
    if (typeof shellToken !== "string" || typeof callerId !== "string") {
      throw new Error("admin-issued pre-warm credential did not include a shell token");
    }
    let last = null;
    while (Date.now() < deadline) {
      const remaining = Math.max(1_000, deadline - Date.now());
      last = await rpcHttp(
        ready.gatewayUrl,
        shellToken,
        callerId,
        "workspace.hostTargets.launch",
        ["react-native"],
        remaining
      );
      if (last?.status === "ready") return true;
      if (last?.status === "approval-required" || last?.status === "unavailable") {
        console.warn(`[mobile-smoke] pre-warm: ${describeHostTargetLaunch(last)}`);
        return false;
      }
      await sleep(Math.min(2_000, Math.max(1, deadline - Date.now())));
    }
    if (last) console.warn(`[mobile-smoke] pre-warm: ${describeHostTargetLaunch(last)}`);
    return false;
  } catch (error) {
    console.warn(
      `[mobile-smoke] pre-warm: active launch failed: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    return false;
  } finally {
    if (issued?.deviceId && ready?.gatewayUrl && ready?.adminToken) {
      await postJson(
        ready.gatewayUrl,
        "/_r/s/auth/revoke-device",
        { deviceId: issued.deviceId },
        ready.adminToken,
        10_000
      ).catch(() => {});
    }
  }
}

async function startConnectIntent(device, packageName, activityName, link) {
  const packageResult = await adbCapture(
    device,
    "shell",
    shellCommand([
      "am",
      "start",
      "-W",
      "-a",
      "android.intent.action.VIEW",
      "-d",
      link,
      "-p",
      packageName,
    ])
  ).catch((error) => error);
  if (!(packageResult instanceof Error)) return;

  await adb(
    device,
    "shell",
    shellCommand([
      "am",
      "start",
      "-W",
      "-a",
      "android.intent.action.VIEW",
      "-d",
      link,
      "-n",
      `${packageName}/${activityName}`,
    ])
  );
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const children = [];
  let cleanedUp = false;
  let emulatorChild = null;
  let launchedEmulator = false;
  let readyInfo = null;
  const readyFilePath = path.join(os.tmpdir(), `natstack-mobile-smoke-ready-${process.pid}.json`);
  const deadlineMs = Date.now() + options.timeoutMs;

  const cleanup = async () => {
    if (cleanedUp) return;
    cleanedUp = true;
    for (const child of children.reverse()) {
      if (child.exitCode == null && !child.killed) child.kill("SIGTERM");
    }
    if (emulatorChild && emulatorChild.exitCode == null && !emulatorChild.killed) {
      emulatorChild.kill("SIGTERM");
    }
    await Promise.all(children.map((child) => waitForChildExit(child)));
    if (emulatorChild) await waitForChildExit(emulatorChild);
    try {
      await fsp.unlink(readyFilePath);
    } catch {}
    if (readyInfo?.isEphemeral && readyInfo.workspaceDir) {
      try {
        await fsp.access(readyInfo.workspaceDir);
        console.warn(
          `[mobile-smoke] Ephemeral workspace still present after shutdown: ${readyInfo.workspaceDir}`
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
    if (!(await hasAdbDevice(options.device))) {
      if (!options.avd) {
        throw new Error(
          "No Android device/emulator detected. Start one first or pass --avd <name>."
        );
      }
      emulatorChild = spawnManaged(
        process.env.ANDROID_EMULATOR ?? "emulator",
        ["-avd", options.avd, "-no-snapshot", "-no-audio", "-no-boot-anim", "-no-window"],
        { label: "emulator" }
      );
      await waitForSpawn(emulatorChild, process.env.ANDROID_EMULATOR ?? "emulator", []);
      children.push(emulatorChild);
      launchedEmulator = true;
    }

    await waitForAndroidBoot(options.device);
    await ensureDeviceInteractive(options.device);

    if (!options.noInstall) {
      await runMobileInstall(options);
    } else if (!options.noBuild) {
      await runMobileInstall(options, { buildOnly: true });
    }

    if (options.noInstall && !options.noReset) {
      await adb(options.device, "shell", "pm", "clear", options.packageName);
    }
    if (options.noInstall) {
      await launchInstalledApp(options.device, options.packageName);
    }
    await ensureDeviceInteractive(options.device);

    try {
      await fsp.unlink(readyFilePath);
    } catch {}

    // 1. Local signaling (Cloudflare local runtime) — the WebRTC rendezvous. The
    //    phone reaches it over loopback via the adb-reversed signaling port.
    const signalPort = await findFreePort();
    // An emulator is NAT'd behind QEMU and can't hold a direct WebRTC pipe, so
    // relay it through a local coturn. Physical devices on the LAN don't need it.
    const useTurn = launchedEmulator || (options.device ?? "").startsWith("emulator-");
    let turn = null;
    if (useTurn) {
      turn = await startLocalTurn();
      children.push(turn.child);
      console.log(`[mobile-smoke] Local TURN relay (emulator NAT): turn:${turn.host}:${turn.port}`);
    }
    const signalingChild = await startSignaling(signalPort, turn);
    children.push(signalingChild);
    const signalUrl = `ws://127.0.0.1:${signalPort}`;

    // 2. The disposable server, as a WebRTC answerer. We pick the room + pairing
    //    code; the server presents its persistent DTLS cert and logs the
    //    natstack://connect link whose `fp` pins that cert.
    const room = randomUUID();
    const pairingCode = randomBytes(18).toString("base64url");
    const serverArgs = createServerArgs(readyFilePath);
    const serverInvocation = createServerInvocation(serverArgs);
    const serverEnv = {
      ...process.env,
      NODE_ENV: process.env.NODE_ENV ?? "development",
      NATSTACK_WEBRTC_SIGNAL_URL: signalUrl,
      NATSTACK_WEBRTC_ROOM: room,
      NATSTACK_PAIRING_CODE: pairingCode,
      // Force the single-workspace server path: `--serve-panels` with no workspace
      // otherwise boots the hub (no WebRTC answerer), so pairing never connects.
      NATSTACK_FORCE_WORKSPACE_SERVER: "1",
      // Auto-approve startup units so the declared react-native app BUILDS at
      // server startup instead of waiting for the post-pairing host-target
      // approval. That makes the launch fast, so the bundle starts streaming
      // seconds after pairing — on a fresh pipe — rather than ~75s in (by which
      // point the emulator's relay has degraded). See unitApprovalCoordinator.
      NATSTACK_AUTO_APPROVE_STARTUP_UNITS: "1",
      // Emulator: force relay-only through the local coturn (a direct NAT'd pipe
      // can't hold ICE consent freshness). The answerer threads this into the
      // pairing link's `ice=relay`, which the client honors.
      ...(turn ? { NATSTACK_WEBRTC_ICE: "relay" } : {}),
    };
    if (options.realModel) {
      delete serverEnv.NATSTACK_TEST_MODE;
    } else {
      serverEnv.NATSTACK_TEST_MODE = "1";
    }
    const serverChild = spawnManaged(serverInvocation.command, serverInvocation.args, {
      cwd: repoRoot,
      env: serverEnv,
      label: "server",
    });
    await waitForSpawn(serverChild, serverInvocation.command, serverInvocation.args);
    children.push(serverChild);
    // Capture the answerer's pairing link from stdout now (before readiness).
    const pairingLinkPromise = waitForPairingLink(
      serverChild,
      Math.max(1_000, deadlineMs - Date.now())
    );

    const ready = await waitForServerReady(
      readyFilePath,
      serverChild,
      Math.max(1_000, deadlineMs - Date.now())
    );
    readyInfo = ready;

    // The phone reaches the host's loopback services over adb reverse: the
    // signaling room (WebRTC rendezvous) and the gateway (native-bundle bootstrap
    // + panel HTTP). Remote reach is the encrypted WebRTC pipe — no Tailscale.
    await adb(options.device, "reverse", `tcp:${signalPort}`, `tcp:${signalPort}`);
    await adb(options.device, "reverse", `tcp:${ready.gatewayPort}`, `tcp:${ready.gatewayPort}`);
    await adb(options.device, "logcat", "-c");

    // Pre-warm: give the server time to BUILD the react-native app before pairing,
    // so the emulator's ~2-min relay window (the clock starts at the pairing tap)
    // is not consumed by the cold Metro extension + app build. Best-effort and
    // emulator/TURN-only — physical devices hold the pipe long enough regardless.
    if (useTurn) {
      console.log("[mobile-smoke] pre-warm: waiting for the react-native app build…");
      const prewarmBudgetMs = Math.min(150_000, Math.max(1_000, deadlineMs - Date.now()));
      let warm = await prewarmReactNativeAppLaunch(ready, prewarmBudgetMs);
      if (!warm) {
        warm = await waitForReactNativeAppReady(
          serverChild,
          Math.min(prewarmBudgetMs, Math.max(1_000, deadlineMs - Date.now()))
        );
      }
      console.log(`[mobile-smoke] pre-warm: ${warm ? "react-native app built" : "timed out, proceeding"}`);
    }

    // Embedded WebRTC flow (the host pairs + connects over the DTLS pipe in JS;
    // there is no native HTTP pairing). Phases are emitted by apps/mobile/index.js.
    const phases = [
      "embedded-deep-link-received",
      "embedded-pairing-complete",
      "embedded-workspace-selected",
      "embedded-host-target-approval-required",
      "embedded-host-target-preparing",
      "embedded-bundle-activate-start",
      "embedded-bundle-activate-complete",
      "workspace-connected",
      "workspace-panel-activate-start",
      "workspace-panel-materialized",
      "workspace-panel-webview-loaded",
    ];
    const pairingDeadlineMs = Date.now() + options.pairingTimeoutMs;
    const logcat = startLogcat(options.device, phases, pairingDeadlineMs);
    children.push(logcat.child);
    await waitForLogcatReady(options.device, logcat);

    const link = buildConnectLinkFromLog(await pairingLinkPromise);
    console.log(`[mobile-smoke] Signaling: ${signalUrl} (adb-reversed)`);
    console.log(`[mobile-smoke] Gateway:   ${ready.gatewayUrl} (adb-reversed)`);
    console.log(`[mobile-smoke] Connect:   ${link}`);
    await ensureDeviceInteractive(options.device);
    // The install helper may launch the app before the server is ready. Deliver
    // the connect link as a cold-start intent so React Native can read it
    // through Linking.getInitialURL instead of racing onNewIntent before the
    // JS listener is attached.
    await adb(options.device, "shell", "am", "force-stop", options.packageName).catch(() => null);
    await startConnectIntent(options.device, options.packageName, options.activityName, link);
    await logcat.waitForPhase("embedded-deep-link-received");
    await ensureDeviceInteractive(options.device);

    // The deep link surfaces a "Pair" button; tapping it starts WebRTC pairing.
    // The host then auto-selects the single workspace the room targets (no
    // workspace-picker tap), so wait straight through to the launch gate.
    if (!options.noTap) {
      await tapButtonByText(options.device, "Pair", pairingDeadlineMs);
    }
    await logcat.waitForPhase("embedded-pairing-complete");
    await logcat.waitForPhase("embedded-workspace-selected");
    // Startup-unit auto-approval pre-approves the host target, so the
    // approval-required + preparing phases are SKIPPED and the app goes straight to
    // bundle activation. Fire a best-effort "Trust and start" tap in the background
    // (for runs WITHOUT auto-approve) but never block on the approval phase — under
    // auto-approve the button never appears and activation has already begun.
    if (!options.noTap) {
      void tapOptionalButtonByText(options.device, "Trust and start", 12_000)
        .then((approved) => {
          if (approved) console.log("[mobile-smoke] Approved mobile workspace app launch gate");
        })
        .catch(() => {});
    }

    // Post-launch phases: bundle activate → workspace connect → panel webview loaded.
    // (approval-required + host-target-preparing are optional — skipped under auto-approve.)
    for (const phase of [
      "embedded-bundle-activate-start",
      "embedded-bundle-activate-complete",
      "workspace-connected",
      "workspace-panel-activate-start",
      "workspace-panel-materialized",
      "workspace-panel-webview-loaded",
    ]) {
      await waitForPhaseTappingApprovals(options.device, logcat, phase, pairingDeadlineMs);
    }
    const panelResult = await captureAndAssertPanelVisible(
      options.device,
      options.agentTimeoutMs,
      readyInfo,
      { realModel: options.realModel }
    );

    console.log(
      panelResult.agentTurnCompleted
        ? "[mobile-smoke] PASS clean QR/deep-link pairing reached workspace connection and completed the initial agent turn"
        : "[mobile-smoke] PASS clean QR/deep-link pairing reached workspace connection and rendered a nonblank panel"
    );
    await cleanup();
  } catch (error) {
    console.error(`[mobile-smoke] ${error instanceof Error ? error.message : String(error)}`);
    await cleanup();
    process.exit(1);
  }
}

await main();
