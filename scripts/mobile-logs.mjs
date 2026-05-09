#!/usr/bin/env node
// Tail adb logcat for the NatStack Android app process.

import { spawn } from "node:child_process";

function parseArgs(argv) {
  const options = {
    device: null,
    packageName: "com.natstack.mobile.internal",
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") {
      continue;
    } else if (arg === "--device") {
      options.device = argv[++i] ?? null;
    } else if (arg === "--package") {
      options.packageName = argv[++i] ?? "";
    } else if (arg === "--help") {
      options.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function printHelp() {
  console.log(`mobile-logs

Usage:
  pnpm mobile:logs:internal
  pnpm mobile:logs:internal --device <adb-serial>

Options:
  --device <serial>  Target a specific adb device.
  --package <id>     App package to inspect. Defaults to com.natstack.mobile.internal.
  --help             Show this help message.
`);
}

function adbArgs(device, args) {
  return device ? ["-s", device, ...args] : args;
}

function runCapture(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
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

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const pidResult = await runCapture("adb", adbArgs(options.device, ["shell", "pidof", options.packageName]));
  const pid = pidResult.stdout.trim().split(/\s+/)[0];
  if (!pid) {
    throw new Error(`Could not find a running process for ${options.packageName}. Launch the app first.`);
  }

  console.log(`[mobile-logs] Tailing ${options.packageName} pid ${pid}. Press Ctrl-C to stop.`);
  const child = spawn("adb", adbArgs(options.device, ["logcat", "--pid", pid, "-v", "time"]), {
    stdio: "inherit",
  });

  child.on("exit", (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exit(code ?? 0);
  });

  process.on("SIGINT", () => child.kill("SIGINT"));
  process.on("SIGTERM", () => child.kill("SIGTERM"));
}

try {
  await main();
} catch (error) {
  console.error(`[mobile-logs] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
