import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import WebSocket from "ws";
import {
  createRpcClient,
  envelopeFromMessage,
  type EnvelopeRpcTransport,
  type RpcClient,
  type RpcEnvelope,
} from "@natstack/rpc";
import type { WsClientMessage, WsServerMessage } from "@natstack/shared/ws/protocol";
import { afterEach, describe, expect, it } from "vitest";

interface ReadyPayload {
  gatewayUrl: string;
  adminToken: string;
  workspaceName: string;
  isEphemeral: boolean;
}

interface ShellCredential {
  shellToken: string;
  callerId: string;
}

interface RuntimeEntityHandle {
  id: string;
  kind: string;
  source: { repoPath: string; effectiveVersion: string };
  contextId: string;
  targetId: string;
}

interface BrowserPanelHandle {
  id: string;
  title: string;
  kind: "browser" | "workspace";
  runtimeEntityId: string;
}

interface CdpEndpoint {
  wsEndpoint: string;
  token: string;
}

const RUN_HEADLESS_PANEL_INTEGRATION =
  process.env["NATSTACK_RUN_HEADLESS_PANEL_INTEGRATION"] === "1";
const serverPath = path.resolve(process.cwd(), "dist", "server.mjs");
const headlessHostEntry = findHeadlessHostEntry();
const maybeDescribe =
  RUN_HEADLESS_PANEL_INTEGRATION && fs.existsSync(serverPath) && headlessHostEntry
    ? describe
    : describe.skip;

let serverProc: ChildProcessWithoutNullStreams | null = null;
let tempRoot: string | null = null;
let fixtureServer: http.Server | null = null;
let shellConnection: RpcWsConnection | null = null;
let workerConnection: RpcWsConnection | null = null;
let cdpClient: CdpClient | null = null;

afterEach(async () => {
  cdpClient?.close();
  cdpClient = null;
  await workerConnection?.close();
  workerConnection = null;
  await shellConnection?.close();
  shellConnection = null;
  if (fixtureServer) {
    await new Promise<void>((resolve) => fixtureServer?.close(() => resolve()));
    fixtureServer = null;
  }
  if (serverProc && serverProc.exitCode === null) {
    serverProc.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(resolve, 8_000);
      serverProc?.once("exit", () => {
        clearTimeout(timeout);
        resolve();
      });
    });
  }
  serverProc = null;
  if (tempRoot) {
    fs.rmSync(tempRoot, { recursive: true, force: true });
    tempRoot = null;
  }
});

maybeDescribe("headless browser panel integration", () => {
  it("opens a browser panel from a worker principal and drives it through the real headless host", async () => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "natstack-headless-panel-"));
    const readyFile = path.join(tempRoot, "ready.json");
    const fixture = await startFixtureServer();

    serverProc = spawn(
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
        env: {
          ...process.env,
          NODE_ENV: "development",
          NATSTACK_HEADLESS_HOST_AUTOSPAWN: "1",
          NATSTACK_HEADLESS_HOST_ENTRY: headlessHostEntry!,
          NATSTACK_HEADLESS_IDLE_EXIT_MS: "1000",
        },
        stdio: ["ignore", "pipe", "pipe"],
      }
    );

    let stderr = "";
    serverProc.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });

    const ready = await waitForReadyFile(readyFile, serverProc, () => stderr);
    const shell = await issueShellToken(ready);
    shellConnection = await connectRpcWebSocket({
      gatewayUrl: ready.gatewayUrl,
      token: shell.shellToken,
      selfId: shell.callerId,
      callerKind: "shell",
      clientLabel: "Vitest Shell",
    });
    await shellConnection.rpc.call("main", "shellPresence.heartbeat", []);

    const worker = await rpc<RuntimeEntityHandle>(ready, shell.shellToken, "runtime.createEntity", [
      {
        kind: "worker",
        source: "workers/agent-worker",
        key: `headless-panel-integration-${Date.now().toString(36)}`,
      },
    ]);
    const grant = await rpc<{ token: string }>(ready, shell.shellToken, "auth.grantConnection", [
      worker.id,
    ]);
    workerConnection = await connectRpcWebSocket({
      gatewayUrl: ready.gatewayUrl,
      token: grant.token,
      selfId: worker.id,
      callerKind: "worker",
      clientLabel: "Vitest Worker Sandbox",
    });

    const panel = await workerConnection.rpc.call<BrowserPanelHandle>("main", "panelTree.create", [
      `${fixture.baseUrl}/first`,
      { focus: true },
    ]);
    expect(panel.kind).toBe("browser");

    const load = await workerConnection.rpc.call<{ loaded: boolean; status: string }>(
      "main",
      "panelTree.ensureLoaded",
      [panel.id]
    );
    if (!load.loaded) {
      throw new Error(`Expected headless host to load panel: ${JSON.stringify(load)}\n${stderr}`);
    }

    await shellConnection.rpc.call("main", "shellPresence.heartbeat", []);
    const [endpoint] = await Promise.all([
      workerConnection.rpc.call<CdpEndpoint>("main", "panelCdp.getCdpEndpoint", [panel.id]),
      resolveCapabilityApproval(ready, shell.shellToken, "panel.automate").then(() => undefined),
    ]);

    cdpClient = await CdpClient.connect(endpoint);
    await cdpClient.send("Runtime.enable");
    await cdpClient.send("Page.enable");

    await expect(
      waitForEval(cdpClient, "document.title", "Initial Headless Integration")
    ).resolves.toBe("Initial Headless Integration");
    await expect(
      cdpClient.evaluate("document.querySelector('[data-testid=\"marker\"]')?.textContent")
    ).resolves.toBe("first");
    await expect(
      cdpClient.evaluate(
        "(() => { window.__natstackIntegration = 42; return window.__natstackIntegration; })()"
      )
    ).resolves.toBe(42);

    const screenshot = await cdpClient.send<{ data: string }>("Page.captureScreenshot", {
      format: "png",
    });
    expect(Buffer.byteLength(screenshot.data, "base64")).toBeGreaterThan(500);

    await workerConnection.rpc.call("main", "panelCdp.navigate", [
      panel.id,
      `${fixture.baseUrl}/second`,
    ]);
    await expect(
      waitForEval(cdpClient, "document.title", "Next Headless Integration")
    ).resolves.toBe("Next Headless Integration");
    await expect(cdpClient.evaluate("location.pathname")).resolves.toBe("/second");

    await cdpClient.evaluate("console.error('headless-panel-integration-error')");
    await expect(
      waitFor(async () => {
        const history = await workerConnection!.rpc.call<{
          errors: Array<{ message: string }>;
        }>("main", "panelCdp.consoleHistory", [panel.id, { errorLimit: 10 }]);
        return history.errors.some((entry) =>
          entry.message.includes("headless-panel-integration-error")
        );
      }, true)
    ).resolves.toBe(true);

    const lease = await workerConnection.rpc.call<{
      leased: boolean;
      supportsCdp?: boolean;
      hostConnectionId?: string;
    }>("main", "panelTree.getRuntimeLease", [panel.id]);
    expect(lease.leased).toBe(true);
    expect(lease.supportsCdp).toBe(true);
    expect(lease.hostConnectionId).toMatch(/^headless-/);
  }, 120_000);
});

function findHeadlessHostEntry(): string | null {
  const candidates = [
    path.resolve(process.cwd(), "dist", "headless-host", "main.js"),
    path.resolve(process.cwd(), "apps", "headless-host", "dist", "main.js"),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? null;
}

async function startFixtureServer(): Promise<{ baseUrl: string }> {
  fixtureServer = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const isSecond = url.pathname === "/second";
    const title = isSecond ? "Next Headless Integration" : "Initial Headless Integration";
    const marker = isSecond ? "second" : "first";
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(`<!doctype html>
<html>
  <head><title>${title}</title></head>
  <body>
    <main>
      <h1>${title}</h1>
      <div data-testid="marker">${marker}</div>
    </main>
  </body>
</html>`);
  });
  await new Promise<void>((resolve) => fixtureServer!.listen(0, "127.0.0.1", resolve));
  const address = fixtureServer.address();
  if (!address || typeof address === "string") throw new Error("fixture server did not bind TCP");
  return { baseUrl: `http://127.0.0.1:${address.port}` };
}

async function waitForReadyFile(
  readyFile: string,
  child: ChildProcessWithoutNullStreams,
  getStderr: () => string
): Promise<ReadyPayload> {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    if (fs.existsSync(readyFile)) {
      return JSON.parse(fs.readFileSync(readyFile, "utf8")) as ReadyPayload;
    }
    if (child.exitCode !== null) {
      throw new Error(`server exited before ready: ${child.exitCode}\n${getStderr()}`);
    }
    await delay(250);
  }
  throw new Error(`server did not write ready file\n${getStderr()}`);
}

async function issueShellToken(ready: ReadyPayload): Promise<ShellCredential> {
  const response = await fetch(`${ready.gatewayUrl}/_r/s/auth/issue-device`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${ready.adminToken}`,
    },
    body: JSON.stringify({ label: "Vitest headless panel integration", platform: "test" }),
  });
  const body = (await response.json()) as {
    shellToken?: unknown;
    callerId?: unknown;
    error?: unknown;
  };
  if (!response.ok || typeof body.shellToken !== "string" || typeof body.callerId !== "string") {
    throw new Error(`failed to issue shell token (${response.status}): ${JSON.stringify(body)}`);
  }
  return { shellToken: body.shellToken, callerId: body.callerId };
}

async function rpc<T = unknown>(
  ready: ReadyPayload,
  shellToken: string,
  method: string,
  args: unknown[]
): Promise<T> {
  const response = await fetch(`${ready.gatewayUrl}/rpc`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${shellToken}`,
    },
    body: JSON.stringify({ method, args }),
  });
  const body = (await response.json()) as { result?: T; error?: string };
  if (!response.ok || body.error) {
    throw new Error(body.error ?? `RPC ${method} failed with status ${response.status}`);
  }
  return body.result as T;
}

async function resolveCapabilityApproval(
  ready: ReadyPayload,
  shellToken: string,
  capability: string
): Promise<void> {
  const approval = await waitFor(async () => {
    const pending = await rpc<
      Array<{ approvalId: string; kind: string; capability?: string; title?: string }>
    >(ready, shellToken, "shellApproval.listPending", []);
    return pending.find((entry) => entry.kind === "capability" && entry.capability === capability);
  }, undefined);
  if (!approval) throw new Error(`No pending ${capability} approval found`);
  await rpc(ready, shellToken, "shellApproval.resolve", [approval.approvalId, "session"]);
}

interface RpcWsConnection {
  rpc: RpcClient;
  auth: {
    callerId: string;
    callerKind: string;
    connectionId: string;
  };
  close(): Promise<void>;
}

async function connectRpcWebSocket(options: {
  gatewayUrl: string;
  token: string;
  selfId: string;
  callerKind: "shell" | "worker";
  clientLabel: string;
}): Promise<RpcWsConnection> {
  const wsUrl = new URL("/rpc", options.gatewayUrl);
  wsUrl.protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:";
  const ws = new WebSocket(wsUrl);
  const listeners = new Set<(envelope: RpcEnvelope) => void>();
  const transport: EnvelopeRpcTransport = {
    async send(envelope) {
      if (ws.readyState !== WebSocket.OPEN) throw new Error("RPC WebSocket is not connected");
      ws.send(JSON.stringify({ type: "ws:rpc", envelope, message: envelope.message }));
    },
    onMessage(handler) {
      listeners.add(handler);
      return () => listeners.delete(handler);
    },
    status: () => (ws.readyState === WebSocket.OPEN ? "connected" : "disconnected"),
    ready: () => Promise.resolve(),
    onStatusChange: () => () => {},
  };
  const rpcClient = createRpcClient({
    selfId: options.selfId,
    callerKind: options.callerKind,
    transport,
  });

  const auth = await new Promise<RpcWsConnection["auth"]>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("RPC WebSocket auth timeout")), 10_000);
    const fail = (error: unknown) => {
      clearTimeout(timeout);
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    ws.once("error", fail);
    ws.once("open", () => {
      ws.send(
        JSON.stringify({
          type: "ws:auth",
          token: options.token,
          clientLabel: options.clientLabel,
          clientPlatform: "desktop",
        } satisfies WsClientMessage)
      );
    });
    ws.on("message", function onMessage(data) {
      const message = parseJson<WsServerMessage>(data);
      if (!message) return;
      if (message.type === "ws:auth-result") {
        ws.off("message", onMessage);
        ws.off("error", fail);
        clearTimeout(timeout);
        if (!message.success) {
          reject(new Error(`RPC WebSocket auth failed: ${message.error ?? "unknown error"}`));
          return;
        }
        resolve({
          callerId: message.callerId ?? options.selfId,
          callerKind: message.callerKind ?? options.callerKind,
          connectionId: message.connectionId,
        });
      }
    });
  });

  ws.on("message", (data) => {
    const message = parseJson<WsServerMessage>(data);
    if (!message) return;
    let envelope: RpcEnvelope | null = null;
    if (message.type === "ws:rpc") {
      envelope =
        message.envelope ??
        (message.message
          ? envelopeFromMessage({
              selfId: options.selfId,
              from: "main",
              target: options.selfId,
              callerKind: "server",
              message: message.message,
            })
          : null);
    } else if (message.type === "ws:routed") {
      envelope =
        message.envelope ??
        (message.message
          ? envelopeFromMessage({
              selfId: options.selfId,
              from: message.fromId ?? "unknown",
              target: options.selfId,
              callerKind: message.fromKind ?? "unknown",
              message: message.message,
            })
          : null);
    }
    if (envelope) {
      for (const listener of listeners) listener(envelope);
    }
  });

  return {
    rpc: rpcClient,
    auth,
    close: async () => {
      if (ws.readyState === WebSocket.CLOSED) return;
      await new Promise<void>((resolve) => {
        ws.once("close", () => resolve());
        ws.close(1000, "test cleanup");
        setTimeout(resolve, 1_000);
      });
    },
  };
}

class CdpClient {
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();

  private constructor(private readonly ws: WebSocket) {
    ws.on("message", (data) => this.handleMessage(data));
    ws.on("close", () => this.rejectPending(new Error("CDP WebSocket closed")));
    ws.on("error", (error) =>
      this.rejectPending(error instanceof Error ? error : new Error(String(error)))
    );
  }

  static async connect(endpoint: CdpEndpoint): Promise<CdpClient> {
    const ws = new WebSocket(endpoint.wsEndpoint);
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("CDP auth timeout")), 10_000);
      const fail = (error: unknown) => {
        clearTimeout(timeout);
        reject(error instanceof Error ? error : new Error(String(error)));
      };
      ws.once("error", fail);
      ws.once("open", () => {
        ws.send(JSON.stringify({ type: "natstack:cdp-auth", token: endpoint.token }));
      });
      ws.on("message", function onAuth(data) {
        const message = parseJson<{ type?: string }>(data);
        if (message?.type !== "natstack:cdp-auth-ok") return;
        ws.off("message", onAuth);
        ws.off("error", fail);
        clearTimeout(timeout);
        resolve();
      });
    });
    return new CdpClient(ws);
  }

  send<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
    if (this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("CDP WebSocket is not open"));
    }
    const id = this.nextId++;
    const message = params === undefined ? { id, method } : { id, method, params };
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
      });
      this.ws.send(JSON.stringify(message), (error) => {
        if (!error) return;
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  async evaluate(expression: string): Promise<unknown> {
    const result = await this.send<{
      result?: { value?: unknown; description?: string };
      exceptionDetails?: { text?: string; exception?: { description?: string } };
    }>("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) {
      throw new Error(
        result.exceptionDetails.exception?.description ??
          result.exceptionDetails.text ??
          `Evaluation failed: ${expression}`
      );
    }
    return result.result?.value;
  }

  close(): void {
    if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
      this.ws.close(1000, "test cleanup");
    }
    this.rejectPending(new Error("CDP client closed"));
  }

  private handleMessage(data: WebSocket.RawData): void {
    const message = parseJson<{ id?: number; result?: unknown; error?: { message?: string } }>(
      data
    );
    if (!message || typeof message.id !== "number") return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    if (message.error) {
      pending.reject(new Error(message.error.message ?? "CDP command failed"));
    } else {
      pending.resolve(message.result);
    }
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}

async function waitForEval<T>(
  client: CdpClient,
  expression: string,
  expected: T,
  timeoutMs = 20_000
): Promise<T> {
  return waitFor(async () => client.evaluate(expression), expected, timeoutMs);
}

async function waitFor<T>(
  producer: () => Promise<T> | T,
  expected: T,
  timeoutMs = 20_000
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastValue: unknown;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await producer();
      lastValue = value;
      if (value === expected || (expected === undefined && value !== undefined)) return value;
    } catch (error) {
      lastError = error;
    }
    await delay(100);
  }
  if (lastError) {
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }
  throw new Error(`Timed out waiting for ${String(expected)}; last value: ${String(lastValue)}`);
}

function parseJson<T>(data: WebSocket.RawData): T | null {
  try {
    return JSON.parse(String(data)) as T;
  } catch {
    return null;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
