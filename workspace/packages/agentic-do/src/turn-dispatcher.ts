/**
 * TurnDispatcher — per-channel user-message dispatch + typing state machine.
 *
 * One instance per channel. Takes ownership of:
 *   - serializing user messages into `runner.runTurnMessage` calls so we
 *     never hit pi-agent-core's `activeRun`-already-set assertion,
 *   - steering during active runs,
 *   - self-healing stranded steers (see "sweep" below),
 *   - broadcasting the channel's typing indicator based on actual busy state.
 *
 * ─── State ────────────────────────────────────────────────────────────────
 *
 *   pending          Fresh-turn queue. Drained serially by runTurnMessage.
 *   pendingSteered   Messages handed to pi-core via steerMessage, awaiting
 *                    absorption. Matched against `message_start` events by
 *                    object identity; leftovers swept on `agent_end`.
 *   running          Our own flag. Flipped TRUE synchronously before every
 *                    runTurnMessage await (closing the agent_start race);
 *                    flipped FALSE in the agent_end handler, BEFORE pi-core
 *                    finishes the run. This is safe because the next iteration
 *                    of drainLoop doesn't call runTurnMessage until the
 *                    current await resolves — which happens after pi-core's
 *                    finishRun.
 *   draining         drainLoop active. Prevents re-entry.
 *   lastTypingOn     Last value broadcast via notifyTyping. Transitions only.
 *
 * ─── The sweep ────────────────────────────────────────────────────────────
 *
 * pi-agent-core's agent-loop drains its steering queue at line 80 (run
 * start) and line 122 (after every turn), but the natural-exit branch
 * (line 125) only polls the follow-up queue. So a `steer(msg)` that
 * lands between the last line-122 poll and the loop's `break` is
 * stranded — pi never processes it, but it stays in pi's steeringQueue.
 *
 * We detect this by tracking every steered message in `pendingSteered`
 * and removing from that set when pi emits `message_start` for our
 * exact object reference (agent-loop.js emits the same reference it
 * processes at line 94). On `agent_end`, anything still in
 * `pendingSteered` got stranded. We:
 *
 *   1. Move those refs into our own `pending` queue (fresh-turn path).
 *   2. Call `runner.clearSteeringQueue()` so pi-core doesn't double-
 *      ingest them on its next line-80 drain.
 *   3. Kick the drain loop.
 *
 * From the user's POV: the follow-up message is injected mid-stream when
 * possible, re-run as a fresh turn when not — never silently dropped.
 *
 * ─── Listener synchrony ───────────────────────────────────────────────────
 *
 * `handleEvent` is synchronous and MUST stay that way. pi-runner calls
 * subscriber listeners without awaiting their return values, so any state
 * update that must land before the surrounding runTurn Promise resolves
 * has to happen during the synchronous body of `handleEvent`.
 */

import type { AgentEvent, AgentMessage } from "@mariozechner/pi-agent-core";

export interface TurnDispatcherRunner {
  /** Subscribe to agent events. Returns an unsubscribe function. */
  subscribe(listener: (event: AgentEvent) => void): () => void;
  /** Submit a prebuilt AgentMessage as a fresh turn. Requires the agent
   *  to be idle; resolves when the turn finishes (including agent_end). */
  runTurnMessage(msg: AgentMessage): Promise<void>;
  /** Continue from the current transcript. Requires the last message to be user/toolResult. */
  continueAgent(): Promise<void>;
  /** Queue a prebuilt AgentMessage for mid-stream steering. */
  steerMessage(msg: AgentMessage): void;
  /** Clear pi-agent-core's internal steering queue. */
  clearSteeringQueue(): void;
}

type WorkItem =
  | { kind: "prompt"; msg: AgentMessage }
  | { kind: "continue" };

export interface TurnDispatcherProjector {
  /** Close every in-flight channel message. Called on runTurn failure to
   *  clear stuck "pending" blocks on the client. */
  closeAll(): Promise<void>;
}

export interface TurnDispatcherOptions {
  runner: TurnDispatcherRunner;
  projector: TurnDispatcherProjector;
  /** Invoked with the current busy state, but only on transitions. */
  notifyTyping: (busy: boolean) => void;
  /** Logger override for tests. Defaults to console. */
  log?: Pick<Console, "warn" | "error">;
}

export class TurnDispatcher {
  private pending: WorkItem[] = [];
  private pendingSteered: AgentMessage[] = [];
  private running = false;
  private draining = false;
  private lastTypingOn = false;
  private disposed = false;
  private readonly unsub: () => void;
  private readonly log: Pick<Console, "warn" | "error">;

  constructor(private readonly opts: TurnDispatcherOptions) {
    this.log = opts.log ?? console;
    this.unsub = opts.runner.subscribe((event) => this.handleEvent(event));
  }

  /**
   * Route a user message.
   *
   * @param msg  The prebuilt AgentMessage. Caller must retain no other uses
   *             of the reference — the dispatcher may keep it pinned in
   *             `pendingSteered` for absorption matching.
   * @param opts.mode
   *   - "auto" (default): steer if mid-run, else enqueue as a fresh turn.
   *   - "sequential": always enqueue as a fresh turn. Used by the replay
   *     path so that missed messages run as independent turns rather than
   *     collapsing into a single steered response.
   */
  submit(msg: AgentMessage, opts?: { mode?: "auto" | "sequential" }): void {
    if (this.disposed) return;
    const sequential = opts?.mode === "sequential";
    if (!sequential && this.running) {
      this.pendingSteered.push(msg);
      this.notifyTyping();
      this.opts.runner.steerMessage(msg);
    } else {
      this.pending.push({ kind: "prompt", msg });
      this.notifyTyping();
      this.ensureDrain();
    }
  }

  submitContinue(): void {
    if (this.disposed) return;
    this.pending.push({ kind: "continue" });
    this.notifyTyping();
    this.ensureDrain();
  }

  /** Wipe all pending work and broadcast typing off. Safe to call from
   *  interrupt / error paths. Caller is responsible for whatever actually
   *  stops the runner (abort + waitForIdle). */
  reset(): void {
    this.pending = [];
    this.pendingSteered = [];
    this.running = false;
    // Don't clear `draining` — the loop's finally handles it. Calling
    // reset while drainLoop is awaiting will cause it to exit cleanly
    // on the next pending.length check.
    this.opts.runner.clearSteeringQueue();
    this.notifyTyping();
  }

  /**
   * Detach from the runner, drop all pending work, and broadcast typing off.
   *
   * IMPORTANT: `dispose` does NOT abort a currently-awaited
   * `runTurnMessage` — the underlying Promise is left to settle naturally.
   * If the caller wants to actually stop in-flight work, it must also
   * abort the runner (`runner.interrupt()` or `runner.dispose()` which
   * calls `agent.abort()` internally). `AgentWorkerBase.unsubscribeChannel`
   * does this: `dispatcher.dispose()` then `runner.dispose()`.
   *
   * After dispose, any subsequent `submit` is a no-op, and the agent_end
   * that eventually fires for the in-flight run won't re-enter the
   * dispatcher (the listener is unsubscribed).
   */
  dispose(): void {
    this.disposed = true;
    this.pending = [];
    this.pendingSteered = [];
    this.running = false;
    this.unsub();
    this.notifyTyping();
  }

  private get busy(): boolean {
    return (
      this.running ||
      this.pending.length > 0 ||
      this.pendingSteered.length > 0
    );
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

  /** Synchronous handler wired into pi-runner. MUST stay sync. */
  private handleEvent(event: AgentEvent): void {
    if (this.disposed) return;

    // `agent_start` is deliberately NOT handled here: the dispatcher is
    // the only path that drives pi's `agent.prompt`, and drainLoop flips
    // `running=true` synchronously before the runTurnMessage await. By
    // the time pi emits agent_start, our flag is already correct — the
    // handler would be a no-op.
    switch (event.type) {
      case "message_start": {
        const msg = (event as { message?: unknown }).message as
          | { role?: string }
          | undefined;
        if (!msg || msg.role !== "user") return;
        const idx = this.pendingSteered.indexOf(msg as AgentMessage);
        if (idx >= 0) this.pendingSteered.splice(idx, 1);
        return;
      }

      case "agent_end": {
        this.running = false;
        if (this.pendingSteered.length > 0) {
          // Stranded steers — sweep into the fresh-turn queue and wipe
          // pi-core's internal queue so the next runTurnMessage's line-80
          // drain doesn't double-ingest.
          for (const stranded of this.pendingSteered) {
            this.pending.push({ kind: "prompt", msg: stranded });
          }
          this.pendingSteered = [];
          this.opts.runner.clearSteeringQueue();
        }
        this.notifyTyping();
        if (this.pending.length > 0) this.ensureDrain();
        return;
      }
    }
  }

  private ensureDrain(): void {
    if (this.draining) return;
    this.draining = true;
    void this.drainLoop().catch((err) => {
      this.log.error("[TurnDispatcher] drainLoop crashed:", err);
      this.draining = false;
      this.notifyTyping();
    });
  }

  private async drainLoop(): Promise<void> {
    try {
      while (!this.disposed && this.pending.length > 0) {
        const work = this.pending.shift()!;
        // Flip synchronously before awaiting — this closes the window
        // between here and pi's agent_start emission, so an onSubmit
        // during setup routes to steer, not a second runTurn.
        this.running = true;
        this.notifyTyping();
        try {
          if (work.kind === "continue") {
            await this.opts.runner.continueAgent();
          } else {
            await this.opts.runner.runTurnMessage(work.msg);
          }
        } catch (err) {
          this.log.warn(
            `[TurnDispatcher] ${work.kind === "continue" ? "continueAgent" : "runTurnMessage"} failed:`,
            err,
          );
          try {
            await this.opts.projector.closeAll();
          } catch (closeErr) {
            this.log.warn("[TurnDispatcher] projector.closeAll failed:", closeErr);
          }
          // Defensive sweep: if pi-core didn't reach its own
          // handleRunFailure → agent_end emit (so our agent_end handler
          // never ran), anything steered into the failed run is still in
          // pendingSteered. Move it to pending and wipe pi-core's queue.
          // Redundant with the agent_end sweep in the common case (pi-core
          // does emit agent_end on most failures), but covers the edge.
          if (this.pendingSteered.length > 0) {
            for (const stranded of this.pendingSteered) {
              this.pending.push({ kind: "prompt", msg: stranded });
            }
            this.pendingSteered = [];
            try { this.opts.runner.clearSteeringQueue(); }
            catch (clearErr) {
              this.log.warn("[TurnDispatcher] clearSteeringQueue failed:", clearErr);
            }
          }
          this.running = false;
          this.notifyTyping();
        }
        // After the await resolves, pi-core has finished the run and our
        // agent_end handler has swept any stranded steers into `pending`.
      }
    } finally {
      this.draining = false;
      this.notifyTyping();
    }
  }
}
