// @vitest-environment node

import { describe, expect, it } from "vitest";
import { LifecycleDriver } from "./lifecycleDriver.js";
import type { RestartBeginEvent, RestartReadyEvent, WorkerdManager } from "../workerdManager.js";
import type { DODispatch, DORef } from "../doDispatch.js";

function makeHarness(
  opts: {
    hangPrepare?: boolean;
    leases?: Array<{ source: string; className: string; objectKey: string }>;
    concurrency?: number;
  } = {}
) {
  let beginHook: ((event: RestartBeginEvent) => Promise<void> | void) | null = null;
  let readyHook: ((event: RestartReadyEvent) => Promise<void> | void) | null = null;
  const calls: Array<{ kind: "workspace" | "lifecycle"; method: string; ref?: DORef; arg?: unknown }> = [];
  const leases = opts.leases ?? [
    { source: "workers/agent", className: "AiChatWorker", objectKey: "ch-1" },
  ];
  let epoch = "";

  const workerdManager = {
    getBootGeneration: () => 7,
    onRestartBegin(fn: (event: RestartBeginEvent) => Promise<void> | void) {
      beginHook = fn;
      return () => {
        beginHook = null;
      };
    },
    onRestartReady(fn: (event: RestartReadyEvent) => Promise<void> | void) {
      readyHook = fn;
      return () => {
        readyHook = null;
      };
    },
  } as Pick<WorkerdManager, "getBootGeneration" | "onRestartBegin" | "onRestartReady">;

  const doDispatch = {
    dispatch: async (_ref: DORef, method: string, ...args: unknown[]) => {
      calls.push({ kind: "workspace", method, arg: args[0] });
      if (method === "lifecycleOpenEpoch") {
        epoch = "epoch-1";
        return epoch;
      }
      if (method === "lifecycleListLeases") return leases;
      if (method === "lifecycleListOps") {
        return leases.map((lease) => ({ ...lease, epochId: epoch, opKind: "resume", status: "pending" }));
      }
      return undefined;
    },
    dispatchLifecycle: async (ref: DORef, method: "prepare" | "resume", arg: unknown) => {
      calls.push({ kind: "lifecycle", method, ref, arg });
      if (opts.hangPrepare && method === "prepare") {
        await new Promise(() => undefined);
      }
      return method === "prepare" ? { status: "ready" } : undefined;
    },
  } as Pick<DODispatch, "dispatch" | "dispatchLifecycle">;

  const driver = new LifecycleDriver({
    workerdManager: workerdManager as WorkerdManager,
    doDispatch: doDispatch as DODispatch,
    workspaceId: "workspace-main",
    prepareDeadlineMs: 50,
    concurrency: opts.concurrency ?? 2,
  });
  driver.start();
  return {
    calls,
    fireBegin: (event: RestartBeginEvent) => beginHook?.(event),
    fireReady: (event: RestartReadyEvent) => readyHook?.(event),
  };
}

describe("LifecycleDriver", () => {
  it("prepares once on restart begin and resumes only on restart ready", async () => {
    const harness = makeHarness();
    await harness.fireBegin({ correlationId: "r1", generation: 8, reason: "planned" });

    expect(harness.calls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "workspace", method: "lifecycleOpenEpoch" }),
        expect.objectContaining({ kind: "lifecycle", method: "prepare" }),
        expect.objectContaining({ kind: "workspace", method: "lifecycleRecordOp" }),
      ])
    );
    expect(harness.calls.some((call) => call.kind === "lifecycle" && call.method === "resume")).toBe(
      false
    );

    await harness.fireReady({
      correlationId: "r1",
      generation: 8,
      previousGeneration: 7,
      reason: "planned",
    });

    expect(harness.calls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "lifecycle", method: "resume" }),
        expect.objectContaining({ kind: "workspace", method: "lifecycleCompleteEpoch" }),
      ])
    );
  });

  it("records timed_out when a DO does not complete prepare before the deadline", async () => {
    const harness = makeHarness({ hangPrepare: true });
    await harness.fireBegin({ correlationId: "r1", generation: 8, reason: "planned" });

    expect(harness.calls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "workspace",
          method: "lifecycleRecordOp",
          arg: expect.objectContaining({
            opKind: "prepare",
            status: "timed_out",
          }),
        }),
      ])
    );
  });

  it("uses one batch deadline instead of timing out each hung prepare serially", async () => {
    const harness = makeHarness({
      hangPrepare: true,
      concurrency: 1,
      leases: [
        { source: "workers/agent", className: "AiChatWorker", objectKey: "ch-1" },
        { source: "workers/agent", className: "AiChatWorker", objectKey: "ch-2" },
      ],
    });

    const startedAt = Date.now();
    await harness.fireBegin({ correlationId: "r1", generation: 8, reason: "planned" });
    const elapsedMs = Date.now() - startedAt;

    const prepareCalls = harness.calls.filter(
      (call) => call.kind === "lifecycle" && call.method === "prepare"
    );
    const timedOutOps = harness.calls.filter(
      (call) =>
        call.kind === "workspace" &&
        call.method === "lifecycleRecordOp" &&
        (call.arg as { status?: string }).status === "timed_out"
    );
    expect(prepareCalls).toHaveLength(1);
    expect(elapsedMs).toBeLessThan(90);
    expect(timedOutOps).toHaveLength(2);
  });
});
