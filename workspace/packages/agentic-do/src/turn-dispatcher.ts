/**
 * TurnDispatcher - per-channel prompt queue and typing state.
 *
 * PiRunner now exposes AgentHarness-native verbs. The dispatcher stores
 * text/image inputs, not prebuilt AgentMessage objects, and never rewrites
 * runner state.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { RunnerEvent, RunnerTurnInput } from "@natstack/harness";

export interface TurnDispatcherRunner {
  subscribe(listener: (event: RunnerEvent) => void): () => void;
  buildUserMessage(input: RunnerTurnInput): AgentMessage;
  prompt(input: RunnerTurnInput): Promise<void>;
  continueAgent(): Promise<void>;
  steerMessage(message: AgentMessage): Promise<void>;
  clearSteeringQueue(): Promise<void>;
}

type WorkItem =
  | { kind: "prompt"; input: RunnerTurnInput }
  | { kind: "continue" };

interface PendingSteer {
  input: RunnerTurnInput;
  message: AgentMessage;
}

export interface TurnDispatcherProjector {
  closeAll(): Promise<void>;
}

export interface TurnDispatcherOptions {
  runner: TurnDispatcherRunner;
  projector: TurnDispatcherProjector;
  notifyTyping: (busy: boolean) => void;
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
  private activeWork:
    | { generation: number; kind: WorkItem["kind"]; sawAgentStart: boolean; sawAgentEnd: boolean }
    | null = null;
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
        this.pendingSteered = this.pendingSteered.filter((candidate) => candidate.message !== message);
        this.pending.push({ kind: "prompt", input });
        this.ensureDrain();
      });
      return;
    }
    this.pending.push({ kind: "prompt", input });
    this.notifyTyping();
    this.ensureDrain();
  }

  submitContinue(): void {
    if (this.disposed) return;
    this.pending.push({ kind: "continue" });
    this.notifyTyping();
    this.ensureDrain();
  }

  reset(): void {
    this.pending = [];
    this.pendingSteered = [];
    this.running = false;
    this.draining = false;
    this.drainGeneration++;
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
    this.unsub();
    this.notifyTyping();
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
        if (this.activeWork) this.activeWork.sawAgentStart = true;
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
        if (this.activeWork) this.activeWork.sawAgentEnd = true;
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
        if (this.pending.length > 0) this.ensureDrain();
        return;
      }
    }
  }

  private ensureDrain(): void {
    if (this.draining) return;
    this.draining = true;
    const generation = ++this.drainGeneration;
    void this.drainLoop(generation).catch((err) => {
      if (generation !== this.drainGeneration) return;
      this.log.error("[TurnDispatcher] drainLoop crashed:", err);
      this.draining = false;
      this.notifyTyping();
    });
  }

  private async drainLoop(generation: number): Promise<void> {
    try {
      while (!this.disposed && generation === this.drainGeneration && this.pending.length > 0) {
        const work = this.pending.shift()!;
        this.running = true;
        this.activeWork = {
          generation,
          kind: work.kind,
          sawAgentStart: false,
          sawAgentEnd: false,
        };
        this.notifyTyping();
        try {
          if (work.kind === "continue") {
            await this.opts.runner.continueAgent();
          } else {
            await this.opts.runner.prompt(work.input);
          }
          if (generation !== this.drainGeneration) return;
          this.warnIfWorkProducedNoLifecycle(work);
        } catch (err) {
          if (generation !== this.drainGeneration) return;
          this.log.warn(
            `[TurnDispatcher] ${work.kind === "continue" ? "continueAgent" : "prompt"} failed:`,
            err,
          );
          try {
            await this.opts.projector.closeAll();
          } catch (closeErr) {
            this.log.warn("[TurnDispatcher] projector.closeAll failed:", closeErr);
          }
          if (this.pendingSteered.length > 0) {
            for (const item of this.pendingSteered) this.pending.push({ kind: "prompt", input: item.input });
            this.pendingSteered = [];
            try {
              await this.opts.runner.clearSteeringQueue();
            } catch (abortErr) {
              this.log.warn("[TurnDispatcher] clearSteeringQueue after prompt failure failed:", abortErr);
            }
          }
          this.running = false;
          this.notifyTyping();
        }
      }
    } finally {
      if (generation !== this.drainGeneration) return;
      this.activeWork = null;
      this.draining = false;
      this.notifyTyping();
    }
  }

  private warnIfWorkProducedNoLifecycle(work: WorkItem): void {
    if (work.kind !== "continue") return;
    const active = this.activeWork;
    if (!active || active.generation !== this.drainGeneration || active.kind !== work.kind) return;
    if (!active.sawAgentStart) {
      this.log.warn(
        `[TurnDispatcher] ${work.kind === "continue" ? "continueAgent" : "prompt"} completed without agent_start`,
      );
      return;
    }
    if (!active.sawAgentEnd) {
      this.log.warn(
        `[TurnDispatcher] ${work.kind === "continue" ? "continueAgent" : "prompt"} completed without agent_end`,
      );
    }
  }
}

function isUserMessage(value: unknown): value is AgentMessage {
  return Boolean(value && typeof value === "object" && (value as { role?: string }).role === "user");
}
