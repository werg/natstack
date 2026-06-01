import { createDevLogger } from "@natstack/dev-log";
import type { DODispatch, DORef } from "../doDispatch.js";
import { INTERNAL_DO_SOURCE } from "../internalDOs/internalDoLoader.js";
import type { LifecycleKey, LifecycleOp } from "../internalDOs/workspaceDO.js";
import type { RestartBeginEvent, RestartReadyEvent, WorkerdManager } from "../workerdManager.js";

const log = createDevLogger("LifecycleDriver");

export interface LifecycleDriverDeps {
  workerdManager: WorkerdManager;
  doDispatch: DODispatch;
  workspaceId: string;
  prepareDeadlineMs?: number;
  concurrency?: number;
}

export class LifecycleDriver {
  private readonly deps: LifecycleDriverDeps;
  private readonly workspaceRef: DORef;
  private readonly prepareDeadlineMs: number;
  private readonly concurrency: number;
  private readonly restartEpochs = new Map<string, string>();
  private unsubscribeBegin: (() => void) | null = null;
  private unsubscribeReady: (() => void) | null = null;

  constructor(deps: LifecycleDriverDeps) {
    this.deps = deps;
    this.workspaceRef = {
      source: INTERNAL_DO_SOURCE,
      className: "WorkspaceDO",
      objectKey: deps.workspaceId,
    };
    this.prepareDeadlineMs = deps.prepareDeadlineMs ?? 5_000;
    this.concurrency = deps.concurrency ?? 8;
  }

  start(): void {
    this.unsubscribeBegin = this.deps.workerdManager.onRestartBegin((event) =>
      this.handleRestartBegin(event)
    );
    this.unsubscribeReady = this.deps.workerdManager.onRestartReady((event) =>
      this.handleRestartReady(event)
    );
  }

  stop(): void {
    this.unsubscribeBegin?.();
    this.unsubscribeReady?.();
    this.unsubscribeBegin = null;
    this.unsubscribeReady = null;
  }

  async recoverStartup(reason: "crash" | "server_restart" = "server_restart"): Promise<void> {
    const targets = await this.dispatchWorkspace<LifecycleKey[]>("lifecycleListResumeTargets");
    if (targets.length === 0) return;
    const epoch = await this.dispatchWorkspace<string>("lifecycleOpenEpoch", {
      kind: reason,
      reason,
      generation: this.deps.workerdManager.getBootGeneration(),
    });
    await this.resumeTargets(epoch, targets, {
      previousGeneration: null,
      currentGeneration: this.deps.workerdManager.getBootGeneration(),
      reason,
    });
    await this.dispatchWorkspace("lifecycleCompleteEpoch", epoch);
  }

  async prepareForShutdown(deadlineMs = 2_000): Promise<void> {
    const epoch = await this.dispatchWorkspace<string>("lifecycleOpenEpoch", {
      kind: "planned",
      reason: "server_shutdown",
      generation: this.deps.workerdManager.getBootGeneration(),
    });
    const targets = await this.dispatchWorkspace<LifecycleKey[]>("lifecycleListLeases");
    await this.prepareTargets(epoch, targets, deadlineMs, "server_shutdown");
  }

  private async handleRestartBegin(event: RestartBeginEvent): Promise<void> {
    const epoch = await this.dispatchWorkspace<string>("lifecycleOpenEpoch", {
      kind: "planned",
      reason: event.reason,
      generation: event.generation,
    });
    this.restartEpochs.set(event.correlationId, epoch);
    const targets = await this.dispatchWorkspace<LifecycleKey[]>("lifecycleListLeases");
    await this.prepareTargets(epoch, targets, this.prepareDeadlineMs, event.reason);
  }

  private async handleRestartReady(event: RestartReadyEvent): Promise<void> {
    const epoch = this.restartEpochs.get(event.correlationId);
    if (!epoch) return;
    this.restartEpochs.delete(event.correlationId);
    const ops = await this.dispatchWorkspace<LifecycleOp[]>("lifecycleListOps", epoch);
    const targets = this.dedupe(
      ops.filter((op) => op.opKind === "resume").map((op) => ({
        source: op.source,
        className: op.className,
        objectKey: op.objectKey,
      }))
    );
    await this.resumeTargets(epoch, targets, {
      previousGeneration: event.previousGeneration,
      currentGeneration: event.generation,
      reason: "planned",
    });
    await this.dispatchWorkspace("lifecycleCompleteEpoch", epoch);
  }

  private async prepareTargets(
    epoch: string,
    targets: LifecycleKey[],
    deadlineMs: number,
    reason: string
  ): Promise<void> {
    const deadlineAt = Date.now() + deadlineMs;
    let deadlineExhausted = false;
    await this.runPool(targets, async (target) => {
      try {
        if (deadlineExhausted) {
          await this.recordOp(epoch, target, "prepare", "timed_out", {
            error: "lifecycle timeout",
          });
          return;
        }
        const remainingMs = Math.max(0, deadlineAt - Date.now());
        if (remainingMs <= 0) {
          deadlineExhausted = true;
          await this.recordOp(epoch, target, "prepare", "timed_out", {
            error: "lifecycle timeout",
          });
          return;
        }
        const result = await this.withTimeout(
          this.deps.doDispatch.dispatchLifecycle(this.toRef(target), "prepare", {
            epoch,
            reason,
            deadlineMs: remainingMs,
          }),
          remainingMs
        );
        const status =
          result &&
          typeof result === "object" &&
          (result as { status?: unknown }).status === "failed"
            ? "failed"
            : "ready";
        await this.recordOp(epoch, target, "prepare", status, result);
      } catch (err) {
        const timedOut = err instanceof Error && err.message === "lifecycle timeout";
        if (timedOut) deadlineExhausted = true;
        await this.recordOp(epoch, target, "prepare", timedOut ? "timed_out" : "failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    });
  }

  private async resumeTargets(
    epoch: string,
    targets: LifecycleKey[],
    input: { previousGeneration: number | null; currentGeneration: number; reason: "planned" | "crash" | "server_restart" }
  ): Promise<void> {
    await this.runPool(this.dedupe(targets), async (target) => {
      try {
        await this.deps.doDispatch.dispatchLifecycle(this.toRef(target), "resume", {
          epoch,
          ...input,
        });
        await this.recordOp(epoch, target, "resume", "resumed", null);
      } catch (err) {
        await this.recordOp(epoch, target, "resume", "failed", {
          error: err instanceof Error ? err.message : String(err),
        });
        log.warn(`resume failed for ${target.source}:${target.className}/${target.objectKey}`, err);
      }
    });
  }

  private async recordOp(
    epochId: string,
    key: LifecycleKey,
    opKind: "prepare" | "resume",
    status: "ready" | "timed_out" | "failed" | "resumed",
    detail: unknown
  ): Promise<void> {
    await this.dispatchWorkspace("lifecycleRecordOp", {
      epochId,
      key,
      opKind,
      status,
      detail,
    });
  }

  private toRef(key: LifecycleKey): DORef {
    return { source: key.source, className: key.className, objectKey: key.objectKey };
  }

  private dispatchWorkspace<T = unknown>(method: string, ...args: unknown[]): Promise<T> {
    return this.deps.doDispatch.dispatch(this.workspaceRef, method, ...args) as Promise<T>;
  }

  private dedupe(targets: LifecycleKey[]): LifecycleKey[] {
    const seen = new Set<string>();
    const result: LifecycleKey[] = [];
    for (const target of targets) {
      const key = `${target.source}\0${target.className}\0${target.objectKey}`;
      if (seen.has(key)) continue;
      seen.add(key);
      result.push(target);
    }
    return result;
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

  private async withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
    let timeout: ReturnType<typeof setTimeout> | null = null;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error("lifecycle timeout")), timeoutMs);
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }
}
