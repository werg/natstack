import fsp from "fs/promises";
import os from "os";
import path from "path";
import process from "process";
import net from "net";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { createPnpmInvocation } from "./lib/package-manager.mjs";
import { createServerInvocation, serverEntryArg } from "./lib/server-entry.mjs";
import { createConnectDeepLink } from "./lib/connect-utils.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const mobileDir = path.join(repoRoot, "apps", "mobile");
const androidDir = path.join(mobileDir, "android");
const appPackage = "com.natstack.mobile";
const appActivity = `${appPackage}/.MainActivity`;
const metroPort = 8081;
const apkPath = path.join(androidDir, "app", "build", "outputs", "apk", "debug", "app-debug.apk");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isPortOpen(host, port, timeoutMs = 500) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const finish = (result) => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
    socket.connect(port, host);
  });
}

function parseArgs(argv) {
  const options = {
    avd: null,
    device: null,
    resetApp: false,
    noMetro: false,
    noInstall: false,
    noLaunch: false,
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
    } else if (arg === "--reset-app") {
      options.resetApp = true;
    } else if (arg === "--no-metro") {
      options.noMetro = true;
    } else if (arg === "--no-install") {
      options.noInstall = true;
    } else if (arg === "--no-launch") {
      options.noLaunch = true;
    } else if (arg === "--help") {
      options.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function printHelp() {
  console.log(`natstack mobile dev

Usage:
  natstack mobile dev [options]

Runner options:
  --avd <name>      Start this AVD if no device is connected
  --device <serial> Use a specific adb device serial
  --reset-app       Clear app data before launch
  --no-metro        Do not start Metro
  --no-install      Do not build/install the Android app
  --no-launch       Do not launch the Android app after setup
  --help            Show this help message
`);
}

function prefixAndWrite(prefix, text, stream) {
  for (const line of text.split(/\r?\n/)) {
    if (!line) continue;
    stream.write(`[${prefix}] ${line}\n`);
  }
}

function pipeChildOutput(child, prefix) {
  child.stdout?.on("data", (chunk) => {
    prefixAndWrite(prefix, chunk.toString(), process.stdout);
  });
  child.stderr?.on("data", (chunk) => {
    prefixAndWrite(prefix, chunk.toString(), process.stderr);
  });
}

function spawnManaged(command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: repoRoot,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });
  pipeChildOutput(child, options.label ?? command);
  child.once("error", (error) => {
    prefixAndWrite(options.label ?? command, `Failed to start ${command}: ${error.message}`, process.stderr);
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
    if (child.exitCode != null) finish(new Error(`${command} ${args.join(" ")} exited before startup`));
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
      cwd: repoRoot,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      ...options,
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
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(`${command} ${args.join(" ")} failed with code ${code}\n${stderr || stdout}`));
      }
    });
  });
}

async function waitForServerReady(readyFile, serverChild, timeoutMs = 120_000) {
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

function makeAdbArgs(device, args) {
  return device ? ["-s", device, ...args] : args;
}

async function adb(device, ...args) {
  return runCommand("adb", makeAdbArgs(device, args), { label: "adb" });
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function shellCommand(args) {
  return args.map(shellQuote).join(" ");
}

async function startConnectIntent(device, link) {
  const packageResult = await adb(
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
      appPackage,
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
      appActivity,
    ])
  );
}

async function hasAdbDevice(device) {
  try {
    await adb(device, "get-state");
    return true;
  } catch {
    return false;
  }
}

async function waitForAndroidBoot(device, timeoutMs = 180_000) {
  await adb(device, "wait-for-device");
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const { stdout } = await adb(device, "shell", "getprop", "sys.boot_completed");
    if (stdout.trim() === "1") return;
    await sleep(1000);
  }
  throw new Error("Timed out waiting for Android boot completion");
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const startedChildren = [];
  let cleanedUp = false;
  let emulatorChild = null;
  let readyInfo = null;

  const cleanup = async (exitCode = 0) => {
    if (cleanedUp) return;
    cleanedUp = true;

    try {
      await fsp.unlink(readyFilePath);
    } catch {}

    for (const child of startedChildren.reverse()) {
      if (child.exitCode == null && !child.killed) {
        child.kill("SIGTERM");
      }
    }
    if (emulatorChild && emulatorChild.exitCode == null && !emulatorChild.killed) {
      emulatorChild.kill("SIGTERM");
    }
    await Promise.all(startedChildren.map((child) => waitForChildExit(child)));
    if (emulatorChild) {
      await waitForChildExit(emulatorChild);
    }
    if (readyInfo?.isEphemeral && readyInfo.workspaceDir) {
      try {
        await fsp.access(readyInfo.workspaceDir);
        console.warn(`[mobile-dev] Ephemeral workspace still present after shutdown: ${readyInfo.workspaceDir}`);
      } catch {
        // Server cleanup completed.
      }
    }
    process.exit(exitCode);
  };

  process.on("SIGINT", () => void cleanup(0));
  process.on("SIGTERM", () => void cleanup(0));

  const readyFilePath = path.join(os.tmpdir(), `natstack-mobile-ready-${process.pid}.json`);

  try {
    if (!await hasAdbDevice(options.device)) {
      if (!options.avd) {
        throw new Error("No Android device/emulator detected. Start one first or pass --avd <name>.");
      }
      emulatorChild = spawnManaged(process.env.ANDROID_EMULATOR ?? "emulator", ["-avd", options.avd, "-no-snapshot", "-no-audio", "-no-boot-anim", "-no-window"], {
        label: "emulator",
      });
    }

    if (emulatorChild) {
      startedChildren.push(emulatorChild);
    }

    await waitForAndroidBoot(options.device);

    let metroChild = null;
    if (!options.noMetro) {
      if (await isPortOpen("127.0.0.1", metroPort)) {
        console.log(`[mobile-dev] Reusing Metro on port ${metroPort}`);
      } else {
        const pnpmStart = createPnpmInvocation(["start"]);
        metroChild = spawnManaged(pnpmStart.command, pnpmStart.args, {
          cwd: mobileDir,
          env: {
            ...process.env,
            REACT_NATIVE_PACKAGER_HOSTNAME: "127.0.0.1",
          },
          label: "metro",
        });
        await waitForSpawn(metroChild, pnpmStart.command, pnpmStart.args);
        startedChildren.push(metroChild);
        await sleep(3000);
      }
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
    startedChildren.push(serverChild);

    const ready = await waitForServerReady(readyFilePath, serverChild);
    readyInfo = ready;
    const connectLink = createConnectDeepLink(
      ready.connectUrl ?? ready.gatewayUrl,
      ready.qrPairingCode ?? ready.pairingCode
    );

    await adb(options.device, "reverse", `tcp:${metroPort}`, `tcp:${metroPort}`);
    await adb(options.device, "reverse", `tcp:${ready.gatewayPort}`, `tcp:${ready.gatewayPort}`);

    if (!options.noInstall) {
      await runCommand("./gradlew", ["assembleDebug"], {
        cwd: androidDir,
        env: process.env,
        label: "gradle",
      });
      await adb(options.device, "install", "-r", "-d", apkPath);
    }

    if (options.resetApp) {
      await adb(options.device, "shell", "pm", "clear", appPackage);
    }

    if (!options.noLaunch) {
      await adb(options.device, "shell", "am", "force-stop", appPackage).catch(() => null);
      await startConnectIntent(options.device, connectLink);
    }

    console.log(`[mobile-dev] Ready`);
    console.log(`[mobile-dev] Workspace: ${ready.workspaceName}${ready.isEphemeral ? " (ephemeral)" : ""}`);
    console.log(`[mobile-dev] Gateway:   ${ready.gatewayUrl}`);
    console.log(`[mobile-dev] Device:    ${options.device ?? "default adb device"}`);

    serverChild.on("exit", (code) => {
      if (!cleanedUp) {
        console.error(`[mobile-dev] Server exited with code ${code ?? 1}`);
        void cleanup(code ?? 1);
      }
    });
    metroChild?.on("exit", (code) => {
      if (!cleanedUp) {
        console.error(`[mobile-dev] Metro exited with code ${code ?? 1}`);
        void cleanup(code ?? 1);
      }
    });
  } catch (error) {
    console.error(`[mobile-dev] ${error instanceof Error ? error.message : String(error)}`);
    await cleanup(1);
  }
}

void main();
