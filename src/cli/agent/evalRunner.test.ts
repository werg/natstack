import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { boundReturnValue, runEval, type EvalHandshake, type RunnerEvent } from "./evalRunner.js";

/**
 * Integration tests for the eval-runner sandbox against a stub HTTP /rpc
 * server (same wire shape as rpcServer.ts: {method,args} → {result|error}).
 */

interface RpcRequest {
  method: string;
  args: unknown[];
}

let server: http.Server;
let serverUrl = "";
let rpcBodies: RpcRequest[] = [];
let rpcHandler: (body: RpcRequest) => unknown = () => null;
let rpcStatus = 200;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const body = JSON.parse(raw) as RpcRequest;
      rpcBodies.push(body);
      res.setHeader("Content-Type", "application/json");
      res.statusCode = rpcStatus;
      try {
        res.end(JSON.stringify({ result: rpcHandler(body) }));
      } catch (error) {
        res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  serverUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve()))
  );
});

afterEach(() => {
  rpcBodies = [];
  rpcHandler = () => null;
  rpcStatus = 200;
});

function handshake(code: string, extra: Partial<EvalHandshake> = {}): EvalHandshake {
  return {
    code,
    serverUrl,
    shellToken: "tok",
    contextId: "ctx_1",
    sessionId: "session:default",
    ...extra,
  };
}

async function run(code: string, extra: Partial<EvalHandshake> = {}) {
  const events: RunnerEvent[] = [];
  const result = await runEval(handshake(code, extra), (event) => events.push(event));
  return { events, result };
}

describe("evalRunner", () => {
  it("round-trips a structured return value", async () => {
    const { result } = await run("return { sum: 40 + 2, list: [1, 2] };");
    expect(result.success).toBe(true);
    expect(result.returnValue).toEqual({ sum: 42, list: [1, 2] });
    expect(result.returnTruncated).toBeUndefined();
  });

  it("streams console events in order with parsed levels", async () => {
    const { events, result } = await run(
      'console.log("first", 1); console.warn("careful"); console.log("last");'
    );
    expect(result.success).toBe(true);
    const consoleEvents = events.filter((e) => e.type === "console");
    expect(consoleEvents.map((e) => [e.level, e.text])).toEqual([
      ["log", "first 1"],
      ["warn", "careful"],
      ["log", "last"],
    ]);
    // The result event is emitted last.
    expect(events[events.length - 1]!.type).toBe("result");
  });

  it("reports thrown errors as a failed result", async () => {
    const { result } = await run('throw new Error("boom");');
    expect(result.success).toBe(false);
    expect(result.error).toBe("boom");
    expect(result.returnValue).toBeUndefined();
  });

  it("fs binding injects the contextId as the first rpc argument", async () => {
    rpcHandler = (body) => {
      if (body.method === "fs.readFile") return "file-content";
      return null;
    };
    const { result } = await run('return await fs.readFile("/notes/a.txt", "utf8");');
    expect(result.success).toBe(true);
    expect(result.returnValue).toBe("file-content");
    expect(rpcBodies).toEqual([{ method: "fs.readFile", args: ["ctx_1", "/notes/a.txt", "utf8"] }]);
  });

  it("services proxy dispatches service.method calls", async () => {
    rpcHandler = (body) => (body.method === "git.contextStatus" ? { clean: true } : null);
    const { result } = await run('return await services.git.contextStatus("ctx_1", "/repo");');
    expect(result.returnValue).toEqual({ clean: true });
    expect(rpcBodies).toEqual([{ method: "git.contextStatus", args: ["ctx_1", "/repo"] }]);
  });

  it("rpc errors from the stub server propagate as eval failures", async () => {
    rpcHandler = () => {
      throw new Error("Path traversal detected");
    };
    const { result } = await run('await fs.rm("../../etc");');
    expect(result.success).toBe(false);
    expect(result.error).toContain("Path traversal detected");
  });

  it("a mid-run 401 surfaces an actionable shell-token error", async () => {
    rpcStatus = 401;
    const { result } = await run("await services.meta.listServices();");
    expect(result.success).toBe(false);
    expect(result.error).toContain("shell token rejected (server restarted?) — rerun the eval");
  });

  it("restores the scope snapshot and serializes the final scope", async () => {
    const { result } = await run(
      "scope.count = (scope.count ?? 0) + 1; scope.label = `run ${scope.count}`; return scope.count;",
      { scopeSnapshot: JSON.stringify({ count: 41, keep: { nested: true } }) }
    );
    expect(result.success).toBe(true);
    expect(result.returnValue).toBe(42);
    // runEval always serializes a scope; only main()'s infrastructure
    // failures omit it.
    expect(JSON.parse(result.scope!.json)).toEqual({
      count: 42,
      label: "run 42",
      keep: { nested: true },
    });
    expect(result.scope!.serializedKeys.sort()).toEqual(["count", "keep", "label"]);
  });

  it("drops function-valued scope entries with a warning path", async () => {
    const { result } = await run("scope.fn = () => 1; scope.ok = 7;");
    expect(result.success).toBe(true);
    expect(JSON.parse(result.scope!.json)).toEqual({ ok: 7 });
    expect(result.scope!.droppedPaths).toEqual([{ path: "fn", reason: "function" }]);
  });

  it("ctx binding exposes the handshake identifiers", async () => {
    const { result } = await run("return ctx;", { workspaceId: "ws_1" });
    expect(result.returnValue).toEqual({
      contextId: "ctx_1",
      sessionId: "session:default",
      workspaceId: "ws_1",
      serverUrl,
    });
  });
});

describe("boundReturnValue", () => {
  it("passes small values through", () => {
    expect(boundReturnValue({ a: 1 })).toEqual({ returnValue: { a: 1 } });
    expect(boundReturnValue(undefined)).toEqual({});
  });

  it("truncates values whose JSON exceeds 256KB", () => {
    const big = "x".repeat(300 * 1024);
    const bounded = boundReturnValue({ big });
    expect(bounded.returnTruncated).toBe(true);
    expect(typeof bounded.returnValue).toBe("string");
    expect((bounded.returnValue as string).length).toBe(256 * 1024);
  });

  it("flags non-serializable values", () => {
    const circular: Record<string, unknown> = {};
    circular["self"] = circular;
    expect(boundReturnValue(circular)).toEqual({
      returnValue: { __unserializable: "object" },
    });
    expect(boundReturnValue(() => 1)).toEqual({
      returnValue: { __unserializable: "function" },
    });
  });
});
