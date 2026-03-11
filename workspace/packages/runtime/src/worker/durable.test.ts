import { describe, it, expect, vi } from "vitest";
import type { ChannelEvent, HarnessOutput, WorkerActions, WorkerAction } from "@natstack/harness";
import { createTestDO } from "./durable-test-utils.js";
import { AgentWorkerBase } from "./durable.js";
import { ActionCollector } from "./action-collector.js";
import { StreamWriter, type PersistedStreamState } from "./stream-writer.js";

// --- Concrete test DO ---
class TestDO extends AgentWorkerBase {
  async onChannelEvent(channelId: string, event: ChannelEvent): Promise<WorkerActions> {
    const $ = this.actions();
    if (this.shouldProcess(event)) {
      const input = this.buildTurnInput(event);
      $.channel(channelId).send(input.content);
    }
    return $.result();
  }

  async onHarnessEvent(harnessId: string, event: HarnessOutput): Promise<WorkerActions> {
    const $ = this.actions();
    const turn = this.getActiveTurn(harnessId);
    if (turn && event.type === 'text-delta') {
      $.channel(turn.channelId).update('msg-1', event.content);
    }
    return $.result();
  }

  // Expose protected methods for testing
  public testGetContextId(channelId: string) { return this.getContextId(channelId); }
  public testSetActiveTurn(...args: Parameters<AgentWorkerBase["setActiveTurn"]>) { return this.setActiveTurn(...args); }
  public testGetActiveTurn(harnessId: string) { return this.getActiveTurn(harnessId); }
  public testClearActiveTurn(harnessId: string) { return this.clearActiveTurn(harnessId); }
  public testAdvanceCheckpoint(...args: Parameters<AgentWorkerBase["advanceCheckpoint"]>) { return this.advanceCheckpoint(...args); }
  public testGetCheckpoint(...args: Parameters<AgentWorkerBase["getCheckpoint"]>) { return this.getCheckpoint(...args); }
  public testGetHarnessForChannel(channelId: string) { return this.getHarnessForChannel(channelId); }
  public testGetChannelForHarness(harnessId: string) { return this.getChannelForHarness(harnessId); }
  public testRecordTurn(...args: Parameters<AgentWorkerBase["recordTurn"]>) { return this.recordTurn(...args); }
  public testGetTurnAtOrBefore(harnessId: string, pubsubId: number) { return this.getTurnAtOrBefore(harnessId, pubsubId); }
  public testGetLatestTurn(harnessId: string) { return this.getLatestTurn(harnessId); }
  public testGetAlignment(harnessId: string) { return this.getAlignment(harnessId); }
  public testGetInFlightTurn(channelId: string, harnessId: string) { return this.getInFlightTurn(channelId, harnessId); }
  public testGetSubscriptionConfig(channelId: string) { return this.getSubscriptionConfig(channelId); }
  public testPendingCall(...args: Parameters<AgentWorkerBase["pendingCall"]>) { return this.pendingCall(...args); }
  public testConsumePendingCall(callId: string) { return this.consumePendingCall(callId); }
  public testGetParticipantId(channelId: string) { return this.getParticipantId(channelId); }
}

// --- Schema version bump test DO ---
class TestDOv2 extends AgentWorkerBase {
  static override schemaVersion = 3;

  async onChannelEvent(_channelId: string, _event: ChannelEvent): Promise<WorkerActions> {
    return { actions: [] };
  }
  async onHarnessEvent(_harnessId: string, _event: HarnessOutput): Promise<WorkerActions> {
    return { actions: [] };
  }
}

const TABLES = ['state', 'subscriptions', 'harnesses', 'turn_map', 'checkpoints', 'in_flight_turns', 'active_turns', 'pending_calls'];

describe("AgentWorkerBase", () => {
  describe("schema initialization", () => {
    it("creates all 8 tables", async () => {
      const { sql } = await createTestDO(TestDO);
      const tables = sql.exec(
        `SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`
      ).toArray().map(r => r["name"] as string);

      for (const t of TABLES) {
        expect(tables).toContain(t);
      }
    });

    it("sets schema_version in state table", async () => {
      const { sql } = await createTestDO(TestDO);
      const row = sql.exec(`SELECT value FROM state WHERE key = 'schema_version'`).one();
      expect(row["value"]).toBe("2");
    });

    it("detects schema version bump", async () => {
      const { sql } = await createTestDO(TestDOv2);
      const row = sql.exec(`SELECT value FROM state WHERE key = 'schema_version'`).one();
      expect(row["value"]).toBe("3");
    });
  });

  describe("subscribeChannel", () => {
    it("returns correct ParticipantDescriptor", async () => {
      const { instance } = await createTestDO(TestDO);
      const desc = await instance.subscribeChannel({
        channelId: "ch-1",
        contextId: "ctx-1",
      });
      expect(desc).toEqual({
        handle: "agent",
        name: "AI Agent",
        type: "agent",
        metadata: {},
        methods: [],
      });
    });

    it("persists subscription to database", async () => {
      const { instance, sql } = await createTestDO(TestDO);
      await instance.subscribeChannel({
        channelId: "ch-1",
        contextId: "ctx-1",
        config: { model: "claude-4" },
      });
      const rows = sql.exec(`SELECT * FROM subscriptions WHERE channel_id = 'ch-1'`).toArray();
      expect(rows).toHaveLength(1);
      expect(rows[0]!["context_id"]).toBe("ctx-1");
      expect(JSON.parse(rows[0]!["config"] as string)).toEqual({ model: "claude-4" });
    });
  });

  describe("unsubscribeChannel", () => {
    it("cleans up all related state", async () => {
      const { instance, sql } = await createTestDO(TestDO);

      // Set up state
      await instance.subscribeChannel({ channelId: "ch-1", contextId: "ctx-1" });
      instance.registerHarness("h-1", "ch-1", "claude-sdk");
      instance.testSetActiveTurn("h-1", "ch-1", "reply-1");
      instance.testAdvanceCheckpoint("ch-1", "h-1", 42);
      instance.testRecordTurn("h-1", "msg-1", 10, "session-1");

      // Unsubscribe
      const result = await instance.unsubscribeChannel("ch-1");

      expect(result.harnessIds).toEqual(["h-1"]);
      expect(sql.exec(`SELECT * FROM subscriptions`).toArray()).toHaveLength(0);
      expect(sql.exec(`SELECT * FROM harnesses`).toArray()).toHaveLength(0);
      expect(sql.exec(`SELECT * FROM active_turns`).toArray()).toHaveLength(0);
      expect(sql.exec(`SELECT * FROM turn_map`).toArray()).toHaveLength(0);
      expect(sql.exec(`SELECT * FROM checkpoints`).toArray()).toHaveLength(0);
    });
  });

  describe("active turn tracking", () => {
    const emptyStreamState: PersistedStreamState = {
      responseMessageId: null,
      thinkingMessageId: null,
      actionMessageId: null,
      typingMessageId: null,
    };

    it("setActiveTurn/getActiveTurn round-trips", async () => {
      const { instance } = await createTestDO(TestDO);
      instance.testSetActiveTurn("h-1", "ch-1", "reply-1", "msg-1", "panel-1", "typing-json");
      const turn = instance.testGetActiveTurn("h-1");
      expect(turn).toEqual({
        channelId: "ch-1",
        replyToId: "reply-1",
        turnMessageId: "msg-1",
        senderParticipantId: "panel-1",
        typingContent: "typing-json",
        streamState: emptyStreamState,
      });
    });

    it("getActiveTurn returns null when no turn exists", async () => {
      const { instance } = await createTestDO(TestDO);
      expect(instance.testGetActiveTurn("nonexistent")).toBeNull();
    });

    it("clearActiveTurn removes the turn", async () => {
      const { instance } = await createTestDO(TestDO);
      instance.testSetActiveTurn("h-1", "ch-1", "reply-1");
      instance.testClearActiveTurn("h-1");
      expect(instance.testGetActiveTurn("h-1")).toBeNull();
    });

    it("turnMessageId defaults to null", async () => {
      const { instance } = await createTestDO(TestDO);
      instance.testSetActiveTurn("h-1", "ch-1", "reply-1");
      const turn = instance.testGetActiveTurn("h-1");
      expect(turn?.turnMessageId).toBeNull();
      expect(turn?.senderParticipantId).toBeNull();
      expect(turn?.typingContent).toBe("");
      expect(turn?.streamState).toEqual(emptyStreamState);
    });
  });

  describe("checkpoint tracking", () => {
    it("advanceCheckpoint/getCheckpoint round-trips with harnessId", async () => {
      const { instance } = await createTestDO(TestDO);
      instance.testAdvanceCheckpoint("ch-1", "h-1", 42);
      expect(instance.testGetCheckpoint("ch-1", "h-1")).toBe(42);
    });

    it("advanceCheckpoint/getCheckpoint with null harnessId", async () => {
      const { instance } = await createTestDO(TestDO);
      instance.testAdvanceCheckpoint("ch-1", null, 99);
      expect(instance.testGetCheckpoint("ch-1", null)).toBe(99);
    });

    it("getCheckpoint returns null when no checkpoint", async () => {
      const { instance } = await createTestDO(TestDO);
      expect(instance.testGetCheckpoint("ch-1", "h-1")).toBeNull();
    });

    it("advances checkpoint monotonically", async () => {
      const { instance } = await createTestDO(TestDO);
      instance.testAdvanceCheckpoint("ch-1", "h-1", 10);
      instance.testAdvanceCheckpoint("ch-1", "h-1", 20);
      expect(instance.testGetCheckpoint("ch-1", "h-1")).toBe(20);
    });
  });

  describe("harness registration", () => {
    it("registerHarness stores with 'starting' status", async () => {
      const { instance, sql } = await createTestDO(TestDO);
      instance.registerHarness("h-1", "ch-1", "claude-sdk");
      const row = sql.exec(`SELECT * FROM harnesses WHERE id = 'h-1'`).one();
      expect(row["status"]).toBe("starting");
      expect(row["type"]).toBe("claude-sdk");
      expect(row["channel_id"]).toBe("ch-1");
    });

    it("getHarnessForChannel finds active harnesses", async () => {
      const { instance, sql } = await createTestDO(TestDO);
      instance.registerHarness("h-1", "ch-1", "claude-sdk");
      // Status is 'starting', not 'active'
      expect(instance.testGetHarnessForChannel("ch-1")).toBeNull();

      // Manually activate
      sql.exec(`UPDATE harnesses SET status = 'active' WHERE id = 'h-1'`);
      expect(instance.testGetHarnessForChannel("ch-1")).toBe("h-1");
    });

    it("getChannelForHarness returns channel", async () => {
      const { instance } = await createTestDO(TestDO);
      instance.registerHarness("h-1", "ch-1", "claude-sdk");
      expect(instance.testGetChannelForHarness("h-1")).toBe("ch-1");
    });

    it("getChannelForHarness returns null for unknown harness", async () => {
      const { instance } = await createTestDO(TestDO);
      expect(instance.testGetChannelForHarness("nonexistent")).toBeNull();
    });
  });

  describe("turn recording", () => {
    it("recordTurn/getLatestTurn round-trips", async () => {
      const { instance } = await createTestDO(TestDO);
      instance.registerHarness("h-1", "ch-1", "claude-sdk");
      instance.testRecordTurn("h-1", "msg-1", 10, "session-abc");
      const latest = instance.testGetLatestTurn("h-1");
      expect(latest).toEqual({
        turnMessageId: "msg-1",
        externalSessionId: "session-abc",
      });
    });

    it("getTurnAtOrBefore finds correct turn", async () => {
      const { instance } = await createTestDO(TestDO);
      instance.registerHarness("h-1", "ch-1", "claude-sdk");
      instance.testRecordTurn("h-1", "msg-1", 10, "s1");
      instance.testRecordTurn("h-1", "msg-2", 20, "s2");
      instance.testRecordTurn("h-1", "msg-3", 30, "s3");

      const atOrBefore15 = instance.testGetTurnAtOrBefore("h-1", 15);
      expect(atOrBefore15?.turnMessageId).toBe("msg-1");

      const atOrBefore25 = instance.testGetTurnAtOrBefore("h-1", 25);
      expect(atOrBefore25?.turnMessageId).toBe("msg-2");

      const atOrBefore30 = instance.testGetTurnAtOrBefore("h-1", 30);
      expect(atOrBefore30?.turnMessageId).toBe("msg-3");
    });

    it("getTurnAtOrBefore returns null when no turns exist", async () => {
      const { instance } = await createTestDO(TestDO);
      expect(instance.testGetTurnAtOrBefore("h-1", 100)).toBeNull();
    });

    it("getLatestTurn returns null when no turns exist", async () => {
      const { instance } = await createTestDO(TestDO);
      expect(instance.testGetLatestTurn("h-1")).toBeNull();
    });

    it("recordTurn updates harness external_session_id", async () => {
      const { instance, sql } = await createTestDO(TestDO);
      instance.registerHarness("h-1", "ch-1", "claude-sdk");
      instance.testRecordTurn("h-1", "msg-1", 10, "session-xyz");
      const row = sql.exec(`SELECT external_session_id FROM harnesses WHERE id = 'h-1'`).one();
      expect(row["external_session_id"]).toBe("session-xyz");
    });
  });

  describe("recordTurnStart", () => {
    it("sets active turn, in-flight turn, and advances checkpoint", async () => {
      const { instance } = await createTestDO(TestDO);
      instance.registerHarness("h-1", "ch-1", "claude-sdk");
      const input = { content: "hello", senderId: "user-1" };
      instance.recordTurnStart("h-1", "ch-1", input, "trigger-msg", 42);

      const active = instance.testGetActiveTurn("h-1");
      expect(active?.replyToId).toBe("trigger-msg");

      const inFlight = instance.testGetInFlightTurn("ch-1", "h-1");
      expect(inFlight?.triggerPubsubId).toBe(42);
      expect(inFlight?.turnInput.content).toBe("hello");

      expect(instance.testGetCheckpoint("ch-1", "h-1")).toBe(42);
    });
  });

  describe("alignment", () => {
    it("returns null lastAlignedMessageId for new harness", async () => {
      const { instance } = await createTestDO(TestDO);
      instance.registerHarness("h-1", "ch-1", "claude-sdk");
      const alignment = instance.testGetAlignment("h-1");
      expect(alignment.lastAlignedMessageId).toBeNull();
    });
  });

  describe("context and config helpers", () => {
    it("getContextId retrieves context for subscribed channel", async () => {
      const { instance } = await createTestDO(TestDO);
      await instance.subscribeChannel({ channelId: "ch-1", contextId: "ctx-1" });
      expect(instance.testGetContextId("ch-1")).toBe("ctx-1");
    });

    it("getContextId throws for unsubscribed channel", async () => {
      const { instance } = await createTestDO(TestDO);
      expect(() => instance.testGetContextId("ch-none")).toThrow("No subscription for channel ch-none");
    });

    it("getSubscriptionConfig returns parsed config", async () => {
      const { instance } = await createTestDO(TestDO);
      await instance.subscribeChannel({
        channelId: "ch-1", contextId: "ctx-1",
        config: { model: "claude-4", temperature: 0.7 },
      });
      expect(instance.testGetSubscriptionConfig("ch-1")).toEqual({
        model: "claude-4",
        temperature: 0.7,
      });
    });

    it("getSubscriptionConfig returns null when no config", async () => {
      const { instance } = await createTestDO(TestDO);
      await instance.subscribeChannel({ channelId: "ch-1", contextId: "ctx-1" });
      expect(instance.testGetSubscriptionConfig("ch-1")).toBeNull();
    });
  });

  describe("getState", () => {
    it("returns all table contents", async () => {
      const { instance } = await createTestDO(TestDO);
      await instance.subscribeChannel({ channelId: "ch-1", contextId: "ctx-1" });
      instance.registerHarness("h-1", "ch-1", "claude-sdk");

      const state = await instance.getState();
      expect((state["subscriptions"] as unknown[]).length).toBe(1);
      expect((state["harnesses"] as unknown[]).length).toBe(1);
    });
  });

  describe("onMethodCall default", () => {
    it("returns error method-result action", async () => {
      const { instance } = await createTestDO(TestDO);
      const result = await instance.onMethodCall("ch-1", "call-1", "unknown", {});
      expect(result.actions).toHaveLength(1);
      const action = result.actions[0]! as Extract<WorkerAction, { op: 'method-result' }>;
      expect(action.op).toBe("method-result");
      expect(action.callId).toBe("call-1");
      expect(action.isError).toBe(true);
    });
  });

  describe("onOutgoingMethodCall default", () => {
    it("returns a pass-through call-method action", async () => {
      const { instance } = await createTestDO(TestDO);
      const result = await instance.onOutgoingMethodCall(
        "ch-1",
        "call-1",
        "participant-1",
        "getData",
        { key: "value" },
      );
      expect(result.actions).toHaveLength(1);
      const action = result.actions[0]! as Extract<WorkerAction, { op: "call-method" }>;
      expect(action.op).toBe("call-method");
      expect(action.callId).toBe("call-1");
      expect(action.participantId).toBe("participant-1");
      expect(action.method).toBe("getData");
      expect(action.args).toEqual({ key: "value" });
    });
  });

  describe("pending call continuations", () => {
    it("pendingCall/consumePendingCall round-trips", async () => {
      const { instance } = await createTestDO(TestDO);
      instance.testPendingCall("call-1", "ch-1", "approval", { harnessId: "h-1", toolUseId: "tu-1" });
      const pending = instance.testConsumePendingCall("call-1");
      expect(pending).toEqual({
        channelId: "ch-1",
        type: "approval",
        context: { harnessId: "h-1", toolUseId: "tu-1" },
      });
    });

    it("consumePendingCall deletes after consuming", async () => {
      const { instance } = await createTestDO(TestDO);
      instance.testPendingCall("call-1", "ch-1", "approval", { harnessId: "h-1" });
      instance.testConsumePendingCall("call-1");
      expect(instance.testConsumePendingCall("call-1")).toBeNull();
    });

    it("consumePendingCall returns null for unknown callId", async () => {
      const { instance } = await createTestDO(TestDO);
      expect(instance.testConsumePendingCall("nonexistent")).toBeNull();
    });

    it("onCallResult consumes pending and calls handleCallResult", async () => {
      const { instance } = await createTestDO(TestDO);
      instance.testPendingCall("call-1", "ch-1", "test-type", { key: "val" });
      const result = await instance.onCallResult("call-1", { allow: true }, false);
      // Base class handleCallResult returns empty actions
      expect(result.actions).toHaveLength(0);
      // Should be consumed
      expect(instance.testConsumePendingCall("call-1")).toBeNull();
    });

    it("onCallResult returns empty for unknown callId", async () => {
      const { instance } = await createTestDO(TestDO);
      const result = await instance.onCallResult("nonexistent", {}, false);
      expect(result.actions).toHaveLength(0);
    });
  });

  describe("participant ID", () => {
    it("setParticipantId/getParticipantId round-trips", async () => {
      const { instance } = await createTestDO(TestDO);
      await instance.subscribeChannel({ channelId: "ch-1", contextId: "ctx-1" });
      await instance.setParticipantId("ch-1", "do:AiChat:default:ch-1");
      expect(instance.testGetParticipantId("ch-1")).toBe("do:AiChat:default:ch-1");
    });

    it("getParticipantId returns null when not set", async () => {
      const { instance } = await createTestDO(TestDO);
      await instance.subscribeChannel({ channelId: "ch-1", contextId: "ctx-1" });
      expect(instance.testGetParticipantId("ch-1")).toBeNull();
    });
  });
});

describe("ActionCollector", () => {
  const mockOwner = {
    persistStreamState: vi.fn(),
  };

  it("channel().send() produces correct action", () => {
    const $ = new ActionCollector(mockOwner);
    $.channel("ch-1").send("hello", { type: "message" });
    const result = $.result();
    expect(result.actions).toHaveLength(1);
    const action = result.actions[0]! as Extract<WorkerAction, { op: 'send' }>;
    expect(action.target).toBe("channel");
    expect(action.channelId).toBe("ch-1");
    expect(action.op).toBe("send");
    expect(action.content).toBe("hello");
    expect(action.messageId).toBeTruthy();
  });

  it("channel().update() produces correct action", () => {
    const $ = new ActionCollector(mockOwner);
    $.channel("ch-1").update("msg-1", "updated content");
    const result = $.result();
    const action = result.actions[0]! as Extract<WorkerAction, { op: 'update' }>;
    expect(action.op).toBe("update");
    expect(action.messageId).toBe("msg-1");
    expect(action.content).toBe("updated content");
  });

  it("channel().complete() produces correct action", () => {
    const $ = new ActionCollector(mockOwner);
    $.channel("ch-1").complete("msg-1");
    const result = $.result();
    const action = result.actions[0]! as Extract<WorkerAction, { op: 'complete' }>;
    expect(action.op).toBe("complete");
    expect(action.messageId).toBe("msg-1");
  });

  it("channel().methodResult() produces correct action", () => {
    const $ = new ActionCollector(mockOwner);
    $.channel("ch-1").methodResult("call-1", { data: 42 }, false);
    const result = $.result();
    const action = result.actions[0]! as Extract<WorkerAction, { op: 'method-result' }>;
    expect(action.op).toBe("method-result");
    expect(action.callId).toBe("call-1");
    expect(action.content).toEqual({ data: 42 });
  });

  it("channel().updateMetadata() produces correct action", () => {
    const $ = new ActionCollector(mockOwner);
    $.channel("ch-1").updateMetadata({ status: "thinking" });
    const result = $.result();
    const action = result.actions[0]! as Extract<WorkerAction, { op: 'update-metadata' }>;
    expect(action.op).toBe("update-metadata");
    expect(action.metadata).toEqual({ status: "thinking" });
  });

  it("channel().sendEphemeral() produces correct action", () => {
    const $ = new ActionCollector(mockOwner);
    $.channel("ch-1").sendEphemeral("typing...", "typing");
    const result = $.result();
    const action = result.actions[0]! as Extract<WorkerAction, { op: 'send-ephemeral' }>;
    expect(action.op).toBe("send-ephemeral");
    expect(action.content).toBe("typing...");
    expect(action.contentType).toBe("typing");
  });

  it("channel().callMethod() produces correct action", () => {
    const $ = new ActionCollector(mockOwner);
    $.channel("ch-1").callMethod("call-1", "participant-1", "getData", { key: "value" });
    const result = $.result();
    const action = result.actions[0]! as Extract<WorkerAction, { op: 'call-method' }>;
    expect(action.op).toBe("call-method");
    expect(action.callId).toBe("call-1");
    expect(action.participantId).toBe("participant-1");
    expect(action.method).toBe("getData");
  });

  it("harness().startTurn() produces correct action", () => {
    const $ = new ActionCollector(mockOwner);
    const input = { content: "hello", senderId: "user-1" };
    $.harness("h-1").startTurn(input);
    const result = $.result();
    const action = result.actions[0]! as Extract<WorkerAction, { target: 'harness' }>;
    expect(action.target).toBe("harness");
    expect(action.harnessId).toBe("h-1");
    expect(action.command.type).toBe("start-turn");
  });

  it("harness().approveTool() produces correct action", () => {
    const $ = new ActionCollector(mockOwner);
    $.harness("h-1").approveTool("tool-1", true, true);
    const result = $.result();
    const action = result.actions[0]! as Extract<WorkerAction, { target: 'harness' }>;
    expect(action.command).toEqual({ type: "approve-tool", toolUseId: "tool-1", allow: true, alwaysAllow: true });
  });

  it("harness().interrupt() produces correct action", () => {
    const $ = new ActionCollector(mockOwner);
    $.harness("h-1").interrupt();
    const result = $.result();
    const action = result.actions[0]! as Extract<WorkerAction, { target: 'harness' }>;
    expect(action.command).toEqual({ type: "interrupt" });
  });

  it("harness().fork() produces correct action", () => {
    const $ = new ActionCollector(mockOwner);
    $.harness("h-1").fork(5, "session-1");
    const result = $.result();
    const action = result.actions[0]! as Extract<WorkerAction, { target: 'harness' }>;
    expect(action.command).toEqual({ type: "fork", forkPointMessageId: 5, turnSessionId: "session-1" });
  });

  it("harness().dispose() produces correct action", () => {
    const $ = new ActionCollector(mockOwner);
    $.harness("h-1").dispose();
    const result = $.result();
    const action = result.actions[0]! as Extract<WorkerAction, { target: 'harness' }>;
    expect(action.command).toEqual({ type: "dispose" });
  });

  it("spawnHarness() produces correct action", () => {
    const $ = new ActionCollector(mockOwner);
    $.spawnHarness({ type: "claude-sdk", channelId: "ch-1", contextId: "ctx-1" });
    const result = $.result();
    const action = result.actions[0]! as Extract<WorkerAction, { op: 'spawn-harness' }>;
    expect(action.target).toBe("system");
    expect(action.op).toBe("spawn-harness");
    expect(action.type).toBe("claude-sdk");
  });

  it("respawnHarness() produces correct action", () => {
    const $ = new ActionCollector(mockOwner);
    $.respawnHarness({ harnessId: "h-1", channelId: "ch-1", contextId: "ctx-1", resumeSessionId: "s-1" });
    const result = $.result();
    const action = result.actions[0]! as Extract<WorkerAction, { op: 'respawn-harness' }>;
    expect(action.op).toBe("respawn-harness");
    expect(action.harnessId).toBe("h-1");
    expect(action.resumeSessionId).toBe("s-1");
  });

  it("forkChannel() produces correct action", () => {
    const $ = new ActionCollector(mockOwner);
    $.forkChannel("ch-source", 42);
    const result = $.result();
    const action = result.actions[0]! as Extract<WorkerAction, { op: 'fork-channel' }>;
    expect(action.op).toBe("fork-channel");
    expect(action.sourceChannel).toBe("ch-source");
    expect(action.forkPointId).toBe(42);
  });

  it("setAlarm() produces correct action", () => {
    const $ = new ActionCollector(mockOwner);
    $.setAlarm(5000);
    const result = $.result();
    const action = result.actions[0]! as Extract<WorkerAction, { op: 'set-alarm' }>;
    expect(action.op).toBe("set-alarm");
    expect(action.delayMs).toBe(5000);
  });

  it("fluent chaining accumulates actions", () => {
    const $ = new ActionCollector(mockOwner);
    $.channel("ch-1").send("hello").send("world");
    $.harness("h-1").startTurn({ content: "go", senderId: "u-1" });
    $.setAlarm(5000);
    const result = $.result();
    expect(result.actions).toHaveLength(4);
  });
});

describe("StreamWriter", () => {
  const emptyState: PersistedStreamState = {
    responseMessageId: null,
    thinkingMessageId: null,
    actionMessageId: null,
    typingMessageId: null,
  };

  it("startText creates send action with new messageId", () => {
    const actions: WorkerAction[] = [];
    const writer = new StreamWriter("ch-1", "reply-1", "", emptyState, actions);
    writer.startText();
    expect(actions).toHaveLength(1);
    const action = actions[0]! as Extract<WorkerAction, { op: 'send' }>;
    expect(action.op).toBe("send");
    expect(action.messageId).toBeTruthy();
    expect(action.options?.persist).toBe(true);
    expect(action.options?.replyTo).toBe("reply-1");
  });

  it("updateText appends update action", () => {
    const actions: WorkerAction[] = [];
    const writer = new StreamWriter("ch-1", "reply-1", "", emptyState, actions);
    writer.startText();
    writer.updateText("chunk 1");
    expect(actions).toHaveLength(2);
    const action = actions[1]! as Extract<WorkerAction, { op: 'update' }>;
    expect(action.op).toBe("update");
    expect(action.content).toBe("chunk 1");
  });

  it("completeText appends complete action and clears responseMessageId", () => {
    const actions: WorkerAction[] = [];
    const writer = new StreamWriter("ch-1", "reply-1", "", emptyState, actions);
    writer.startText();
    writer.completeText();
    expect(actions).toHaveLength(2);
    expect(writer.getState().responseMessageId).toBeNull();
  });

  it("updateText is no-op when no active message", () => {
    const actions: WorkerAction[] = [];
    const writer = new StreamWriter("ch-1", "reply-1", "", emptyState, actions);
    writer.updateText("ignored");
    expect(actions).toHaveLength(0);
  });

  it("thinking lifecycle: start -> update -> end", () => {
    const actions: WorkerAction[] = [];
    const writer = new StreamWriter("ch-1", "reply-1", "", emptyState, actions);
    writer.startThinking();
    writer.updateThinking("hmm...");
    writer.endThinking();
    expect(actions).toHaveLength(3);
    const send = actions[0]! as Extract<WorkerAction, { op: 'send' }>;
    expect(send.options?.type).toBe("thinking");
    const update = actions[1]! as Extract<WorkerAction, { op: 'update' }>;
    expect(update.content).toBe("hmm...");
    const complete = actions[2]! as Extract<WorkerAction, { op: 'complete' }>;
    expect(complete.op).toBe("complete");
    expect(writer.getState().thinkingMessageId).toBeNull();
  });

  it("startAction/endAction lifecycle", () => {
    const actions: WorkerAction[] = [];
    const writer = new StreamWriter("ch-1", "reply-1", "", emptyState, actions);
    writer.startAction("search", "Searching files");
    writer.endAction();
    expect(actions).toHaveLength(2);
    const send = actions[0]! as Extract<WorkerAction, { op: 'send' }>;
    expect(send.options?.type).toBe("action");
    expect(JSON.parse(send.content)).toEqual({ type: "search", description: "Searching files", status: "pending" });
    expect(writer.getState().actionMessageId).toBeNull();
  });

  it("sendInlineUi creates standalone send action", () => {
    const actions: WorkerAction[] = [];
    const writer = new StreamWriter("ch-1", "reply-1", "", emptyState, actions);
    writer.sendInlineUi({ component: "chart", data: [1, 2, 3] });
    expect(actions).toHaveLength(1);
    const action = actions[0]! as Extract<WorkerAction, { op: 'send' }>;
    expect(action.options?.type).toBe("inline_ui");
    expect(JSON.parse(action.content)).toEqual({ component: "chart", data: [1, 2, 3] });
  });

  it("startTyping/stopTyping lifecycle", () => {
    const actions: WorkerAction[] = [];
    const writer = new StreamWriter("ch-1", "reply-1", '{"typing":true}', emptyState, actions);
    writer.startTyping();
    expect(actions).toHaveLength(1);
    const send = actions[0]! as Extract<WorkerAction, { op: 'send' }>;
    expect(send.options?.type).toBe("typing");
    expect(send.options?.persist).toBe(false);
    expect(send.content).toBe('{"typing":true}');
    expect(writer.getState().typingMessageId).toBeTruthy();

    writer.stopTyping();
    expect(actions).toHaveLength(2);
    expect(actions[1]!).toMatchObject({ op: "complete" });
    expect(writer.getState().typingMessageId).toBeNull();
  });

  it("startThinking auto-stops typing", () => {
    const actions: WorkerAction[] = [];
    const writer = new StreamWriter("ch-1", "reply-1", '{"typing":true}', emptyState, actions);
    writer.startTyping();
    writer.startThinking();
    // typing send, typing complete, thinking send
    expect(actions).toHaveLength(3);
    expect(writer.getState().typingMessageId).toBeNull();
    expect(writer.getState().thinkingMessageId).toBeTruthy();
  });

  it("restores stream state from persisted state", () => {
    const actions: WorkerAction[] = [];
    const restoredState: PersistedStreamState = {
      responseMessageId: "existing-msg",
      thinkingMessageId: null,
      actionMessageId: null,
      typingMessageId: null,
    };
    const writer = new StreamWriter("ch-1", "reply-1", "", restoredState, actions);
    expect(writer.getState().responseMessageId).toBe("existing-msg");
    writer.updateText("continued");
    expect(actions).toHaveLength(1);
    const action = actions[0]! as Extract<WorkerAction, { op: 'update' }>;
    expect(action.messageId).toBe("existing-msg");
  });

  it("startText with metadata includes it in options", () => {
    const actions: WorkerAction[] = [];
    const writer = new StreamWriter("ch-1", "reply-1", "", emptyState, actions);
    writer.startText({ model: "claude-4" });
    const action = actions[0]! as Extract<WorkerAction, { op: 'send' }>;
    expect(action.options?.metadata).toEqual({ model: "claude-4" });
  });

  it("independent thinking and response tracking", () => {
    const actions: WorkerAction[] = [];
    const writer = new StreamWriter("ch-1", "reply-1", "", emptyState, actions);

    // Start thinking, then start text — both get independent IDs
    writer.startThinking();
    writer.updateThinking("hmm");
    writer.endThinking();
    writer.startText();
    writer.updateText("Hello");

    const state = writer.getState();
    expect(state.thinkingMessageId).toBeNull(); // ended
    expect(state.responseMessageId).toBeTruthy(); // active
  });

  describe("auto-persistence via ActionCollector", () => {
    it("persistStreamState updates active turn stream state and messageId", async () => {
      const { instance } = await createTestDO(TestDO);
      instance.testSetActiveTurn("h-1", "ch-1", "reply-1");

      const $ = instance["actions"]();
      const ch = $.channel("ch-1");
      const turn = instance.testGetActiveTurn("h-1")!;
      const writer = ch.streamFor("h-1", turn);
      writer.startText();
      const newMsgId = writer.getState().responseMessageId;

      $.result(); // triggers persistStreamState

      const updatedTurn = instance.testGetActiveTurn("h-1");
      expect(updatedTurn?.turnMessageId).toBe(newMsgId);
      expect(updatedTurn?.streamState.responseMessageId).toBe(newMsgId);
    });

    it("does not update turn_message_id when no response started", async () => {
      const { instance } = await createTestDO(TestDO);
      instance.testSetActiveTurn("h-1", "ch-1", "reply-1", "existing-msg");

      const $ = instance["actions"]();
      const ch = $.channel("ch-1");
      const turn = instance.testGetActiveTurn("h-1")!;
      // Only start thinking, no text — turn_message_id preserved
      const writer = ch.streamFor("h-1", turn);
      writer.startThinking();

      $.result();

      const updatedTurn = instance.testGetActiveTurn("h-1");
      expect(updatedTurn?.turnMessageId).toBe("existing-msg");
      expect(updatedTurn?.streamState.thinkingMessageId).toBeTruthy();
    });
  });
});
