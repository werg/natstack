#!/usr/bin/env node
// Build and optionally install the trusted/internal Android APK used for
// phone-on-VPN testing. The internal variant is debug-signed and allows HTTP
// connections to private/VPN hosts.

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const androidDir = path.join(repoRoot, "apps", "mobile", "android");
const defaultApkPath = path.join(androidDir, "app", "build", "outputs", "apk", "internal", "app-internal.apk");
const defaultPackage = "com.natstack.mobile.internal";

function parseArgs(argv) {
  const options = {
    device: null,
    apkPath: defaultApkPath,
    packageName: defaultPackage,
    noBuild: false,
    buildOnly: false,
    launch: false,
    resetApp: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") {
      continue;
    } else if (arg === "--device") {
      options.device = argv[++i] ?? null;
    } else if (arg === "--apk") {
      options.apkPath = path.resolve(argv[++i] ?? "");
    } else if (arg === "--package") {
      options.packageName = argv[++i] ?? "";
    } else if (arg === "--no-build") {
      options.noBuild = true;
    } else if (arg === "--build-only") {
      options.buildOnly = true;
    } else if (arg === "--launch") {
      options.launch = true;
    } else if (arg === "--reset-app") {
      options.resetApp = true;
    } else if (arg === "--help") {
      options.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function printHelp() {
  console.log(`natstack mobile build/install

Usage:
  natstack mobile build
  natstack mobile install
  natstack mobile install --device <adb-serial> --launch

Options:
  --device <serial>    Target a specific adb device.
  --apk <path>         Install a specific APK path.
  --package <id>       Package id to reset/launch. Defaults to com.natstack.mobile.internal.
  --no-build           Install the existing APK without rebuilding.
  --build-only         Build the APK and skip adb install.
  --launch             Launch the app after install.
  --reset-app          Clear app data before install.
  --help               Show this help message.
`);
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? repoRoot,
      env: process.env,
      stdio: options.stdio ?? "inherit",
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(" ")} failed with code ${code}`));
    });
  });
}

function runCapture(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? repoRoot,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${command} ${args.join(" ")} failed with code ${code}\n${stderr || stdout}`));
    });
  });
}

function adbArgs(device, args) {
  return device ? ["-s", device, ...args] : args;
}

function parseAdbDevices(stdout) {
  return stdout
    .split(/\r?\n/)
    .slice(1)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [serial, state] = line.split(/\s+/, 2);
      return { serial, state, line };
    });
}

async function assertInstallTarget(device) {
  let result;
  try {
    result = await runCapture("adb", ["devices", "-l"]);
  } catch (error) {
    throw new Error(
      "adb is not available or failed to list devices. Install Android platform-tools and make sure adb is on PATH.\n" +
      String(error instanceof Error ? error.message : error),
    );
  }

  const devices = parseAdbDevices(result.stdout);
  if (device) {
    const match = devices.find((entry) => entry.serial === device);
    if (!match) {
      throw new Error(`adb does not see device "${device}".\n\n${result.stdout.trim() || "No adb output"}`);
    }
    if (match.state !== "device") {
      throw new Error(`adb sees "${device}" but it is "${match.state}". Unlock the phone and accept the USB debugging prompt.`);
    }
    return;
  }

  const ready = devices.filter((entry) => entry.state === "device");
  if (ready.length === 1) return;

  if (ready.length > 1) {
    throw new Error(
      "adb sees multiple install targets. Re-run with --device <serial>.\n\n" +
      result.stdout.trim(),
    );
  }

  if (devices.length > 0) {
    throw new Error(
      "adb sees a device, but it is not ready. Unlock the phone and accept the USB debugging prompt.\n\n" +
      result.stdout.trim(),
    );
  }

  throw new Error(
    "adb does not see any Android device or emulator.\n\n" +
    "Check that the phone is plugged in, Developer options are enabled, USB debugging is on, " +
    "the phone is unlocked, and the USB debugging authorization prompt has been accepted.\n" +
    "Then confirm with: adb devices -l",
  );
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  if (!options.buildOnly) {
    await assertInstallTarget(options.device);
  }

  if (!options.noBuild) {
    await run("./gradlew", ["assembleInternal"], { cwd: androidDir });
  }

  console.log(`[mobile-internal] APK: ${options.apkPath}`);
  if (options.buildOnly) return;

  if (options.resetApp) {
    try {
      await run("adb", adbArgs(options.device, ["shell", "pm", "clear", options.packageName]));
    } catch {
      // The app may not be installed yet; install can continue.
    }
  }

  await run("adb", adbArgs(options.device, ["install", "-r", "-d", options.apkPath]));

  if (options.launch) {
    await run("adb", adbArgs(options.device, [
      "shell",
      "monkey",
      "-p",
      options.packageName,
      "-c",
      "android.intent.category.LAUNCHER",
      "1",
    ]));
  }
}

try {
  await main();
} catch (error) {
  console.error(`[mobile-internal] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
