import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { clearShellTokenCache } from "../rpcClient.js";
import { resolveRunnerInvocation, runEvalProcess } from "./evalCommand.js";
import type { EvalHandshake } from "./evalRunner.js";

vi.mock("@natstack/shared/tailscaleDiscovery", () => ({
  discoverNatstackServers: vi.fn(async () => []),
}));

interface RpcRequest {
  method: string;
  args: unknown[];
}

function stubServer(handle: (body: RpcRequest) => unknown): { rpcBodies: RpcRequest[] } {
  const rpcBodies: RpcRequest[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: URL, init?: RequestInit) => {
      if (String(url).endsWith("/_r/s/auth/refresh-shell")) {
        return new Response(
          JSON.stringify({
            shellToken: "tok",
            callerId: "shell:dev_cli",
            deviceId: "dev_cli",
            workspaceId: "ws_1",
          })
        );
      }
      const body = JSON.parse(String(init?.body ?? "{}")) as RpcRequest;
      rpcBodies.push(body);
      try {
        return new Response(JSON.stringify({ result: handle(body) }));
      } catch (error) {
        return new Response(
          JSON.stringify({ error: error instanceof Error ? error.message : String(error) })
        );
      }
    })
  );
  return { rpcBodies };
}

function writeCredentials(tmpDir: string, url = "https://host.tailnet.ts.net"): void {
  const dir = path.join(tmpDir, ".config", "natstack");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "cli-credentials.json"),
    JSON.stringify({
      schemaVersion: 1,
      kind: "device",
      url,
      workspaceName: "dev",
      deviceId: "dev_cli",
      refreshToken: "refresh_cli",
    })
  );
}

function writeSession(tmpDir: string, name = "default", serverUrl = "https://host.tailnet.ts.net") {
  const dir = path.join(tmpDir, ".config", "natstack", "agent-sessions");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${name}.json`),
    JSON.stringify({
      schemaVersion: 1,
      name,
      serverUrl,
      entityId: `session:${name}`,
      contextId: "ctx_1",
      scopeKey: name,
      createdAt: 1,
    })
  );
}

/** Write a stub runner script and point NATSTACK_EVAL_RUNNER at it. */
function stubRunner(tmpDir: string, source: string): string {
  const runnerPath = path.join(tmpDir, "stub-runner.mjs");
  fs.writeFileSync(runnerPath, source);
  vi.stubEnv("NATSTACK_EVAL_RUNNER", runnerPath);
  return runnerPath;
}

const EMPTY_SCOPE = '{ json: "{}", serializedKeys: [], droppedPaths: [], partialKeys: [] }';

/** Runner that echoes its handshake back inside a successful result. */
const ECHO_RUNNER = `
let raw = "";
process.stdin.on("data", (d) => (raw += d));
process.stdin.on("end", () => {
  const handshake = JSON.parse(raw);
  process.stdout.write(JSON.stringify({ type: "console", level: "log", text: "hello", ts: 1 }) + "\\n");
  process.stdout.write(JSON.stringify({ type: "console", level: "warn", text: "careful", ts: 2 }) + "\\n");
  process.stdout.write(JSON.stringify({
    type: "result", success: true, returnValue: { echoed: handshake },
    scope: { json: JSON.stringify({ x: 1 }), serializedKeys: ["x"], droppedPaths: [], partialKeys: [] },
  }) + "\\n");
});
`;

const FAILING_RUNNER = `
process.stdin.resume();
process.stdin.on("end", () => {
  process.stdout.write(JSON.stringify({
    type: "result", success: false, error: "boom", scope: ${EMPTY_SCOPE},
  }) + "\\n");
});
`;

/** Runner that never reads stdin and never exits (for SIGKILL/timeout). */
const SLEEP_RUNNER = `setInterval(() => {}, 1000);`;

/** Runner that logs to console + stderr, then hangs (for timeout context). */
const LOGGING_SLEEP_RUNNER = `
process.stdout.write(JSON.stringify({ type: "console", level: "log", text: "before hang", ts: 1 }) + "\\n");
process.stderr.write("stuck in a loop\\n");
setInterval(() => {}, 1000);
`;

/** Runner that fails at infrastructure level: result without a scope. */
const INFRA_FAILING_RUNNER = `
process.stdin.resume();
process.stdin.on("end", () => {
  process.stdout.write(JSON.stringify({
    type: "result", success: false, error: "invalid eval handshake: boom",
  }) + "\\n");
});
`;

function jsonOutput(): Record<string, unknown> {
  const lines = vi.mocked(console.log).mock.calls.map((call) => String(call[0]));
  return JSON.parse(lines[lines.length - 1]!) as Record<string, unknown>;
}

function jsonErrorOutput(): Record<string, unknown> {
  const lines = vi.mocked(console.error).mock.calls.map((call) => String(call[0]));
  return JSON.parse(lines[lines.length - 1]!) as Record<string, unknown>;
}

describe("runEvalProcess", () => {
  let tmpDir = "";

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "natstack-eval-cli-"));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const handshake: EvalHandshake = {
    code: "return 1;",
    serverUrl: "https://host.tailnet.ts.net",
    shellToken: "tok",
    contextId: "ctx_1",
    sessionId: "session:default",
  };

  it("delivers the handshake and collects console + result events", async () => {
    const runnerPath = stubRunner(tmpDir, ECHO_RUNNER);
    const streamed: string[] = [];
    const outcome = await runEvalProcess({
      invocation: { command: process.execPath, args: [runnerPath] },
      handshake,
      timeoutMs: 10_000,
      onConsole: (event) => streamed.push(`${event.level}:${event.text}`),
    });
    expect(outcome.timedOut).toBe(false);
    expect(outcome.exitCode).toBe(0);
    expect(streamed).toEqual(["log:hello", "warn:careful"]);
    expect(outcome.result?.success).toBe(true);
    expect(outcome.result?.returnValue).toEqual({ echoed: handshake });
  });

  it("SIGKILLs the runner on timeout", async () => {
    const runnerPath = stubRunner(tmpDir, SLEEP_RUNNER);
    const started = Date.now();
    const outcome = await runEvalProcess({
      invocation: { command: process.execPath, args: [runnerPath] },
      handshake,
      timeoutMs: 300,
    });
    expect(outcome.timedOut).toBe(true);
    expect(outcome.result).toBeNull();
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("real runner omits scope from infrastructure-failure results", async () => {
    // Invalid handshake (code is not a string) — main() must emit a result
    // event without a scope so the parent keeps the stored one.
    const outcome = await runEvalProcess({
      invocation: resolveRunnerInvocation(),
      handshake: { code: 42 } as unknown as EvalHandshake,
      timeoutMs: 30_000,
    });
    expect(outcome.result?.success).toBe(false);
    expect(outcome.result?.error).toContain("invalid eval handshake");
    expect(outcome.result?.scope).toBeUndefined();
  }, 30_000);
});

describe("natstack eval commands", () => {
  let tmpDir = "";

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "natstack-eval-cli-"));
    vi.stubEnv("HOME", tmpDir);
    clearShellTokenCache();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("eval run wires scope load/save around the runner and exits 0", async () => {
    writeCredentials(tmpDir);
    writeSession(tmpDir);
    stubRunner(tmpDir, ECHO_RUNNER);
    const scopeEntry = {
      id: "scope_1",
      channelId: "cli:default",
      panelId: "repl",
      data: JSON.stringify({ count: 1 }),
      serializedKeys: ["count"],
      droppedPaths: [],
      partialKeys: [],
      createdAt: 100,
    };
    const { rpcBodies } = stubServer((body) =>
      body.method === "scope.loadCurrent" ? scopeEntry : null
    );

    const { main } = await import("../client.js");
    await expect(main(["eval", "run", "-e", "return 1;", "--json"])).resolves.toBe(0);

    expect(rpcBodies.map((b) => b.method)).toEqual(["scope.loadCurrent", "scope.upsert"]);
    expect(rpcBodies[0]!.args).toEqual(["cli:default", "repl"]);
    // Upsert keeps the previous scope identity and stores the runner's scope.
    expect(rpcBodies[1]!.args[0]).toMatchObject({
      id: "scope_1",
      channelId: "cli:default",
      panelId: "repl",
      data: JSON.stringify({ x: 1 }),
      serializedKeys: ["x"],
      createdAt: 100,
    });

    const output = jsonOutput();
    expect(output["success"]).toBe(true);
    expect(output["scopeSaved"]).toBe(true);
    expect(output["console"]).toEqual([
      { type: "console", level: "log", text: "hello", ts: 1 },
      { type: "console", level: "warn", text: "careful", ts: 2 },
    ]);
    // The handshake passed to the runner carries the restored scope snapshot.
    const echoed = (output["returnValue"] as { echoed: EvalHandshake }).echoed;
    expect(echoed.scopeSnapshot).toBe(JSON.stringify({ count: 1 }));
    expect(echoed.contextId).toBe("ctx_1");
    expect(echoed.sessionId).toBe("session:default");
    expect(echoed.shellToken).toBe("tok");
    expect(echoed.code).toBe("return 1;");
    // One shell refresh per eval: the handshake token is the client's token.
    const refreshCalls = vi
      .mocked(globalThis.fetch)
      .mock.calls.filter((call) => String(call[0]).endsWith("/_r/s/auth/refresh-shell"));
    expect(refreshCalls).toHaveLength(1);
  });

  it("eval run --fresh-scope skips the scope load and save", async () => {
    writeCredentials(tmpDir);
    writeSession(tmpDir);
    stubRunner(tmpDir, ECHO_RUNNER);
    const { rpcBodies } = stubServer(() => null);

    const { main } = await import("../client.js");
    await expect(main(["eval", "run", "-e", "return 1;", "--fresh-scope", "--json"])).resolves.toBe(
      0
    );

    // The throwaway scope must not clobber the stored one.
    expect(rpcBodies.map((b) => b.method)).toEqual([]);
    expect(jsonOutput()["scopeSaved"]).toBe(false);
  });

  it("eval run keeps the stored scope when the result carries none", async () => {
    writeCredentials(tmpDir);
    writeSession(tmpDir);
    stubRunner(tmpDir, INFRA_FAILING_RUNNER);
    const { rpcBodies } = stubServer(() => null);

    const { main } = await import("../client.js");
    await expect(main(["eval", "run", "-e", "return 1;", "--json"])).resolves.toBe(1);

    // No scope.upsert: an infrastructure failure must not wipe the scope.
    expect(rpcBodies.map((b) => b.method)).toEqual(["scope.loadCurrent"]);
    const output = jsonOutput();
    expect(output["success"]).toBe(false);
    expect(output["scopeSaved"]).toBe(false);
  });

  it("eval run reads code from a local FILE positional", async () => {
    writeCredentials(tmpDir);
    writeSession(tmpDir);
    stubRunner(tmpDir, ECHO_RUNNER);
    stubServer(() => null);
    const codeFile = path.join(tmpDir, "snippet.ts");
    fs.writeFileSync(codeFile, "return 42;");

    const { main } = await import("../client.js");
    await expect(main(["eval", "run", codeFile, "--json"])).resolves.toBe(0);

    const echoed = (jsonOutput()["returnValue"] as { echoed: EvalHandshake }).echoed;
    expect(echoed.code).toBe("return 42;");
  });

  it("eval run maps a failed result to exit 1", async () => {
    writeCredentials(tmpDir);
    writeSession(tmpDir);
    stubRunner(tmpDir, FAILING_RUNNER);
    stubServer(() => null);

    const { main } = await import("../client.js");
    await expect(main(["eval", "run", "-e", "throw 1;", "--json"])).resolves.toBe(1);

    const output = jsonOutput();
    expect(output["success"]).toBe(false);
    expect(output["error"]).toBe("boom");
  });

  it("eval run maps a timeout to exit 4", async () => {
    writeCredentials(tmpDir);
    writeSession(tmpDir);
    stubRunner(tmpDir, SLEEP_RUNNER);
    stubServer(() => null);

    const { main } = await import("../client.js");
    await expect(
      main(["eval", "run", "-e", "while(true){}", "--timeout", "300", "--json"])
    ).resolves.toBe(4);
  });

  it("eval run timeout error JSON includes console events and stderr", async () => {
    writeCredentials(tmpDir);
    writeSession(tmpDir);
    stubRunner(tmpDir, LOGGING_SLEEP_RUNNER);
    stubServer(() => null);

    const { main } = await import("../client.js");
    await expect(
      main(["eval", "run", "-e", "while(true){}", "--timeout", "300", "--json"])
    ).resolves.toBe(4);

    const output = jsonErrorOutput();
    expect(String(output["error"])).toContain("timed out");
    expect(output["exitCode"]).toBe(4);
    expect(output["console"]).toEqual([
      { type: "console", level: "log", text: "before hang", ts: 1 },
    ]);
    expect(output["stderr"]).toBe("stuck in a loop");
  });

  it("eval run usage errors exit 2", async () => {
    writeCredentials(tmpDir);
    writeSession(tmpDir);
    const { main } = await import("../client.js");
    await expect(main(["eval", "run", "-e", "1", "--timeout", "nope", "--json"])).resolves.toBe(2);
    await expect(main(["eval", "run", "-e", "1", "--imports", "[1]", "--json"])).resolves.toBe(2);
    await expect(main(["eval", "run", "file.ts", "-e", "1", "--json"])).resolves.toBe(2);
  });

  it("eval run without credentials is an auth error (exit 3)", async () => {
    writeSession(tmpDir);
    const { main } = await import("../client.js");
    await expect(main(["eval", "run", "-e", "1", "--json"])).resolves.toBe(3);
  });

  it("eval repl-reset upserts an empty scope", async () => {
    writeCredentials(tmpDir);
    writeSession(tmpDir);
    const { rpcBodies } = stubServer(() => null);

    const { main } = await import("../client.js");
    await expect(main(["eval", "repl-reset", "--json"])).resolves.toBe(0);

    expect(rpcBodies).toHaveLength(1);
    expect(rpcBodies[0]!.method).toBe("scope.upsert");
    expect(rpcBodies[0]!.args[0]).toMatchObject({
      channelId: "cli:default",
      panelId: "repl",
      data: "{}",
      serializedKeys: [],
    });
    expect(jsonOutput()).toMatchObject({ reset: true });
  });
});
