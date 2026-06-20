import { describe, expect, it, vi } from "vitest";
import {
  collectExposableMethods,
  createConnectionlessRpcClient,
  rpc,
  rpcExposedMethodNames,
  rpcMethodPolicy,
} from "./connectionless.js";
import type { RpcEnvelope } from "./types.js";

const SELF = "do:test:EvalDO:obj1";

function caller() {
  return { callerId: "main", callerKind: "server" as const };
}

function responseEnvelope(requestId: string, body: Record<string, unknown>): RpcEnvelope {
  return {
    from: "main",
    target: SELF,
    delivery: { caller: caller() },
    provenance: [caller()],
    message: { type: "response", requestId, ...body } as never,
  };
}

function requestEnvelope(method: string, args: unknown[], requestId = "q1"): RpcEnvelope {
  return {
    from: "main",
    target: SELF,
    delivery: { caller: caller() },
    provenance: [caller()],
    message: { type: "request", requestId, fromId: "main", method, args },
  };
}

function makeClient(fetchImpl: typeof fetch) {
  return createConnectionlessRpcClient({
    selfId: SELF,
    serverUrl: "http://gw.test",
    authToken: "T",
    callerKind: "do",
    fetch: fetchImpl,
  });
}

describe("createConnectionlessRpcClient", () => {
  describe("callDeferred", () => {
    it("surfaces a {deferred,requestId} ack (does NOT complete on the initial POST)", async () => {
      const fetchMock = vi.fn(async (_url: unknown, _init?: RequestInit) =>
        new Response(JSON.stringify({ deferred: true, requestId: "caller-rid" }), { status: 200 }),
      );
      const { client } = makeClient(fetchMock as unknown as typeof fetch);
      const ack = await client.callDeferred("main", "credentials.resolveCredential", [{}], {
        requestId: "caller-rid",
      });
      expect(ack).toEqual({ status: "deferred", requestId: "caller-rid" });
      // The deferrable flag + caller-supplied requestId are on the wire.
      const body = JSON.parse(String((fetchMock.mock.calls[0]![1] as RequestInit).body));
      expect(body.message).toMatchObject({ requestId: "caller-rid", deferrable: true });
    });

    it("returns {completed,result} when the server answers inline", async () => {
      const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
        const env = JSON.parse(String(init!.body)) as RpcEnvelope;
        const rid = (env.message as { requestId: string }).requestId;
        return new Response(JSON.stringify(responseEnvelope(rid, { result: { ok: 1 } })), {
          status: 200,
        });
      });
      const { client } = makeClient(fetchMock as unknown as typeof fetch);
      const ack = await client.callDeferred("main", "x.y", []);
      expect(ack).toEqual({ status: "completed", result: { ok: 1 } });
    });

    it("throws when the inline response is an error envelope", async () => {
      const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
        const env = JSON.parse(String(init!.body)) as RpcEnvelope;
        const rid = (env.message as { requestId: string }).requestId;
        return new Response(
          JSON.stringify(responseEnvelope(rid, { error: "boom", errorCode: "EBOOM" })),
          { status: 200 },
        );
      });
      const { client } = makeClient(fetchMock as unknown as typeof fetch);
      await expect(client.callDeferred("main", "x.y", [])).rejects.toThrow("boom");
    });
  });

  describe("respond (inbound request → response envelope, no POST)", () => {
    it("dispatches an exposed method and captures the response synchronously", async () => {
      const fetchMock = vi.fn();
      const { client, respond } = makeClient(fetchMock as unknown as typeof fetch);
      client.expose("ping", (req) => `pong-${(req.args as unknown[])[0]}`);

      const response = await respond(requestEnvelope("ping", ["x"]));
      expect(response).not.toBeNull();
      expect(response!.message).toMatchObject({ type: "response", requestId: "q1", result: "pong-x" });
      // The response was captured locally — never POSTed.
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("returns an error response for an unexposed method", async () => {
      const { client: _client, respond } = makeClient(vi.fn() as unknown as typeof fetch);
      const response = await respond(requestEnvelope("nope", []));
      expect(response!.message).toMatchObject({ type: "response" });
      expect((response!.message as { error?: string }).error).toMatch(/not exposed/);
    });
  });

  describe("deliver (inbound event → rpc.on listener)", () => {
    it("fires a matching event listener with no response", async () => {
      const { client, deliver } = makeClient(vi.fn() as unknown as typeof fetch);
      const seen: unknown[] = [];
      client.on("event:vcs:head:main", (ev) => seen.push(ev.payload));
      deliver({
        from: "main",
        target: SELF,
        delivery: { caller: caller() },
        provenance: [caller()],
        message: { type: "event", fromId: "main", event: "event:vcs:head:main", payload: { head: "h2" } },
      });
      expect(seen).toEqual([{ head: "h2" }]);
    });
  });
});

// A framework base whose plumbing must NEVER be reachable, an intermediate base, and a concrete DO.
// Only `@rpc`-marked methods are exposed (opt-in / default-deny) — including INHERITED decorated
// ones; ungated/private helpers and framework plumbing are unreachable.
class FrameworkBase {
  async dispatchInboundEnvelope(_env: unknown) {
    return "FRAMEWORK_REDISPATCH"; // re-dispatches under caller-supplied identity — must stay hidden
  }
  getStateValue(_key: string) {
    return "internal-state";
  }
}
class IntermediateBase extends FrameworkBase {
  @rpc async chatOp(_op: string) {
    return "ok"; // decorated on an intermediate base → still exposed on the concrete DO
  }
}
class ConcreteDO extends IntermediateBase {
  @rpc async run(x: number) {
    return x + 1;
  }
  // NOT @rpc — an ungated app helper (like appendDurable/callGad): must be unreachable over RPC.
  async appendDurable(_input: unknown) {
    return "ungated-internal";
  }
}

describe("@rpc opt-in exposure (default-deny, enforced)", () => {
  it("rpcExposedMethodNames collects own + inherited @rpc methods on the concrete class", () => {
    expect([...rpcExposedMethodNames(new ConcreteDO())].sort()).toEqual(["chatOp", "run"]);
  });

  it("collectExposableMethods exposes ONLY @rpc methods — not ungated helpers or framework plumbing", () => {
    const exposed = collectExposableMethods(
      new ConcreteDO(),
      rpcExposedMethodNames(new ConcreteDO()),
      FrameworkBase.prototype
    );
    expect(Object.keys(exposed).sort()).toEqual(["chatOp", "run"]);
    expect(exposed).not.toHaveProperty("appendDurable"); // ungated helper — unreachable
    expect(exposed).not.toHaveProperty("dispatchInboundEnvelope");
    expect(exposed).not.toHaveProperty("getStateValue");
  });

  it("rejects over-the-relay calls to undecorated methods (forgery vector AND ungated helpers closed)", async () => {
    const { client, respond } = makeClient(vi.fn() as unknown as typeof fetch);
    client.exposeAll(
      collectExposableMethods(
        new ConcreteDO(),
        rpcExposedMethodNames(new ConcreteDO()),
        FrameworkBase.prototype
      )
    );
    const ok = await respond(requestEnvelope("run", [41]));
    expect((ok!.message as { result?: unknown }).result).toBe(42);
    for (const method of ["appendDurable", "dispatchInboundEnvelope"]) {
      const denied = await respond(requestEnvelope(method, [{ forged: true }]));
      expect((denied!.message as { error?: string }).error).toMatch(/not exposed/);
    }
  });
});

// Declarative caller policy: `@rpc({ callers })` registers BOTH exposure and a caller-kind floor.
class PolicyBase {
  @rpc({ callers: ["server"] }) async serverOnly() {
    return "s"; // decorated on a base → policy lands on the concrete class too
  }
}
class PolicyDO extends PolicyBase {
  @rpc({ callers: ["panel", "do"] }) async broad() {
    return "b";
  }
  @rpc async noPolicy() {
    return "n"; // bare @rpc → exposed, but NO policy (realm gate / inline check governs)
  }
}

describe("@rpc({ callers }) declarative policy", () => {
  it("rpcMethodPolicy returns the policy for `@rpc({callers})` (own + inherited), undefined for bare `@rpc`", () => {
    const inst = new PolicyDO();
    expect(rpcMethodPolicy(inst, "broad")).toEqual({ callers: ["panel", "do"] });
    expect(rpcMethodPolicy(inst, "serverOnly")).toEqual({ callers: ["server"] }); // inherited
    expect(rpcMethodPolicy(inst, "noPolicy")).toBeUndefined(); // bare @rpc
  });

  it("the factory form `@rpc({callers})` still registers exposure", () => {
    expect([...rpcExposedMethodNames(new PolicyDO())].sort()).toEqual([
      "broad",
      "noPolicy",
      "serverOnly",
    ]);
  });
});
