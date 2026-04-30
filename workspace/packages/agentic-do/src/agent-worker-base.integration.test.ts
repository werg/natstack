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
  continueCount: number;
  executeToolDirectCalls: Array<{ toolName: string; toolCallId: string; params: unknown }>;
  executeToolDirectImpl?: (toolName: string, toolCallId: string, params: unknown) => Promise<any>;
  replaceHistoryCalls: AgentMessage[][];
  emit: (event: AgentEvent) => void;
}

function makeFakeRunner(): { fake: PiRunner; state: FakeRunnerState } {
  const listeners: Array<(event: AgentEvent) => void> = [];
  const state: FakeRunnerState = {
    runTurnCalls: [],
    steerCalls: [],
    buildCalls: [],
    clearCount: 0,
    continueCount: 0,
    executeToolDirectCalls: [],
    replaceHistoryCalls: [],
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
    async continueAgent() {
      state.continueCount++;
      state.emit({ type: "agent_start" } as AgentEvent);
      state.emit({ type: "agent_end", messages: [] } as unknown as AgentEvent);
    },
    async executeToolDirect(toolName: string, toolCallId: string, params: unknown) {
      state.executeToolDirectCalls.push({ toolName, toolCallId, params });
      if (state.executeToolDirectImpl) {
        return state.executeToolDirectImpl(toolName, toolCallId, params);
      }
      return {
        content: [{ type: "text", text: "executed" }],
        details: undefined,
      };
    },
    trimTrailingAbortedAssistant(messages: AgentMessage[]) {
      return messages;
    },
    replaceHistory(messages: AgentMessage[]) {
      state.replaceHistoryCalls.push(messages);
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

  protected override getModel(): string {
    return "test-provider:test-model";
  }

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

  readPromptConfig(channelId: string) {
    return this.getRunnerPromptConfig(channelId);
  }

  resumeAfterCredential(channelId: string): Promise<boolean> {
    return this.resumeAfterModelCredentialConnected(channelId);
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
  it("reads subscription system prompt config for PiRunner construction", async () => {
    const { instance, sql } = await createTestDO(TestWorker);
    sql.exec(
      `INSERT INTO subscriptions (channel_id, context_id, subscribed_at, config) VALUES (?, ?, ?, ?)`,
      "ch-1",
      "ctx-1",
      Date.now(),
      JSON.stringify({ systemPrompt: "CHANNEL PROMPT", systemPromptMode: "replace-natstack" }),
    );

    expect((instance as TestWorker).readPromptConfig("ch-1")).toEqual({
      systemPrompt: "CHANNEL PROMPT",
      systemPromptMode: "replace-natstack",
    });
  });

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
          runTurnCalls: [],
          steerCalls: [],
          buildCalls: [],
          clearCount: 0,
          continueCount: 0,
          executeToolDirectCalls: [],
          replaceHistoryCalls: [],
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
          continueAgent(): Promise<void> {
            return Promise.resolve();
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
          runTurnCalls: [],
          steerCalls: [],
          buildCalls: [],
          clearCount: 0,
          continueCount: 0,
          executeToolDirectCalls: [],
          replaceHistoryCalls: [],
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
          continueAgent(): Promise<void> {
            return Promise.resolve();
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

  it("claims approval results once even if onCallResult is delivered twice", async () => {
    const { instance, sql } = await createTestDO(TestWorker);
    await (instance as any).getOrCreateRunner("ch-1");

    sql.exec(
      `INSERT INTO pi_messages (channel_id, idx, content) VALUES (?, ?, ?)`,
      "ch-1",
      0,
      JSON.stringify({
        role: "toolResult",
        toolCallId: "tool-1",
        toolName: "write",
        content: [{ type: "text", text: "dispatched: approval" }],
        timestamp: 1,
        isError: false,
      }),
    );
    sql.exec(
      `INSERT INTO dispatched_calls (
         call_id, channel_id, kind, tool_call_id, tool_name, params_json,
         pending_result_json, pending_is_error, abandoned_reason, resolving_token, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?)`,
      "call-1",
      "ch-1",
      "approval",
      "tool-1",
      "write",
      JSON.stringify({ path: "a.txt" }),
      Date.now(),
    );

    await Promise.all([
      instance.onCallResult("call-1", true, false),
      instance.onCallResult("call-1", true, false),
    ]);

    expect(instance.fakeState!.executeToolDirectCalls).toHaveLength(1);
    expect(sql.exec(`SELECT * FROM dispatched_calls WHERE call_id = ?`, "call-1").toArray()).toHaveLength(0);
    const rows = sql.exec(`SELECT content FROM pi_messages WHERE channel_id = ? ORDER BY idx`, "ch-1").toArray();
    const messages = rows.map((row) => JSON.parse(row["content"] as string));
    expect(messages[0]).toMatchObject({
      role: "toolResult",
      toolCallId: "tool-1",
      toolName: "write",
      isError: false,
    });
    expect(messages[0]!.content[0]!.text).toBe("executed");
  });

  it("converts resume-time approval execution failures into error tool results", async () => {
    const { instance, sql } = await createTestDO(TestWorker);
    await (instance as any).getOrCreateRunner("ch-1");
    instance.fakeState!.executeToolDirectImpl = async () => {
      throw new Error("boom on resume");
    };

    sql.exec(
      `INSERT INTO pi_messages (channel_id, idx, content) VALUES (?, ?, ?)`,
      "ch-1",
      0,
      JSON.stringify({
        role: "toolResult",
        toolCallId: "tool-1",
        toolName: "write",
        content: [{ type: "text", text: "dispatched: approval" }],
        timestamp: 1,
        isError: false,
      }),
    );
    sql.exec(
      `INSERT INTO dispatched_calls (
         call_id, channel_id, kind, tool_call_id, tool_name, params_json,
         pending_result_json, pending_is_error, abandoned_reason, resolving_token, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?)`,
      "call-1",
      "ch-1",
      "approval",
      "tool-1",
      "write",
      JSON.stringify({ path: "a.txt" }),
      Date.now(),
    );

    await instance.onCallResult("call-1", true, false);

    expect(sql.exec(`SELECT * FROM dispatched_calls WHERE call_id = ?`, "call-1").toArray()).toHaveLength(0);
    const message = JSON.parse(
      sql.exec(`SELECT content FROM pi_messages WHERE channel_id = ? AND idx = 0`, "ch-1").one()["content"] as string,
    );
    expect(message).toMatchObject({
      role: "toolResult",
      toolCallId: "tool-1",
      isError: true,
    });
    expect(message.content[0].text).toContain("boom on resume");
  });

  it("records dispatch results after interrupt without auto-continuing", async () => {
    const { instance, sql } = await createTestDO(TestWorker);
    await (instance as any).getOrCreateRunner("ch-1");
    const createdAt = Date.now();

    sql.exec(
      `INSERT INTO pi_messages (channel_id, idx, content) VALUES (?, ?, ?)`,
      "ch-1",
      0,
      JSON.stringify({
        role: "toolResult",
        toolCallId: "tool-1",
        toolName: "ask_user",
        content: [{ type: "text", text: "dispatched: ask-user" }],
        timestamp: 1,
        isError: false,
      }),
    );
    sql.exec(
      `INSERT INTO dispatched_calls (
         call_id, channel_id, kind, tool_call_id, tool_name, params_json,
         pending_result_json, pending_is_error, abandoned_reason, resolving_token, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?)`,
      "call-1",
      "ch-1",
      "ask-user",
      "tool-1",
      null,
      null,
      createdAt,
    );
    (instance as any).lastUserInterruptAt.set("ch-1", createdAt + 1);

    await instance.onCallResult("call-1", "tool completed", false);
    await flush();

    expect(sql.exec(`SELECT * FROM dispatched_calls WHERE call_id = ?`, "call-1").toArray()).toHaveLength(0);
    const message = JSON.parse(
      sql.exec(`SELECT content FROM pi_messages WHERE channel_id = ? AND idx = 0`, "ch-1").one()["content"] as string,
    );
    expect(message).toMatchObject({
      role: "toolResult",
      toolCallId: "tool-1",
      isError: false,
    });
    expect(message.content[0].text).toBe("tool completed");
    expect(instance.fakeState!.continueCount).toBe(0);
  });

  it("keeps superseded dispatch rows until the placeholder is persisted, then rewrites them", async () => {
    const { instance, sql } = await createTestDO(TestWorker);
    await (instance as any).getOrCreateRunner("ch-1");
    await (instance as any).recoverDispatchesForChannel("ch-1");

    sql.exec(
      `INSERT INTO dispatched_calls (
         call_id, channel_id, kind, tool_call_id, tool_name, params_json,
         pending_result_json, pending_is_error, abandoned_reason, resolving_token, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?)`,
      "call-1",
      "ch-1",
      "ask-user",
      "tool-1",
      null,
      null,
      Date.now(),
    );

    await instance.onChannelEvent("ch-1", userMessage("new message"));

    const pending = sql.exec(`SELECT abandoned_reason FROM dispatched_calls WHERE call_id = ?`, "call-1").toArray();
    expect(pending).toHaveLength(1);
    expect(pending[0]!["abandoned_reason"]).toBe("user-superseded");

    await (instance as any).saveMessages("ch-1", [{
      role: "toolResult",
      toolCallId: "tool-1",
      toolName: "ask_user",
      content: [{ type: "text", text: "dispatched: ask-user" }],
      timestamp: 1,
      isError: false,
    }]);
    await (instance as any).drainDeferredDispatchesFor("ch-1");

    expect(sql.exec(`SELECT * FROM dispatched_calls WHERE call_id = ?`, "call-1").toArray()).toHaveLength(0);
    const message = JSON.parse(
      sql.exec(`SELECT content FROM pi_messages WHERE channel_id = ? AND idx = 0`, "ch-1").one()["content"] as string,
    );
    expect(message).toMatchObject({
      role: "toolResult",
      toolCallId: "tool-1",
      isError: true,
    });
    expect(message.content[0].text).toBe("Dispatched call superseded by user message");
  });

  it("drops restart-orphaned dispatch rows whose placeholders were never persisted", async () => {
    const { instance, sql } = await createTestDO(TestWorker);

    sql.exec(
      `INSERT INTO dispatched_calls (
         call_id, channel_id, kind, tool_call_id, tool_name, params_json,
         pending_result_json, pending_is_error, abandoned_reason, resolving_token, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?)`,
      "call-1",
      "ch-1",
      "ask-user",
      "tool-1",
      null,
      null,
      Date.now(),
    );

    await (instance as any).recoverDispatchesForChannel("ch-1");

    expect(sql.exec(`SELECT * FROM dispatched_calls WHERE call_id = ?`, "call-1").toArray()).toHaveLength(0);
  });

  it("does not persist empty aborted assistant messages", async () => {
    const { instance, sql } = await createTestDO(TestWorker);

    await (instance as any).saveMessages("ch-1", [
      { role: "user", content: "hello", timestamp: 1 },
      {
        role: "assistant",
        content: [],
        stopReason: "aborted",
        errorMessage: "Request was aborted",
        timestamp: 2,
      },
    ]);

    const rows = sql.exec(`SELECT content FROM pi_messages WHERE channel_id = ? ORDER BY idx`, "ch-1").toArray();
    expect(rows.map((row) => JSON.parse(row["content"] as string))).toEqual([
      { role: "user", content: "hello", timestamp: 1 },
    ]);
  });

  it("resumes the failed user turn after a model credential is connected", async () => {
    const { instance, sql } = await createTestDO(TestWorker);

    await (instance as any).saveMessages("ch-1", [
      { role: "user", content: "hello", timestamp: 1 },
      {
        role: "assistant",
        content: [{ type: "text", text: "" }],
        stopReason: "error",
        errorMessage: "No URL-bound model credential is configured for model provider: openai-codex",
        timestamp: 2,
      },
    ]);

    await (instance as TestWorker).resumeAfterCredential("ch-1");
    await flush();

    expect(instance.fakeState!.continueCount).toBe(1);
    const rows = sql.exec(`SELECT content FROM pi_messages WHERE channel_id = ? ORDER BY idx`, "ch-1").toArray();
    expect(rows.map((row) => JSON.parse(row["content"] as string))).toEqual([
      { role: "user", content: "hello", timestamp: 1 },
    ]);
  });

  it("does not resume after unrelated assistant errors", async () => {
    const { instance } = await createTestDO(TestWorker);

    await (instance as any).saveMessages("ch-1", [
      { role: "user", content: "hello", timestamp: 1 },
      {
        role: "assistant",
        content: [{ type: "text", text: "" }],
        stopReason: "error",
        errorMessage: "unrelated failure",
        timestamp: 2,
      },
    ]);

    const resumed = await (instance as TestWorker).resumeAfterCredential("ch-1");
    await flush();

    expect(resumed).toBe(false);
    expect(instance.fakeState!.continueCount).toBe(0);
  });

  it("does not replay a user turn from a stale credential card", async () => {
    const { instance } = await createTestDO(TestWorker);

    await (instance as any).saveMessages("ch-1", [
      { role: "user", content: "hello", timestamp: 1 },
    ]);

    const resumed = await (instance as TestWorker).resumeAfterCredential("ch-1");
    await flush();

    expect(resumed).toBe(false);
    expect(instance.fakeState!.continueCount).toBe(0);
  });

  it("clears stale resolving tokens so buffered dispatch results can drain after restart", async () => {
    const { instance, sql } = await createTestDO(TestWorker);

    sql.exec(
      `INSERT INTO pi_messages (channel_id, idx, content) VALUES (?, ?, ?)`,
      "ch-1",
      0,
      JSON.stringify({
        role: "toolResult",
        toolCallId: "tool-1",
        toolName: "ask_user",
        content: [{ type: "text", text: "dispatched: ask-user" }],
        timestamp: 1,
        isError: false,
      }),
    );
    sql.exec(
      `INSERT INTO dispatched_calls (
         call_id, channel_id, kind, tool_call_id, tool_name, params_json,
         pending_result_json, pending_is_error, abandoned_reason, resolving_token, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
      "call-1",
      "ch-1",
      "ask-user",
      "tool-1",
      null,
      null,
      JSON.stringify({ value: "submitted" }),
      0,
      "stuck-token",
      Date.now(),
    );

    (instance as any).dispatches.clearResolvingTokens();
    await (instance as any).drainDeferredDispatchesFor("ch-1");
    await flush();

    expect(sql.exec(`SELECT * FROM dispatched_calls WHERE call_id = ?`, "call-1").toArray()).toHaveLength(0);
    const message = JSON.parse(
      sql.exec(`SELECT content FROM pi_messages WHERE channel_id = ? AND idx = 0`, "ch-1").one()["content"] as string,
    );
    expect(message).toMatchObject({
      role: "toolResult",
      toolCallId: "tool-1",
      isError: false,
    });
    expect(message.content[0].text).toBe("submitted");
    expect(instance.fakeState!.continueCount).toBe(1);
  });
});
