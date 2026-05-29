/**
 * TurnDispatcher - per-channel prompt queue and typing state.
 *
 * PiRunner now exposes AgentHarness-native verbs. The dispatcher stores
 * text/image inputs, not prebuilt AgentMessage objects, and never rewrites
 * runner state.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { RunnerEvent, RunnerTurnInput, RunnerTurnOptions } from "@natstack/harness";

export interface TurnDispatcherRunner {
  subscribe(listener: (event: RunnerEvent) => void): () => void;
  buildUserMessage(input: RunnerTurnInput): AgentMessage;
  prompt(input: RunnerTurnInput, opts?: RunnerTurnOptions): Promise<void>;
  continueAgent(opts?: RunnerTurnOptions): Promise<void>;
  steerMessage(message: AgentMessage): Promise<void>;
  clearSteeringQueue(): Promise<void>;
}

export type WorkItem =
  | { kind: "prompt"; input: RunnerTurnInput }
  | { kind: "continue"; turnId?: string };

type WorkCompletion =
  | { status: "completed"; source: "runner" | "agent_end" }
  | { status: "failed"; error: unknown }
  | { status: "invalidated" };

interface ActiveWork {
  generation: number;
  kind: WorkItem["kind"];
  turnId?: string;
  sawAgentStart: boolean;
  sawAgentEnd: boolean;
  runnerSettled: boolean;
  completed: boolean;
  completion: Promise<WorkCompletion>;
  complete(result: WorkCompletion): void;
}

interface PendingSteer {
  input: RunnerTurnInput;
  message: AgentMessage;
}

export interface TurnDispatcherOptions {
  runner: TurnDispatcherRunner;
  notifyTyping: (busy: boolean) => void;
  onWorkStart?: (work: WorkItem) => string | undefined | Promise<string | undefined>;
  onWorkFailure?: (work: WorkItem, error: unknown, turnId?: string) => void | Promise<void>;
  onInvariantViolation?: (
    code: string,
    detail?: Record<string, unknown>
  ) => void | Promise<void>;
  /**
   * Anchor the detached drain promise to the DO's current request lifetime
   * (typically `ctx.waitUntil`). The drain loop is started fire-and-forget
   * from an inbound request handler that returns immediately; without an
   * anchor, workerd binds the drain's promise continuations to that already
   * -completed request context and cancels them ("A promise was resolved or
   * rejected from a different request context..."). Registering the drain
   * promise here keeps a live context around until the turn settles.
   */
  keepAlive?: (promise: Promise<unknown>) => void;
  log?: Pick<Console, "warn" | "error">;
}

export class TurnDispatcher {
  private pending: WorkItem[] = [];
  private pendingSteered: PendingSteer[] = [];
  private running = false;
  private draining = false;
  private drainGeneration = 0;
  private lastTypingOn = false;
  private disposed = false;
  private activeWork: ActiveWork | null = null;
  private readonly unsub: () => void;
  private readonly log: Pick<Console, "warn" | "error">;

  constructor(private readonly opts: TurnDispatcherOptions) {
    this.log = opts.log ?? console;
    this.unsub = opts.runner.subscribe((event) => this.handleEvent(event));
  }

  submit(input: RunnerTurnInput, opts?: { mode?: "auto" | "sequential" }): void {
    if (this.disposed) return;
    const sequential = opts?.mode === "sequential";
    if (!sequential && this.running) {
      const message = this.opts.runner.buildUserMessage(input);
      this.pendingSteered.push({ input, message });
      this.notifyTyping();
      void this.opts.runner.steerMessage(message).catch((err) => {
        this.log.warn("[TurnDispatcher] steer failed; routing as fresh prompt:", err);
        this.pendingSteered = this.pendingSteered.filter(
          (candidate) => candidate.message !== message
        );
        this.pending.push({ kind: "prompt", input });
        this.ensureDrain();
      });
      return;
    }
    this.pending.push({ kind: "prompt", input });
    this.notifyTyping();
    this.ensureDrain();
  }

  submitContinue(opts: RunnerTurnOptions = {}): void {
    if (this.disposed) return;
    this.pending.push({ kind: "continue", ...(opts.turnId ? { turnId: opts.turnId } : {}) });
    this.notifyTyping();
    this.ensureDrain();
  }

  reset(): void {
    this.pending = [];
    this.pendingSteered = [];
    this.running = false;
    this.draining = false;
    this.drainGeneration++;
    this.invalidateActiveWork();
    void this.opts.runner.clearSteeringQueue().catch((err) => {
      this.log.warn("[TurnDispatcher] clearSteeringQueue during reset failed:", err);
    });
    this.notifyTyping();
  }

  markCurrentTurnAborted(): void {
    if (this.disposed) return;
    if (!this.running && !this.draining) return;
    this.running = false;
    this.draining = false;
    this.drainGeneration++;
    this.invalidateActiveWork();
    this.notifyTyping();
    if (this.pending.length > 0) this.ensureDrain();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.pending = [];
    this.pendingSteered = [];
    this.running = false;
    this.draining = false;
    this.drainGeneration++;
    this.invalidateActiveWork();
    this.unsub();
    this.notifyTyping();
  }

  getDebugState(): Record<string, unknown> {
    return {
      pending: this.pending.map((item) =>
        item.kind === "continue"
          ? { kind: item.kind }
          : { kind: item.kind, input: summarizeTurnInput(item.input) }
      ),
      pendingSteered: this.pendingSteered.map((item) => ({
        input: summarizeTurnInput(item.input),
        messageRole: (item.message as { role?: unknown }).role ?? null,
      })),
      pendingSteeredCount: this.pendingSteered.length,
      running: this.running,
      draining: this.draining,
      drainGeneration: this.drainGeneration,
      lastTypingOn: this.lastTypingOn,
      disposed: this.disposed,
      activeWork: this.activeWork ? this.activeWorkDebugState(this.activeWork) : null,
      busy: this.busy,
    };
  }

  private get busy(): boolean {
    return this.running || this.pending.length > 0 || this.pendingSteered.length > 0;
  }

  private notifyTyping(): void {
    const on = this.busy;
    if (on === this.lastTypingOn) return;
    this.lastTypingOn = on;
    try {
      this.opts.notifyTyping(on);
    } catch (err) {
      this.log.warn("[TurnDispatcher] notifyTyping threw:", err);
    }
  }

  private handleEvent(event: RunnerEvent): void {
    if (this.disposed) return;
    switch (event.type) {
      case "agent_start": {
        const active = this.activeWork;
        if (active && this.eventMatchesActiveWork(event, active)) {
          active.sawAgentStart = true;
        }
        return;
      }
      case "message_start": {
        const msg = (event as { message?: unknown }).message;
        if (!isUserMessage(msg)) return;
        const idx = this.pendingSteered.findIndex((pending) => pending.message === msg);
        if (idx >= 0) this.pendingSteered.splice(idx, 1);
        return;
      }
      case "agent_end": {
        const active = this.activeWork;
        if (active && !this.eventMatchesActiveWork(event, active)) return;
        if (active && eventMetadata(event).lifecycleMatched === false) {
          this.reportInvariant("runner_lifecycle_unmatched_agent_end", {
            activeTurnId: active.turnId ?? null,
            eventTurnId: eventMetadata(event).turnId ?? null,
          });
          return;
        }
        if (active && !active.sawAgentStart) {
          this.reportInvariant("runner_lifecycle_agent_end_before_agent_start", {
            activeTurnId: active.turnId ?? null,
          });
          return;
        }
        if (active) active.sawAgentEnd = true;
        this.running = false;
        if (this.pendingSteered.length > 0) {
          const stranded = this.pendingSteered;
          this.pendingSteered = [];
          void this.opts.runner.clearSteeringQueue().catch((err) => {
            this.log.warn("[TurnDispatcher] clearSteeringQueue after stranded steer failed:", err);
          });
          for (const item of stranded) this.pending.push({ kind: "prompt", input: item.input });
        }
        this.notifyTyping();
        if (active && active.generation === this.drainGeneration) {
          this.completeActiveWork(active, { status: "completed", source: "agent_end" });
        }
        if (this.pending.length > 0) this.ensureDrain();
        return;
      }
    }
  }

  private ensureDrain(): void {
    if (this.draining) return;
    this.draining = true;
    const generation = ++this.drainGeneration;
    const drained = this.drainLoop(generation).catch((err) => {
      if (generation !== this.drainGeneration) return;
      this.log.error("[TurnDispatcher] drainLoop crashed:", err);
      this.reportInvariant("dispatcher_drain_loop_crashed", {
        error: err instanceof Error ? err.message : String(err),
      });
      this.draining = false;
      this.notifyTyping();
    });
    // Anchor the detached drain to a live request context so workerd does not
    // cancel its cross-request promise continuations. See keepAlive docs.
    this.opts.keepAlive?.(drained);
  }

  private async drainLoop(generation: number): Promise<void> {
    try {
      while (!this.disposed && generation === this.drainGeneration && this.pending.length > 0) {
        const work = this.pending.shift()!;
        this.running = true;
        const active = this.beginActiveWork(generation, work);
        this.notifyTyping();
        this.observeRunnerWork(work, active);
        const completion = await active.completion;
        if (generation !== this.drainGeneration || completion.status === "invalidated") return;
        if (completion.status === "failed") {
          if (generation !== this.drainGeneration) return;
          this.log.warn(
            `[TurnDispatcher] ${work.kind === "continue" ? "continueAgent" : "prompt"} failed:`,
            completion.error
          );
          try {
            await this.opts.onWorkFailure?.(work, completion.error, active.turnId);
          } catch (failureErr) {
            this.log.warn("[TurnDispatcher] onWorkFailure failed:", failureErr);
            this.reportInvariant("dispatcher_on_work_failure_failed", {
              workKind: work.kind,
              turnId: active.turnId ?? null,
              error: failureErr instanceof Error ? failureErr.message : String(failureErr),
            });
          }
          if (this.pendingSteered.length > 0) {
            for (const item of this.pendingSteered)
              this.pending.push({ kind: "prompt", input: item.input });
            this.pendingSteered = [];
            try {
              await this.opts.runner.clearSteeringQueue();
            } catch (abortErr) {
              this.log.warn(
                "[TurnDispatcher] clearSteeringQueue after prompt failure failed:",
                abortErr
              );
            }
          }
          this.running = false;
          this.notifyTyping();
          continue;
        }
        if (!active.sawAgentEnd) {
          this.running = false;
          await this.sweepPendingSteered("after runner completion without agent_end");
          this.notifyTyping();
        }
        this.warnIfWorkProducedNoLifecycle(work, active);
      }
    } finally {
      if (generation !== this.drainGeneration) return;
      this.activeWork = null;
      this.draining = false;
      this.notifyTyping();
    }
  }

  private beginActiveWork(generation: number, work: WorkItem): ActiveWork {
    let resolveCompletion!: (result: WorkCompletion) => void;
    const active: ActiveWork = {
      generation,
      kind: work.kind,
      sawAgentStart: false,
      sawAgentEnd: false,
      runnerSettled: false,
      completed: false,
      completion: new Promise<WorkCompletion>((resolve) => {
        resolveCompletion = resolve;
      }),
      complete: (result) => {
        if (active.completed) return;
        active.completed = true;
        resolveCompletion(result);
      },
    };
    this.activeWork = active;
    return active;
  }

  private observeRunnerWork(work: WorkItem, active: ActiveWork): void {
    let promise: Promise<void>;
    try {
      if (this.opts.onWorkStart) {
        promise = Promise.resolve(this.opts.onWorkStart(work)).then((turnId) => {
          active.turnId = turnId;
          return work.kind === "continue"
            ? this.opts.runner.continueAgent({ turnId })
            : this.opts.runner.prompt(work.input, { turnId });
        });
      } else {
        promise =
          work.kind === "continue"
            ? this.opts.runner.continueAgent()
            : this.opts.runner.prompt(work.input);
      }
    } catch (err) {
      active.runnerSettled = true;
      this.completeActiveWork(active, { status: "failed", error: err });
      return;
    }
    void promise.then(
      () => {
        active.runnerSettled = true;
        this.completeActiveWork(active, { status: "completed", source: "runner" });
      },
      (err) => {
        active.runnerSettled = true;
        this.completeActiveWork(active, { status: "failed", error: err });
      }
    );
  }

  private completeActiveWork(active: ActiveWork, result: WorkCompletion): void {
    if (this.activeWork !== active || active.generation !== this.drainGeneration) return;
    active.complete(result);
  }

  private eventMatchesActiveWork(event: RunnerEvent, active: ActiveWork): boolean {
    const eventTurnId = eventMetadata(event).turnId;
    return !eventTurnId || !active.turnId || eventTurnId === active.turnId;
  }

  private invalidateActiveWork(): void {
    const active = this.activeWork;
    this.activeWork = null;
    active?.complete({ status: "invalidated" });
  }

  private async sweepPendingSteered(context: string): Promise<void> {
    if (this.pendingSteered.length === 0) return;
    const stranded = this.pendingSteered;
    this.pendingSteered = [];
    for (const item of stranded) this.pending.push({ kind: "prompt", input: item.input });
    try {
      await this.opts.runner.clearSteeringQueue();
    } catch (err) {
      this.log.warn(`[TurnDispatcher] clearSteeringQueue ${context} failed:`, err);
    }
  }

  private activeWorkDebugState(active: ActiveWork): Record<string, unknown> {
    return {
      generation: active.generation,
      kind: active.kind,
      sawAgentStart: active.sawAgentStart,
      sawAgentEnd: active.sawAgentEnd,
      runnerSettled: active.runnerSettled,
      completed: active.completed,
    };
  }

  private warnIfWorkProducedNoLifecycle(work: WorkItem, active: ActiveWork): void {
    if (active.generation !== this.drainGeneration || active.kind !== work.kind) return;
    if (!active.sawAgentStart) {
      this.reportInvariant("runner_completed_without_agent_start", {
        workKind: work.kind,
        turnId: active.turnId ?? null,
      });
      return;
    }
    if (!active.sawAgentEnd) {
      this.reportInvariant("runner_completed_without_agent_end", {
        workKind: work.kind,
        turnId: active.turnId ?? null,
      });
    }
  }

  private reportInvariant(code: string, detail?: Record<string, unknown>): void {
    this.log.warn(`[TurnDispatcher] invariant violation: ${code}`, detail ?? {});
    void Promise.resolve(this.opts.onInvariantViolation?.(code, detail)).catch((err) => {
      this.log.warn("[TurnDispatcher] onInvariantViolation failed:", err);
    });
  }
}

function eventMetadata(event: RunnerEvent): { turnId?: string; lifecycleMatched?: boolean } {
  return ((event as { natstack?: { turnId?: string; lifecycleMatched?: boolean } }).natstack ??
    {}) as { turnId?: string; lifecycleMatched?: boolean };
}

function isUserMessage(value: unknown): value is AgentMessage {
  return Boolean(
    value && typeof value === "object" && (value as { role?: string }).role === "user"
  );
}

function summarizeTurnInput(input: RunnerTurnInput): Record<string, unknown> {
  return {
    contentLength: input.content.length,
    contentPreview: previewDebugText(input.content),
    imageCount: input.images?.length ?? 0,
  };
}

function previewDebugText(value: string, limit = 240): string {
  const compact = value.replace(/\s+/gu, " ").trim();
  return compact.length > limit ? `${compact.slice(0, limit - 3)}...` : compact;
}
