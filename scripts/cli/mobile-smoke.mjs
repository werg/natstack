#!/usr/bin/env node
// End-to-end Android smoke test for a fresh internal app install accepting a
// natstack://connect QR/deep link, activating the served RN bundle, connecting
// the workspace app, and rendering a panel WebView.

import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { inflateSync } from "node:zlib";
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
const screenshotDir = path.join(repoRoot, "test-results", "mobile-smoke");

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
the Pair screen, then waits for native bundle activation, workspace connection,
panel materialization, and panel WebView load log markers.
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

async function tapOptionalButtonByText(device, text, timeoutMs = 6_000) {
  const deadlineMs = Date.now() + timeoutMs;
  const dumpPath = "/sdcard/natstack-mobile-smoke-window.xml";
  while (Date.now() < deadlineMs) {
    await adbCapture(device, "shell", "uiautomator", "dump", dumpPath).catch(() => null);
    const result = await adbCapture(device, "exec-out", "cat", dumpPath).catch(() => null);
    const xml = result?.stdout ?? "";
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
  const dumpPath = "/sdcard/natstack-mobile-smoke-window.xml";
  while (Date.now() < deadlineMs) {
    await adbCapture(device, "shell", "uiautomator", "dump", dumpPath).catch(() => null);
    const result = await adbCapture(device, "exec-out", "cat", dumpPath).catch(() => null);
    const xml = result?.stdout ?? "";
    const bounds = findNodeBounds(xml, text, { labelPrefix: true });
    if (bounds) {
      await adb(device, "shell", "input", "tap", String(bounds.x), String(bounds.y));
      return true;
    }
    await sleep(500);
  }
  return false;
}

function findNodeBounds(xml, text, options = {}) {
  const pattern = /<node\b[^>]*>/g;
  let match;
  const expected = text.toLowerCase();
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

async function captureAndAssertPanelVisible(device) {
  await sleep(2_000);
  if (await tapOptionalButtonByText(device, "Approve all", 2_000)) {
    await sleep(2_000);
  }
  if (await tapOptionalButtonByLabelPrefix(device, "Use once", 2_000)) {
    await sleep(3_000);
  }
  await assertNoBlockingPermissionDialog(device);
  await fsp.mkdir(screenshotDir, { recursive: true });
  const screenshotPath = path.join(screenshotDir, `panel-${new Date().toISOString().replace(/[:.]/g, "-")}.png`);
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
}

async function assertNoBlockingPermissionDialog(device) {
  const dumpPath = "/sdcard/natstack-mobile-smoke-window.xml";
  await adbCapture(device, "shell", "uiautomator", "dump", dumpPath).catch(() => null);
  const result = await adbCapture(device, "exec-out", "cat", dumpPath).catch(() => null);
  const xml = result?.stdout ?? "";
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
    const upLeft = i >= bytesPerPixel ? previous[i - bytesPerPixel] ?? 0 : 0;
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
      "workspace-panel-activate-start",
      "workspace-panel-materialized",
      "workspace-panel-webview-loaded",
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
    await captureAndAssertPanelVisible(options.device);

    console.log(
      "[mobile-smoke] PASS clean QR/deep-link pairing reached workspace connection and visibly loaded a panel WebView"
    );
    await cleanup();
  } catch (error) {
    console.error(`[mobile-smoke] ${error instanceof Error ? error.message : String(error)}`);
    await cleanup();
    process.exit(1);
  }
}

await main();
