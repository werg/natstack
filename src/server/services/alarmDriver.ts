import { createDevLogger } from "@natstack/dev-log";
import type { DODispatch, DORef } from "../doDispatch.js";
import { INTERNAL_DO_SOURCE } from "../internalDOs/internalDoLoader.js";
import type { LifecycleKey } from "../internalDOs/workspaceDO.js";

const log = createDevLogger("AlarmDriver");

/** setTimeout caps out near 2^31 ms; clamp longer delays and re-evaluate on wake. */
const MAX_TIMER_MS = 2_000_000_000;

export interface AlarmDriverDeps {
  doDispatch: DODispatch;
  workspaceId: string;
  concurrency?: number;
}

/**
 * Server-driven DO alarms. workerd does not implement alarms for SQLite-backed
 * Durable Objects (and never for facets), so wake times live durably in
 * WorkspaceDO (`do_alarms`) and this driver fires `__alarm` on schedule.
 *
 * A single timer tracks the soonest pending wake. On fire it atomically drains
 * all due alarms (each fires once; recurring DOs re-arm inside `alarm()`),
 * dispatches `__alarm` to each, then reschedules. Survives server/workerd
 * restart: `start()` reloads from durable storage.
 */
export class AlarmDriver {
  private readonly deps: AlarmDriverDeps;
  private readonly workspaceRef: DORef;
  private readonly concurrency: number;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private rescheduling: Promise<void> | null = null;

  constructor(deps: AlarmDriverDeps) {
    this.deps = deps;
    this.workspaceRef = {
      source: INTERNAL_DO_SOURCE,
      className: "WorkspaceDO",
      objectKey: deps.workspaceId,
    };
    this.concurrency = deps.concurrency ?? 8;
  }

  /** Load durable alarms and arm the timer. Idempotent; call on boot. */
  start(): void {
    this.stopped = false;
    void this.reschedule();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /** Re-evaluate the next wake time. Call after any alarm set/clear. */
  notifyChanged(): void {
    void this.reschedule();
  }

  private async reschedule(): Promise<void> {
    if (this.stopped) return;
    // Serialize reschedules so concurrent set/clear/fire don't race the timer.
    const run = async (): Promise<void> => {
      if (this.stopped) return;
      let next: number | null = null;
      try {
        next = await this.dispatchWorkspace<number | null>("alarmNextWakeAt");
      } catch (err) {
        log.warn("alarmNextWakeAt failed; will retry on next change:", err);
        return;
      }
      if (this.stopped) return;
      if (this.timer) {
        clearTimeout(this.timer);
        this.timer = null;
      }
      if (next === null) return;
      const delay = Math.max(0, Math.min(MAX_TIMER_MS, next - Date.now()));
      this.timer = setTimeout(() => void this.fire(), delay);
    };
    // Chain onto any in-flight reschedule, then run; the last caller wins.
    const prior = this.rescheduling ?? Promise.resolve();
    const mine = prior.then(run, run);
    this.rescheduling = mine;
    await mine;
    if (this.rescheduling === mine) this.rescheduling = null;
  }

  private async fire(): Promise<void> {
    this.timer = null;
    if (this.stopped) return;
    let due: Array<LifecycleKey & { wakeAt: number }> = [];
    try {
      due = await this.dispatchWorkspace<Array<LifecycleKey & { wakeAt: number }>>(
        "alarmTakeDue",
        Date.now()
      );
    } catch (err) {
      log.warn("alarmTakeDue failed:", err);
      void this.reschedule();
      return;
    }
    await this.runPool(due, async (target) => {
      try {
        await this.deps.doDispatch.dispatchAlarm({
          source: target.source,
          className: target.className,
          objectKey: target.objectKey,
        });
      } catch (err) {
        // The DO may have been destroyed, or load/dispatch failed. The alarm was
        // already removed; a recurring DO simply won't re-arm. Best-effort.
        log.warn(
          `alarm dispatch failed for ${target.source}:${target.className}/${target.objectKey}:`,
          err
        );
      }
    });
    void this.reschedule();
  }

  private dispatchWorkspace<T = unknown>(method: string, ...args: unknown[]): Promise<T> {
    return this.deps.doDispatch.dispatch(this.workspaceRef, method, ...args) as Promise<T>;
  }

  private async runPool<T>(items: T[], fn: (item: T) => Promise<void>): Promise<void> {
    let next = 0;
    const workers = Array.from({ length: Math.min(this.concurrency, items.length) }, async () => {
      for (;;) {
        const index = next++;
        const item = items[index];
        if (item === undefined) return;
        await fn(item);
      }
    });
    await Promise.all(workers);
  }
}
