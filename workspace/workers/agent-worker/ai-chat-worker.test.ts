import { describe, it, expect } from "vitest";
import type {
  ChannelEvent,
  HarnessOutput,
  WorkerAction,
} from "@natstack/harness";
import { createTestDO } from "@workspace/runtime/worker/test-utils";
import { AiChatWorker } from "./ai-chat-worker.js";

// --- Helpers ---

function makeEvent(overrides: Partial<ChannelEvent> = {}): ChannelEvent {
  return {
    id: 1,
    messageId: "msg-1",
    type: "message",
    payload: { content: "Hello" },
    senderId: "user-1",
    senderType: "panel",
    ts: Date.now(),
    persist: true,
    ...overrides,
  };
}

function findAction<T extends WorkerAction>(
  actions: WorkerAction[],
  predicate: (a: WorkerAction) => boolean,
): T | undefined {
  return actions.find(predicate) as T | undefined;
}

async function setupWithHarness() {
  const { instance, sql } = await createTestDO(AiChatWorker);
  instance.subscribeChannel({
    channelId: "ch-1",
    contextId: "ctx-1",
  });
  // Register and activate a harness
  instance.registerHarness("h-1", "ch-1", "claude-sdk");
  sql.exec(`UPDATE harnesses SET status = 'active' WHERE id = 'h-1'`);
  return { instance, sql };
}

describe("AiChatWorker", () => {
  describe("getParticipantInfo", () => {
    it("returns correct descriptor with pause/resume methods", async () => {
      const { instance } = await createTestDO(AiChatWorker);
      const desc = await instance.subscribeChannel({
        channelId: "ch-1",
        contextId: "ctx-1",
      });
      expect(desc.handle).toBe("ai-chat");
      expect(desc.name).toBe("AI Chat");
      expect(desc.type).toBe("agent");
      expect(desc.methods).toHaveLength(2);
      expect(desc.methods![0]!.name).toBe("pause");
      expect(desc.methods![1]!.name).toBe("resume");
    });
  });

  describe("onChannelEvent — first message (no harness)", () => {
    it("spawns harness with initialTurn and typing indicator", async () => {
      const { instance, sql } = await createTestDO(AiChatWorker);
      await instance.subscribeChannel({
        channelId: "ch-1",
        contextId: "ctx-1",
      });

      const event = makeEvent({ id: 10 });
      const result = await instance.onChannelEvent("ch-1", event);

      // Should emit tracked typing indicator during bootstrap (with known ID for cleanup)
      const typing = findAction<
        Extract<WorkerAction, { op: "send" }>
      >(result.actions, (a) => "op" in a && a.op === "send" && a.options?.type === "typing");
      expect(typing).toBeDefined();
      expect(typing!.options?.type).toBe("typing");
      expect(typing!.options?.persist).toBe(false);
      const typingData = JSON.parse(typing!.content);
      expect(typingData.senderName).toBe("AI Chat");

      // Bootstrap typing ID should be stored in state table for adoption by recordTurnStart
      const bootstrapRow = sql.exec(`SELECT value FROM state WHERE key = 'bootstrap_typing:ch-1'`).toArray();
      expect(bootstrapRow).toHaveLength(1);
      expect(bootstrapRow[0]!["value"]).toBe(typing!.messageId);

      const spawn = findAction<
        Extract<WorkerAction, { op: "spawn-harness" }>
      >(result.actions, (a) => "op" in a && a.op === "spawn-harness");

      expect(spawn).toBeDefined();
      expect(spawn!.type).toBe("claude-sdk");
      expect(spawn!.channelId).toBe("ch-1");
      expect(spawn!.contextId).toBe("ctx-1");
      expect(spawn!.initialTurn).toBeDefined();
      expect(spawn!.initialTurn!.input.content).toBe("Hello");
      expect(spawn!.initialTurn!.triggerMessageId).toBe("msg-1");
      expect(spawn!.initialTurn!.triggerPubsubId).toBe(10);
    });
  });

  describe("onChannelEvent — second message (active harness)", () => {
    it("starts turn + typing indicator", async () => {
      const { instance } = await setupWithHarness();

      const event = makeEvent({ id: 20, messageId: "msg-2" });
      const result = await instance.onChannelEvent("ch-1", event);

      // Should have harness start-turn action
      const startTurn = findAction<
        Extract<WorkerAction, { target: "harness" }>
      >(result.actions, (a) => a.target === "harness" && a.command.type === "start-turn");
      expect(startTurn).toBeDefined();
      expect(startTurn!.harnessId).toBe("h-1");

      // Should have StreamWriter-tracked typing indicator (managed lifecycle)
      const typing = findAction<
        Extract<WorkerAction, { op: "send" }>
      >(result.actions, (a) => "op" in a && a.op === "send" && a.options?.type === "typing");
      expect(typing).toBeDefined();
      expect(typing!.options?.type).toBe("typing");
      expect(typing!.options?.persist).toBe(false);
      const typingData = JSON.parse(typing!.content);
      expect(typingData.senderName).toBe("AI Chat");
    });

    it("records active turn and in-flight turn in SQLite", async () => {
      const { instance, sql } = await setupWithHarness();

      const event = makeEvent({ id: 20, messageId: "msg-2" });
      await instance.onChannelEvent("ch-1", event);

      const activeTurns = sql
        .exec(`SELECT * FROM active_turns WHERE harness_id = 'h-1'`)
        .toArray();
      expect(activeTurns).toHaveLength(1);
      expect(activeTurns[0]!["reply_to_id"]).toBe("msg-2");

      const inFlight = sql
        .exec(
          `SELECT * FROM in_flight_turns WHERE channel_id = 'ch-1' AND harness_id = 'h-1'`,
        )
        .toArray();
      expect(inFlight).toHaveLength(1);
      expect(inFlight[0]!["trigger_pubsub_id"]).toBe(20);
    });
  });

  describe("onChannelEvent — filtered events", () => {
    it("advances checkpoint for non-matching events", async () => {
      const { instance, sql } = await setupWithHarness();

      // Agent-sent event should be filtered
      const event = makeEvent({
        id: 30,
        senderType: "agent",
        messageId: "msg-agent",
      });
      const result = await instance.onChannelEvent("ch-1", event);

      // No spawn or start-turn actions
      expect(result.actions).toHaveLength(0);

      // Checkpoint should advance
      const cp = sql
        .exec(
          `SELECT last_pubsub_id FROM checkpoints WHERE channel_id = 'ch-1' AND harness_id IS NULL`,
        )
        .toArray();
      expect(cp).toHaveLength(1);
      expect(cp[0]!["last_pubsub_id"]).toBe(30);
    });

    it("filters messages with contentType (typing, approval responses, etc.)", async () => {
      const { instance, sql } = await setupWithHarness();

      // A panel message with contentType should NOT trigger a turn
      const event = makeEvent({
        id: 32,
        contentType: "some-protocol-message",
        senderType: "panel",
      });
      const result = await instance.onChannelEvent("ch-1", event);

      // No spawn or start-turn actions — filtered by shouldProcess
      expect(result.actions).toHaveLength(0);
    });

    it("advances checkpoint for non-message type events", async () => {
      const { instance, sql } = await setupWithHarness();

      const event = makeEvent({
        id: 31,
        type: "presence",
        senderType: "panel",
      });
      await instance.onChannelEvent("ch-1", event);

      const cp = sql
        .exec(
          `SELECT last_pubsub_id FROM checkpoints WHERE channel_id = 'ch-1' AND harness_id IS NULL`,
        )
        .toArray();
      expect(cp[0]!["last_pubsub_id"]).toBe(31);
    });
  });

  describe("onHarnessEvent — approval-needed (continuation-based)", () => {
    it("stores continuation and emits call-method action", async () => {
      const { instance, sql } = await setupWithHarness();

      // Set up active turn with sender participant ID
      sql.exec(
        `INSERT INTO active_turns (harness_id, channel_id, reply_to_id, turn_message_id, sender_participant_id, started_at) VALUES ('h-1', 'ch-1', 'msg-1', NULL, 'panel-user-1', ?)`,
        Date.now(),
      );

      const event: HarnessOutput = {
        type: "approval-needed",
        toolUseId: "tool-1",
        toolName: "shell",
        input: { command: "rm -rf /" },
      };
      const result = await instance.onHarnessEvent("h-1", event);

      // Should emit call-method to panel via PubSub RPC
      const callMethod = findAction<
        Extract<WorkerAction, { op: "call-method" }>
      >(result.actions, (a) => "op" in a && a.op === "call-method");
      expect(callMethod).toBeDefined();
      expect(callMethod!.participantId).toBe("panel-user-1");
      expect(callMethod!.method).toBe("request_tool_approval");
      expect(callMethod!.callId).toBeTruthy();

      const args = callMethod!.args as Record<string, unknown>;
      expect(args["agentName"]).toBe("AI Chat");
      expect(args["toolName"]).toBe("shell");
      expect(args["toolArgs"]).toEqual({ command: "rm -rf /" });

      // Should have stored a pending call continuation
      const pending = sql.exec(`SELECT * FROM pending_calls`).toArray();
      expect(pending).toHaveLength(1);
      expect(pending[0]!["call_type"]).toBe("approval");
      const ctx = JSON.parse(pending[0]!["context"] as string);
      expect(ctx.harnessId).toBe("h-1");
      expect(ctx.toolUseId).toBe("tool-1");
    });

    it("denies when no sender participant ID available", async () => {
      const { instance, sql } = await setupWithHarness();

      // Active turn WITHOUT sender_participant_id
      sql.exec(
        `INSERT INTO active_turns (harness_id, channel_id, reply_to_id, turn_message_id, started_at) VALUES ('h-1', 'ch-1', 'msg-1', NULL, ?)`,
        Date.now(),
      );

      const event: HarnessOutput = {
        type: "approval-needed",
        toolUseId: "tool-1",
        toolName: "shell",
        input: {},
      };
      const result = await instance.onHarnessEvent("h-1", event);

      // Should deny directly via approve-tool command
      const approve = findAction<
        Extract<WorkerAction, { target: "harness" }>
      >(result.actions, (a) => a.target === "harness" && a.command.type === "approve-tool");
      expect(approve).toBeDefined();
      const cmd = approve!.command as { type: "approve-tool"; toolUseId: string; allow: boolean };
      expect(cmd.toolUseId).toBe("tool-1");
      expect(cmd.allow).toBe(false);

      // No pending call should be stored
      const pending = sql.exec(`SELECT * FROM pending_calls`).toArray();
      expect(pending).toHaveLength(0);
    });
  });

  describe("onCallResult — approval continuation", () => {
    it("forwards allow=true to harness", async () => {
      const { instance, sql } = await setupWithHarness();

      // Store a pending approval continuation
      sql.exec(
        `INSERT INTO pending_calls (call_id, channel_id, call_type, context, created_at) VALUES ('call-1', 'ch-1', 'approval', '{"harnessId":"h-1","toolUseId":"tool-1"}', ?)`,
        Date.now(),
      );

      const result = await instance.onCallResult(
        "call-1",
        { allow: true, alwaysAllow: false },
        false,
      );

      const approve = findAction<
        Extract<WorkerAction, { target: "harness" }>
      >(result.actions, (a) => a.target === "harness" && a.command.type === "approve-tool");
      expect(approve).toBeDefined();
      expect(approve!.harnessId).toBe("h-1");
      const cmd = approve!.command as { type: "approve-tool"; toolUseId: string; allow: boolean };
      expect(cmd.toolUseId).toBe("tool-1");
      expect(cmd.allow).toBe(true);

      // Pending call should be consumed
      const pending = sql.exec(`SELECT * FROM pending_calls`).toArray();
      expect(pending).toHaveLength(0);
    });

    it("forwards allow=false on error", async () => {
      const { instance, sql } = await setupWithHarness();

      sql.exec(
        `INSERT INTO pending_calls (call_id, channel_id, call_type, context, created_at) VALUES ('call-1', 'ch-1', 'approval', '{"harnessId":"h-1","toolUseId":"tool-1"}', ?)`,
        Date.now(),
      );

      const result = await instance.onCallResult("call-1", "timeout", true);

      const approve = findAction<
        Extract<WorkerAction, { target: "harness" }>
      >(result.actions, (a) => a.target === "harness" && a.command.type === "approve-tool");
      expect(approve).toBeDefined();
      const cmd = approve!.command as { type: "approve-tool"; allow: boolean };
      expect(cmd.allow).toBe(false);
    });

    it("returns empty actions for unknown callId", async () => {
      const { instance } = await setupWithHarness();
      const result = await instance.onCallResult("nonexistent", {}, false);
      expect(result.actions).toHaveLength(0);
    });
  });

  describe("onHarnessEvent — text-delta", () => {
    it("produces channel update action via StreamWriter", async () => {
      const { instance, sql } = await setupWithHarness();

      // Set up active turn
      sql.exec(
        `INSERT INTO active_turns (harness_id, channel_id, reply_to_id, turn_message_id, started_at) VALUES ('h-1', 'ch-1', 'msg-1', 'stream-msg', ?)`,
        Date.now(),
      );

      const event: HarnessOutput = { type: "text-delta", content: "Hello world" };
      const result = await instance.onHarnessEvent("h-1", event);

      const update = findAction<
        Extract<WorkerAction, { op: "update" }>
      >(result.actions, (a) => "op" in a && a.op === "update");
      expect(update).toBeDefined();
      expect(update!.content).toBe("Hello world");
      expect(update!.messageId).toBe("stream-msg");
    });
  });

  describe("onHarnessEvent — text-start", () => {
    it("produces channel send action with replyTo", async () => {
      const { instance, sql } = await setupWithHarness();

      const streamState = JSON.stringify({ responseMessageId: null, thinkingMessageId: null, actionMessageId: null, typingMessageId: null });
      sql.exec(
        `INSERT INTO active_turns (harness_id, channel_id, reply_to_id, turn_message_id, stream_state, typing_content, started_at) VALUES ('h-1', 'ch-1', 'msg-1', NULL, ?, '', ?)`,
        streamState,
        Date.now(),
      );

      const event: HarnessOutput = { type: "text-start" };
      const result = await instance.onHarnessEvent("h-1", event);

      const send = findAction<
        Extract<WorkerAction, { op: "send" }>
      >(result.actions, (a) => "op" in a && a.op === "send");
      expect(send).toBeDefined();
      expect(send!.options?.persist).toBe(true);
      expect(send!.options?.replyTo).toBe("msg-1");
    });
  });

  describe("onHarnessEvent — turn-complete", () => {
    it("records turn and clears state", async () => {
      const { instance, sql } = await setupWithHarness();

      // Set up active turn and in-flight turn
      sql.exec(
        `INSERT INTO active_turns (harness_id, channel_id, reply_to_id, turn_message_id, started_at) VALUES ('h-1', 'ch-1', 'msg-1', 'resp-1', ?)`,
        Date.now(),
      );
      sql.exec(
        `INSERT INTO in_flight_turns (channel_id, harness_id, trigger_message_id, trigger_pubsub_id, turn_input, started_at) VALUES ('ch-1', 'h-1', 'msg-1', 10, '{"content":"hello","senderId":"user-1"}', ?)`,
        Date.now(),
      );

      const event: HarnessOutput = {
        type: "turn-complete",
        sessionId: "session-abc",
      };
      const result = await instance.onHarnessEvent("h-1", event);

      // Turn should be recorded
      const turns = sql
        .exec(`SELECT * FROM turn_map WHERE harness_id = 'h-1'`)
        .toArray();
      expect(turns).toHaveLength(1);
      expect(turns[0]!["turn_message_id"]).toBe("resp-1");
      expect(turns[0]!["external_session_id"]).toBe("session-abc");

      // Active turn should be cleared
      const active = sql
        .exec(`SELECT * FROM active_turns WHERE harness_id = 'h-1'`)
        .toArray();
      expect(active).toHaveLength(0);

      // In-flight turn should be cleared
      const inFlight = sql
        .exec(
          `SELECT * FROM in_flight_turns WHERE channel_id = 'ch-1' AND harness_id = 'h-1'`,
        )
        .toArray();
      expect(inFlight).toHaveLength(0);

      // turn-complete finalizes any outstanding streams as a safety net
      // (the resp-1 response message gets completed)
      const complete = findAction<
        Extract<WorkerAction, { op: "complete" }>
      >(result.actions, (a) => "op" in a && a.op === "complete");
      expect(complete).toBeDefined();
      expect(complete!.messageId).toBe("resp-1");
    });
  });

  describe("onHarnessEvent — error", () => {
    it("produces respawn-harness action with retryTurn", async () => {
      const { instance, sql } = await setupWithHarness();

      // Set up active turn with partial stream and in-flight turn
      sql.exec(
        `INSERT INTO active_turns (harness_id, channel_id, reply_to_id, turn_message_id, started_at) VALUES ('h-1', 'ch-1', 'msg-1', 'partial-msg', ?)`,
        Date.now(),
      );
      sql.exec(
        `INSERT INTO in_flight_turns (channel_id, harness_id, trigger_message_id, trigger_pubsub_id, turn_input, started_at) VALUES ('ch-1', 'h-1', 'msg-1', 10, '{"content":"hello","senderId":"user-1"}', ?)`,
        Date.now(),
      );

      const event: HarnessOutput = {
        type: "error",
        error: "harness crashed",
      };
      const result = await instance.onHarnessEvent("h-1", event);

      // Should complete partial message
      const complete = findAction<
        Extract<WorkerAction, { op: "complete" }>
      >(result.actions, (a) => "op" in a && a.op === "complete");
      expect(complete).toBeDefined();
      expect(complete!.messageId).toBe("partial-msg");

      // Should produce respawn action
      const respawn = findAction<
        Extract<WorkerAction, { op: "respawn-harness" }>
      >(result.actions, (a) => "op" in a && a.op === "respawn-harness");
      expect(respawn).toBeDefined();
      expect(respawn!.harnessId).toBe("h-1");
      expect(respawn!.channelId).toBe("ch-1");
      expect(respawn!.retryTurn).toBeDefined();
      expect(respawn!.retryTurn!.input.content).toBe("hello");

      // Harness should be marked crashed
      const harness = sql
        .exec(`SELECT status, state FROM harnesses WHERE id = 'h-1'`)
        .one();
      expect(harness["status"]).toBe("crashed");
      const state = JSON.parse(harness["state"] as string);
      expect(state.error).toBe("harness crashed");
    });

    it("handles turn-level error (with code) without crash recovery", async () => {
      const { instance, sql } = await setupWithHarness();

      // Set up active turn with partial stream
      sql.exec(
        `INSERT INTO active_turns (harness_id, channel_id, reply_to_id, turn_message_id, started_at) VALUES ('h-1', 'ch-1', 'msg-1', 'partial-msg', ?)`,
        Date.now(),
      );

      const event: HarnessOutput = {
        type: "error",
        error: "Maximum turns exceeded",
        code: "error_max_turns",
      };
      const result = await instance.onHarnessEvent("h-1", event);

      // Should complete partial message
      const complete = findAction<
        Extract<WorkerAction, { op: "complete" }>
      >(result.actions, (a) => "op" in a && a.op === "complete");
      expect(complete).toBeDefined();
      expect(complete!.messageId).toBe("partial-msg");

      // Should send error message to channel (not respawn)
      const send = findAction<
        Extract<WorkerAction, { op: "send" }>
      >(result.actions, (a) => "op" in a && a.op === "send");
      expect(send).toBeDefined();
      const payload = JSON.parse(send!.content);
      expect(payload.error).toBe("Maximum turns exceeded");
      expect(payload.code).toBe("error_max_turns");

      // Should NOT produce respawn action
      const respawn = result.actions.find((a) => "op" in a && a.op === "respawn-harness");
      expect(respawn).toBeUndefined();

      // Harness should NOT be marked crashed
      const harness = sql
        .exec(`SELECT status FROM harnesses WHERE id = 'h-1'`)
        .one();
      expect(harness["status"]).toBe("active");
    });
  });

  // approval-needed tests are now in the continuation-based section above

  describe("onHarnessEvent — metadata-update", () => {
    it("produces channel updateMetadata action", async () => {
      const { instance, sql } = await setupWithHarness();

      sql.exec(
        `INSERT INTO active_turns (harness_id, channel_id, reply_to_id, turn_message_id, started_at) VALUES ('h-1', 'ch-1', 'msg-1', NULL, ?)`,
        Date.now(),
      );

      const event: HarnessOutput = {
        type: "metadata-update",
        metadata: { model: "claude-4", status: "thinking" },
      };
      const result = await instance.onHarnessEvent("h-1", event);

      const meta = findAction<
        Extract<WorkerAction, { op: "update-metadata" }>
      >(result.actions, (a) => "op" in a && a.op === "update-metadata");
      expect(meta).toBeDefined();
      expect(meta!.metadata).toEqual({
        model: "claude-4",
        status: "thinking",
      });
    });
  });

  describe("onHarnessEvent — ready", () => {
    it("marks harness as active", async () => {
      const { instance, sql } = await createTestDO(AiChatWorker);
      await instance.subscribeChannel({
        channelId: "ch-1",
        contextId: "ctx-1",
      });
      instance.registerHarness("h-1", "ch-1", "claude-sdk");

      // Initially 'starting'
      let row = sql.exec(`SELECT status FROM harnesses WHERE id = 'h-1'`).one();
      expect(row["status"]).toBe("starting");

      const event: HarnessOutput = { type: "ready" };
      await instance.onHarnessEvent("h-1", event);

      row = sql.exec(`SELECT status FROM harnesses WHERE id = 'h-1'`).one();
      expect(row["status"]).toBe("active");
    });
  });

  describe("onMethodCall", () => {
    it("pause interrupts active harness", async () => {
      const { instance } = await setupWithHarness();

      const result = await instance.onMethodCall(
        "ch-1",
        "call-1",
        "pause",
        {},
      );

      const interrupt = findAction<
        Extract<WorkerAction, { target: "harness" }>
      >(result.actions, (a) => a.target === "harness" && a.command.type === "interrupt");
      expect(interrupt).toBeDefined();
      expect(interrupt!.harnessId).toBe("h-1");

      // Also returns method result
      const methodResult = findAction<
        Extract<WorkerAction, { op: "method-result" }>
      >(result.actions, (a) => "op" in a && a.op === "method-result");
      expect(methodResult).toBeDefined();
      expect(methodResult!.content).toEqual({ paused: true });
    });

    it("pause returns error when no active harness", async () => {
      const { instance } = await createTestDO(AiChatWorker);
      await instance.subscribeChannel({
        channelId: "ch-1",
        contextId: "ctx-1",
      });

      const result = await instance.onMethodCall(
        "ch-1",
        "call-1",
        "pause",
        {},
      );

      const methodResult = findAction<
        Extract<WorkerAction, { op: "method-result" }>
      >(result.actions, (a) => "op" in a && a.op === "method-result");
      expect(methodResult).toBeDefined();
      expect(methodResult!.isError).toBe(true);
    });

    it("resume is a no-op success", async () => {
      const { instance } = await setupWithHarness();

      const result = await instance.onMethodCall(
        "ch-1",
        "call-1",
        "resume",
        {},
      );

      const methodResult = findAction<
        Extract<WorkerAction, { op: "method-result" }>
      >(result.actions, (a) => "op" in a && a.op === "method-result");
      expect(methodResult).toBeDefined();
      expect(methodResult!.content).toEqual({ resumed: true });
      expect(methodResult!.isError).toBeFalsy();
    });

    it("unknown method returns error", async () => {
      const { instance } = await setupWithHarness();

      const result = await instance.onMethodCall(
        "ch-1",
        "call-1",
        "nonexistent",
        {},
      );

      const methodResult = findAction<
        Extract<WorkerAction, { op: "method-result" }>
      >(result.actions, (a) => "op" in a && a.op === "method-result");
      expect(methodResult).toBeDefined();
      expect(methodResult!.isError).toBe(true);
    });
  });

  describe("onHarnessEvent — thinking lifecycle", () => {
    it("thinking-start/delta/end produce correct stream actions", async () => {
      const { instance, sql } = await setupWithHarness();

      sql.exec(
        `INSERT INTO active_turns (harness_id, channel_id, reply_to_id, turn_message_id, started_at) VALUES ('h-1', 'ch-1', 'msg-1', NULL, ?)`,
        Date.now(),
      );

      const r1 = await instance.onHarnessEvent("h-1", { type: "thinking-start" });
      const send = findAction<Extract<WorkerAction, { op: "send" }>>(
        r1.actions,
        (a) => "op" in a && a.op === "send",
      );
      expect(send).toBeDefined();
      expect(send!.options?.type).toBe("thinking");
    });
  });

  describe("onHarnessEvent — action-start/end", () => {
    it("produces action send and complete", async () => {
      const { instance, sql } = await setupWithHarness();

      sql.exec(
        `INSERT INTO active_turns (harness_id, channel_id, reply_to_id, turn_message_id, started_at) VALUES ('h-1', 'ch-1', 'msg-1', NULL, ?)`,
        Date.now(),
      );

      const r1 = await instance.onHarnessEvent("h-1", {
        type: "action-start",
        tool: "search",
        description: "Searching files",
        toolUseId: "tu-1",
      });
      const send = findAction<Extract<WorkerAction, { op: "send" }>>(
        r1.actions,
        (a) => "op" in a && a.op === "send",
      );
      expect(send).toBeDefined();
      expect(send!.options?.type).toBe("action");
      expect(JSON.parse(send!.content)).toEqual({
        type: "search",
        description: "Searching files",
        toolUseId: "tu-1",
        status: "pending",
      });
    });
  });
});
