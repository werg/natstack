import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

interface ReadyPayload {
  gatewayUrl: string;
  adminToken: string;
  workspaceName: string;
  isEphemeral: boolean;
}

const RUN_SERVER_INTEGRATION = process.env["NATSTACK_RUN_SERVER_INTEGRATION"] === "1";
const serverPath = path.resolve(process.cwd(), "dist", "server.mjs");
const maybeDescribe = RUN_SERVER_INTEGRATION && fs.existsSync(serverPath) ? describe : describe.skip;

let proc: ChildProcessWithoutNullStreams | null = null;
let tempRoot: string | null = null;

afterEach(async () => {
  if (proc && proc.exitCode === null) {
    proc.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(resolve, 8_000);
      proc?.once("exit", () => {
        clearTimeout(timeout);
        resolve();
      });
    });
  }
  proc = null;
  if (tempRoot) {
    fs.rmSync(tempRoot, { recursive: true, force: true });
    tempRoot = null;
  }
});

maybeDescribe("image-service extension server smoke", () => {
  it("approves declared extensions then invokes image-service through the server RPC surface", async () => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "natstack-extension-server-smoke-"));
    const readyFile = path.join(tempRoot, "ready.json");
    proc = spawn(
      process.execPath,
      [
        serverPath,
        "--ephemeral",
        "--init",
        "--serve-panels",
        "--no-vpn-detect",
        "--ready-file",
        readyFile,
      ],
      {
        cwd: process.cwd(),
        env: { ...process.env, NODE_ENV: "development" },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    let stderr = "";
    proc.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });

    const ready = await waitForReadyFile(readyFile, proc, () => stderr);
    const shellToken = await issueShellToken(ready);

    // Extensions are declared in meta/natstack.yml; the startup reconcile raises
    // one joint approval. Approve it as the shell would, then wait for the
    // image-service process to come up.
    const approvalId = await waitForExtensionBatchApproval(ready, shellToken);
    await rpc(ready, shellToken, "shellApproval.resolve", [approvalId, "once"]);
    await waitForExtensionRunning(ready, shellToken, "@workspace-extensions/image-service");

    await expect(rpc(ready, shellToken, "extensions.invoke", [
      "@workspace-extensions/image-service",
      "detectMimeType",
      [[137, 80, 78, 71, 13, 10, 26, 10]],
    ])).resolves.toBe("image/png");
  }, 60_000);
});

async function waitForExtensionBatchApproval(
  ready: ReadyPayload,
  shellToken: string,
): Promise<string> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const pending = await rpc<Array<{ approvalId: string; kind: string }>>(
      ready,
      shellToken,
      "shellApproval.listPending",
      [],
    );
    const batch = pending.find((p) => p.kind === "extension-batch");
    if (batch) return batch.approvalId;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("extension-batch approval never appeared");
}

async function waitForExtensionRunning(
  ready: ReadyPayload,
  shellToken: string,
  name: string,
): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const extensions = await rpc<Array<{ name: string; status: string; lastError: string | null }>>(
      ready,
      shellToken,
      "extensions.list",
      [],
    );
    const entry = extensions.find((e) => e.name === name);
    if (entry?.status === "running") return;
    if (entry?.status === "error") throw new Error(`${name} failed: ${entry.lastError}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`${name} never reached running state`);
}

async function waitForReadyFile(
  readyFile: string,
  child: ChildProcessWithoutNullStreams,
  getStderr: () => string,
): Promise<ReadyPayload> {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    if (fs.existsSync(readyFile)) {
      return JSON.parse(fs.readFileSync(readyFile, "utf8")) as ReadyPayload;
    }
    if (child.exitCode !== null) {
      throw new Error(`server exited before ready: ${child.exitCode}\n${getStderr()}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`server did not write ready file\n${getStderr()}`);
}

async function issueShellToken(ready: ReadyPayload): Promise<string> {
  const response = await fetch(`${ready.gatewayUrl}/_r/s/auth/issue-device`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${ready.adminToken}`,
    },
    body: JSON.stringify({ label: "Vitest extension smoke", platform: "test" }),
  });
  const body = await response.json() as { shellToken?: unknown; error?: unknown };
  if (!response.ok || typeof body.shellToken !== "string") {
    throw new Error(`failed to issue shell token (${response.status}): ${JSON.stringify(body)}`);
  }
  return body.shellToken;
}

async function rpc<T = unknown>(
  ready: ReadyPayload,
  shellToken: string,
  method: string,
  args: unknown[],
): Promise<T> {
  const response = await fetch(`${ready.gatewayUrl}/rpc`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${shellToken}`,
    },
    body: JSON.stringify({ method, args }),
  });
  const body = await response.json() as { result?: T; error?: string };
  if (!response.ok || body.error) {
    throw new Error(body.error ?? `RPC ${method} failed with status ${response.status}`);
  }
  return body.result as T;
}
