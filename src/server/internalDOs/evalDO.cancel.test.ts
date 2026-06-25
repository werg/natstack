/**
 * Eval cancellation + forced recovery.
 *
 * Covers the run-chain hardening:
 *  - `cancel(runId)`: an in-flight run wedged on an outbound rpc.call unwinds once cancelled (its
 *    abort signal — threaded into `runLocked` — fires and the run rejects), and the CAS to
 *    `cancelled` makes a late finish lose so it can never resurrect itself `done`.
 *  - `forceReset()`: a WEDGED run holding `runChain` does NOT block a subsequently-enqueued run
 *    (the chain is REPLACED, not `.then()`'d off), and user tables + scope are cleared immediately.
 *
 * The EvalDO's heavy engine (a workerd build of `@workspace/eval`) is NOT instantiated here — we
 * override `runLocked` to simulate a run that blocks until its threaded abort signal fires, which is
 * EXACTLY what a real outbound `rpc.call` does on abort (rpc client.ts rejects the pending request
 * when `options.signal` aborts). So this faithfully exercises `runEval`'s controller wiring, the CAS
 * persist, and the `cancel`/`forceReset`/run-chain machinery — the code under change.
 *
 * No timeouts/deadlines are used anywhere: recovery is via abort/forced-reset only.
 */
import { describe, expect, it, vi } from "vitest";
import { createTestDO } from "@natstack/durable/test-utils";
import { EvalDO } from "./evalDO.js";

type RunResult = { success: boolean; console: string; returnValue?: unknown; error?: string };
type RunLockedFn = (args: unknown, signal?: AbortSignal, runId?: string) => Promise<RunResult>;

/** Access a private method/field on the instance without TS visibility friction (test-only). */
function priv<T = unknown>(instance: object, key: string): T {
  return (instance as unknown as Record<string, unknown>)[key] as T;
}
function setPriv(instance: object, key: string, value: unknown): void {
  (instance as unknown as Record<string, unknown>)[key] = value;
}

/**
 * A run that BLOCKS until its threaded abort signal fires, then rejects — mirroring a real outbound
 * rpc.call wedged on a never-returning peer (the rpc client rejects the pending request on abort).
 * Resolves the returned `started` promise once the run is actually executing so tests can sequence.
 */
function blockUntilAborted(): {
  runLocked: RunLockedFn;
  started: Promise<{ signal: AbortSignal | undefined; runId: string | undefined }>;
} {
  let resolveStarted!: (v: { signal: AbortSignal | undefined; runId: string | undefined }) => void;
  const started = new Promise<{ signal: AbortSignal | undefined; runId: string | undefined }>(
    (r) => (resolveStarted = r)
  );
  const runLocked: RunLockedFn = (_args, signal, runId) =>
    new Promise<RunResult>((_resolve, reject) => {
      resolveStarted({ signal, runId });
      if (signal?.aborted) {
        reject(new Error("aborted"));
        return;
      }
      signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    });
  return { runLocked, started };
}

/** Insert a pending run row directly (bypasses the schema-validated service so the DO is exercised). */
function seedPendingRun(
  sql: { exec: (q: string, ...b: unknown[]) => unknown },
  runId: string
): void {
  sql.exec(
    `INSERT INTO runs (run_id, args, agent_ref, channel_id, status, started_at, deadline_at)
     VALUES (?, ?, NULL, NULL, 'pending', ?, NULL)`,
    runId,
    JSON.stringify({ code: "return 1;", contextId: "ctx" }),
    Date.now()
  );
}

describe("EvalDO cancellation + forced recovery", () => {
  it("startRun counts as activity and re-arms idle eviction", async () => {
    const { instance } = await createTestDO(EvalDO);
    const setAlarmAt = vi
      .spyOn(
        instance as unknown as { setAlarmAt: (timeMs: number, opts?: unknown) => void },
        "setAlarmAt"
      )
      .mockImplementation(() => undefined);

    const ret = priv<
      (args: { runId: string; code: string; contextId: string }) => {
        runId: string;
        status: string;
      }
    >(instance, "startRun").call(instance, {
      runId: "queued",
      code: "return 1;",
      contextId: "ctx",
    });

    expect(ret).toEqual({ runId: "queued", status: "pending" });
    expect(setAlarmAt).toHaveBeenCalledTimes(1);
    expect(setAlarmAt).toHaveBeenCalledWith(expect.any(Number), { bestEffort: true });
  });

  it.each(["pending", "running"] as const)(
    "alarm re-arms instead of aborting when a durable %s run exists",
    async (status) => {
      const { instance, sql } = await createTestDO(EvalDO);
      seedPendingRun(sql, "active-run");
      if (status === "running") {
        sql.exec(`UPDATE runs SET status = 'running' WHERE run_id = 'active-run'`);
      }
      const consoleInfo = vi.spyOn(console, "info").mockImplementation(() => undefined);
      const setAlarmAt = vi
        .spyOn(
          instance as unknown as { setAlarmAt: (timeMs: number, opts?: unknown) => void },
          "setAlarmAt"
        )
        .mockImplementation(() => undefined);

      await instance.alarm();

      expect(setAlarmAt).toHaveBeenCalledTimes(1);
      expect(setAlarmAt).toHaveBeenCalledWith(expect.any(Number), { bestEffort: true });
      expect(consoleInfo).toHaveBeenCalledWith(
        "[EvalDO] idle eviction alarm",
        expect.objectContaining({
          objectKey: "test-key",
          inFlightRuns: 0,
          durableRuns: 1,
          oldestDurableRunStartedAt: expect.any(Number),
        })
      );
      consoleInfo.mockRestore();
    }
  );

  it("alarm re-arms instead of aborting when an in-memory claimed run exists", async () => {
    const { instance } = await createTestDO(EvalDO);
    priv<Set<string>>(instance, "activeRunIds").add("claimed-run");
    const consoleInfo = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const setAlarmAt = vi
      .spyOn(
        instance as unknown as { setAlarmAt: (timeMs: number, opts?: unknown) => void },
        "setAlarmAt"
      )
      .mockImplementation(() => undefined);

    await instance.alarm();

    expect(setAlarmAt).toHaveBeenCalledTimes(1);
    expect(setAlarmAt).toHaveBeenCalledWith(expect.any(Number), { bestEffort: true });
    expect(consoleInfo).toHaveBeenCalledWith(
      "[EvalDO] idle eviction alarm",
      expect.objectContaining({
        objectKey: "test-key",
        inFlightRuns: 0,
        activeRunIds: 1,
        inMemoryRunIds: ["claimed-run"],
        durableRuns: 0,
      })
    );
    consoleInfo.mockRestore();
  });

  it("alarm does not log the detailed state dump for confirmed-idle eviction", async () => {
    const { instance } = await createTestDO(EvalDO);
    const consoleInfo = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const unsubscribeAll = vi.fn(() => Promise.resolve());
    setPriv(instance, "mainEvents", () => ({ unsubscribeAll }));
    const abort = vi.fn();
    priv<{ abort?: (reason?: string) => void }>(instance, "ctx").abort = abort;

    await instance.alarm();

    expect(consoleInfo).not.toHaveBeenCalled();
    expect(unsubscribeAll).toHaveBeenCalledTimes(1);
    expect(abort).toHaveBeenCalledWith("EvalDO: idle eviction (reclaim memory; SQLite preserved)");
    consoleInfo.mockRestore();
  });

  it("executeRun persists a bounded terminal result for huge console and return payloads", async () => {
    const { instance, sql } = await createTestDO(EvalDO);
    const hugeConsole = `console-start\n${"c".repeat(220_000)}\nconsole-end`;
    const hugeReturn = { value: `return-start\n${"r".repeat(220_000)}\nreturn-end` };
    setPriv(instance, "runLocked", () =>
      Promise.resolve({ success: true, console: hugeConsole, returnValue: hugeReturn })
    );
    seedPendingRun(sql, "huge-run");

    const result = await priv<(id: string) => Promise<RunResult>>(instance, "executeRun").call(
      instance,
      "huge-run"
    );

    expect(result.success).toBe(true);
    expect(result.console.length).toBeLessThan(100_000);
    expect(result.console).toContain("scope.$lastConsole");
    expect(result.returnValue).toMatchObject({
      truncated: true,
      scopeKey: "$lastReturn",
    });

    const persisted = priv<(id: string) => { status: string; result?: RunResult }>(
      instance,
      "getRun"
    ).call(instance, "huge-run");
    expect(persisted.status).toBe("done");
    expect(persisted.result).toEqual(result);
    expect(JSON.stringify(persisted.result).length).toBeLessThan(250_000);
  });

  it("cancel(runId): an in-flight run wedged on an outbound call unwinds once cancelled", async () => {
    const { instance, sql } = await createTestDO(EvalDO);
    const { runLocked, started } = blockUntilAborted();
    setPriv(instance, "runLocked", runLocked);

    seedPendingRun(sql, "run-A");
    // Kick the held execution; do NOT await — it wedges until cancelled.
    const runP = priv<(id: string) => Promise<RunResult>>(instance, "executeRun").call(
      instance,
      "run-A"
    );
    runP.catch(() => undefined); // avoid an unhandled-rejection warning before the assertion awaits

    // The run is now executing (blocked on the simulated outbound call).
    const { signal } = await started;
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal!.aborted).toBe(false);
    expect(sql.exec(`SELECT status FROM runs WHERE run_id = 'run-A'`).toArray()[0]).toMatchObject({
      status: "running",
    });

    // Cancel: CAS row → cancelled, then abort the controller threaded into the run.
    const cancelRet = priv<(id: string) => { ok: boolean }>(instance, "cancel").call(
      instance,
      "run-A"
    );
    expect(cancelRet).toEqual({ ok: true });
    expect(signal!.aborted).toBe(true);

    // The wedged run unwinds (rejects), and `runEval` maps the cancelled status to a failure result —
    // it can NEVER resurrect itself `done` (the CAS persist requires status='running').
    const result = await runP;
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/cancelled/i);
    expect(sql.exec(`SELECT status FROM runs WHERE run_id = 'run-A'`).toArray()[0]).toMatchObject({
      status: "cancelled",
    });
  });

  it("cancel(runId): a no-op for an already-terminal run, and leaves other runs untouched", async () => {
    const { instance, sql } = await createTestDO(EvalDO);
    // A done run + a pending run that is NOT the cancel target.
    sql.exec(
      `INSERT INTO runs (run_id, args, status, started_at) VALUES ('done-1', '{}', 'done', ?)`,
      Date.now()
    );
    seedPendingRun(sql, "other");

    const ret = priv<(id: string) => { ok: boolean }>(instance, "cancel").call(instance, "done-1");
    expect(ret).toEqual({ ok: true });
    // The done run is NOT flipped to cancelled (CAS only touches pending/running), and `other` is untouched.
    expect(sql.exec(`SELECT status FROM runs WHERE run_id = 'done-1'`).toArray()[0]).toMatchObject({
      status: "done",
    });
    expect(sql.exec(`SELECT status FROM runs WHERE run_id = 'other'`).toArray()[0]).toMatchObject({
      status: "pending",
    });
  });

  it("forceReset(): a wedged run on runChain does not block a later run, and tables/scope are cleared", async () => {
    const { instance, sql } = await createTestDO(EvalDO);

    // 1) A wedged run that holds `runChain` forever (never aborts on its own).
    const { runLocked: wedge, started: wedgeStarted } = blockUntilAborted();
    setPriv(instance, "runLocked", wedge);
    seedPendingRun(sql, "wedged");
    const wedgedP = priv<(id: string) => Promise<RunResult>>(instance, "executeRun").call(
      instance,
      "wedged"
    );
    wedgedP.catch(() => undefined);
    await wedgeStarted; // the wedged run now occupies runChain

    // Seed user table + a fake scope table so we can assert resetLocked wiped them.
    sql.exec(`CREATE TABLE IF NOT EXISTS user_data (k TEXT)`);
    sql.exec(`INSERT INTO user_data (k) VALUES ('x')`);
    sql.exec(`CREATE TABLE IF NOT EXISTS repl_scopes (id TEXT)`);
    setPriv(instance, "scopeManager", { marker: "stale" });

    // 2) forceReset: cancel non-terminal runs, abort in-flight, REPLACE runChain, resetLocked NOW.
    const chainBefore = priv<Promise<unknown>>(instance, "runChain");
    const forceRet = priv<() => { ok: boolean }>(instance, "forceReset").call(instance);
    expect(forceRet).toEqual({ ok: true });

    // The wedged run was CAS'd to cancelled and aborted (so it unwinds rather than leaking forever).
    expect(sql.exec(`SELECT status FROM runs WHERE run_id = 'wedged'`).toArray()[0]).toMatchObject({
      status: "cancelled",
    });
    const wedgedResult = await wedgedP;
    expect(wedgedResult.success).toBe(false);

    // runChain was REPLACED (orphaned), not chained off the stuck one.
    const chainAfter = priv<Promise<unknown>>(instance, "runChain");
    expect(chainAfter).not.toBe(chainBefore);
    await expect(chainAfter).resolves.toBeUndefined();

    // resetLocked ran SYNCHRONOUSLY (not queued behind the wedged run): user tables + scope cleared.
    const tables = sql
      .exec(`SELECT name FROM sqlite_master WHERE type='table'`)
      .toArray()
      .map((r) => (r as { name: string }).name);
    expect(tables).not.toContain("user_data");
    expect(tables).not.toContain("repl_scopes");
    expect(priv(instance, "scopeManager")).toBeNull();

    // 3) A NEW run enqueued AFTER forceReset proceeds at once — the chain was not wedged.
    const { runLocked: fresh, started: freshStarted } = (() => {
      let resolveStarted!: () => void;
      const startedP = new Promise<void>((r) => (resolveStarted = r));
      const fn: RunLockedFn = () => {
        resolveStarted();
        return Promise.resolve({ success: true, console: "ok" });
      };
      return { runLocked: fn, started: startedP };
    })();
    setPriv(instance, "runLocked", fresh);
    seedPendingRun(sql, "after");
    const afterP = priv<(id: string) => Promise<RunResult>>(instance, "executeRun").call(
      instance,
      "after"
    );
    await freshStarted; // proves the new run actually ran (did not hang behind the wedged chain)
    const afterResult = await afterP;
    expect(afterResult).toMatchObject({ success: true, console: "ok" });
    expect(sql.exec(`SELECT status FROM runs WHERE run_id = 'after'`).toArray()[0]).toMatchObject({
      status: "done",
    });
  });

  it("runLocked threads the run's abort signal into eval outbound rpc.call", async () => {
    // Verifies task 2a end-to-end through the REAL runLocked: the `rpc` binding handed to the sandbox
    // forwards the current run's signal as the rpc call's `options.signal`, so abort can unwind it.
    const { instance } = await createTestDO(EvalDO);

    // Capture the options every outbound rpc.call receives.
    const seenOptions: Array<{ method: string; options: unknown }> = [];
    const fakeRpc = {
      selfId: "do:test:EvalDO:test-key",
      call: vi.fn((_target: string, method: string, _args: unknown[], options?: unknown) => {
        seenOptions.push({ method, options });
        return Promise.resolve("ok");
      }),
      stream: vi.fn(),
      emit: vi.fn(),
      on: vi.fn(() => vi.fn()),
      expose: vi.fn(),
      exposeAll: vi.fn(),
      exposeStreaming: vi.fn(),
      peer: vi.fn(() => ({})),
      status: vi.fn(() => "connected"),
      ready: vi.fn(() => Promise.resolve()),
      onStatusChange: vi.fn(() => vi.fn()),
    };
    // `runLocked` reads `this.rpc` for the binding closures — stub it.
    Object.defineProperty(instance, "rpc", { get: () => fakeRpc, configurable: true });

    // Stub the heavy engine path: capture the bindings, then invoke the eval's rpc binding ourselves.
    const fakeScope = {
      current: {},
      api: {},
      enterEval: () => {},
      exitEval: () => Promise.resolve(),
    };
    setPriv(instance, "ensureEngine", () =>
      Promise.resolve({
        executeSandbox: async (_code: string, opts: { bindings: Record<string, unknown> }) => {
          const rpcBinding = opts.bindings["rpc"] as {
            call: (t: string, m: string, a: unknown[]) => Promise<unknown>;
          };
          // Eval uses the same portable RpcClient call shape as panels/workers.
          await rpcBinding.call("main", "svc.method", []);
          await rpcBinding.call("do:peer", "ping", []);
          return { success: true, consoleOutput: "", returnValue: undefined };
        },
      })
    );
    setPriv(instance, "ensureScopeManager", () => Promise.resolve(fakeScope));

    const controller = new AbortController();
    const runLocked = priv<RunLockedFn>(instance, "runLocked").bind(instance);
    await runLocked({ code: "x", contextId: "ctx" }, controller.signal, "run-sig");

    // Both outbound calls carried the SAME run signal in their options.
    expect(seenOptions).toHaveLength(2);
    for (const { options } of seenOptions) {
      expect((options as { signal?: AbortSignal }).signal).toBe(controller.signal);
    }
    // And aborting the run's controller would unwind those calls (rpc client honors options.signal).
    expect(controller.signal.aborted).toBe(false);
  });
});
