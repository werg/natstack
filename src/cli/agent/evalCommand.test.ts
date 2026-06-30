import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { clearShellTokenCache } from "../rpcClient.js";

/**
 * `natstack eval` drives the server-side `eval` service (eval.run / eval.reset)
 * over the CLI's Bearer /rpc transport. These tests stub that HTTP surface
 * (same wire shape as rpcServer.ts: {method,args} → {result|error}) and assert
 * the command builds the right calls and shapes its output/exit codes.
 */

interface RpcRequest {
  method: string;
  args: unknown[];
}

type RunResult = {
  success: boolean;
  console: string;
  returnValue?: unknown;
  error?: string;
  scopeKeys?: string[];
};

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
      // Envelope-native /rpc: unwrap the request envelope into the legacy
      // {type,targetId,method,args} shape tests assert on, and reply with a
      // response envelope the CLI client unwraps.
      const envelope = JSON.parse(String(init?.body ?? "{}")) as {
        from?: string;
        target?: string;
        message?: {
          type?: string;
          requestId?: string;
          method?: string;
          args?: unknown[];
          event?: string;
          payload?: unknown;
        };
      };
      const msg = envelope.message ?? {};
      const target = envelope.target;
      const body = (msg.type === "event"
        ? { type: "emit", targetId: target, event: msg.event, payload: msg.payload }
        : target && target !== "main"
          ? { type: "call", targetId: target, method: msg.method, args: msg.args ?? [] }
          : { method: msg.method, args: msg.args ?? [] }) as unknown as RpcRequest;
      rpcBodies.push(body);
      const respond = (payload: { result?: unknown; error?: string }): Response =>
        new Response(
          JSON.stringify({
            from: envelope.target,
            target: envelope.from,
            delivery: { caller: { callerId: "main", callerKind: "server" } },
            provenance: [],
            message: { type: "response", requestId: msg.requestId, ...payload },
          })
        );
      try {
        return respond({ result: handle(body) });
      } catch (error) {
        return respond({ error: error instanceof Error ? error.message : String(error) });
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

const OK_RESULT: RunResult = {
  success: true,
  console: "hello\n[WARN] careful",
  returnValue: { answer: 42 },
  scopeKeys: ["x"],
};

function jsonOutput(): Record<string, unknown> {
  const lines = vi.mocked(console.log).mock.calls.map((call) => String(call[0]));
  return JSON.parse(lines[lines.length - 1]!) as Record<string, unknown>;
}

function jsonErrorOutput(): Record<string, unknown> {
  const lines = vi.mocked(console.error).mock.calls.map((call) => String(call[0]));
  return JSON.parse(lines[lines.length - 1]!) as Record<string, unknown>;
}

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

  it("eval run calls eval.run with the session subKey and exits 0", async () => {
    writeCredentials(tmpDir);
    writeSession(tmpDir);
    const { rpcBodies } = stubServer((body) => (body.method === "eval.run" ? OK_RESULT : null));

    const { main } = await import("../client.js");
    await expect(main(["eval", "run", "-e", "return 42;", "--json"])).resolves.toBe(0);

    expect(rpcBodies.map((b) => b.method)).toEqual(["eval.run"]);
    expect(rpcBodies[0]!.args[0]).toEqual({
      ownerId: "session:default",
      contextId: "ctx_1",
      subKey: "default",
      code: "return 42;",
      path: undefined,
      syntax: undefined,
      imports: undefined,
    });

    const output = jsonOutput();
    expect(output["success"]).toBe(true);
    expect(output["returnValue"]).toEqual({ answer: 42 });
    expect(output["console"]).toBe("hello\n[WARN] careful");
    expect(output["scopeKeys"]).toEqual(["x"]);
    // One shell refresh per eval.
    const refreshCalls = vi
      .mocked(globalThis.fetch)
      .mock.calls.filter((call) => String(call[0]).endsWith("/_r/s/auth/refresh-shell"));
    expect(refreshCalls).toHaveLength(1);
  });

  it("eval run --fresh-scope resets before running", async () => {
    writeCredentials(tmpDir);
    writeSession(tmpDir);
    const { rpcBodies } = stubServer((body) =>
      body.method === "eval.reset" ? { ok: true } : OK_RESULT
    );

    const { main } = await import("../client.js");
    await expect(main(["eval", "run", "-e", "return 1;", "--fresh-scope", "--json"])).resolves.toBe(
      0
    );

    expect(rpcBodies.map((b) => b.method)).toEqual(["eval.reset", "eval.run"]);
    expect(rpcBodies[0]!.args[0]).toEqual({
      ownerId: "session:default",
      contextId: "ctx_1",
      subKey: "default",
    });
  });

  it("eval run forwards syntax + imports", async () => {
    writeCredentials(tmpDir);
    writeSession(tmpDir);
    const { rpcBodies } = stubServer(() => OK_RESULT);

    const { main } = await import("../client.js");
    await expect(
      main([
        "eval",
        "run",
        "-e",
        "return 1;",
        "--syntax",
        "typescript",
        "--imports",
        '{"lodash":"npm:4"}',
        "--json",
      ])
    ).resolves.toBe(0);

    expect(rpcBodies[0]!.args[0]).toMatchObject({
      syntax: "typescript",
      imports: { lodash: "npm:4" },
    });
  });

  it("eval run --path lets the server read the file (no inline code)", async () => {
    writeCredentials(tmpDir);
    writeSession(tmpDir);
    const { rpcBodies } = stubServer(() => OK_RESULT);

    const { main } = await import("../client.js");
    await expect(main(["eval", "run", "--path", "/snippets/a.ts", "--json"])).resolves.toBe(0);

    // `code` is undefined → dropped by JSON serialization; only `path` is sent.
    expect(rpcBodies[0]!.args[0]).toEqual({
      ownerId: "session:default",
      contextId: "ctx_1",
      subKey: "default",
      path: "/snippets/a.ts",
      syntax: undefined,
      imports: undefined,
    });
  });

  it("eval run reads code from a local FILE positional", async () => {
    writeCredentials(tmpDir);
    writeSession(tmpDir);
    const { rpcBodies } = stubServer(() => OK_RESULT);
    const codeFile = path.join(tmpDir, "snippet.ts");
    fs.writeFileSync(codeFile, "return 42;");

    const { main } = await import("../client.js");
    await expect(main(["eval", "run", codeFile, "--json"])).resolves.toBe(0);

    expect(rpcBodies[0]!.args[0]).toMatchObject({ code: "return 42;" });
  });

  it("eval run maps a failed result to exit 1", async () => {
    writeCredentials(tmpDir);
    writeSession(tmpDir);
    stubServer(() => ({ success: false, console: "", error: "boom" }) satisfies RunResult);

    const { main } = await import("../client.js");
    await expect(main(["eval", "run", "-e", "throw 1;", "--json"])).resolves.toBe(1);

    const output = jsonOutput();
    expect(output["success"]).toBe(false);
    expect(output["error"]).toBe("boom");
  });

  it("eval run maps a slow server call to a timeout (exit 4)", async () => {
    writeCredentials(tmpDir);
    writeSession(tmpDir);
    // Server never responds to eval.run → the client-side timeout trips.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: URL) => {
        if (String(url).endsWith("/_r/s/auth/refresh-shell")) {
          return new Response(
            JSON.stringify({ shellToken: "tok", callerId: "shell:dev_cli", deviceId: "dev_cli" })
          );
        }
        return await new Promise<Response>(() => {}); // hang forever
      })
    );

    const { main } = await import("../client.js");
    await expect(
      main(["eval", "run", "-e", "while(true){}", "--timeout", "200", "--json"])
    ).resolves.toBe(4);

    const output = jsonErrorOutput();
    expect(String(output["error"])).toContain("timed out");
    expect(output["exitCode"]).toBe(4);
  });

  it("eval run usage errors exit 2", async () => {
    writeCredentials(tmpDir);
    writeSession(tmpDir);
    const { main } = await import("../client.js");
    await expect(main(["eval", "run", "-e", "1", "--timeout", "nope", "--json"])).resolves.toBe(2);
    await expect(main(["eval", "run", "-e", "1", "--imports", "[1]", "--json"])).resolves.toBe(2);
    await expect(main(["eval", "run", "file.ts", "-e", "1", "--json"])).resolves.toBe(2);
    await expect(main(["eval", "run", "-e", "1", "--path", "/a.ts", "--json"])).resolves.toBe(2);
  });

  it("eval run without credentials is an auth error (exit 3)", async () => {
    writeSession(tmpDir);
    const { main } = await import("../client.js");
    await expect(main(["eval", "run", "-e", "1", "--json"])).resolves.toBe(3);
  });

  it("eval repl-reset calls eval.reset with the session subKey", async () => {
    writeCredentials(tmpDir);
    writeSession(tmpDir);
    const { rpcBodies } = stubServer(() => ({ ok: true }));

    const { main } = await import("../client.js");
    await expect(main(["eval", "repl-reset", "--json"])).resolves.toBe(0);

    expect(rpcBodies).toHaveLength(1);
    expect(rpcBodies[0]!.method).toBe("eval.reset");
    expect(rpcBodies[0]!.args[0]).toEqual({
      ownerId: "session:default",
      contextId: "ctx_1",
      subKey: "default",
    });
    expect(jsonOutput()).toMatchObject({ ok: true });
  });
});
