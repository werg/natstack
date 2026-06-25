#!/usr/bin/env node
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { discoverNatstackServers } from "@natstack/shared/tailscaleDiscovery";
import { appendServerPath, isSelectedWorkspaceUrl } from "@natstack/shared/connect";
import {
  clearCliCredentials,
  loadCliCredentials,
  saveCliCredentials,
  credentialPath,
} from "./credentialStore.js";
import {
  createPairingInvite,
  listRemoteWorkspaces,
  pairRemoteServer,
  selectRemoteWorkspace,
  type PairOptions,
  type RemoteWorkspaceEntry,
} from "./remoteClient.js";
import { refreshShell, type DeviceCredential } from "./rpcClient.js";
import { runTerminalLaunchGate } from "./terminalLaunchGate.js";
import { agentCommands } from "./agent/index.js";
import { fsCommands } from "./agent/fsCommands.js";
import { vcsCommands } from "./agent/vcsCommands.js";
import { evalCommands } from "./agent/evalCommand.js";
import {
  findCommand,
  groupCommands,
  parseInvocation,
  renderCommandHelp,
  renderGroupHelp,
  JSON_FLAG,
  type CliCommand,
  type ParsedInvocation,
} from "./commandTable.js";
import { AuthError, UsageError, jsonMode, printError, printResult } from "./output.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

// ───────────────────────────────────────────────────────────────────────────
// remote commands
// ───────────────────────────────────────────────────────────────────────────

async function remotePair(inv: ParsedInvocation): Promise<number> {
  const json = jsonMode(inv.flags["json"] === true);
  const opts: { url?: string; code?: string; link?: string; label?: string } = {};
  if (typeof inv.flags["url"] === "string") opts.url = inv.flags["url"];
  if (typeof inv.flags["code"] === "string") opts.code = inv.flags["code"];
  if (typeof inv.flags["label"] === "string") opts.label = inv.flags["label"];
  const positional = inv.positionals[0];
  if (positional?.startsWith("natstack://")) opts.link = positional;
  else if (positional) opts.url = positional;
  try {
    const creds = await pairRemoteServer(opts);
    saveCliCredentials(creds);
    const result = { url: creds.url, credentialPath: credentialPath() };
    printResult(result, {
      json,
      human: () => {
        console.log(`paired ${result.url}`);
        console.log(`credentials: ${result.credentialPath}`);
      },
    });
    return 0;
  } catch (error) {
    return printError(error, { json });
  }
}

async function remoteStatus(inv: ParsedInvocation): Promise<number> {
  const json = jsonMode(inv.flags["json"] === true);
  try {
    const creds = loadCliCredentials();
    if (!creds) throw new AuthError("not paired");
    if (!creds.workspaceName || !isSelectedWorkspaceUrl(creds.url)) {
      throw new AuthError(
        "no remote workspace selected - run `natstack remote select <workspace>`"
      );
    }
    const refresh = await refreshShell(creds);
    const response = await fetch(appendServerPath(creds.url, "/healthz"));
    if (!response.ok) throw new AuthError(`unreachable (${response.status})`);
    const body = (await response.json()) as Record<string, unknown>;
    const result = {
      url: creds.url,
      version: typeof body["version"] === "string" ? body["version"] : undefined,
      workspaceId:
        refresh.workspaceId ??
        (typeof body["workspaceId"] === "string" ? body["workspaceId"] : undefined),
      serverId: refresh.serverId,
    };
    printResult(result, {
      json,
      human: () => {
        console.log(`connected: ${result.url}`);
        if (result.version) console.log(`version: ${result.version}`);
        if (result.workspaceId) console.log(`workspace: ${result.workspaceId}`);
        if (result.serverId) console.log(`server: ${result.serverId}`);
      },
    });
    return 0;
  } catch (error) {
    return printError(error, { json });
  }
}

async function remoteInvite(inv: ParsedInvocation): Promise<number> {
  const json = jsonMode(inv.flags["json"] === true);
  try {
    const creds = loadCliCredentials();
    if (!creds) throw new AuthError("not paired");
    let ttlMs: number | undefined;
    if (typeof inv.flags["ttl-ms"] === "string") {
      const value = Number(inv.flags["ttl-ms"]);
      if (!Number.isFinite(value)) {
        throw new UsageError(`--ttl-ms must be a number, got: ${inv.flags["ttl-ms"]}`);
      }
      ttlMs = value;
    }
    if (!creds.hubUrl) throw new AuthError("stored credential is missing a hub URL; pair again");
    const invite = await createPairingInvite({ ...creds, url: creds.hubUrl }, { ttlMs });
    printResult(invite, {
      json,
      human: () => {
        console.log(`Pairing code: ${invite.code}`);
        console.log(`Pair URL: ${invite.deepLink}`);
        if (typeof invite.expiresAt === "number") {
          console.log(`Expires: ${new Date(invite.expiresAt).toISOString()}`);
        }
      },
    });
    return 0;
  } catch (error) {
    return printError(error, { json });
  }
}

async function remoteWorkspaceList(inv: ParsedInvocation): Promise<number> {
  const json = jsonMode(inv.flags["json"] === true);
  try {
    const creds = loadCliCredentials();
    if (!creds) throw new AuthError("not paired");
    const workspaces = await listRemoteWorkspaces(creds);
    printResult(
      { workspaces },
      {
        json,
        human: () => {
          for (const workspace of workspaces) {
            console.log(`${workspace.name}${workspace.running ? " (running)" : ""}`);
          }
        },
      }
    );
    return 0;
  } catch (error) {
    return printError(error, { json });
  }
}

async function remoteWorkspaceSelect(inv: ParsedInvocation): Promise<number> {
  const json = jsonMode(inv.flags["json"] === true);
  try {
    const name =
      inv.positionals[0] ??
      (typeof inv.flags["workspace"] === "string" ? inv.flags["workspace"] : "");
    if (!name) throw new UsageError("workspace name is required");
    const creds = loadCliCredentials();
    if (!creds) throw new AuthError("not paired");
    const selected = await selectRemoteWorkspace(creds, name);
    saveCliCredentials(selected);
    printResult(
      {
        workspaceName: selected.workspaceName,
        url: selected.url,
        credentialPath: credentialPath(),
      },
      {
        json,
        human: () => {
          console.log(`workspace: ${selected.workspaceName}`);
          console.log(`server: ${selected.url}`);
        },
      }
    );
    return 0;
  } catch (error) {
    return printError(error, { json });
  }
}

function terminalPairOptions(inv: ParsedInvocation): PairOptions | null {
  const opts: PairOptions = {};
  if (typeof inv.flags["pair"] === "string") opts.link = inv.flags["pair"];
  if (typeof inv.flags["url"] === "string") opts.url = inv.flags["url"];
  if (typeof inv.flags["code"] === "string") opts.code = inv.flags["code"];
  if (typeof inv.flags["label"] === "string") opts.label = inv.flags["label"];

  const positional = inv.positionals[0];
  if (positional?.startsWith("natstack://")) opts.link = positional;
  else if (positional) {
    throw new UsageError(
      `Unexpected argument for terminal start: ${positional}. Pass a natstack://connect link with --pair.`
    );
  }

  if (opts.link || opts.url || opts.code) {
    if (!opts.label) opts.label = `Terminal on ${os.hostname()}`;
    opts.platform = "terminal";
    return opts;
  }
  if (opts.label) {
    throw new UsageError("--label is only valid when pairing with --pair or --url/--code");
  }
  return null;
}

async function terminalCredentials(
  inv: ParsedInvocation,
  json: boolean
): Promise<DeviceCredential> {
  const requestedWorkspace =
    typeof inv.flags["workspace"] === "string" ? inv.flags["workspace"].trim() : undefined;
  const pairOptions = terminalPairOptions(inv);
  let creds: DeviceCredential;
  if (pairOptions) {
    creds = await pairRemoteServer(pairOptions);
    saveCliCredentials(creds);
    if (!json) console.log(`paired ${creds.url}`);
  } else {
    const loaded = loadCliCredentials();
    if (!loaded) {
      throw new AuthError(
        'not paired - run `natstack terminal start --pair "natstack://connect?url=...&code=..."`'
      );
    }
    creds = loaded;
  }

  if (requestedWorkspace || !creds.workspaceName) {
    creds = await chooseTerminalWorkspace(creds, { requestedWorkspace, json });
    saveCliCredentials(creds);
  }
  if (!isSelectedWorkspaceUrl(creds.url)) {
    throw new AuthError(
      "stored remote credential is not scoped to a workspace; select a workspace"
    );
  }
  return creds;
}

async function chooseTerminalWorkspace(
  creds: DeviceCredential,
  opts: { requestedWorkspace?: string; json: boolean }
): Promise<DeviceCredential> {
  if (!creds.hubUrl) throw new AuthError("stored credential is missing a hub URL; pair again");
  if (opts.requestedWorkspace) {
    return await selectRemoteWorkspace(creds, opts.requestedWorkspace);
  }
  const workspaces = await listRemoteWorkspaces(creds);
  if (workspaces.length === 0) {
    throw new AuthError("server has no workspaces to open");
  }
  if (opts.json || !process.stdin.isTTY) {
    throw new UsageError(
      `choose a workspace with --workspace <name> (${workspaces
        .map((workspace) => workspace.name)
        .join(", ")})`
    );
  }
  const selected = await promptWorkspaceSelection(workspaces);
  return await selectRemoteWorkspace(creds, selected);
}

async function promptWorkspaceSelection(workspaces: RemoteWorkspaceEntry[]): Promise<string> {
  console.log("Choose a workspace:");
  workspaces.forEach((workspace, index) => {
    const status = workspace.running ? " running" : "";
    console.log(`  ${index + 1}. ${workspace.name}${status}`);
  });
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    while (true) {
      const answer = (await rl.question("Workspace: ")).trim();
      const numeric = Number(answer);
      if (Number.isInteger(numeric) && numeric >= 1 && numeric <= workspaces.length) {
        const selected = workspaces[numeric - 1];
        if (selected) return selected.name;
      }
      const byName = workspaces.find((workspace) => workspace.name === answer);
      if (byName) return byName.name;
      console.log("Enter a workspace number or name.");
    }
  } finally {
    rl.close();
  }
}

async function terminalStart(inv: ParsedInvocation): Promise<number> {
  const json = jsonMode(inv.flags["json"] === true);
  try {
    const creds = await terminalCredentials(inv, json);
    const result = await runTerminalLaunchGate(creds, {
      target: "terminal",
      yes: inv.flags["yes"] === true,
      json,
    });
    printResult(result, {
      json,
      human: () => {
        if (result.status === "ready") {
          const launch = result.launch?.status === "ready" ? result.launch : null;
          console.log(`terminal app started${launch?.appId ? `: ${launch.appId}` : ""}`);
          if (launch?.buildKey) console.log(`build: ${launch.buildKey}`);
          if (result.approvalsResolved > 0) {
            console.log(`approvals resolved: ${result.approvalsResolved}`);
          }
          return;
        }
        if (result.status === "denied") {
          console.log("terminal app startup denied");
          return;
        }
        if (result.launch?.status === "unavailable") {
          const details = result.launch.details.length
            ? `: ${result.launch.details.join("; ")}`
            : "";
          console.log(`${result.launch.reason}${details}`);
          return;
        }
        if (result.launch?.status === "preparing") {
          const details = result.launch.details.length
            ? `: ${result.launch.details.join("; ")}`
            : "";
          console.log(`${result.launch.reason}${details}`);
          return;
        }
        console.log(`terminal app did not start: ${result.status}`);
      },
    });
    return result.status === "ready" ? 0 : 1;
  } catch (error) {
    return printError(error, { json });
  }
}

function scriptCommand(
  group: string,
  name: string,
  scriptName: string,
  summary: string,
  options: {
    aliases?: string[];
    usage?: string;
    prependArgs?: string[];
    passthroughHelp?: boolean;
  } = {}
): CliCommand {
  return {
    group,
    name,
    aliases: options.aliases,
    summary,
    usage: options.usage,
    passthrough: true,
    ...(options.passthroughHelp ? { passthroughHelp: true } : {}),
    run: (_inv, rawArgs) => runScript(scriptName, [...(options.prependArgs ?? []), ...rawArgs]),
  };
}

const remoteCommands: CliCommand[] = [
  scriptCommand("remote", "serve", "remote-serve.mjs", "Start a QR/deep-link pairing server", {
    aliases: ["server"],
    usage: "natstack remote serve [--host tailscale] [--port 3030]",
    // The pair server's own help documents the resolved server entry.
    passthroughHelp: true,
  }),
  {
    group: "remote",
    name: "pair",
    summary: "Save a CLI device credential without launching Electron",
    usage: 'natstack remote pair "natstack://connect?url=...&code=..."',
    flags: [
      { name: "url", takesValue: true, description: "Server URL (with --code)" },
      { name: "code", takesValue: true, description: "Pairing code (with --url)" },
      { name: "label", takesValue: true, description: "Device label shown on the server" },
      JSON_FLAG,
    ],
    run: remotePair,
  },
  {
    group: "remote",
    name: "invite",
    summary: "Create a pairing invite for another device",
    usage: "natstack remote invite [--ttl-ms <milliseconds>]",
    flags: [{ name: "ttl-ms", takesValue: true }, JSON_FLAG],
    run: remoteInvite,
  },
  {
    group: "remote",
    name: "status",
    summary: "Check the stored credential against the server",
    usage: "natstack remote status",
    flags: [JSON_FLAG],
    run: remoteStatus,
  },
  {
    group: "remote",
    name: "workspaces",
    summary: "List workspaces on the paired server",
    usage: "natstack remote workspaces",
    flags: [JSON_FLAG],
    run: remoteWorkspaceList,
  },
  {
    group: "remote",
    name: "select",
    summary: "Select a workspace on the paired server",
    usage: "natstack remote select <workspace>",
    flags: [{ name: "workspace", takesValue: true }, JSON_FLAG],
    run: remoteWorkspaceSelect,
  },
  {
    group: "remote",
    name: "terminal",
    summary: "Review approvals and start the selected terminal app",
    usage: "natstack remote terminal [--pair <link>] [--workspace <name>] [--yes]",
    flags: [
      {
        name: "pair",
        takesValue: true,
        description: "Pair from a natstack://connect link before starting",
      },
      { name: "url", takesValue: true, description: "Server URL for --code pairing" },
      { name: "code", takesValue: true, description: "Pairing code for --url pairing" },
      { name: "label", takesValue: true, description: "Device label used while pairing" },
      { name: "workspace", takesValue: true, description: "Remote workspace to open" },
      {
        name: "yes",
        takesValue: false,
        description: "Approve each terminal startup approval once without prompting",
      },
      JSON_FLAG,
    ],
    run: terminalStart,
  },
  {
    group: "remote",
    name: "logout",
    summary: "Remove the stored CLI device credential",
    usage: "natstack remote logout",
    flags: [JSON_FLAG],
    run: async (inv) => {
      const json = jsonMode(inv.flags["json"] === true);
      clearCliCredentials();
      printResult({ loggedOut: true }, { json, human: () => console.log("logged out") });
      return 0;
    },
  },
  {
    group: "remote",
    name: "discover",
    summary: "Print NatStack servers discovered on the tailnet",
    usage: "natstack remote discover",
    flags: [JSON_FLAG],
    run: async (inv) => {
      const json = jsonMode(inv.flags["json"] === true);
      const servers = await discoverNatstackServers();
      printResult(servers, {
        json,
        human: () => {
          for (const server of servers) console.log(server.url);
        },
      });
      return 0;
    },
  },
  {
    group: "remote",
    name: "host",
    aliases: ["headless-host"],
    summary: "Run a headless Chromium panel host against the paired server",
    usage:
      "natstack remote host [--url <serverUrl> --token <shellToken>] [--label <name>] " +
      "[--max-panels 8] [--idle-unload-min 5] [--idle-exit-min 0] [--chromium-path <bin>] [--lean-browser]",
    flags: [
      { name: "url", takesValue: true, description: "Server URL (defaults to the paired server)" },
      {
        name: "token",
        takesValue: true,
        description: "Shell token (defaults to device-credential refresh)",
      },
      { name: "label", takesValue: true, description: "Client label shown in lease holders" },
      { name: "max-panels", takesValue: true, description: "Concurrent hosted panels (default 8)" },
      {
        name: "idle-unload-min",
        takesValue: true,
        description: "Unload panels idle this long (default 5)",
      },
      {
        name: "idle-exit-min",
        takesValue: true,
        description: "Self-exit after holding zero leases this long (default: never)",
      },
      { name: "chromium-path", takesValue: true, description: "Chromium executable override" },
      {
        name: "lean-browser",
        takesValue: false,
        description: "Download chrome-headless-shell instead of full Chrome",
      },
    ],
    run: remoteHost,
  },
];

const terminalCommands: CliCommand[] = [
  {
    group: "terminal",
    name: "start",
    aliases: ["launch"],
    summary: "Review approvals and start the selected terminal app",
    usage: "natstack terminal start [--pair <link>] [--workspace <name>] [--yes]",
    flags: [
      {
        name: "pair",
        takesValue: true,
        description: "Pair from a natstack://connect link before starting",
      },
      { name: "url", takesValue: true, description: "Server URL for --code pairing" },
      { name: "code", takesValue: true, description: "Pairing code for --url pairing" },
      { name: "label", takesValue: true, description: "Device label used while pairing" },
      { name: "workspace", takesValue: true, description: "Remote workspace to open" },
      {
        name: "yes",
        takesValue: false,
        description: "Approve each terminal startup approval once without prompting",
      },
      JSON_FLAG,
    ],
    run: terminalStart,
  },
];

async function remoteHost(inv: ParsedInvocation): Promise<number> {
  const flagStr = (name: string): string | undefined =>
    typeof inv.flags[name] === "string" ? (inv.flags[name] as string) : undefined;
  const flagMin = (name: string): number | undefined => {
    const raw = flagStr(name);
    if (!raw) return undefined;
    const minutes = Number.parseInt(raw, 10);
    return Number.isFinite(minutes) && minutes > 0 ? minutes * 60_000 : undefined;
  };

  const explicitUrl = flagStr("url");
  const explicitToken = flagStr("token");
  if (explicitUrl && !isSelectedWorkspaceUrl(explicitUrl)) {
    console.error("remote host requires a selected workspace URL");
    return 3;
  }
  let auth:
    | { serverUrl: string; token: string }
    | { deviceCredential: { serverUrl: string; deviceId: string; refreshToken: string } };
  if (explicitUrl && explicitToken) {
    auth = { serverUrl: explicitUrl, token: explicitToken };
  } else {
    const creds = loadCliCredentials();
    if (!creds) {
      console.error("not paired — run `natstack remote pair` first or pass --url and --token");
      return 3;
    }
    if (!explicitUrl && !creds.workspaceName) {
      console.error("no remote workspace selected — run `natstack remote select <workspace>`");
      return 3;
    }
    if (!explicitUrl && !isSelectedWorkspaceUrl(creds.url)) {
      console.error("stored remote credential is not scoped to a workspace");
      return 3;
    }
    auth = {
      deviceCredential: {
        serverUrl: explicitUrl ?? creds.url,
        deviceId: creds.deviceId,
        refreshToken: creds.refreshToken,
      },
    };
  }

  // Root builds copy the headless host bundle to dist/headless-host so the
  // installed CLI can import plain JS. In-repo dev falls back to app dist or
  // TS source (the CLI runs under tsx in-repo).
  const bundledEntry = path.join(repoRoot, "dist", "headless-host", "index.js");
  const appDistEntry = path.join(repoRoot, "apps", "headless-host", "dist", "index.js");
  const srcEntry = path.join(repoRoot, "apps", "headless-host", "src", "index.ts");
  const entry = fs.existsSync(bundledEntry)
    ? bundledEntry
    : fs.existsSync(appDistEntry)
      ? appDistEntry
      : srcEntry;
  const { HeadlessHost, resolveConfig } = (await import(pathToFileURL(entry).href)) as {
    HeadlessHost: new (config: unknown) => {
      start(): Promise<void>;
      stop(reason: string): Promise<void>;
      done: Promise<void>;
    };
    resolveConfig: (overrides: Record<string, unknown>) => unknown;
  };

  const config = resolveConfig({
    ...auth,
    label: flagStr("label"),
    maxPanels: flagStr("max-panels")
      ? Number.parseInt(flagStr("max-panels") as string, 10)
      : undefined,
    idleUnloadMs: flagMin("idle-unload-min"),
    idleExitMs: flagMin("idle-exit-min"),
    chromiumPath: flagStr("chromium-path"),
    leanBrowser: inv.flags["lean-browser"] === true,
  });
  const host = new HeadlessHost(config);
  process.on("SIGINT", () => void host.stop("SIGINT"));
  process.on("SIGTERM", () => void host.stop("SIGTERM"));
  try {
    await host.start();
  } catch (error) {
    console.error(
      `headless host failed to start: ${error instanceof Error ? error.message : String(error)}`
    );
    return 1;
  }
  await host.done;
  return 0;
}

const mobileCommands: CliCommand[] = [
  scriptCommand("mobile", "pair", "mobile-pair.mjs", "Start the QR/deep-link pairing server", {
    usage: "natstack mobile pair [--host tailscale] [--port 3030]",
    // The pair server's own help documents the resolved server entry.
    passthroughHelp: true,
  }),
  scriptCommand("mobile", "dev", "mobile-dev.mjs", "Metro + local server + debug APK", {
    usage: "natstack mobile dev [--avd <name>] [--device <serial>]",
  }),
  scriptCommand(
    "mobile",
    "smoke",
    "mobile-smoke.mjs",
    "Verify the installed internal APK can pair and reach the workspace app",
    {
      usage: "natstack mobile smoke [options]",
      passthroughHelp: true,
    }
  ),
  scriptCommand("mobile", "build", "mobile-install.mjs", "Build the trusted internal APK", {
    aliases: ["apk"],
    usage: "natstack mobile build",
    prependArgs: ["--build-only"],
  }),
  scriptCommand("mobile", "install", "mobile-install.mjs", "Install the internal APK", {
    usage: "natstack mobile install [--device <serial>] [--launch]",
  }),
  scriptCommand("mobile", "logs", "mobile-logs.mjs", "Tail app logs from a device", {
    usage: "natstack mobile logs [--device <serial>]",
  }),
  scriptCommand("mobile", "emulator", "mobile-emulator.mjs", "Start an Android emulator", {
    usage: "natstack mobile emulator [--avd <name>]",
  }),
];

/**
 * The full command registry. Extension point: later command groups
 * (fs, vcs, eval, ...) append their `CliCommand[]` here.
 */
const commandRegistry: CliCommand[] = [
  ...remoteCommands,
  ...terminalCommands,
  ...mobileCommands,
  ...agentCommands,
  ...fsCommands,
  ...vcsCommands,
  ...evalCommands,
];

const GROUP_ORDER = ["remote", "terminal", "mobile", "agent", "fs", "vcs", "eval"];

export async function main(argv: string[]): Promise<number> {
  const [group, ...rest] = argv;
  if (!group || group === "--help" || group === "help") {
    printHelp();
    return 0;
  }
  if (!GROUP_ORDER.includes(group)) {
    console.error(`Unknown command: ${group}`);
    printHelp();
    return 2;
  }
  const [sub, ...subArgs] = rest;
  if (!sub || sub === "--help" || sub === "help") {
    printGroupHelp(group);
    return 0;
  }
  const command = findCommand(commandRegistry, group, sub);
  if (!command) {
    console.error(`Unknown ${group} command: ${sub}`);
    printGroupHelp(group);
    return 2;
  }
  if (command.passthrough && command.passthroughHelp && wantsScriptHelp(subArgs)) {
    return await command.run({ positionals: subArgs, flags: {}, flagsMulti: () => [] }, subArgs);
  }
  if (wantsHelp(subArgs)) {
    console.log(renderCommandHelp(command));
    return 0;
  }
  if (command.passthrough) {
    return await command.run({ positionals: subArgs, flags: {}, flagsMulti: () => [] }, subArgs);
  }
  let inv: ParsedInvocation;
  try {
    inv = parseInvocation(command, subArgs);
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(error.message);
      if (command.usage) console.error(`Usage: ${command.usage}`);
      return error.exitCode;
    }
    throw error;
  }
  return await command.run(inv, subArgs);
}

/** Whether argv requests command help (--help/-h before any `--` separator). */
function wantsHelp(args: string[]): boolean {
  for (const arg of args) {
    if (arg === "--") return false;
    if (arg === "--help" || arg === "-h") return true;
  }
  return false;
}

/** Whether argv asks a passthrough script for its own richer help. */
function wantsScriptHelp(args: string[]): boolean {
  for (const arg of args) {
    if (arg === "--") return false;
    if (arg === "--help") return true;
  }
  return false;
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
        // If the signal is trapped or ignored, still resolve so main() exits.
        resolve(128 + (os.constants.signals[signal] ?? 0));
        return;
      }
      resolve(code ?? 0);
    });
  });
}

function printHelp(): void {
  const sections = GROUP_ORDER.map((group) => renderGroupHelp(commandRegistry, group)).join("\n");
  console.log(`natstack

Usage:
${sections}

Credentials are stored as a 0600 JSON file at ${credentialPath()}.
`);
}

function printGroupHelp(group: string): void {
  console.log(`natstack ${group}

Usage:
${renderGroupHelp(commandRegistry, group)}
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

export { commandRegistry, groupCommands };
