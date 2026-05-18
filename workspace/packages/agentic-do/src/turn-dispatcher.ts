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
  prompt(input: RunnerTurnInput): Promise<void>;
  continueAgent(): Promise<void>;
  steer(input: RunnerTurnInput): Promise<void>;
  abort(): Promise<{ clearedSteer: AgentMessage[]; clearedFollowUp: AgentMessage[] }>;
}

type WorkItem =
  | { kind: "prompt"; input: RunnerTurnInput }
  | { kind: "continue" };

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
  private pendingSteered: RunnerTurnInput[] = [];
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

  submit(input: RunnerTurnInput, opts?: { mode?: "auto" | "sequential" }): void {
    if (this.disposed) return;
    const sequential = opts?.mode === "sequential";
    if (!sequential && this.running) {
      this.pendingSteered.push(input);
      this.notifyTyping();
      void this.opts.runner.steer(input).catch((err) => {
        this.log.warn("[TurnDispatcher] steer failed; routing as fresh prompt:", err);
        this.pendingSteered = this.pendingSteered.filter((candidate) => candidate !== input);
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
    void this.opts.runner.abort().catch((err) => {
      this.log.warn("[TurnDispatcher] abort during reset failed:", err);
    });
    this.notifyTyping();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.pending = [];
    this.pendingSteered = [];
    this.running = false;
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
      case "message_start": {
        const msg = (event as { message?: unknown }).message;
        if (!isUserMessage(msg)) return;
        const idx = this.pendingSteered.findIndex((input) => inputMatchesMessage(input, msg));
        if (idx >= 0) this.pendingSteered.splice(idx, 1);
        return;
      }
      case "agent_end": {
        this.running = false;
        if (this.pendingSteered.length > 0) {
          const stranded = this.pendingSteered;
          this.pendingSteered = [];
          void this.opts.runner.abort().catch((err) => {
            this.log.warn("[TurnDispatcher] abort after stranded steer failed:", err);
          });
          for (const input of stranded) this.pending.push({ kind: "prompt", input });
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
        this.running = true;
        this.notifyTyping();
        try {
          if (work.kind === "continue") {
            await this.opts.runner.continueAgent();
          } else {
            await this.opts.runner.prompt(work.input);
          }
        } catch (err) {
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
            for (const input of this.pendingSteered) this.pending.push({ kind: "prompt", input });
            this.pendingSteered = [];
            try {
              await this.opts.runner.abort();
            } catch (abortErr) {
              this.log.warn("[TurnDispatcher] abort after prompt failure failed:", abortErr);
            }
          }
          this.running = false;
          this.notifyTyping();
        }
      }
    } finally {
      this.draining = false;
      this.notifyTyping();
    }
  }
}

function isUserMessage(value: unknown): value is AgentMessage {
  return Boolean(value && typeof value === "object" && (value as { role?: string }).role === "user");
}

function inputMatchesMessage(input: RunnerTurnInput, message: AgentMessage): boolean {
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content === input.content;
  if (!Array.isArray(content)) return false;
  const text = content.find((block) => (
    block &&
    typeof block === "object" &&
    (block as { type?: string }).type === "text"
  )) as { text?: string } | undefined;
  return text?.text === input.content;
}
