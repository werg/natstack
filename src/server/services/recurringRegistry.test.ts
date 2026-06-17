import { describe, expect, it } from "vitest";
import {
  RecurringRegistry,
  computeFailureBackoffMs,
  computeNextRunAt,
  computeRunAfter,
  declToJobRow,
  parseScheduleSpec,
  recurringSpecHash,
} from "./recurringRegistry.js";
import type { WorkspaceRecurringDecl } from "@natstack/shared/workspace/types";

const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

describe("parseScheduleSpec", () => {
  it("parses durations", () => {
    expect(parseScheduleSpec({ every: "30m" })).toEqual({ intervalMs: 30 * MIN, atMinutes: null });
    expect(parseScheduleSpec({ every: "6h" })).toEqual({ intervalMs: 6 * HOUR, atMinutes: null });
    expect(parseScheduleSpec({ every: "1d" })).toEqual({ intervalMs: DAY, atMinutes: null });
  });

  it("parses a local-time anchor on day-multiple intervals", () => {
    expect(parseScheduleSpec({ every: "1d", at: "08:00" })).toEqual({
      intervalMs: DAY,
      atMinutes: 8 * 60,
    });
  });

  it("rejects bad specs", () => {
    expect(() => parseScheduleSpec({ every: "soon" })).toThrow(/invalid schedule\.every/);
    expect(() => parseScheduleSpec({ every: "10s" })).toThrow(/at least 1m/);
    expect(() => parseScheduleSpec({ every: "1d", at: "8am" })).toThrow(/invalid schedule\.at/);
    expect(() => parseScheduleSpec({ every: "1d", at: "25:00" })).toThrow(/out of range/);
    expect(() => parseScheduleSpec({ every: "6h", at: "08:00" })).toThrow(/whole-day interval/);
  });
});

describe("computeNextRunAt / computeRunAfter", () => {
  it("free-running schedules start one interval out", () => {
    expect(computeNextRunAt(1000, { intervalMs: 30 * MIN, atMinutes: null })).toBe(1000 + 30 * MIN);
  });

  it("anchored schedules start at the next local HH:MM", () => {
    const now = new Date(2026, 5, 12, 9, 30).getTime(); // local 09:30
    const next = computeNextRunAt(now, { intervalMs: DAY, atMinutes: 8 * 60 });
    expect(new Date(next).getHours()).toBe(8);
    expect(new Date(next).getMinutes()).toBe(0);
    expect(next).toBeGreaterThan(now);
    expect(next - now).toBeLessThanOrEqual(DAY);
  });

  it("run-after skips past missed runs without bursts", () => {
    // scheduled at t=0, interval 10min, woke up 35min late → next is t=40min
    expect(computeRunAfter(35 * MIN, { intervalMs: 10 * MIN, atMinutes: null }, 0)).toBe(40 * MIN);
  });
});

describe("computeFailureBackoffMs", () => {
  it("grows exponentially and caps", () => {
    expect(computeFailureBackoffMs(1, MIN, 4 * MIN)).toBe(MIN);
    expect(computeFailureBackoffMs(2, MIN, 4 * MIN)).toBe(2 * MIN);
    expect(computeFailureBackoffMs(3, MIN, 4 * MIN)).toBe(4 * MIN);
    expect(computeFailureBackoffMs(4, MIN, 4 * MIN)).toBe(4 * MIN);
  });
});

describe("RecurringRegistry observability", () => {
  it("lists jobs with target, schedule, args, and failure status", async () => {
    const registry = new RecurringRegistry({
      workspaceId: "ws",
      loadRecurring: () => [],
      doDispatch: {
        dispatch: async (_ref: unknown, method: string) => {
          if (method !== "recurringList") return null;
          return [
            {
              name: "news-briefing",
              source: "workers/news-agent",
              className: "NewsAgentWorker",
              objectKey: "news",
              method: "runScheduledJob",
              argsJson: JSON.stringify([{ job: "briefing" }]),
              intervalMs: DAY,
              atMinutes: 8 * 60,
              specHash: "hash",
              initialNextRunAt: 20_000,
              nextRunAt: 20_000,
              lastRunAt: 10_000,
              failCount: 2,
              backoffUntil: 20_000,
              lastError: "boom",
            },
          ];
        },
      } as never,
    });

    await expect(registry.listJobs(15_000)).resolves.toEqual([
      expect.objectContaining({
        name: "news-briefing",
        status: "backing-off",
        target: {
          source: "workers/news-agent",
          className: "NewsAgentWorker",
          objectKey: "news",
          method: "runScheduledJob",
        },
        args: [{ job: "briefing" }],
        schedule: { intervalMs: DAY, atMinutes: 8 * 60 },
        failCount: 2,
        backoffUntil: 20_000,
        lastError: "boom",
      }),
    ]);
  });
});

describe("declToJobRow / recurringSpecHash", () => {
  const decl: WorkspaceRecurringDecl = {
    name: "news-briefing",
    target: { source: "workers/news-agent", className: "NewsAgentWorker" },
    method: "runScheduledJob",
    args: [{ job: "briefing" }],
    schedule: { every: "1d", at: "08:00" },
  };

  it("builds a durable row with objectKey defaulting to the job name", () => {
    const row = declToJobRow(decl, 1000);
    expect(row).toMatchObject({
      name: "news-briefing",
      source: "workers/news-agent",
      className: "NewsAgentWorker",
      objectKey: "news-briefing",
      method: "runScheduledJob",
      intervalMs: DAY,
      atMinutes: 8 * 60,
    });
    expect(JSON.parse(row.argsJson)).toEqual([{ job: "briefing" }]);
    expect(row.specHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("hash is stable across equivalent decls and changes when the spec changes", () => {
    const same = recurringSpecHash({ ...decl, args: [{ job: "briefing" }] });
    expect(recurringSpecHash(decl)).toBe(same);
    expect(recurringSpecHash({ ...decl, schedule: { every: "1d", at: "09:00" } })).not.toBe(same);
    expect(recurringSpecHash({ ...decl, method: "other" })).not.toBe(same);
  });

  it("rejects invalid names and incomplete targets", () => {
    expect(() => declToJobRow({ ...decl, name: "bad name!" }, 0)).toThrow(
      /invalid recurring job name/
    );
    expect(() => declToJobRow({ ...decl, target: { source: "", className: "X" } }, 0)).toThrow(
      /required/
    );
  });
});
