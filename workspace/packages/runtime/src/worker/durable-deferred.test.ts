import { describe, expect, it } from "vitest";
import { DurableObjectBase, type DeferredCallOutcome } from "./durable-base.js";
import type { DeferredCallAck } from "../shared/httpRpcBridge.js";
import { createTestDO } from "./durable-test-utils.js";

interface FakeCall {
  target: string;
  method: string;
  args: unknown[];
  options?: { requestId?: string; idempotencyKey?: string };
}

/** Controllable stand-in for the HTTP bridge's callDeferred. */
function makeFakeRpc() {
  const calls: FakeCall[] = [];
  let ackFor: (call: FakeCall) => DeferredCallAck = (c) => ({
    status: "deferred",
    requestId: c.options?.requestId ?? "x",
  });
  return {
    calls,
    setAck(fn: (call: FakeCall) => DeferredCallAck) {
      ackFor = fn;
    },
    client: {
      callDeferred: async (
        target: string,
        method: string,
        args: unknown[],
        options?: { requestId?: string; idempotencyKey?: string },
      ): Promise<DeferredCallAck> => {
        const call: FakeCall = { target, method, args, ...(options ? { options } : {}) };
        calls.push(call);
        return ackFor(call);
      },
    },
  };
}

interface Resolution {
  requestId: string;
  result: unknown;
  isError: boolean;
  context: unknown;
}

class DeferProbeDO extends DurableObjectBase {
  protected createTables(): void {}
  readonly resolved: Resolution[] = [];

  protected override async onDeferredResolved(
    requestId: string,
    result: unknown,
    isError: boolean,
    context: unknown,
  ): Promise<void> {
    this.resolved.push({ requestId, result, isError, context });
  }

  async doDefer(
    target: string,
    method: string,
    args: unknown[],
    opts?: { idempotencyKey?: string; context?: unknown },
  ): Promise<DeferredCallOutcome> {
    return this.callDeferred(target, method, args, opts);
  }

  async doRedrive(): Promise<void> {
    return this.redriveDeferredRequests();
  }
}

/** A DO that never defers — used to assert zero-cost (no table). */
class PlainDO extends DurableObjectBase {
  protected createTables(): void {}
  ping(): string {
    return "pong";
  }
}

type Fetchable = { fetch(request: Request): Promise<Response> };

async function deliver(
  instance: DurableObjectBase,
  payload: { requestId: string; result?: unknown; isError?: boolean },
  callerKind = "server",
): Promise<Response> {
  return (instance as unknown as Fetchable).fetch(
    new Request("http://test/test-key/onDeferredResult", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Natstack-Rpc-Caller-Id": "server",
        "X-Natstack-Rpc-Caller-Kind": callerKind,
      },
      body: JSON.stringify([payload]),
    }),
  );
}

async function setup() {
  const { instance, sql } = await createTestDO(DeferProbeDO);
  const fake = makeFakeRpc();
  (instance as unknown as { _rpc: unknown })._rpc = fake.client;
  return { instance, sql, fake };
}

const rowsFor = (sql: { exec: (q: string, ...a: unknown[]) => { toArray(): Record<string, unknown>[] } }) =>
  sql.exec(`SELECT request_id, status, is_error FROM deferred_requests`).toArray();

describe("DurableObjectBase deferred calls", () => {
  it("persists a pending row and returns the deferred sentinel", async () => {
    const { instance, sql, fake } = await setup();
    const outcome = await instance.doDefer("main", "credentials.resolveCredential", [{ url: "u" }]);

    expect(outcome.status).toBe("deferred");
    expect(instance.resolved).toHaveLength(0);
    // The bridge was called with the DO-chosen requestId (persist-before-issue).
    expect(fake.calls[0]!.options?.requestId).toBe(outcome.requestId);
    const rows = rowsFor(sql);
    expect(rows).toEqual([{ request_id: outcome.requestId, status: "pending", is_error: 0 }]);
  });

  it("resolves once on inbound delivery and is idempotent", async () => {
    const { instance, sql } = await setup();
    const outcome = await instance.doDefer("main", "svc.m", [1]);
    expect(outcome.status).toBe("deferred");

    const r1 = await deliver(instance, { requestId: outcome.requestId, result: { ok: true } });
    expect(r1.status).toBe(200);
    // Duplicate delivery is a no-op.
    const r2 = await deliver(instance, { requestId: outcome.requestId, result: { ok: true } });
    expect(r2.status).toBe(200);

    expect(instance.resolved).toEqual([
      { requestId: outcome.requestId, result: { ok: true }, isError: false, context: undefined },
    ]);
    expect(rowsFor(sql)).toEqual([
      { request_id: outcome.requestId, status: "completed", is_error: 0 },
    ]);
  });

  it("hands the opaque context back to the resolver", async () => {
    const { instance } = await setup();
    const outcome = await instance.doDefer("main", "svc.m", [1], { context: { turnId: "t-7" } });
    await deliver(instance, { requestId: outcome.requestId, result: "done" });
    expect(instance.resolved[0]!.context).toEqual({ turnId: "t-7" });
  });

  it("delivers an error result as isError", async () => {
    const { instance, sql } = await setup();
    const outcome = await instance.doDefer("main", "svc.m", [1]);
    await deliver(instance, { requestId: outcome.requestId, result: { message: "no" }, isError: true });
    expect(instance.resolved[0]!.isError).toBe(true);
    expect(rowsFor(sql)).toEqual([{ request_id: outcome.requestId, status: "failed", is_error: 1 }]);
  });

  it("rejects a non-server caller", async () => {
    const { instance } = await setup();
    const outcome = await instance.doDefer("main", "svc.m", [1]);
    const res = await deliver(instance, { requestId: outcome.requestId, result: 1 }, "panel");
    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toMatchObject({ error: expect.stringContaining("server") });
    expect(instance.resolved).toHaveLength(0);
  });

  it("tolerates delivery for an unknown requestId", async () => {
    const { instance } = await setup();
    // Force the table to exist without a matching row.
    await instance.doDefer("main", "svc.m", [1]);
    const res = await deliver(instance, { requestId: "does-not-exist", result: 1 });
    expect(res.status).toBe(200);
    expect(instance.resolved).toHaveLength(0);
  });

  it("applies a fast-path inline completion without an inbound delivery", async () => {
    const { instance, sql, fake } = await setup();
    fake.setAck((c) => ({ status: "completed", result: { grant: "session" }, requestId: c.options?.requestId ?? "x" }) as DeferredCallAck);
    const outcome = await instance.doDefer("main", "svc.m", [1]);
    expect(outcome.status).toBe("completed");
    expect(instance.resolved).toEqual([
      { requestId: outcome.requestId, result: { grant: "session" }, isError: false, context: undefined },
    ]);
    expect(rowsFor(sql)).toEqual([
      { request_id: outcome.requestId, status: "completed", is_error: 0 },
    ]);
  });

  it("re-drive reissues pending calls and applies an inline resolution", async () => {
    const { instance, fake } = await setup();
    const outcome = await instance.doDefer("main", "svc.m", [1], { idempotencyKey: "idem-9" });
    expect(outcome.status).toBe("deferred");
    expect(instance.resolved).toHaveLength(0);

    // On re-drive, the server now has the grant and resolves inline.
    fake.setAck((c) => ({ status: "completed", result: "ok", requestId: c.options?.requestId ?? "x" }) as DeferredCallAck);
    await instance.doRedrive();

    expect(instance.resolved).toEqual([
      { requestId: outcome.requestId, result: "ok", isError: false, context: undefined },
    ]);
    // Reissue carried the original requestId + idempotencyKey.
    const reissue = fake.calls[fake.calls.length - 1]!;
    expect(reissue.options?.requestId).toBe(outcome.requestId);
    expect(reissue.options?.idempotencyKey).toBe("idem-9");
  });

  it("a DO that never defers creates no deferred_requests table", async () => {
    const { instance, sql } = await createTestDO(PlainDO);
    expect(instance.ping()).toBe("pong");
    const tables = sql
      .exec(`SELECT name FROM sqlite_master WHERE type='table' AND name='deferred_requests'`)
      .toArray();
    expect(tables).toHaveLength(0);
  });
});
