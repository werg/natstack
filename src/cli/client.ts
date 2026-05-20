#!/usr/bin/env node
import * as os from "node:os";
import { pathToFileURL } from "node:url";
import { discoverNatstackServers } from "@natstack/shared/tailscaleDiscovery";
import {
  parseConnectLink,
  parseConnectServerUrl,
  PAIRING_CODE_PATTERN,
} from "@natstack/shared/connect";
import {
  clearCliCredentials,
  loadCliCredentials,
  saveCliCredentials,
  credentialPath,
} from "./credentialStore.js";

interface Options {
  url?: string;
  code?: string;
  label?: string;
}

export async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (!command || command === "--help" || command === "help") {
    printHelp();
    return 0;
  }
  if (command === "discover") {
    const servers = await discoverNatstackServers();
    for (const server of servers) console.log(server.url);
    return 0;
  }
  if (command === "pair") return pair(rest);
  if (command === "status") return status();
  if (command === "logout") {
    clearCliCredentials();
    console.log("logged out");
    return 0;
  }
  console.error(`Unknown command: ${command}`);
  printHelp();
  return 2;
}

async function pair(argv: string[]): Promise<number> {
  const opts = parseOptions(argv);
  if (argv[0] && argv[0].startsWith("natstack://")) {
    const parsed = parseConnectLink(argv[0]);
    if (parsed.kind === "error") {
      console.error(parsed.reason);
      return 2;
    }
    opts.url = parsed.url;
    opts.code = parsed.code;
  } else if (argv[0] && !argv[0].startsWith("--")) {
    opts.url = argv[0];
  }
  if (!opts.url || !opts.code) {
    console.error("pair requires a natstack:// link or --url and --code");
    return 2;
  }
  if (!PAIRING_CODE_PATTERN.test(opts.code)) {
    console.error("pairing code has an unexpected format");
    return 2;
  }
  const parsedUrl = parseConnectServerUrl(opts.url);
  if (parsedUrl.kind === "error") {
    console.error(parsedUrl.reason);
    return 2;
  }
  const response = await fetch(new URL("/_r/s/auth/complete-pairing", parsedUrl.url), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      code: opts.code,
      label: opts.label ?? `${os.userInfo().username}@${os.hostname()}`,
      platform: "desktop",
    }),
  });
  const body = (await response.json().catch(() => ({}))) as {
    deviceId?: unknown;
    refreshToken?: unknown;
    error?: unknown;
  };
  if (!response.ok || typeof body.deviceId !== "string" || typeof body.refreshToken !== "string") {
    console.error(
      typeof body.error === "string"
        ? body.error
        : `pairing failed (${response.status} ${response.statusText})`
    );
    return 1;
  }
  saveCliCredentials({
    schemaVersion: 1,
    kind: "device",
    url: parsedUrl.url,
    deviceId: body.deviceId,
    refreshToken: body.refreshToken,
  });
  console.log(`paired ${parsedUrl.url}`);
  console.log(`credentials: ${credentialPath()}`);
  return 0;
}

async function status(): Promise<number> {
  const creds = loadCliCredentials();
  if (!creds) {
    console.log("not paired");
    return 1;
  }
  const refresh = await fetch(new URL("/_r/s/auth/refresh-shell", creds.url), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ deviceId: creds.deviceId, refreshToken: creds.refreshToken }),
  });
  const refreshBody = (await refresh.json().catch(() => ({}))) as Record<string, unknown>;
  if (!refresh.ok) {
    console.log(
      `not connected: ${
        typeof refreshBody["error"] === "string"
          ? refreshBody["error"]
          : `${refresh.status} ${refresh.statusText}`
      }`
    );
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
    typeof refreshBody["workspaceId"] === "string"
      ? refreshBody["workspaceId"]
      : typeof body["workspaceId"] === "string"
        ? body["workspaceId"]
        : undefined;
  if (workspaceId) console.log(`workspace: ${workspaceId}`);
  if (typeof refreshBody["serverId"] === "string")
    console.log(`server: ${refreshBody["serverId"]}`);
  return 0;
}

function parseOptions(argv: string[]): Options {
  const opts: Options = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--url") opts.url = argv[++i];
    else if (arg === "--code") opts.code = argv[++i];
    else if (arg === "--label") opts.label = argv[++i];
  }
  return opts;
}

function printHelp(): void {
  console.log(`natstack-client

Usage:
  natstack-client discover
  natstack-client pair "natstack://connect?url=...&code=..."
  natstack-client pair --url <url> --code <code> [--label <label>]
  natstack-client status
  natstack-client logout

Credentials are stored as a 0600 JSON file at ${credentialPath()}.
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
