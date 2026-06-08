import { describe, it, expect } from "vitest";
import { isDeferredResult } from "@natstack/shared/serviceDispatcher";
import { DeferralRegistry } from "./deferralRegistry.js";

interface Delivery {
  callerId: string;
  requestId: string;
  result: unknown;
  isError: boolean;
}

/** A registry wired to a manual timer + a recording deliver callback. */
function makeRegistry(opts?: { ttlMs?: number }) {
  const deliveries: Delivery[] = [];
  const timers: Array<{ fn: () => void; ms: number; cancelled: boolean }> = [];
  const registry = new DeferralRegistry({
    deliver: async (callerId, requestId, result, isError) => {
      deliveries.push({ callerId, requestId, result, isError });
    },
    ...(opts?.ttlMs ? { ttlMs: opts.ttlMs } : {}),
    setTimer: (fn, ms) => {
      const handle = { fn, ms, cancelled: false };
      timers.push(handle);
      return { cancel: () => (handle.cancelled = true) };
    },
  });
  const fireTimers = () => timers.filter((t) => !t.cancelled).forEach((t) => t.fn());
  return { registry, deliveries, timers, fireTimers };
}

const info = (over?: Partial<Parameters<DeferralRegistry["createApi"]>[0]>) => ({
  callerId: "do:workers/agent:Agent:chan-1",
  requestId: "req-1",
  service: "credentials",
  method: "resolveCredential",
  ...over,
});

describe("DeferralRegistry", () => {
  it("aborts the in-flight work signal on TTL expiry (P1-3: no leaked approval waiter)", async () => {
    const { registry, fireTimers } = makeRegistry({ ttlMs: 1000 });
    let captured: AbortSignal | null = null;
    registry.createApi(info()).run((signal) => {
      captured = signal;
      return new Promise(() => {}); // never resolves (a pending human approval)
    });
    expect(captured).not.toBeNull();
    expect(captured!.aborted).toBe(false);
    fireTimers(); // TTL fires
    expect(captured!.aborted).toBe(true);
  });

  it("run() returns the deferred sentinel and defers delivery", async () => {
    const { registry, deliveries } = makeRegistry();
    let resolveWork!: (v: unknown) => void;
    const sentinel = registry.createApi(info()).run(() => new Promise((r) => (resolveWork = r)));

    expect(isDeferredResult(sentinel)).toBe(true);
    expect(sentinel.requestId).toBe("req-1");
    expect(deliveries).toHaveLength(0); // not yet settled
    expect(registry.size).toBe(1);

    resolveWork({ decision: "session" });
    await Promise.resolve();
    await Promise.resolve();

    expect(deliveries).toEqual([
      {
        callerId: "do:workers/agent:Agent:chan-1",
        requestId: "req-1",
        result: { decision: "session" },
        isError: false,
      },
    ]);
    expect(registry.size).toBe(0);
  });

  it("delivers a handler error as isError without throwing", async () => {
    const { registry, deliveries } = makeRegistry();
    registry.createApi(info()).run(async () => {
      throw Object.assign(new Error("denied"), { code: "EACCES" });
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]!.isError).toBe(true);
    expect(deliveries[0]!.result).toEqual({ message: "denied", code: "EACCES" });
  });

  it("dedups reissued calls with the same idempotencyKey onto one work run", async () => {
    const { registry, deliveries } = makeRegistry();
    let runs = 0;
    let resolveWork!: (v: unknown) => void;
    const work = () => {
      runs++;
      return new Promise((r) => (resolveWork = r));
    };

    // Two reissues of the same logical call (same idempotencyKey, different requestId).
    registry.createApi(info({ requestId: "req-A", idempotencyKey: "idem-1" })).run(work);
    registry.createApi(info({ requestId: "req-B", idempotencyKey: "idem-1" })).run(work);

    expect(runs).toBe(1); // work ran once
    expect(registry.size).toBe(1);

    resolveWork("ok");
    await Promise.resolve();
    await Promise.resolve();

    // Both requestIds receive the single result.
    expect(deliveries.map((d) => d.requestId).sort()).toEqual(["req-A", "req-B"]);
    expect(deliveries.every((d) => d.result === "ok")).toBe(true);
  });

  it("does NOT collapse different callers sharing an idempotencyKey (isolation)", () => {
    const { registry } = makeRegistry();
    let runs = 0;
    const work = () => {
      runs++;
      return new Promise(() => {});
    };
    registry.createApi(info({ callerId: "do:a:A:1", idempotencyKey: "k" })).run(work);
    registry.createApi(info({ callerId: "do:b:B:2", idempotencyKey: "k" })).run(work);
    expect(runs).toBe(2);
    expect(registry.size).toBe(2);
  });

  it("TTL expiry settles a never-resolving call as an error", async () => {
    const { registry, deliveries, fireTimers } = makeRegistry({ ttlMs: 1000 });
    registry.createApi(info()).run(() => new Promise(() => {})); // never settles
    expect(registry.size).toBe(1);

    fireTimers();
    await Promise.resolve();

    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]!.isError).toBe(true);
    expect(registry.size).toBe(0);
  });

  it("late work resolution after TTL does not double-deliver", async () => {
    const { registry, deliveries, fireTimers } = makeRegistry({ ttlMs: 1000 });
    let resolveWork!: (v: unknown) => void;
    registry.createApi(info()).run(() => new Promise((r) => (resolveWork = r)));

    fireTimers(); // settle via timeout
    await Promise.resolve();
    expect(deliveries).toHaveLength(1);

    resolveWork("late"); // work resolves after the entry is gone
    await Promise.resolve();
    await Promise.resolve();
    expect(deliveries).toHaveLength(1); // no second delivery
  });
});
