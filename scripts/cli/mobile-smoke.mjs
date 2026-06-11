#!/usr/bin/env node
// End-to-end Android smoke test for a fresh internal app install accepting a
// natstack://connect QR/deep link, activating the served RN bundle, and
// connecting the workspace app.

import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  createServerInvocation,
  serverEntryArg,
  serverEntryDescription,
} from "./lib/server-entry.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const androidDir = path.join(repoRoot, "apps", "mobile", "android");
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
    timeoutMs: 180_000,
    serverArgs: [],
    help: false,
  };

  let passthrough = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (passthrough) {
      options.serverArgs.push(arg);
      continue;
    }
    if (arg === "--") {
      passthrough = true;
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
    } else if (arg === "--timeout-ms") {
      options.timeoutMs = parsePositiveInt(argv[++i], "--timeout-ms");
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
  natstack mobile smoke [runner options] [-- server options]

Runner options:
  --avd <name>        Start this AVD if no adb device is connected.
  --device <serial>   Target a specific adb device serial.
  --apk <path>        Install a specific APK path.
  --package <id>      App package. Defaults to ${defaultPackage}.
  --activity <class>  Main activity class. Defaults to ${defaultActivity}.
  --no-build          Use the existing internal APK without rebuilding.
  --no-install        Skip APK install.
  --no-reset          Do not clear app data before pairing.
  --no-tap            Do not automate the Pair button tap.
  --timeout-ms <ms>   Overall smoke timeout. Defaults to 180000.
  --help              Show this help message.

Everything after '--' is forwarded to ${serverEntryDescription()}.

The smoke starts a disposable local server, reverses its gateway port through
adb, sends a natstack://connect intent to the installed internal app, confirms
the Pair screen, then waits for native bundle activation and workspace connect
log markers.
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

function createConnectLink(ready) {
  const serverUrl = ready.connectUrl || ready.gatewayUrl;
  const code = ready.qrPairingCode || ready.pairingCode;
  if (!serverUrl) throw new Error("Ready file did not include connectUrl or gatewayUrl");
  if (!code) throw new Error("Ready file did not include qrPairingCode or pairingCode");
  return `natstack://connect?url=${encodeURIComponent(serverUrl)}&code=${encodeURIComponent(code)}`;
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

  return { child, waitForPhase };
}

async function tapButtonByText(device, text, deadlineMs) {
  const dumpPath = "/sdcard/natstack-mobile-smoke-window.xml";
  while (Date.now() < deadlineMs) {
    await adbCapture(device, "shell", "uiautomator", "dump", dumpPath).catch(() => null);
    const result = await adbCapture(device, "exec-out", "cat", dumpPath).catch(() => null);
    const xml = result?.stdout ?? "";
    const bounds = findNodeBounds(xml, text);
    if (bounds) {
      await adb(device, "shell", "input", "tap", String(bounds.x), String(bounds.y));
      return;
    }
    await sleep(500);
  }
  throw new Error(`Timed out waiting for visible Android button "${text}"`);
}

function findNodeBounds(xml, text) {
  const pattern = /<node\b[^>]*>/g;
  let match;
  while ((match = pattern.exec(xml))) {
    const node = match[0];
    const label = readXmlAttribute(node, "text") || readXmlAttribute(node, "content-desc");
    if (label.toLowerCase() !== text.toLowerCase()) continue;
    const boundsMatch = node.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
    if (!boundsMatch) continue;
    const left = Number(boundsMatch[1]);
    const top = Number(boundsMatch[2]);
    const right = Number(boundsMatch[3]);
    const bottom = Number(boundsMatch[4]);
    if ([left, top, right, bottom].every(Number.isFinite) && right > left && bottom > top) {
      return {
        x: Math.round((left + right) / 2),
        y: Math.round((top + bottom) / 2),
      };
    }
  }
  return null;
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

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function shellCommand(args) {
  return args.map(shellQuote).join(" ");
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
    }

    await waitForAndroidBoot(options.device);

    if (!options.noBuild) {
      await runCommand("./gradlew", ["assembleInternal"], {
        cwd: androidDir,
        env: process.env,
        label: "gradle",
      });
    }

    if (!options.noInstall) {
      await adb(options.device, "install", "-r", "-d", options.apkPath);
    }

    if (!options.noReset) {
      await adb(options.device, "shell", "pm", "clear", options.packageName);
    }

    try {
      await fsp.unlink(readyFilePath);
    } catch {}

    const serverArgs = [
      serverEntryArg(),
      "--app-root",
      repoRoot,
      "--ready-file",
      readyFilePath,
      "--ephemeral",
      "--host",
      "127.0.0.1",
      "--bind-host",
      "127.0.0.1",
      "--serve-panels",
      "--print-credentials",
      "--require-mobile-ready",
      "--no-vpn-detect",
      ...options.serverArgs,
    ];
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
      readyFilePath,
      serverChild,
      Math.max(1_000, deadlineMs - Date.now())
    );
    readyInfo = ready;

    await adb(options.device, "reverse", `tcp:${ready.gatewayPort}`, `tcp:${ready.gatewayPort}`);
    await adb(options.device, "logcat", "-c");

    const phases = [
      "embedded-deep-link-received",
      "embedded-pairing-complete",
      "native-pairing-complete",
      "native-bundle-bootstrap-fetched",
      "native-bundle-prepared",
      "native-bundle-activated",
      "native-rn-reload-requested",
      "workspace-connected",
    ];
    const logcat = startLogcat(options.device, phases, deadlineMs);
    children.push(logcat.child);

    const link = createConnectLink(ready);
    console.log(`[mobile-smoke] Gateway: ${ready.gatewayUrl}`);
    console.log(`[mobile-smoke] Connect URL: ${ready.connectUrl || ready.gatewayUrl}`);
    await startConnectIntent(options.device, options.packageName, options.activityName, link);
    await logcat.waitForPhase("embedded-deep-link-received");

    if (!options.noTap) {
      await tapButtonByText(options.device, "Pair", deadlineMs);
    }

    for (const phase of phases.slice(1)) {
      await logcat.waitForPhase(phase);
    }

    console.log("[mobile-smoke] PASS clean QR/deep-link pairing reached workspace connection");
    await cleanup();
  } catch (error) {
    console.error(`[mobile-smoke] ${error instanceof Error ? error.message : String(error)}`);
    await cleanup();
    process.exit(1);
  }
}

await main();
