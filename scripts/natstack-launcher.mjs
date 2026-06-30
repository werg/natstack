#!/usr/bin/env node
// Unified `natstack` entry point for the npm-published packages.
//
// - @natstack/app ships this with Electron present: no args / `open` → launch
//   the desktop GUI; a recognized verb (remote, pair, mobile, fs, vcs, agent,
//   eval, --help, --version, ...) → delegate to the CLI client.
// - @natstack/server ships the same file but without Electron: every invocation
//   routes to the CLI (bare invocation prints CLI help).
//
// Both variants pin NATSTACK_APP_ROOT to the installed package so getAppRoot()
// resolves against the package, not the user's shell cwd (npx / global installs
// land in arbitrary directories — see src/server/index.ts:506, paths.ts:345).
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import * as path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const packageRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

if (!process.env["NATSTACK_APP_ROOT"]) {
  process.env["NATSTACK_APP_ROOT"] = packageRoot;
}

const argv = process.argv.slice(2);
// Explicit GUI verbs; bare invocation also opens the GUI when Electron exists.
const GUI_TRIGGERS = new Set(["open", "gui", "app", "--gui"]);
const wantsGui = argv.length === 0 || GUI_TRIGGERS.has(argv[0]);

function hasElectron() {
  try {
    require.resolve("electron");
    return true;
  } catch {
    return false;
  }
}

function packageName() {
  try {
    return require(path.join(packageRoot, "package.json")).name ?? null;
  } catch {
    return null;
  }
}

function forwardSignals(child) {
  const handlers = [];
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    const handler = () => {
      if (!child.killed) child.kill(signal);
    };
    handlers.push([signal, handler]);
    process.on(signal, handler);
  }
  return () => {
    for (const [signal, handler] of handlers) {
      process.off(signal, handler);
    }
  };
}

function endWith(cleanupSignals, code, signal) {
  cleanupSignals();
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
}

function launchCli(args) {
  const cli = path.join(packageRoot, "dist", "cli", "client.mjs");
  const child = spawn(process.execPath, [cli, ...args], { stdio: "inherit" });
  const cleanupSignals = forwardSignals(child);
  child.on("exit", (code, signal) => endWith(cleanupSignals, code, signal));
}

async function launchGui(args) {
  // Reuse the macOS-branded Electron resolver (installed mode: per-user cache +
  // ad-hoc re-sign). On non-darwin this returns the plain Electron binary.
  const { resolveElectronExecutableForNatStack } = await import(
    pathToFileURL(path.join(packageRoot, "scripts", "branded-electron.mjs")).href
  );
  const electronBinary = resolveElectronExecutableForNatStack({ installed: true });
  // Pass the package root as the app path; Electron loads `main` (dist/main.cjs)
  // and runs in the unpackaged mode resolved at src/main/paths.ts:183-189.
  const child = spawn(electronBinary, [packageRoot, ...args], {
    stdio: "inherit",
    env: {
      ...process.env,
      NODE_OPTIONS: "--max-old-space-size=3072",
      // Enable the in-app npm update notice (src/main/updateCheck.ts) — the
      // installed package name is the registry package to check against.
      ...(packageName() ? { NATSTACK_NPM_CHANNEL: packageName() } : {}),
    },
  });
  const cleanupSignals = forwardSignals(child);
  child.on("exit", (code, signal) => endWith(cleanupSignals, code, signal));
}

if (wantsGui && hasElectron()) {
  await launchGui(argv.filter((arg) => !GUI_TRIGGERS.has(arg)));
} else if (wantsGui) {
  // Server package (no Electron): bare invocation shows CLI help.
  launchCli(["--help"]);
} else {
  launchCli(argv);
}
