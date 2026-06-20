// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AlarmDriver } from "./alarmDriver.js";
import type { DODispatch, DORef } from "../doDispatch.js";

type Alarm = { source: string; className: string; objectKey: string; wakeAt: number };

function makeHarness(initial: Alarm[] = []) {
  const alarms = [...initial];
  const fired: DORef[] = [];

  const doDispatch = {
    dispatch: async (_ref: DORef, method: string, ...args: unknown[]) => {
      if (method === "alarmNextWakeAt") {
        return alarms.length ? Math.min(...alarms.map((a) => a.wakeAt)) : null;
      }
      if (method === "alarmTakeDue") {
        const now = args[0] as number;
        const due = alarms.filter((a) => a.wakeAt <= now);
        for (const d of due) alarms.splice(alarms.indexOf(d), 1);
        return due;
      }
      return undefined;
    },
    dispatchAlarm: async (ref: DORef) => {
      fired.push(ref);
      return { result: "ok" };
    },
  } as unknown as DODispatch;

  const driver = new AlarmDriver({ doDispatch, workspaceId: "ws-1" });
  return { driver, alarms, fired };
}

describe("AlarmDriver", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("fires __alarm for a due alarm and reschedules to the next", async () => {
    vi.setSystemTime(0);
    const { driver, fired } = makeHarness([
      { source: "workers/poller", className: "PollerDO", objectKey: "p-1", wakeAt: 1_000 },
      { source: "workers/poller", className: "PollerDO", objectKey: "p-2", wakeAt: 3_000 },
    ]);

    driver.start();
    await vi.advanceTimersByTimeAsync(0); // let the initial reschedule settle

    // Before the first wake — nothing fired yet.
    await vi.advanceTimersByTimeAsync(999);
    expect(fired).toHaveLength(0);

    // At 1s, p-1 fires; driver re-arms for p-2.
    await vi.advanceTimersByTimeAsync(1);
    expect(fired.map((r) => r.objectKey)).toEqual(["p-1"]);

    // At 3s, p-2 fires.
    await vi.advanceTimersByTimeAsync(2_000);
    expect(fired.map((r) => r.objectKey)).toEqual(["p-1", "p-2"]);

    driver.stop();
  });

  it("re-arms when a newly-set alarm is sooner than the pending one", async () => {
    vi.setSystemTime(0);
    const { driver, alarms, fired } = makeHarness([
      { source: "workers/poller", className: "PollerDO", objectKey: "far", wakeAt: 10_000 },
    ]);
    driver.start();
    await vi.advanceTimersByTimeAsync(0);

    // A new, sooner alarm appears; notifyChanged re-arms the timer.
    alarms.push({
      source: "workers/poller",
      className: "PollerDO",
      objectKey: "soon",
      wakeAt: 500,
    });
    driver.notifyChanged();
    await vi.advanceTimersByTimeAsync(0);

    await vi.advanceTimersByTimeAsync(500);
    expect(fired.map((r) => r.objectKey)).toEqual(["soon"]);

    driver.stop();
  });

  it("stop() cancels the pending timer", async () => {
    vi.setSystemTime(0);
    const { driver, fired } = makeHarness([
      { source: "workers/poller", className: "PollerDO", objectKey: "p-1", wakeAt: 1_000 },
    ]);
    driver.start();
    await vi.advanceTimersByTimeAsync(0);
    driver.stop();

    await vi.advanceTimersByTimeAsync(5_000);
    expect(fired).toHaveLength(0);
  });
});

/** Harness whose `dispatchAlarm` always fails (as when an EvalDO aborts itself in
 *  `alarm()`), recording any re-arm so we can assert the re-arm decision. */
function makeFailingHarness(initial: Array<Alarm & { bestEffort?: boolean }>) {
  const alarms = [...initial];
  const reArmed: Array<{ objectKey: string }> = [];
  const doDispatch = {
    dispatch: async (_ref: DORef, method: string, ...args: unknown[]) => {
      if (method === "alarmNextWakeAt") {
        return alarms.length ? Math.min(...alarms.map((a) => a.wakeAt)) : null;
      }
      if (method === "alarmTakeDue") {
        const now = args[0] as number;
        const due = alarms.filter((a) => a.wakeAt <= now);
        for (const d of due) alarms.splice(alarms.indexOf(d), 1);
        return due; // carries bestEffort through to the driver
      }
      if (method === "alarmSet") {
        reArmed.push(args[0] as { objectKey: string });
      }
      return undefined;
    },
    dispatchAlarm: async () => {
      throw new Error("dispatch failed (DO aborted itself)");
    },
  } as unknown as DODispatch;
  const driver = new AlarmDriver({ doDispatch, workspaceId: "ws-1" });
  return { driver, reArmed };
}

describe("AlarmDriver re-arm on dispatch failure", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("re-arms a normal at-least-once alarm whose dispatch fails (wake must not be lost)", async () => {
    vi.setSystemTime(0);
    const { driver, reArmed } = makeFailingHarness([
      { source: "workers/poller", className: "PollerDO", objectKey: "k", wakeAt: 1_000 },
    ]);
    driver.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1_000); // fire → dispatch fails → re-arm
    expect(reArmed).toHaveLength(1);
    expect(reArmed[0]).toMatchObject({ objectKey: "k" });
    driver.stop();
  });

  it("does NOT re-arm a best-effort alarm whose dispatch fails (EvalDO idle eviction — no resurrection loop)", async () => {
    vi.setSystemTime(0);
    const { driver, reArmed } = makeFailingHarness([
      {
        source: "natstack/internal",
        className: "EvalDO",
        objectKey: "k",
        wakeAt: 1_000,
        bestEffort: true,
      },
    ]);
    driver.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1_000); // fire → dispatch fails → best-effort → no re-arm
    expect(reArmed).toEqual([]);
    driver.stop();
  });
});
