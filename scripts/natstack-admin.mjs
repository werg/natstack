#!/usr/bin/env node
import process from "node:process";

function usage() {
  console.error(`Usage:
  node scripts/natstack-admin.mjs --url <gateway-url> [--admin-token <token>] <command>

Commands:
  approvals list
  approvals approve [decision]
  units list
  units restart <name>
  units logs <name> [--limit <n>]
  units rollback <name> [buildKey]
`);
}

function parseArgs(argv) {
  const opts = {
    url: process.env.NATSTACK_GATEWAY_URL ?? process.env.NATSTACK_SERVER_URL ?? "",
    adminToken: process.env.NATSTACK_ADMIN_TOKEN ?? "",
    args: [],
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--url") {
      opts.url = argv[++i] ?? "";
    } else if (arg === "--admin-token") {
      opts.adminToken = argv[++i] ?? "";
    } else {
      opts.args.push(arg);
    }
  }
  opts.url = opts.url.replace(/\/+$/, "");
  return opts;
}

async function postJson(url, path, body, token) {
  const res = await fetch(`${url}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok) {
    throw new Error(`${path} failed ${res.status}: ${JSON.stringify(json)}`);
  }
  return json;
}

async function createShellToken(url, adminToken) {
  const issued = await postJson(
    url,
    "/_r/s/auth/issue-device",
    { label: "NatStack admin CLI", platform: "desktop" },
    adminToken,
  );
  if (!issued.shellToken) throw new Error("Server did not issue a shell token");
  return issued.shellToken;
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
  if (!res.ok || body.error) {
    throw new Error(body.error ?? `/rpc failed ${res.status}`);
  }
  return body.result;
}

function printUnit(unit) {
  const target = unit.target ? ` target=${unit.target}` : "";
  const build = unit.activeBundleKey ? ` build=${String(unit.activeBundleKey).slice(0, 12)}` : "";
  const error = unit.lastError ? ` error=${JSON.stringify(unit.lastError)}` : "";
  console.log(`${unit.kind} ${unit.name} ${unit.source} status=${unit.status}${target}${build}${error}`);
}

export async function run(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  const [group, action, ...rest] = opts.args;
  if (!opts.url || !opts.adminToken || !group) {
    usage();
    return 2;
  }
  const shellToken = await createShellToken(opts.url, opts.adminToken);

  if (group === "approvals" && action === "list") {
    const approvals = await rpc(opts.url, shellToken, "shellApproval.listPending");
    console.log(JSON.stringify(approvals, null, 2));
    return 0;
  }
  if (group === "approvals" && action === "approve") {
    const decision = rest[0] ?? "version";
    const approvals = await rpc(opts.url, shellToken, "shellApproval.listPending");
    for (const approval of approvals) {
      await rpc(opts.url, shellToken, "shellApproval.resolve", [approval.approvalId, decision]);
      console.log(`approved ${approval.approvalId} ${approval.title ?? ""}`.trim());
    }
    return 0;
  }
  if (group === "units" && action === "list") {
    const units = await rpc(opts.url, shellToken, "workspace.units.list");
    for (const unit of units) printUnit(unit);
    return 0;
  }
  if (group === "units" && action === "restart") {
    const name = rest[0];
    if (!name) throw new Error("units restart requires a unit name");
    await rpc(opts.url, shellToken, "workspace.units.restart", [name]);
    console.log(`restart requested for ${name}`);
    return 0;
  }
  if (group === "units" && action === "logs") {
    const name = rest[0];
    if (!name) throw new Error("units logs requires a unit name");
    const limitIndex = rest.indexOf("--limit");
    const limit = limitIndex >= 0 ? Number(rest[limitIndex + 1] ?? 200) : 200;
    const logs = await rpc(opts.url, shellToken, "workspace.units.logs", [name, { limit }]);
    for (const row of logs) {
      console.log(`[${row.level}] ${row.source ?? ""} ${row.message}`.trim());
    }
    return 0;
  }
  if (group === "units" && action === "rollback") {
    const [name, buildKey] = rest;
    if (!name) throw new Error("units rollback requires a unit name");
    const args = buildKey ? [name, { buildKey }] : [name];
    await rpc(opts.url, shellToken, "workspace.units.rollback", args);
    console.log(`rollback requested for ${name}`);
    return 0;
  }

  usage();
  return 2;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().then(
    (code) => process.exit(code),
    (error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    },
  );
}
