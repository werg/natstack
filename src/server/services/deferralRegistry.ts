/**
 * DeferralRegistry — server-side tracking for out-of-band ("deferred") RPC
 * completion.
 *
 * When a DO/worker calls a human-gated service method (approval, credential
 * use) it cannot hold its inbound request open across a hibernation. Instead
 * the handler calls `ctx.deferral.run(work)`: the transport immediately acks
 * with `{deferred, requestId}`, `work` runs detached here, and its eventual
 * result is delivered to the caller via an inbound `onDeferredResult` POST
 * (which revives a hibernated DO).
 *
 * This registry owns the detached work: it dedups reissued calls (so a DO
 * re-driving after a missed push doesn't double-prompt), enforces a TTL, and
 * isolates delivery failures. Correctness across a *server* restart still comes
 * from DO-side re-drive against durable state (grant stores); this registry is
 * the in-memory fast path, deliberately not durable.
 */

import {
  DEFERRED_RESULT,
  type DeferralApi,
  type DeferredResult,
} from "@natstack/shared/serviceDispatcher";

const DEFAULT_TTL_MS = 10 * 60 * 1000;

/** Identity of a single deferrable call, used to build the dedup key. */
export interface DeferralCallInfo {
  callerId: string;
  requestId: string;
  idempotencyKey?: string;
  service: string;
  method: string;
}

interface TimerHandle {
  cancel(): void;
}

export interface DeferralRegistryDeps {
  /**
   * Deliver a settled deferred result to the caller. On the server this calls
   * `rpcServer.callTarget(callerId, "onDeferredResult", payload)`, an inbound
   * POST that revives a hibernated DO. Best-effort: failures are logged.
   */
  deliver: (
    callerId: string,
    requestId: string,
    result: unknown,
    isError: boolean
  ) => Promise<void>;
  ttlMs?: number;
  logger?: { warn: (...args: unknown[]) => void };
  /** Injectable timer (tests). Defaults to an unref'd setTimeout. */
  setTimer?: (fn: () => void, ms: number) => TimerHandle;
}

interface PendingEntry {
  callerId: string;
  /** All requestIds awaiting this single `work` run (dedup collapses them here). */
  requestIds: Set<string>;
  abort: AbortController;
  timer: TimerHandle;
}

function defaultTimer(fn: () => void, ms: number): TimerHandle {
  const t = setTimeout(fn, ms);
  (t as { unref?: () => void }).unref?.();
  return { cancel: () => clearTimeout(t) };
}

function errorPayload(err: unknown): { message: string; code?: string } {
  if (err instanceof Error) {
    const code = (err as Error & { code?: string }).code;
    return { message: err.message, ...(code ? { code } : {}) };
  }
  return { message: String(err) };
}

export class DeferralRegistry {
  private pending = new Map<string, PendingEntry>();
  private readonly ttlMs: number;
  private readonly setTimer: (fn: () => void, ms: number) => TimerHandle;

  constructor(private readonly deps: DeferralRegistryDeps) {
    this.ttlMs = deps.ttlMs ?? DEFAULT_TTL_MS;
    this.setTimer = deps.setTimer ?? defaultTimer;
  }

  /**
   * Scoped composite dedup key — never a bare `idempotencyKey`, so independent
   * callers cannot collide. Without an `idempotencyKey`, each `requestId` is its
   * own entry (no dedup, still tracked).
   */
  private keyFor(info: DeferralCallInfo): string {
    const dedup = info.idempotencyKey ?? info.requestId;
    return [info.callerId, `${info.service}.${info.method}`, dedup].join("\u0000");
  }

  /** Build the per-call `DeferralApi` injected onto the `ServiceContext`. */
  createApi(info: DeferralCallInfo): DeferralApi {
    const sentinel: DeferredResult = { [DEFERRED_RESULT]: true, requestId: info.requestId };
    return {
      canDefer: true,
      run: (work) => {
        const key = this.keyFor(info);
        const existing = this.pending.get(key);
        if (existing) {
          // Reissue / concurrent duplicate: attach to the in-flight run.
          existing.requestIds.add(info.requestId);
          return sentinel;
        }
        const abort = new AbortController();
        const entry: PendingEntry = {
          callerId: info.callerId,
          requestIds: new Set([info.requestId]),
          abort,
          timer: this.setTimer(() => {
            // Abort the in-flight work (e.g. the human approval waiter) BEFORE
            // settling, so a slow approval is cancelled cleanly instead of
            // leaking a pending waiter (P1-3).
            abort.abort(new Error("Deferred call timed out"));
            this.settle(key, new Error("Deferred call timed out"), true);
          }, this.ttlMs),
        };
        this.pending.set(key, entry);
        void (async () => {
          try {
            this.settle(key, await work(abort.signal), false);
          } catch (err) {
            this.settle(key, err, true);
          }
        })();
        return sentinel;
      },
    };
  }

  private settle(key: string, payload: unknown, isError: boolean): void {
    const entry = this.pending.get(key);
    if (!entry) return; // already settled (e.g. TTL fired then work resolved)
    this.pending.delete(key);
    entry.timer.cancel();
    const value = isError ? errorPayload(payload) : payload;
    for (const requestId of entry.requestIds) {
      void this.deps.deliver(entry.callerId, requestId, value, isError).catch((err) => {
        this.deps.logger?.warn?.(
          `[DeferralRegistry] onDeferredResult delivery failed for ${requestId}:`,
          err
        );
      });
    }
  }

  /** In-flight deferral count (diagnostics/tests). */
  get size(): number {
    return this.pending.size;
  }

  /** Abort and drop all in-flight deferrals (shutdown). */
  cancelAll(): void {
    for (const entry of this.pending.values()) {
      entry.abort.abort();
      entry.timer.cancel();
    }
    this.pending.clear();
  }
}
