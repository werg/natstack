import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const runIntegration = process.env["NATSTACK_RUN_SUPERVISOR_INTEGRATION"] === "1";

const describeIntegration = runIntegration ? describe : describe.skip;

interface SupervisorHandle {
  url: string;
  operatorToken: string;
  proc: ChildProcessWithoutNullStreams;
  stop: () => Promise<void>;
}

const handles: SupervisorHandle[] = [];
const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(handles.splice(0).map((handle) => handle.stop()));
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describeIntegration("natstack-supervisor integration", () => {
  it("creates and serves two isolated bare workspaces on tenant prefixes", async () => {
    const supervisor = await startSupervisor({ port: 8131 });

    await createWorkspace(supervisor, "alpha");
    await createWorkspace(supervisor, "beta");

    const alpha = await getJson<{ ok: boolean; workspaceId: string }>(
      `${supervisor.url}/w/alpha/healthz`
    );
    const beta = await getJson<{ ok: boolean; workspaceId: string }>(
      `${supervisor.url}/w/beta/healthz`
    );

    expect(alpha).toMatchObject({ ok: true, workspaceId: "alpha" });
    expect(beta).toMatchObject({ ok: true, workspaceId: "beta" });
    expect(alpha.workspaceId).not.toBe(beta.workspaceId);
  });

  it("honors a non-empty public base path for tenant and supervisor routes", async () => {
    const supervisor = await startSupervisor({
      port: 8132,
      publicUrl: "http://localhost:8132/base",
    });

    await createWorkspace(supervisor, "base-alpha", "/base");
    const health = await getJson<{ ok: boolean; workspaceId: string }>(
      `${supervisor.url}/base/w/base-alpha/healthz`
    );
    const rootTenant = await fetch(`${supervisor.url}/w/base-alpha/healthz`);

    expect(health).toMatchObject({ ok: true, workspaceId: "base-alpha" });
    expect(rootTenant.status).toBe(404);
  });

  it("mints device credentials only through the operator-authenticated supervisor route", async () => {
    const supervisor = await startSupervisor({ port: 8133 });
    await createWorkspace(supervisor, "device-alpha");
    await getJson(`${supervisor.url}/w/device-alpha/healthz`);

    const unauth = await fetch(
      `${supervisor.url}/_supervisor/workspaces/device-alpha/issue-device`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label: "integration", platform: "test" }),
      }
    );
    const auth = await postJson<{
      deviceId: string;
      shellToken: string;
      workspaceId: string;
    }>(
      `${supervisor.url}/_supervisor/workspaces/device-alpha/issue-device`,
      { label: "integration", platform: "test" },
      supervisor.operatorToken
    );

    expect(unauth.status).toBe(401);
    expect(auth.deviceId).toMatch(/^dev_/);
    expect(typeof auth.shellToken).toBe("string");
    expect(auth.workspaceId).toBe("device-alpha");
  });
});

async function startSupervisor(opts: {
  port: number;
  publicUrl?: string;
}): Promise<SupervisorHandle> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "natstack-supervisor-it-"));
  tempRoots.push(root);
  const emptyApp = path.join(root, "empty-app");
  fs.mkdirSync(emptyApp, { recursive: true });
  const operatorToken = `it-token-${opts.port}`;
  const args = [
    "dist/supervisor.mjs",
    "--port",
    String(opts.port),
    "--operator-token",
    operatorToken,
    "--allow-create",
    "--app-root",
    emptyApp,
  ];
  if (opts.publicUrl) args.push("--public-url", opts.publicUrl);

  const proc = spawn(process.execPath, args, {
    cwd: process.cwd(),
    env: {
      ...process.env,
      XDG_CONFIG_HOME: path.join(root, "xdg"),
    },
  });
  proc.stdout.setEncoding("utf8");
  proc.stderr.setEncoding("utf8");
  let stdout = "";
  let stderr = "";
  proc.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  proc.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  const handle: SupervisorHandle = {
    url: `http://127.0.0.1:${opts.port}`,
    operatorToken,
    proc,
    stop: async () => {
      if (proc.exitCode !== null || proc.signalCode !== null) return;
      proc.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          proc.kill("SIGKILL");
          resolve();
        }, 5000);
        proc.once("exit", () => {
          clearTimeout(timeout);
          resolve();
        });
      });
    },
  };
  handles.push(handle);

  for (let i = 0; i < 50; i++) {
    if (proc.exitCode !== null) {
      throw new Error(`supervisor exited early: ${stdout}\n${stderr}`);
    }
    const res = await fetch(`${handle.url}${opts.publicUrl ? "/base" : ""}/healthz`).catch(
      () => null
    );
    if (res?.ok) return handle;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`supervisor did not become ready: ${stdout}\n${stderr}`);
}

async function createWorkspace(
  supervisor: SupervisorHandle,
  name: string,
  basePath = ""
): Promise<void> {
  await postJson(
    `${supervisor.url}${basePath}/_supervisor/workspaces`,
    { name },
    supervisor.operatorToken
  );
}

async function postJson<T>(url: string, body: unknown, token: string): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`POST ${url} failed (${res.status}): ${await res.text()}`);
  }
  return (await res.json()) as T;
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`GET ${url} failed (${res.status}): ${await res.text()}`);
  }
  return (await res.json()) as T;
}
