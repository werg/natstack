/**
 * AgentWorkerBase integration tests — exercise onChannelEvent → dispatcher
 * wiring without spinning up pi-agent-core or hitting the RPC layer.
 *
 * Strategy: subclass AgentWorkerBase with a minimal override that injects
 * a fake PiRunner. The fake satisfies the subset of the PiRunner surface
 * that the dispatcher actually touches (buildUserMessage, subscribe,
 * runTurnMessage, steerMessage, clearSteeringQueue). Everything else
 * (roster refresh, image resize, participant lookup) is either stubbed
 * or allowed to bail out via missing subscription state.
 *
 * What this covers that the unit tests don't:
 *   - onChannelEvent's shouldProcess / buildTurnInput / buildUserMessage
 *     glue actually wires a real message into the real TurnDispatcher.
 *   - The dispatcher is created as a side-effect of getOrCreateRunner.
 *   - Replay-path sequential mode forces runTurn instead of steering
 *     even when running is true from a prior replay event.
 */

import { describe, it, expect, vi } from "vitest";

import type {
  AgentEvent,
  AgentMessage,
} from "@mariozechner/pi-agent-core";
import type { ChannelEvent } from "@natstack/harness/types";
import type { PiRunner } from "@natstack/harness";

import { createTestDO } from "@workspace/runtime/worker/test-utils";

import { AgentWorkerBase } from "./agent-worker-base.js";
import { ContentBlockProjector } from "./content-block-projector.js";

// ─── Fake PiRunner ───────────────────────────────────────────────────────────

interface FakeRunnerState {
  runTurnCalls: AgentMessage[];
  steerCalls: AgentMessage[];
  buildCalls: Array<{ content: string; images?: unknown }>;
  clearCount: number;
  emit: (event: AgentEvent) => void;
}

function makeFakeRunner(): { fake: PiRunner; state: FakeRunnerState } {
  const listeners: Array<(event: AgentEvent) => void> = [];
  const state: FakeRunnerState = {
    runTurnCalls: [],
    steerCalls: [],
    buildCalls: [],
    clearCount: 0,
    emit: (event) => {
      for (const l of listeners) l(event);
    },
  };
  const fake = {
    buildUserMessage(content: string, images?: unknown): AgentMessage {
      state.buildCalls.push({ content, images });
      return {
        role: "user",
        content: images ? [{ type: "text", text: content }] : content,
        timestamp: 1,
      } as AgentMessage;
    },
    subscribe(fn: (event: AgentEvent) => void) {
      listeners.push(fn);
      return () => {
        const i = listeners.indexOf(fn);
        if (i >= 0) listeners.splice(i, 1);
      };
    },
    async runTurnMessage(msg: AgentMessage) {
      state.runTurnCalls.push(msg);
      // Emit a synthetic lifecycle so drainLoop's await resolves promptly.
      // Match pi-core's emit-and-await pattern: our listeners are
      // synchronous, so we can safely call them here.
      state.emit({ type: "agent_start" } as AgentEvent);
      state.emit({ type: "message_start", message: msg } as unknown as AgentEvent);
      state.emit({ type: "agent_end", messages: [] } as unknown as AgentEvent);
    },
    steerMessage(msg: AgentMessage) {
      state.steerCalls.push(msg);
    },
    clearSteeringQueue() {
      state.clearCount++;
    },
    dispose() { /* no-op */ },
    setApprovalLevel() { /* no-op */ },
  } as unknown as PiRunner;
  return { fake, state };
}

// ─── Test subclass ───────────────────────────────────────────────────────────

class TestWorker extends AgentWorkerBase {
  static override schemaVersion = 99;

  public fakeState: FakeRunnerState | null = null;

  /** Skip the real roster RPC. */
  protected override async refreshRoster(): Promise<void> { /* no-op */ }

  /** Inject a fake runner instead of booting pi-agent-core + loading
   *  workspace resources over RPC. Still uses the real dispatcher +
   *  projector so the test actually exercises them. */
  protected override async getOrCreateRunner(channelId: string): Promise<PiRunner> {
    const existing = (this as unknown as { runners: Map<string, { runner: PiRunner }> }).runners.get(channelId);
    if (existing) return existing.runner;

    const { fake, state } = makeFakeRunner();
    this.fakeState = state;

    const projector = this.getOrCreateProjector(channelId);
    fake.subscribe((event) => projector.handleEvent(event));
    (this as unknown as { runners: Map<string, { runner: PiRunner }> }).runners.set(channelId, { runner: fake });
    this.getOrCreateDispatcher(channelId, fake, projector);
    return fake;
  }

  protected override getParticipantInfo() {
    return { handle: "test", name: "Test", type: "agent" as const, metadata: {}, methods: [] };
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function userMessage(content: string): ChannelEvent {
  return {
    type: "message",
    senderId: "client-1",
    senderMetadata: { type: "panel" },
    payload: { content },
  } as unknown as ChannelEvent;
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("AgentWorkerBase — onChannelEvent → TurnDispatcher wiring", () => {
  it("user message flows: shouldProcess → buildTurnInput → buildUserMessage → dispatcher → runTurnMessage", async () => {
    const { instance } = await createTestDO(TestWorker);

    await instance.onChannelEvent("ch-1", userMessage("hello world"));
    await flush();

    const s = (instance as TestWorker).fakeState!;
    expect(s.buildCalls).toHaveLength(1);
    expect(s.buildCalls[0]!.content).toBe("hello world");
    expect(s.runTurnCalls).toHaveLength(1);
    expect(s.runTurnCalls[0]!.content).toBe("hello world");
    expect(s.steerCalls).toHaveLength(0);
  });

  it("non-user messages are filtered by shouldProcess", async () => {
    const { instance } = await createTestDO(TestWorker);

    // senderType is "agent" — shouldProcess returns false before any setup.
    const event = {
      type: "message",
      senderId: "agent-x",
      senderMetadata: { type: "agent" },
      payload: { content: "from the agent" },
    } as unknown as ChannelEvent;

    await instance.onChannelEvent("ch-1", event);
    await flush();

    // getOrCreateRunner never got called — no fakeState created.
    expect((instance as TestWorker).fakeState).toBeNull();
  });

  it("message events with a contentType are filtered (agent-emitted sub-blocks)", async () => {
    const { instance } = await createTestDO(TestWorker);

    const event = {
      type: "message",
      senderId: "client-1",
      senderMetadata: { type: "panel" },
      payload: { content: "sub-block" },
      contentType: "thinking",
    } as unknown as ChannelEvent;

    await instance.onChannelEvent("ch-1", event);
    await flush();

    expect((instance as TestWorker).fakeState).toBeNull();
  });

  it("two rapid-fire user messages serialize: first runs, second steers", async () => {
    // Override the fake's runTurnMessage to NOT auto-complete so we can
    // observe mid-run behavior.
    class SlowTestWorker extends TestWorker {
      public resolveRun: (() => void) | null = null;
      protected override async getOrCreateRunner(channelId: string): Promise<PiRunner> {
        const existing = (this as unknown as { runners: Map<string, { runner: PiRunner }> }).runners.get(channelId);
        if (existing) return existing.runner;

        const listeners: Array<(event: AgentEvent) => void> = [];
        const state: FakeRunnerState = {
          runTurnCalls: [], steerCalls: [], buildCalls: [], clearCount: 0,
          emit: (event) => { for (const l of listeners) l(event); },
        };
        this.fakeState = state;

        const self = this;
        const fake = {
          buildUserMessage(content: string): AgentMessage {
            state.buildCalls.push({ content });
            return { role: "user", content, timestamp: 1 } as AgentMessage;
          },
          subscribe(fn: (event: AgentEvent) => void) {
            listeners.push(fn);
            return () => { listeners.splice(listeners.indexOf(fn), 1); };
          },
          runTurnMessage(msg: AgentMessage): Promise<void> {
            state.runTurnCalls.push(msg);
            return new Promise<void>((resolve) => { self.resolveRun = resolve; });
          },
          steerMessage(msg: AgentMessage) { state.steerCalls.push(msg); },
          clearSteeringQueue() { state.clearCount++; },
          dispose() {},
          setApprovalLevel() {},
        } as unknown as PiRunner;

        const projector = this.getOrCreateProjector(channelId);
        fake.subscribe((event: AgentEvent) => projector.handleEvent(event));
        (this as unknown as { runners: Map<string, { runner: PiRunner }> }).runners.set(channelId, { runner: fake });
        this.getOrCreateDispatcher(channelId, fake, projector);
        return fake;
      }
    }

    const { instance } = await createTestDO(SlowTestWorker);
    await instance.onChannelEvent("ch-1", userMessage("first"));
    await flush();
    // First is in-flight (runTurn pending).
    expect(instance.fakeState!.runTurnCalls).toHaveLength(1);

    // Second message arrives mid-run → should steer.
    await instance.onChannelEvent("ch-1", userMessage("second"));
    await flush();

    expect(instance.fakeState!.steerCalls).toHaveLength(1);
    expect(instance.fakeState!.steerCalls[0]!.content).toBe("second");
  });

  it("sequential mode forces runTurn (simulates replay of missed messages)", async () => {
    // Same SlowTestWorker pattern so we can inspect mid-run state.
    class SlowTestWorker extends TestWorker {
      public resolveRuns: Array<() => void> = [];
      protected override async getOrCreateRunner(channelId: string): Promise<PiRunner> {
        const existing = (this as unknown as { runners: Map<string, { runner: PiRunner }> }).runners.get(channelId);
        if (existing) return existing.runner;

        const listeners: Array<(event: AgentEvent) => void> = [];
        const state: FakeRunnerState = {
          runTurnCalls: [], steerCalls: [], buildCalls: [], clearCount: 0,
          emit: (event) => { for (const l of listeners) l(event); },
        };
        this.fakeState = state;

        const self = this;
        const fake = {
          buildUserMessage(content: string): AgentMessage {
            state.buildCalls.push({ content });
            return { role: "user", content, timestamp: 1 } as AgentMessage;
          },
          subscribe(fn: (event: AgentEvent) => void) {
            listeners.push(fn);
            return () => { listeners.splice(listeners.indexOf(fn), 1); };
          },
          runTurnMessage(msg: AgentMessage): Promise<void> {
            state.runTurnCalls.push(msg);
            return new Promise<void>((resolve) => { self.resolveRuns.push(resolve); });
          },
          steerMessage(msg: AgentMessage) { state.steerCalls.push(msg); },
          clearSteeringQueue() { state.clearCount++; },
          dispose() {},
          setApprovalLevel() {},
        } as unknown as PiRunner;

        const projector = this.getOrCreateProjector(channelId);
        fake.subscribe((event: AgentEvent) => projector.handleEvent(event));
        (this as unknown as { runners: Map<string, { runner: PiRunner }> }).runners.set(channelId, { runner: fake });
        this.getOrCreateDispatcher(channelId, fake, projector);
        return fake;
      }
    }

    const { instance } = await createTestDO(SlowTestWorker);

    // Event 1: auto mode, starts a run.
    await instance.onChannelEvent("ch-1", userMessage("r1"));
    await flush();
    // Event 2: sequential mode (replay path). Must NOT steer even though
    // running is true from r1.
    await instance.onChannelEvent("ch-1", userMessage("r2"), { mode: "sequential" });
    await flush();

    const s = instance.fakeState!;
    expect(s.runTurnCalls).toHaveLength(1);   // r2 not yet — it's queued
    expect(s.steerCalls).toHaveLength(0);      // critical: no steering in replay

    // Finish r1 so dispatcher drains to r2.
    instance.resolveRuns[0]!();
    // The fake emits no lifecycle events from runTurnMessage, so flip the
    // dispatcher's `running` back to false via a fake agent_end.
    s.emit({ type: "agent_end", messages: [] } as unknown as AgentEvent);
    await flush();

    expect(s.runTurnCalls).toHaveLength(2);
    expect(s.runTurnCalls[1]!.content).toBe("r2");
  });
});
