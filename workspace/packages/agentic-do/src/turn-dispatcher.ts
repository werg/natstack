/**
 * TurnDispatcher - per-channel prompt queue and typing state.
 *
 * PiRunner now exposes AgentHarness-native verbs. The dispatcher stores
 * text/image inputs, not prebuilt AgentMessage objects, and never rewrites
 * runner state.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  isTurnSuspensionSignal,
  type RunnerEvent,
  type RunnerTurnInput,
  type RunnerTurnOptions,
} from "@workspace/harness";

export interface TurnDispatcherRunner {
  subscribe(listener: (event: RunnerEvent) => void): () => void;
  buildUserMessage(input: RunnerTurnInput): AgentMessage;
  prompt(input: RunnerTurnInput, opts?: RunnerTurnOptions): Promise<void>;
  continueAgent(opts?: RunnerTurnOptions): Promise<void>;
  steerMessage(message: AgentMessage): Promise<void>;
  clearSteeringQueue(): Promise<void>;
  /**
   * The turn currently open in the runner, or null if idle. Reconstructed from
   * durable trajectory state on every activation, so it is the authoritative,
   * hibernation-surviving signal for "is this channel occupied" — a turn that is
   * running OR parked/suspended is open. The dispatcher steers new input into an
   * open turn rather than starting a competing one (which would collide on the
   * single-open-turn invariant). This replaces the old in-memory `parkedTurnId`,
   * which was lost on hibernation and let a post-revival message collide.
   */
  getCurrentTurnId(): string | null;
}

export type WorkItem =
  | { kind: "prompt"; input: RunnerTurnInput; steeringId?: string }
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
  steeringId?: string;
  completion: Promise<WorkCompletion>;
  complete(result: WorkCompletion): void;
}

interface PendingSteer {
  input: RunnerTurnInput;
  message: AgentMessage;
  steeringId?: string;
}

export interface TurnDispatcherOptions {
  runner: TurnDispatcherRunner;
  notifyTyping: (busy: boolean) => void;
  onWorkStart?: (work: WorkItem) => string | undefined | Promise<string | undefined>;
  onWorkFailure?: (work: WorkItem, error: unknown, turnId?: string) => void | Promise<void>;
  onInvariantViolation?: (code: string, detail?: Record<string, unknown>) => void | Promise<void>;
  onSteeredMessageObserved?: (steeringId: string) => void | Promise<void>;
  diagnosticContext?: () => Record<string, unknown>;
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
  // Set when the user interrupts. Suppresses auto-continuation (suspension
  // resumes / recovery continues) so an aborted agent does not keep churning
  // through new turns. Cleared by the next user message (`submit`), which is
  // the only thing that should re-start the agent after an interrupt.
  private interrupted = false;
  private activeWork: ActiveWork | null = null;
  private readonly unsub: () => void;
  private readonly log: Pick<Console, "warn" | "error">;

  constructor(private readonly opts: TurnDispatcherOptions) {
    this.log = opts.log ?? console;
    this.unsub = opts.runner.subscribe((event) => this.handleEvent(event));
  }

  submit(
    input: RunnerTurnInput,
    opts?: { mode?: "auto" | "sequential"; steeringId?: string }
  ): void {
    if (this.disposed) return;
    // A fresh user message re-engages the agent after an interrupt.
    this.interrupted = false;
    if (opts?.steeringId && this.hasInFlightSteeringId(opts.steeringId)) return;
    const sequential = opts?.mode === "sequential";
    // Steer into any OPEN turn — running OR parked/suspended. The runner's
    // current turn id is reconstructed from durable trajectory on activation, so
    // this holds even after a hibernation that happened mid-park: a fresh prompt
    // would collide on `adoptTurnId`, so we steer the message into the open turn,
    // which the resume (`submitContinue`) drains. (Fixes the P0-2 collision.)
    if (!sequential && this.shouldSteerAutoSubmit()) {
      this.enqueueSteer(input, opts);
      return;
    }
    this.pending.push({
      kind: "prompt",
      input,
      ...(opts?.steeringId ? { steeringId: opts.steeringId } : {}),
    });
    this.notifyTyping();
    this.ensureDrain();
  }

  /**
   * Steer a fresh user message into a turn that is open but not actively
   * draining here — i.e. a turn parked on a surviving method call after a
   * runner restart. The runner holds `currentTurnId`, but this dispatcher is
   * idle, so a plain `submit()` would mint a competing turn and collide on
   * `adoptTurnId`. Routing it as a steer instead lets the message ride the
   * in-flight turn: it is consumed when the method result redelivers and the
   * turn continues, or — if the continue produces an `agent_end` without
   * consuming it — re-queued as a fresh prompt by the `agent_end` handler.
   */
  steerIntoActiveTurn(input: RunnerTurnInput, opts?: { steeringId?: string }): void {
    if (this.disposed) return;
    this.interrupted = false;
    if (opts?.steeringId && this.hasInFlightSteeringId(opts.steeringId)) return;
    const message = this.opts.runner.buildUserMessage(input);
    const pending: PendingSteer = {
      input,
      message,
      ...(opts?.steeringId ? { steeringId: opts.steeringId } : {}),
    };
    this.pendingSteered.push(pending);
    this.notifyTyping();
    void this.opts.runner.steerMessage(message).catch((err) => {
      this.log.warn(
        "[TurnDispatcher] steer into active turn failed; routing as fresh prompt:",
        err
      );
      this.pendingSteered = this.pendingSteered.filter(
        (candidate) => candidate.message !== message
      );
      this.pending.push({
        kind: "prompt",
        input,
        ...(pending.steeringId ? { steeringId: pending.steeringId } : {}),
      });
      this.ensureDrain();
    });
  }

  submitContinue(opts: RunnerTurnOptions = {}): void {
    if (this.disposed) return;
    // Drop auto-continuations once the user has interrupted. A suspension
    // result or recovery pass that resolves after the interrupt must not
    // re-start the agent loop — only a new user message may.
    if (this.interrupted) {
      this.log.warn("[TurnDispatcher] dropping continue after user interrupt", {
        turnId: opts.turnId ?? null,
      });
      this.notifyTyping();
      return;
    }
    this.pending.push({ kind: "continue", ...(opts.turnId ? { turnId: opts.turnId } : {}) });
    this.notifyTyping();
    this.ensureDrain();
  }

  /**
   * Interrupt: clear all queued/active work like `reset()`, and additionally
   * suppress further auto-continuation until the next user message. Used by the
   * worker's pause/interrupt path so a stopped agent stays stopped instead of
   * being resumed by a late suspension result or recovery continue.
   */
  interrupt(): void {
    this.interrupted = true;
    this.reset();
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
          : {
              kind: item.kind,
              input: summarizeTurnInput(item.input),
              ...(item.steeringId ? { steeringId: item.steeringId } : {}),
            }
      ),
      pendingSteered: this.pendingSteered.map((item) => ({
        input: summarizeTurnInput(item.input),
        messageRole: (item.message as { role?: unknown }).role ?? null,
        ...(item.steeringId ? { steeringId: item.steeringId } : {}),
      })),
      pendingSteeredCount: this.pendingSteered.length,
      running: this.running,
      draining: this.draining,
      openTurnId: this.opts.runner.getCurrentTurnId(),
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

  private shouldSteerAutoSubmit(): boolean {
    return (
      this.running ||
      this.draining ||
      this.pending.length > 0 ||
      this.pendingSteered.length > 0 ||
      this.opts.runner.getCurrentTurnId() !== null
    );
  }

  private enqueueSteer(input: RunnerTurnInput, opts?: { steeringId?: string }): void {
    const message = this.opts.runner.buildUserMessage(input);
    const pending: PendingSteer = {
      input,
      message,
      ...(opts?.steeringId ? { steeringId: opts.steeringId } : {}),
    };
    this.pendingSteered.push(pending);
    this.notifyTyping();
    void this.opts.runner.steerMessage(message).catch((err) => {
      this.log.warn("[TurnDispatcher] steer failed; routing as fresh prompt:", err);
      this.pendingSteered = this.pendingSteered.filter(
        (candidate) => candidate.message !== message
      );
      this.pending.push({
        kind: "prompt",
        input,
        ...(pending.steeringId ? { steeringId: pending.steeringId } : {}),
      });
      this.ensureDrain();
    });
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

  private diagnosticContext(extra: Record<string, unknown> = {}): Record<string, unknown> {
    let base: Record<string, unknown> = {};
    try {
      base = this.opts.diagnosticContext?.() ?? {};
    } catch (err) {
      base = { diagnosticContextError: err instanceof Error ? err.message : String(err) };
    }
    return {
      ...base,
      running: this.running,
      draining: this.draining,
      pendingCount: this.pending.length,
      pendingSteeredCount: this.pendingSteered.length,
      openTurnId: this.opts.runner.getCurrentTurnId(),
      activeWork: this.activeWork ? this.activeWorkDebugState(this.activeWork) : null,
      ...extra,
    };
  }

  private notifySteeringObserved(steeringId: string): void {
    void Promise.resolve(this.opts.onSteeredMessageObserved?.(steeringId)).catch((err) => {
      this.log.warn("[TurnDispatcher] onSteeredMessageObserved failed:", err);
    });
  }

  private hasInFlightSteeringId(steeringId: string): boolean {
    if (this.activeWork?.steeringId === steeringId) return true;
    if (this.pendingSteered.some((item) => item.steeringId === steeringId)) return true;
    return this.pending.some((item) => item.kind === "prompt" && item.steeringId === steeringId);
  }

  private observeActivePromptSteering(active: ActiveWork): void {
    if (active.kind !== "prompt" || !active.steeringId) return;
    const steeringId = active.steeringId;
    delete active.steeringId;
    this.notifySteeringObserved(steeringId);
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
        if (idx >= 0) {
          const [observed] = this.pendingSteered.splice(idx, 1);
          if (observed?.steeringId) this.notifySteeringObserved(observed.steeringId);
          return;
        }
        const active = this.activeWork;
        if (active && this.eventMatchesActiveWork(event, active)) {
          this.observeActivePromptSteering(active);
        }
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
        const openTurnId = this.opts.runner.getCurrentTurnId();
        if (this.pendingSteered.length > 0 && openTurnId === null) {
          const stranded = this.pendingSteered;
          this.pendingSteered = [];
          void this.opts.runner.clearSteeringQueue().catch((err) => {
            this.log.warn("[TurnDispatcher] clearSteeringQueue after stranded steer failed:", err);
          });
          for (const item of stranded)
            this.pending.push({
              kind: "prompt",
              input: item.input,
              ...(item.steeringId ? { steeringId: item.steeringId } : {}),
            });
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
        if (work.kind === "prompt" && this.opts.runner.getCurrentTurnId() !== null) {
          this.log.warn(
            "[TurnDispatcher] queued prompt found open runner turn; converting to steer",
            this.diagnosticContext({
              workKind: work.kind,
              steeringId: work.steeringId ?? null,
            })
          );
          this.enqueueSteer(
            work.input,
            work.steeringId ? { steeringId: work.steeringId } : undefined
          );
          continue;
        }
        this.running = true;
        const active = this.beginActiveWork(generation, work);
        this.notifyTyping();
        this.observeRunnerWork(work, active);
        const completion = await active.completion;
        if (generation !== this.drainGeneration || completion.status === "invalidated") return;
        if (completion.status === "failed") {
          if (generation !== this.drainGeneration) return;
          if (
            isTurnSuspensionSignal(completion.error) ||
            isStaleDispatchSignal(completion.error)
          ) {
            this.running = false;
            this.notifyTyping();
            continue;
          }
          this.log.warn(
            `[TurnDispatcher] ${work.kind === "continue" ? "continueAgent" : "prompt"} failed:`,
            this.diagnosticContext({
              workKind: work.kind,
              turnId: active.turnId ?? null,
              sawAgentStart: active.sawAgentStart,
              sawAgentEnd: active.sawAgentEnd,
              runnerSettled: active.runnerSettled,
            }),
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
            for (const item of this.pendingSteered) {
              this.pending.push({
                kind: "prompt",
                input: item.input,
                ...(item.steeringId ? { steeringId: item.steeringId } : {}),
              });
            }
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
          this.observeActivePromptSteering(active);
          this.running = false;
          this.notifyTyping();
          continue;
        }
        this.observeActivePromptSteering(active);
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
      ...(work.kind === "prompt" && work.steeringId ? { steeringId: work.steeringId } : {}),
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
    for (const item of stranded) {
      this.pending.push({
        kind: "prompt",
        input: item.input,
        ...(item.steeringId ? { steeringId: item.steeringId } : {}),
      });
    }
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
      turnId: active.turnId ?? null,
      ...(active.steeringId ? { steeringId: active.steeringId } : {}),
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

function isStaleDispatchSignal(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      (error as { name?: unknown }).name === "AgentLifecycleError" &&
      (error as { outcome?: unknown }).outcome === "stale_dispatch"
  );
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
