#!/usr/bin/env node
import { spawn } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { discoverNatstackServers } from "@natstack/shared/tailscaleDiscovery";
import {
  clearCliCredentials,
  loadCliCredentials,
  saveCliCredentials,
  credentialPath,
} from "./credentialStore.js";
import { completePairing, createPairingInvite, refreshShell } from "./remoteClient.js";

interface Options {
  url?: string;
  code?: string;
  link?: string;
  label?: string;
  ttlMs?: number;
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (!command || command === "--help" || command === "help") {
    printHelp();
    return 0;
  }
  if (command === "remote") return remote(rest);
  if (command === "mobile") return mobile(rest);
  console.error(`Unknown command: ${command}`);
  printHelp();
  return 2;
}

async function remote(argv: string[]): Promise<number> {
  const [subcommand, ...rest] = argv;
  if (!subcommand || subcommand === "--help" || subcommand === "help") {
    printRemoteHelp();
    return 0;
  }
  if (subcommand === "start" || subcommand === "desktop") {
    return runScript("remote-start.mjs", rest);
  }
  if (subcommand === "serve" || subcommand === "server") {
    return runScript("remote-serve.mjs", rest);
  }
  if (subcommand === "pair") return pair(rest);
  if (subcommand === "invite") return invite(rest);
  if (subcommand === "status") return status();
  if (subcommand === "logout") {
    clearCliCredentials();
    console.log("logged out");
    return 0;
  }
  if (subcommand === "discover") {
    const servers = await discoverNatstackServers();
    for (const server of servers) console.log(server.url);
    return 0;
  }
  console.error(`Unknown remote command: ${subcommand}`);
  printRemoteHelp();
  return 2;
}

async function mobile(argv: string[]): Promise<number> {
  const [subcommand, ...rest] = argv;
  if (!subcommand || subcommand === "--help" || subcommand === "help") {
    printMobileHelp();
    return 0;
  }
  if (subcommand === "pair") return runScript("mobile-pair.mjs", rest);
  if (subcommand === "dev") return runScript("mobile-dev.mjs", rest);
  if (subcommand === "smoke") return runScript("mobile-smoke.mjs", rest);
  if (subcommand === "build" || subcommand === "apk") {
    return runScript("mobile-install.mjs", ["--build-only", ...rest]);
  }
  if (subcommand === "install") return runScript("mobile-install.mjs", rest);
  if (subcommand === "logs") return runScript("mobile-logs.mjs", rest);
  if (subcommand === "emulator") return runScript("mobile-emulator.mjs", rest);
  console.error(`Unknown mobile command: ${subcommand}`);
  printMobileHelp();
  return 2;
}

function runScript(scriptName: string, argv: string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [path.join(repoRoot, "scripts", "cli", scriptName), ...argv],
      {
        cwd: repoRoot,
        env: process.env,
        stdio: "inherit",
      }
    );
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (signal) {
        process.kill(process.pid, signal);
        return;
      }
      resolve(code ?? 0);
    });
  });
}

async function pair(argv: string[]): Promise<number> {
  const opts = parseOptions(argv);
  if (argv[0] && argv[0].startsWith("natstack://")) {
    opts.link = argv[0];
  } else if (argv[0] && !argv[0].startsWith("--")) {
    opts.url = argv[0];
  }
  let creds;
  try {
    creds = await completePairing(opts);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
  saveCliCredentials(creds);
  console.log(`paired ${creds.url}`);
  console.log(`credentials: ${credentialPath()}`);
  return 0;
}

async function status(): Promise<number> {
  const creds = loadCliCredentials();
  if (!creds) {
    console.log("not paired");
    return 1;
  }
  let refresh;
  try {
    refresh = await refreshShell(creds);
  } catch (error) {
    console.log(`not connected: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  const response = await fetch(new URL("/healthz", creds.url));
  if (!response.ok) {
    console.log(`unreachable (${response.status})`);
    return 1;
  }
  const body = (await response.json()) as Record<string, unknown>;
  console.log(`connected: ${creds.url}`);
  if (typeof body["version"] === "string") console.log(`version: ${body["version"]}`);
  const workspaceId =
    typeof refresh["workspaceId"] === "string"
      ? refresh["workspaceId"]
      : typeof body["workspaceId"] === "string"
        ? body["workspaceId"]
        : undefined;
  if (workspaceId) console.log(`workspace: ${workspaceId}`);
  if (typeof refresh["serverId"] === "string") console.log(`server: ${refresh["serverId"]}`);
  return 0;
}

async function invite(argv: string[]): Promise<number> {
  const opts = parseOptions(argv);
  const creds = loadCliCredentials();
  if (!creds) {
    console.error("not paired");
    return 1;
  }
  let invite;
  try {
    invite = await createPairingInvite(creds, { ttlMs: opts.ttlMs });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
  console.log(`Pairing code: ${invite.code}`);
  console.log(`Pair URL: ${invite.deepLink}`);
  if (typeof invite.expiresAt === "number") {
    console.log(`Expires: ${new Date(invite.expiresAt).toISOString()}`);
  }
  return 0;
}

function parseOptions(argv: string[]): Options {
  const opts: Options = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--url") opts.url = argv[++i];
    else if (arg === "--code") opts.code = argv[++i];
    else if (arg === "--label") opts.label = argv[++i];
    else if (arg === "--ttl-ms") {
      const value = Number(argv[++i]);
      if (Number.isFinite(value)) opts.ttlMs = value;
    }
  }
  return opts;
}

function printHelp(): void {
  console.log(`natstack

Usage:
  natstack remote start [--pair <link>]
  natstack remote serve [--host tailscale] [--port 3030]
  natstack remote pair "natstack://connect?url=...&code=..."
  natstack remote invite [--ttl-ms <milliseconds>]
  natstack remote status
  natstack mobile pair [--host tailscale] [--port 3030]
  natstack mobile build
  natstack mobile install [--launch]
  natstack mobile dev
  natstack mobile smoke [--device <serial>]

Credentials are stored as a 0600 JSON file at ${credentialPath()}.
`);
}

function printRemoteHelp(): void {
  console.log(`natstack remote

Usage:
  natstack remote start [--pair <link>]
  natstack remote start
  natstack remote serve [--host tailscale] [--port 3030]
  natstack remote pair "natstack://connect?url=...&code=..."
  natstack remote invite [--ttl-ms <milliseconds>]
  natstack remote status
  natstack remote logout
  natstack remote discover

Notes:
  start launches Electron against the paired remote server.
  start uses built Electron artifacts even when invoked through pnpm cli.
  serve starts a QR/deep-link pairing server for phones and laptops.
  pair saves the CLI device credential without launching Electron.
`);
}

function printMobileHelp(): void {
  console.log(`natstack mobile

Usage:
  natstack mobile pair [--host tailscale] [--port 3030]
  natstack mobile dev [--avd <name>] [--device <serial>]
  natstack mobile smoke [--avd <name>] [--device <serial>]
  natstack mobile build
  natstack mobile install [--device <serial>] [--launch]
  natstack mobile logs [--device <serial>]
  natstack mobile emulator [--avd <name>]

Notes:
  pair starts the QR/deep-link pairing server.
  dev starts Metro, a disposable local server, installs the debug APK, and launches it.
  smoke verifies the installed internal APK can accept a connect link and reach the workspace app.
  build and install use the trusted internal Android variant.
`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    });
}
