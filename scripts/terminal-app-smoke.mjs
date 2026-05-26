#!/usr/bin/env node
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import process from "node:process";
import { run as runAdmin } from "./natstack-admin.mjs";

const READY_FILE = path.join(os.tmpdir(), `natstack-terminal-smoke-${process.pid}.json`);
const REMOTE_CLI = "@workspace-apps/remote-cli";

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForReady(filePath, timeoutMs = 120_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, "utf8"));
    }
    await wait(500);
  }
  throw new Error(`Server did not write ready file within ${timeoutMs}ms`);
}

async function postJson(url, pathName, body, token) {
  const res = await fetch(`${url}${pathName}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`${pathName} failed ${res.status}: ${JSON.stringify(json)}`);
  return json;
}

async function rpc(url, shellToken, method, args = []) {
  const res = await fetch(`${url}/rpc`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${shellToken}`,
    },
    body: JSON.stringify({ targetId: "main", method, args }),
  });
  const body = await res.json();
  if (!res.ok || body.error) throw new Error(body.error ?? `/rpc failed ${res.status}`);
  return body.result;
}

async function createShellToken(url, adminToken) {
  const issued = await postJson(
    url,
    "/_r/s/auth/issue-device",
    { label: "Terminal app smoke", platform: "desktop" },
    adminToken,
  );
  return issued.shellToken;
}

async function waitForRemoteCli(url, shellToken) {
  for (let i = 0; i < 120; i += 1) {
    const units = await rpc(url, shellToken, "workspace.units.list");
    const remoteCli = units.find((unit) => unit.name === REMOTE_CLI);
    if (
      remoteCli?.activeBundleKey &&
      remoteCli.status !== "building" &&
      remoteCli.status !== "pending-approval"
    ) {
      return remoteCli;
    }
    await wait(1000);
  }
  throw new Error(`${REMOTE_CLI} did not become launchable`);
}

async function waitForRunning(url, shellToken) {
  for (let i = 0; i < 30; i += 1) {
    const units = await rpc(url, shellToken, "workspace.units.list");
    const remoteCli = units.find((unit) => unit.name === REMOTE_CLI);
    if (remoteCli?.status === "running") return remoteCli;
    if (remoteCli?.status === "error") {
      const logs = await rpc(url, shellToken, "workspace.units.logs", [REMOTE_CLI, { limit: 80 }]);
      throw new Error(`${REMOTE_CLI} errored: ${remoteCli.lastError}\n${JSON.stringify(logs, null, 2)}`);
    }
    await wait(1000);
  }
  throw new Error(`${REMOTE_CLI} did not reach running status`);
}

async function waitForLogLine(url, shellToken, needle) {
  let lastLogs = [];
  for (let i = 0; i < 30; i += 1) {
    const units = await rpc(url, shellToken, "workspace.units.list");
    const remoteCli = units.find((unit) => unit.name === REMOTE_CLI);
    lastLogs = await rpc(url, shellToken, "workspace.units.logs", [REMOTE_CLI, { limit: 200 }]);
    if (lastLogs.some((row) => String(row.message).includes(needle))) {
      return lastLogs;
    }
    if (remoteCli?.status === "error") {
      throw new Error(`${REMOTE_CLI} errored before logging ${needle}:\n${JSON.stringify(lastLogs, null, 2)}`);
    }
    await wait(1000);
  }
  throw new Error(`${REMOTE_CLI} ran but did not log ${needle}:\n${JSON.stringify(lastLogs, null, 2)}`);
}

async function stopServer(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGINT");
  await new Promise((resolve) => {
    const timeout = setTimeout(resolve, 10_000);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
}

async function main() {
  fs.rmSync(READY_FILE, { force: true });
  const child = spawn(
    process.execPath,
    ["dist/server.mjs", "--ephemeral", "--ready-file", READY_FILE, "--print-credentials", "--no-vpn-detect"],
    {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, NODE_ENV: process.env.NODE_ENV ?? "development" },
    },
  );
  child.stdout.on("data", (chunk) => process.stdout.write(chunk));
  child.stderr.on("data", (chunk) => process.stderr.write(chunk));

  try {
    const ready = await waitForReady(READY_FILE);
    const url = ready.gatewayUrl;
    const adminToken = ready.adminToken;
    const shellToken = await createShellToken(url, adminToken);

    await runAdmin(["--url", url, "--admin-token", adminToken, "approvals", "approve", "version"]);
    await waitForRemoteCli(url, shellToken);
    await rpc(url, shellToken, "workspace.units.restart", [REMOTE_CLI]);
    const running = await waitForRunning(url, shellToken);
    await waitForLogLine(url, shellToken, "Pairing code:");
    console.log(
      `[terminal-smoke] ${REMOTE_CLI} ${running.status} build=${String(running.activeBundleKey).slice(0, 12)}`,
    );
  } finally {
    await stopServer(child);
    fs.rmSync(READY_FILE, { force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
