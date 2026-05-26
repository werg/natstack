import { describe, expect, it } from "vitest";
import { vi } from "vitest";
import { createTestDO } from "@workspace/runtime/worker/test-utils";
import type { AgentMessage } from "@earendil-works/pi-agent-core";

import { AgentWorkerBase } from "./agent-worker-base.js";
import type { RespondPolicy, CustomMessageReducer } from "./trajectory-vessel-base.js";
import type { TurnDispatcherRunner } from "./turn-dispatcher.js";
import type { ChannelEvent } from "@natstack/harness/types";
import type { PiRunner } from "@natstack/harness";
import { AGENTIC_EVENT_PAYLOAD_KIND } from "@workspace/agentic-protocol";

class TestAgentWorker extends AgentWorkerBase {
  protected override getDefaultModel(): string {
    return "test:model";
  }

  protected override async refreshRoster(_channelId: string): Promise<void> {
    // Integration tests that need roster behavior stub createChannelClient directly.
  }

  protected override async getOrCreateRunner(channelId: string): Promise<PiRunner> {
    const runners = (this as unknown as { runners: Map<string, { runner: PiRunner }> }).runners;
    const existing = runners.get(channelId)?.runner;
    if (existing) return existing;
    const runner = {} as PiRunner;
    runners.set(channelId, { runner });
    return runner;
  }

  public testShouldProcess(event: ChannelEvent): boolean {
    return this.shouldProcess(event);
  }
}

class InterruptTestAgentWorker extends TestAgentWorker {
  public testInterruptRunner(channelId: string): Promise<void> {
    return this.interruptRunner(channelId);
  }

  public testInterruptAllRunners(): Promise<void> {
    return this.interruptAllRunners();
  }
}

class CloneTestAgentWorker extends TestAgentWorker {
  public subscribeCalls: Array<{
    channelId: string;
    contextId: string;
    config?: unknown;
    replay?: boolean;
  }> = [];

  override async subscribeChannel(opts: {
    channelId: string;
    contextId: string;
    config?: unknown;
    replay?: boolean;
  }): Promise<{ ok: boolean; participantId: string }> {
    this.subscribeCalls.push(opts);
    return { ok: true, participantId: "do:workers/test-agent:TestAgentWorker:agent-fork" };
  }
}

class StrictMentionTestAgentWorker extends TestAgentWorker {
  protected override getRespondPolicy(_channelId: string): RespondPolicy {
    return "mentioned-strict";
  }

  public testShouldRespond(channelId: string, event: ChannelEvent) {
    return this.shouldRespond(channelId, event);
  }
}

class MentionedTestAgentWorker extends TestAgentWorker {
  protected override getRespondPolicy(_channelId: string): RespondPolicy {
    return "mentioned";
  }

  public testShouldRespond(channelId: string, event: ChannelEvent) {
    return this.shouldRespond(channelId, event);
  }
}

class CustomMessageIndexTestAgentWorker extends TestAgentWorker {
  public testIndexOwnCustomMessages(
    channelId: string,
    reducerLookup?: (typeId: string) => CustomMessageReducer | undefined | null
  ) {
    return this.indexOwnCustomMessages(channelId, reducerLookup);
  }
}

describe("AgentWorkerBase runner contract", () => {
  it("uses the clean AgentHarness-facing dispatcher surface", () => {
    const methods = [
      "subscribe",
      "buildUserMessage",
      "prompt",
      "steerMessage",
      "continueAgent",
      "clearSteeringQueue",
    ] satisfies Array<keyof TurnDispatcherRunner>;

    expect(methods).toEqual([
      "subscribe",
      "buildUserMessage",
      "prompt",
      "steerMessage",
      "continueAgent",
      "clearSteeringQueue",
    ]);
  });
});

describe("AgentWorkerBase method suspension ledger", () => {
  function insertSuspension(
    sql: { exec(query: string, ...bindings: unknown[]): { toArray(): Record<string, unknown>[] } },
    opts: {
      callId: string;
      channelId?: string;
      invocationId?: string;
      kind?: string;
      deliveryStatus?: string;
      terminalKind?: string;
      result?: unknown;
      resultIsError?: number;
      createdAt?: number;
      toolCallIndex?: number;
      toolName?: string;
      sessionLeafBeforeCall?: string | null;
      args?: unknown;
    }
  ) {
    const channelId = opts.channelId ?? "chat-1";
    const invocationId = opts.invocationId ?? "tool-1";
    const now = opts.createdAt ?? Date.now();
    sql.exec(
      `INSERT INTO agent_method_suspensions (
         transport_call_id, channel_id, invocation_id, model_tool_call_id,
         assistant_message_id, tool_call_index, tool_name, turn_id, kind, method,
         participant_handle, target_participant_id, args_json, session_leaf_before_call,
         terminal_kind, result_json, result_is_error, result_event_id, result_received_at,
         delivery_status, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      opts.callId,
      channelId,
      invocationId,
      invocationId,
      "assistant-1",
      opts.toolCallIndex ?? 0,
      opts.toolName ?? "eval",
      opts.kind ?? "channelMethod",
      opts.kind === "approval" || opts.kind === "uiPrompt" ? "ui_prompt" : "eval",
      opts.kind === "approval" || opts.kind === "uiPrompt" ? "panel-1" : "tool-1",
      opts.args === undefined ? null : JSON.stringify(opts.args),
      opts.sessionLeafBeforeCall ?? "leaf-1",
      opts.terminalKind ?? "none",
      opts.result === undefined ? null : JSON.stringify(opts.result),
      opts.resultIsError ?? null,
      now,
      opts.terminalKind === "none" ? null : now,
      opts.deliveryStatus ?? "pending",
      now,
      now
    );
  }

  it("caps partial updates and deletes them after hot-path transcript admission", async () => {
    const { instance, sql } = await createTestDO(TestAgentWorker, {
      __objectKey: "agent-test",
    });
    const worker = instance as unknown as {
      appendMethodSuspensionUpdate(callId: string, content: unknown): void;
      markMethodSuspensionTerminal(
        callId: string,
        opts: {
          terminalKind: "completed";
          result: unknown;
          isError: boolean;
          waiterPresent: boolean;
        }
      ): void;
      markLiveToolResultAdmitted(channelId: string, message: AgentMessage): void;
    };

    insertSuspension(sql, { callId: "call-1" });
    for (let i = 0; i < 260; i++) {
      worker.appendMethodSuspensionUpdate("call-1", { chunk: i });
    }
    expect(
      sql
        .exec(
          `SELECT COUNT(*) AS count, MIN(seq) AS min_seq, MAX(seq) AS max_seq
             FROM agent_method_suspension_updates
             WHERE transport_call_id = ?`,
          "call-1"
        )
        .toArray()[0]
    ).toMatchObject({ count: 256, min_seq: 5, max_seq: 260 });

    worker.markMethodSuspensionTerminal("call-1", {
      terminalKind: "completed",
      result: { content: [{ type: "text", text: "done" }] },
      isError: false,
      waiterPresent: true,
    });
    worker.markLiveToolResultAdmitted("chat-1", {
      role: "toolResult",
      toolCallId: "tool-1",
      toolName: "eval",
      content: [{ type: "text", text: "done" }],
    } as AgentMessage);

    expect(
      sql
        .exec(
          `SELECT delivery_status FROM agent_method_suspensions WHERE transport_call_id = ?`,
          "call-1"
        )
        .toArray()[0]
    ).toMatchObject({ delivery_status: "transcript_admitted" });
    expect(
      sql
        .exec(
          `SELECT COUNT(*) AS count FROM agent_method_suspension_updates WHERE transport_call_id = ?`,
          "call-1"
        )
        .toArray()[0]
    ).toMatchObject({ count: 0 });
  });

  it("settles approval siblings as superseded when the live tool result is admitted", async () => {
    const { instance, sql } = await createTestDO(TestAgentWorker, {
      __objectKey: "agent-test",
    });
    const worker = instance as unknown as {
      markLiveToolResultAdmitted(channelId: string, message: AgentMessage): void;
    };

    insertSuspension(sql, {
      callId: "approval-call",
      invocationId: "tool-1",
      kind: "approval",
      deliveryStatus: "delivered_live",
      terminalKind: "completed",
      result: true,
      createdAt: 100,
      toolName: "bash",
    });
    insertSuspension(sql, {
      callId: "eval-call",
      invocationId: "tool-1",
      kind: "channelMethod",
      deliveryStatus: "delivered_live",
      terminalKind: "completed",
      result: { content: [{ type: "text", text: "ran" }] },
      createdAt: 200,
      toolName: "bash",
    });

    worker.markLiveToolResultAdmitted("chat-1", {
      role: "toolResult",
      toolCallId: "tool-1",
      toolName: "bash",
      content: [{ type: "text", text: "ran" }],
    } as AgentMessage);

    expect(
      sql
        .exec(
          `SELECT transport_call_id, delivery_status
             FROM agent_method_suspensions
             ORDER BY transport_call_id`
        )
        .toArray()
    ).toEqual([
      { transport_call_id: "approval-call", delivery_status: "superseded" },
      { transport_call_id: "eval-call", delivery_status: "transcript_admitted" },
    ]);
  });

  it("does not delete partials when a live admission hook has no delivered row to settle", async () => {
    const { instance, sql } = await createTestDO(TestAgentWorker, {
      __objectKey: "agent-test",
    });
    const worker = instance as unknown as {
      appendMethodSuspensionUpdate(callId: string, content: unknown): void;
      markLiveToolResultAdmitted(channelId: string, message: AgentMessage): void;
    };

    insertSuspension(sql, { callId: "call-1", deliveryStatus: "pending" });
    worker.appendMethodSuspensionUpdate("call-1", { chunk: "still-in-flight" });
    worker.markLiveToolResultAdmitted("chat-1", {
      role: "toolResult",
      toolCallId: "tool-1",
      toolName: "eval",
      content: [{ type: "text", text: "done" }],
    } as AgentMessage);

    expect(
      sql
        .exec(
          `SELECT COUNT(*) AS count FROM agent_method_suspension_updates WHERE transport_call_id = ?`,
          "call-1"
        )
        .toArray()[0]
    ).toMatchObject({ count: 1 });
  });

  it("settles delivered-live siblings group-wise during activation sweep", async () => {
    const { instance, sql } = await createTestDO(TestAgentWorker, {
      __objectKey: "agent-test",
    });
    const worker = instance as unknown as {
      sweepStuckDelivery(channelId: string, runner: PiRunner): Promise<void>;
    };

    insertSuspension(sql, {
      callId: "approval-call",
      invocationId: "tool-1",
      kind: "approval",
      deliveryStatus: "delivered_live",
      terminalKind: "completed",
      result: true,
      createdAt: 100,
      toolName: "bash",
    });
    insertSuspension(sql, {
      callId: "eval-call",
      invocationId: "tool-1",
      kind: "channelMethod",
      deliveryStatus: "delivered_live",
      terminalKind: "completed",
      result: { content: [{ type: "text", text: "ran" }] },
      createdAt: 200,
      toolName: "bash",
    });

    await worker.sweepStuckDelivery("chat-1", {
      isInvocationOpen: () => false,
      hasToolResult: async () => true,
      isCurrentLeafToolResult: async () => false,
    } as unknown as PiRunner);

    expect(
      sql
        .exec(
          `SELECT transport_call_id, delivery_status
             FROM agent_method_suspensions
             ORDER BY transport_call_id`
        )
        .toArray()
    ).toEqual([
      { transport_call_id: "approval-call", delivery_status: "superseded" },
      { transport_call_id: "eval-call", delivery_status: "transcript_admitted" },
    ]);
  });

  it("recovers the model-visible channel result instead of an older approval prompt", async () => {
    const { instance, sql } = await createTestDO(TestAgentWorker, {
      __objectKey: "agent-test",
    });
    const appended: AgentMessage[] = [];
    const submitContinue = vi.fn();
    const worker = instance as unknown as {
      runners: Map<string, { runner: unknown }>;
      dispatchers: Map<string, unknown>;
      recoverDeliveredAndOrphanedSuspensions(channelId: string): Promise<void>;
    };
    worker.runners.set("chat-1", {
      runner: {
        isInvocationOpen: () => true,
        isLeafDescendantOf: async () => true,
        appendToolResult: async (message: AgentMessage) => {
          appended.push(message);
          return "entry-recovered";
        },
      },
    });
    worker.dispatchers.set("chat-1", {
      submitContinue,
      getDebugState: () => ({ busy: false }),
    });

    insertSuspension(sql, {
      callId: "approval-call",
      invocationId: "tool-1",
      kind: "approval",
      deliveryStatus: "pending",
      terminalKind: "completed",
      result: true,
      createdAt: 100,
      toolName: "bash",
    });
    insertSuspension(sql, {
      callId: "eval-call",
      invocationId: "tool-1",
      kind: "channelMethod",
      deliveryStatus: "pending",
      terminalKind: "completed",
      result: { content: [{ type: "text", text: "real output" }] },
      createdAt: 200,
      toolName: "bash",
    });

    await worker.recoverDeliveredAndOrphanedSuspensions("chat-1");

    expect(appended).toHaveLength(1);
    expect(appended[0]).toMatchObject({
      role: "toolResult",
      toolCallId: "tool-1",
      toolName: "bash",
      content: [{ type: "text", text: "real output" }],
    });
    expect(submitContinue).toHaveBeenCalledTimes(1);
    expect(
      sql
        .exec(
          `SELECT transport_call_id, delivery_status, recovered_entry_id
             FROM agent_method_suspensions
             ORDER BY transport_call_id`
        )
        .toArray()
    ).toEqual([
      {
        transport_call_id: "approval-call",
        delivery_status: "superseded",
        recovered_entry_id: null,
      },
      {
        transport_call_id: "eval-call",
        delivery_status: "recovered",
        recovered_entry_id: "entry-recovered",
      },
    ]);
  });

  it("skips an approval result while the higher-priority channel method is still pending", async () => {
    const { instance, sql } = await createTestDO(TestAgentWorker, {
      __objectKey: "agent-test",
    });
    const appended: AgentMessage[] = [];
    const worker = instance as unknown as {
      runners: Map<string, { runner: unknown }>;
      dispatchers: Map<string, unknown>;
      recoverDeliveredAndOrphanedSuspensions(channelId: string): Promise<void>;
    };
    worker.runners.set("chat-1", {
      runner: {
        isInvocationOpen: () => true,
        isLeafDescendantOf: async () => true,
        appendToolResult: async (message: AgentMessage) => {
          appended.push(message);
          return "entry-recovered";
        },
      },
    });
    worker.dispatchers.set("chat-1", {
      submitContinue: vi.fn(),
      getDebugState: () => ({ busy: false }),
    });

    insertSuspension(sql, {
      callId: "approval-call",
      invocationId: "tool-1",
      kind: "approval",
      deliveryStatus: "pending",
      terminalKind: "completed",
      result: true,
      createdAt: 100,
      toolName: "bash",
    });
    insertSuspension(sql, {
      callId: "eval-call",
      invocationId: "tool-1",
      kind: "channelMethod",
      deliveryStatus: "pending",
      terminalKind: "none",
      createdAt: 200,
      toolName: "bash",
    });

    await worker.recoverDeliveredAndOrphanedSuspensions("chat-1");

    expect(appended).toEqual([]);
    expect(
      sql
        .exec(
          `SELECT transport_call_id, delivery_status
             FROM agent_method_suspensions
             ORDER BY transport_call_id`
        )
        .toArray()
    ).toEqual([
      { transport_call_id: "approval-call", delivery_status: "pending" },
      { transport_call_id: "eval-call", delivery_status: "pending" },
    ]);
  });

  it("resumes approval-only groups by directly executing the pre-approved outer tool", async () => {
    const { instance, sql } = await createTestDO(TestAgentWorker, {
      __objectKey: "agent-test",
    });
    const appended: AgentMessage[] = [];
    const executeToolDirect = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "resumed output" }],
      details: { resumed: true },
    });
    const submitContinue = vi.fn();
    const worker = instance as unknown as {
      runners: Map<string, { runner: unknown }>;
      dispatchers: Map<string, unknown>;
      recoverDeliveredAndOrphanedSuspensions(channelId: string): Promise<void>;
    };
    worker.runners.set("chat-1", {
      runner: {
        isInvocationOpen: () => true,
        isLeafDescendantOf: async () => true,
        executeToolDirect,
        appendToolResult: async (message: AgentMessage) => {
          appended.push(message);
          return "entry-approval";
        },
      },
    });
    worker.dispatchers.set("chat-1", {
      submitContinue,
      getDebugState: () => ({ busy: false }),
    });
    insertSuspension(sql, {
      callId: "approval-call",
      invocationId: "tool-1",
      kind: "approval",
      deliveryStatus: "pending",
      terminalKind: "completed",
      result: true,
      createdAt: 100,
      toolName: "bash",
      args: {
        prompt: { kind: "confirm", title: "Allow tool call?", message: "Tool: bash" },
        resumeToolInput: { command: "echo resumed" },
      },
    });

    await worker.recoverDeliveredAndOrphanedSuspensions("chat-1");

    expect(executeToolDirect).toHaveBeenCalledWith(
      "bash",
      "tool-1",
      { command: "echo resumed" },
      expect.any(AbortSignal)
    );
    expect(appended).toHaveLength(1);
    expect(appended[0]).toMatchObject({
      role: "toolResult",
      toolCallId: "tool-1",
      toolName: "bash",
      content: [
        {
          type: "text",
          text: "resumed output",
        },
      ],
      details: { resumed: true },
    });
    expect(submitContinue).toHaveBeenCalledTimes(1);
    expect(
      sql
        .exec(
          `SELECT channel_id, reason FROM agent_recovery_continuations WHERE channel_id = ?`,
          "chat-1"
        )
        .toArray()
    ).toEqual([{ channel_id: "chat-1", reason: "method_suspension_recovered" }]);
  });

  it("replays recovered ui prompt answers while resuming the outer tool", async () => {
    const { instance, sql } = await createTestDO(TestAgentWorker, {
      __objectKey: "agent-test",
    });
    const appended: AgentMessage[] = [];
    const submitContinue = vi.fn();
    const worker = instance as unknown as {
      runners: Map<string, { runner: unknown }>;
      dispatchers: Map<string, unknown>;
      dispatchUiPrompt(
        channelId: string,
        toolCallId: string,
        kind: "confirm" | "input",
        params: Record<string, unknown>
      ): Promise<unknown>;
      recoverDeliveredAndOrphanedSuspensions(channelId: string): Promise<void>;
    };
    const executeToolDirect = vi.fn(async () => {
      const first = await worker.dispatchUiPrompt("chat-1", "tool-1", "confirm", {
        title: "Continue?",
        message: "Use first recovered answer",
      });
      const second = await worker.dispatchUiPrompt("chat-1", "tool-1", "input", {
        title: "Name?",
      });
      return {
        content: [{ type: "text", text: `replayed=${String(first)}:${String(second)}` }],
      };
    });
    worker.runners.set("chat-1", {
      runner: {
        isInvocationOpen: () => true,
        isLeafDescendantOf: async () => true,
        executeToolDirect,
        appendToolResult: async (message: AgentMessage) => {
          appended.push(message);
          return "entry-ui";
        },
      },
    });
    worker.dispatchers.set("chat-1", {
      submitContinue,
      getDebugState: () => ({ busy: false }),
    });
    insertSuspension(sql, {
      callId: "ui-call",
      invocationId: "tool-1",
      kind: "uiPrompt",
      deliveryStatus: "pending",
      terminalKind: "completed",
      result: "true",
      createdAt: 100,
      toolName: "custom_tool",
      args: {
        prompt: { kind: "confirm", title: "Continue?", message: "Use first recovered answer" },
        resumeToolInput: { value: 42 },
      },
    });
    insertSuspension(sql, {
      callId: "ui-call-2",
      invocationId: "tool-1",
      kind: "uiPrompt",
      deliveryStatus: "pending",
      terminalKind: "completed",
      result: "alice",
      createdAt: 101,
      toolName: "custom_tool",
      args: {
        prompt: { kind: "input", title: "Name?" },
        resumeToolInput: { value: 42 },
      },
    });

    await worker.recoverDeliveredAndOrphanedSuspensions("chat-1");

    expect(executeToolDirect).toHaveBeenCalledWith(
      "custom_tool",
      "tool-1",
      { value: 42 },
      expect.any(AbortSignal)
    );
    expect(appended).toHaveLength(1);
    expect(appended[0]).toMatchObject({
      role: "toolResult",
      toolCallId: "tool-1",
      toolName: "custom_tool",
      content: [{ type: "text", text: "replayed=true:alice" }],
    });
    expect(submitContinue).toHaveBeenCalledTimes(1);
  });

  it("recovers multiple terminal tool calls in assistant block order", async () => {
    const { instance, sql } = await createTestDO(TestAgentWorker, {
      __objectKey: "agent-test",
    });
    const appended: AgentMessage[] = [];
    const worker = instance as unknown as {
      runners: Map<string, { runner: unknown }>;
      dispatchers: Map<string, unknown>;
      recoverDeliveredAndOrphanedSuspensions(channelId: string): Promise<void>;
    };
    worker.runners.set("chat-1", {
      runner: {
        isInvocationOpen: () => true,
        isLeafDescendantOf: async () => true,
        appendToolResult: async (message: AgentMessage) => {
          appended.push(message);
          return `entry-${String((message as { toolCallId?: unknown }).toolCallId)}`;
        },
      },
    });
    worker.dispatchers.set("chat-1", {
      submitContinue: vi.fn(),
      getDebugState: () => ({ busy: false }),
    });
    insertSuspension(sql, {
      callId: "call-b",
      invocationId: "tool-b",
      terminalKind: "completed",
      result: "B",
      createdAt: 100,
      toolCallIndex: 1,
    });
    insertSuspension(sql, {
      callId: "call-a",
      invocationId: "tool-a",
      terminalKind: "completed",
      result: "A",
      createdAt: 200,
      toolCallIndex: 0,
    });

    await worker.recoverDeliveredAndOrphanedSuspensions("chat-1");

    expect(appended.map((message) => (message as { toolCallId?: string }).toolCallId)).toEqual([
      "tool-a",
      "tool-b",
    ]);
  });

  it("ignores late terminal results for cancelled suspensions", async () => {
    const { instance, sql } = await createTestDO(TestAgentWorker, {
      __objectKey: "agent-test",
    });
    const worker = instance as unknown as {
      handleCompletedMethodResult(
        channelId: string,
        callId: string,
        result: unknown,
        isError: boolean
      ): Promise<void>;
      runners: Map<string, unknown>;
    };
    insertSuspension(sql, {
      callId: "call-1",
      deliveryStatus: "cancelled",
      terminalKind: "cancelled",
      result: { reason: "user_interrupted" },
      resultIsError: 1,
    });

    await worker.handleCompletedMethodResult("chat-1", "call-1", "late success", false);

    expect(
      sql
        .exec(
          `SELECT delivery_status FROM agent_method_suspensions WHERE transport_call_id = ?`,
          "call-1"
        )
        .toArray()[0]
    ).toMatchObject({ delivery_status: "ignored" });
    expect(worker.runners.has("chat-1")).toBe(false);
  });

  it("recovers an orphan terminal through the channel event completion handler", async () => {
    const { instance, sql } = await createTestDO(TestAgentWorker, {
      __objectKey: "agent-test",
    });
    const appended: AgentMessage[] = [];
    const submitContinue = vi.fn();
    const worker = instance as unknown as {
      runners: Map<string, { runner: unknown }>;
      dispatchers: Map<string, unknown>;
      handleCompletedMethodResult(
        channelId: string,
        callId: string,
        result: unknown,
        isError: boolean
      ): Promise<void>;
    };
    worker.runners.set("chat-1", {
      runner: {
        isInvocationOpen: () => true,
        isLeafDescendantOf: async () => true,
        appendToolResult: async (message: AgentMessage) => {
          appended.push(message);
          return "entry-orphan";
        },
      },
    });
    worker.dispatchers.set("chat-1", {
      submitContinue,
      getDebugState: () => ({ busy: false }),
    });
    insertSuspension(sql, {
      callId: "call-1",
      terminalKind: "none",
      deliveryStatus: "pending",
      sessionLeafBeforeCall: null,
    });

    await worker.handleCompletedMethodResult("chat-1", "call-1", "terminal payload", false);

    expect(appended).toHaveLength(1);
    expect(appended[0]).toMatchObject({
      role: "toolResult",
      toolCallId: "tool-1",
      content: [{ type: "text", text: "terminal payload" }],
    });
    expect(submitContinue).toHaveBeenCalledTimes(1);
    expect(
      sql
        .exec(
          `SELECT terminal_kind, delivery_status, recovered_entry_id
             FROM agent_method_suspensions
             WHERE transport_call_id = ?`,
          "call-1"
        )
        .toArray()[0]
    ).toMatchObject({
      terminal_kind: "completed",
      delivery_status: "recovered",
      recovered_entry_id: "entry-orphan",
    });
  });

  it("hydrates stored transport refs before admitting recovered tool results", async () => {
    const { instance, sql } = await createTestDO(TestAgentWorker, {
      __objectKey: "agent-test",
    });
    const appended: AgentMessage[] = [];
    const submitContinue = vi.fn();
    const hydratedResult = {
      content: [{ type: "text", text: "stored eval output" }],
      details: { bytes: 18 },
    };
    const rpcCall = vi.fn(async (_target: string, method: string, args: unknown[]) => {
      if (method === "blobstore.getText" && args[0] === "stored-result-digest") {
        return JSON.stringify(hydratedResult);
      }
      return null;
    });
    const worker = instance as unknown as {
      _rpc: {
        call: ReturnType<typeof vi.fn>;
        streamCall: ReturnType<typeof vi.fn>;
        emit: ReturnType<typeof vi.fn>;
        onEvent: ReturnType<typeof vi.fn>;
        handleIncomingPost: ReturnType<typeof vi.fn>;
      };
      runners: Map<string, { runner: unknown }>;
      dispatchers: Map<string, unknown>;
      handleCompletedMethodResult(
        channelId: string,
        callId: string,
        result: unknown,
        isError: boolean
      ): Promise<void>;
    };
    worker._rpc = {
      call: rpcCall,
      streamCall: vi.fn(),
      emit: vi.fn(),
      onEvent: vi.fn(),
      handleIncomingPost: vi.fn(),
    };
    worker.runners.set("chat-1", {
      runner: {
        isInvocationOpen: () => true,
        isLeafDescendantOf: async () => true,
        appendToolResult: async (message: AgentMessage) => {
          appended.push(message);
          return "entry-stored";
        },
      },
    });
    worker.dispatchers.set("chat-1", {
      submitContinue,
      getDebugState: () => ({ busy: false }),
    });
    insertSuspension(sql, {
      callId: "call-1",
      terminalKind: "none",
      deliveryStatus: "pending",
      sessionLeafBeforeCall: null,
    });

    await worker.handleCompletedMethodResult(
      "chat-1",
      "call-1",
      {
        protocol: "natstack.blob-ref.v1",
        digest: "stored-result-digest",
        size: 128,
        encoding: "json",
        originalBytes: 128,
        preview: "{\"content\":[{\"type\":\"text\",\"text\":\"stored eval output\"}]}",
      },
      false
    );

    expect(rpcCall).toHaveBeenCalledWith("main", "blobstore.getText", ["stored-result-digest"]);
    expect(appended).toHaveLength(1);
    expect(appended[0]).toMatchObject({
      role: "toolResult",
      toolCallId: "tool-1",
      content: [{ type: "text", text: "stored eval output" }],
      details: { bytes: 18 },
    });
    expect(
      sql
        .exec(
          `SELECT result_json, delivery_status
             FROM agent_method_suspensions
             WHERE transport_call_id = ?`,
          "call-1"
        )
        .toArray()[0]
    ).toMatchObject({
      result_json: JSON.stringify(hydratedResult),
      delivery_status: "recovered",
    });
  });

  it("raises missing stored transport blobs instead of admitting blob refs", async () => {
    const { instance, sql } = await createTestDO(TestAgentWorker, {
      __objectKey: "agent-test",
    });
    const worker = instance as unknown as {
      _rpc: {
        call: ReturnType<typeof vi.fn>;
        streamCall: ReturnType<typeof vi.fn>;
        emit: ReturnType<typeof vi.fn>;
        onEvent: ReturnType<typeof vi.fn>;
        handleIncomingPost: ReturnType<typeof vi.fn>;
      };
      handleCompletedMethodResult(
        channelId: string,
        callId: string,
        result: unknown,
        isError: boolean
      ): Promise<void>;
    };
    worker._rpc = {
      call: vi.fn(async () => null),
      streamCall: vi.fn(),
      emit: vi.fn(),
      onEvent: vi.fn(),
      handleIncomingPost: vi.fn(),
    };
    insertSuspension(sql, {
      callId: "call-1",
      terminalKind: "none",
      deliveryStatus: "pending",
    });

    await expect(
      worker.handleCompletedMethodResult(
        "chat-1",
        "call-1",
        {
          protocol: "natstack.blob-ref.v1",
          digest: "missing-digest",
          size: 64,
          encoding: "json",
          originalBytes: 64,
        },
        false
      )
    ).rejects.toThrow("Stored transport blob is missing: missing-digest");
    expect(
      sql
        .exec(
          `SELECT terminal_kind, result_json, delivery_status
             FROM agent_method_suspensions
             WHERE transport_call_id = ?`,
          "call-1"
        )
        .toArray()[0]
    ).toMatchObject({
      terminal_kind: "none",
      result_json: null,
      delivery_status: "pending",
    });
  });

  it("ignores duplicate terminal results already delivered to a live waiter", async () => {
    const { instance, sql } = await createTestDO(TestAgentWorker, {
      __objectKey: "agent-test",
    });
    const appendToolResult = vi.fn(async () => "entry-duplicate");
    const submitContinue = vi.fn();
    const worker = instance as unknown as {
      runners: Map<string, { runner: unknown }>;
      dispatchers: Map<string, unknown>;
      handleCompletedMethodResult(
        channelId: string,
        callId: string,
        result: unknown,
        isError: boolean
      ): Promise<void>;
    };
    worker.runners.set("chat-1", {
      runner: {
        isInvocationOpen: () => true,
        isLeafDescendantOf: async () => true,
        appendToolResult,
      },
    });
    worker.dispatchers.set("chat-1", {
      submitContinue,
      getDebugState: () => ({ busy: false }),
    });
    insertSuspension(sql, {
      callId: "call-1",
      terminalKind: "completed",
      deliveryStatus: "delivered_live",
      result: { content: [{ type: "text", text: "already delivered" }] },
    });

    await worker.handleCompletedMethodResult("chat-1", "call-1", "duplicate payload", false);

    expect(appendToolResult).not.toHaveBeenCalled();
    expect(submitContinue).not.toHaveBeenCalled();
    expect(
      sql
        .exec(
          `SELECT delivery_status, recovered_entry_id
             FROM agent_method_suspensions
             WHERE transport_call_id = ?`,
          "call-1"
        )
        .toArray()[0]
    ).toMatchObject({ delivery_status: "delivered_live", recovered_entry_id: null });
  });

  it("marks recovery rows stale when the invocation is no longer open", async () => {
    const { instance, sql } = await createTestDO(TestAgentWorker, {
      __objectKey: "agent-test",
    });
    const appendToolResult = vi.fn();
    const submitContinue = vi.fn();
    const worker = instance as unknown as {
      runners: Map<string, { runner: unknown }>;
      dispatchers: Map<string, unknown>;
      recoverDeliveredAndOrphanedSuspensions(channelId: string): Promise<void>;
    };
    worker.runners.set("chat-1", {
      runner: {
        isInvocationOpen: () => false,
        hasToolResult: async () => true,
        isLeafDescendantOf: async () => true,
        appendToolResult,
      },
    });
    worker.dispatchers.set("chat-1", {
      submitContinue,
      getDebugState: () => ({ busy: false }),
    });
    insertSuspension(sql, {
      callId: "call-1",
      terminalKind: "completed",
      result: "done",
    });

    await worker.recoverDeliveredAndOrphanedSuspensions("chat-1");

    expect(appendToolResult).not.toHaveBeenCalled();
    expect(submitContinue).not.toHaveBeenCalled();
    expect(
      sql
        .exec(
          `SELECT delivery_status, recovery_error
             FROM agent_method_suspensions
             WHERE transport_call_id = ?`,
          "call-1"
        )
        .toArray()[0]
    ).toMatchObject({ delivery_status: "stale", recovery_error: "invocation closed" });
  });

  it("records recovery_error and retains partials when appendToolResult fails", async () => {
    const { instance, sql } = await createTestDO(TestAgentWorker, {
      __objectKey: "agent-test",
    });
    const worker = instance as unknown as {
      runners: Map<string, { runner: unknown }>;
      dispatchers: Map<string, unknown>;
      appendMethodSuspensionUpdate(callId: string, content: unknown): void;
      recoverDeliveredAndOrphanedSuspensions(channelId: string): Promise<void>;
    };
    worker.runners.set("chat-1", {
      runner: {
        isInvocationOpen: () => true,
        isLeafDescendantOf: async () => true,
        appendToolResult: async () => {
          throw new Error("append failed");
        },
      },
    });
    worker.dispatchers.set("chat-1", {
      submitContinue: vi.fn(),
      getDebugState: () => ({ busy: false }),
    });
    insertSuspension(sql, {
      callId: "call-1",
      terminalKind: "completed",
      result: "done",
    });
    worker.appendMethodSuspensionUpdate("call-1", { partial: "kept" });

    await worker.recoverDeliveredAndOrphanedSuspensions("chat-1");

    expect(
      sql
        .exec(
          `SELECT delivery_status, recovery_error
             FROM agent_method_suspensions
             WHERE transport_call_id = ?`,
          "call-1"
        )
        .toArray()[0]
    ).toMatchObject({ delivery_status: "recovery_error", recovery_error: "append failed" });
    expect(
      sql
        .exec(
          `SELECT COUNT(*) AS count
             FROM agent_method_suspension_updates
             WHERE transport_call_id = ?`,
          "call-1"
        )
        .toArray()[0]
    ).toMatchObject({ count: 1 });
  });

  it("releases stuck recovering rows on activation sweep when the invocation is still open", async () => {
    const { instance, sql } = await createTestDO(TestAgentWorker, {
      __objectKey: "agent-test",
    });
    const worker = instance as unknown as {
      sweepStuckDelivery(channelId: string, runner: PiRunner): Promise<void>;
    };
    insertSuspension(sql, {
      callId: "call-1",
      terminalKind: "completed",
      result: "done",
      deliveryStatus: "recovering",
    });

    await worker.sweepStuckDelivery("chat-1", {
      isInvocationOpen: () => true,
      hasToolResult: async () => false,
    } as unknown as PiRunner);

    expect(
      sql
        .exec(
          `SELECT delivery_status FROM agent_method_suspensions WHERE transport_call_id = ?`,
          "call-1"
        )
        .toArray()[0]
    ).toMatchObject({ delivery_status: "delivered_live" });
  });

  it("does not treat a closed invocation as admitted unless a tool result is present", async () => {
    const { instance, sql } = await createTestDO(TestAgentWorker, {
      __objectKey: "agent-test",
    });
    const worker = instance as unknown as {
      sweepStuckDelivery(channelId: string, runner: PiRunner): Promise<void>;
    };
    insertSuspension(sql, {
      callId: "call-1",
      terminalKind: "completed",
      result: "done",
      deliveryStatus: "recovering",
    });

    await worker.sweepStuckDelivery("chat-1", {
      isInvocationOpen: () => false,
      hasToolResult: async () => false,
    } as unknown as PiRunner);

    expect(
      sql
        .exec(
          `SELECT delivery_status, recovery_error FROM agent_method_suspensions WHERE transport_call_id = ?`,
          "call-1"
        )
        .toArray()[0]
    ).toMatchObject({ delivery_status: "delivered_live", recovery_error: null });
  });

  it("cancels terminal-but-not-admitted suspensions on interrupt", async () => {
    const { instance, sql } = await createTestDO(TestAgentWorker, {
      __objectKey: "agent-test",
    });
    const worker = instance as unknown as {
      cancelMethodSuspensionsForChannel(channelId: string, reason: string): string[];
    };
    insertSuspension(sql, {
      callId: "call-1",
      terminalKind: "completed",
      result: "done",
      deliveryStatus: "delivered_live",
    });

    expect(worker.cancelMethodSuspensionsForChannel("chat-1", "user_interrupted")).toEqual([
      "call-1",
    ]);
    expect(
      sql
        .exec(
          `SELECT terminal_kind, delivery_status, recovery_error
             FROM agent_method_suspensions
             WHERE transport_call_id = ?`,
          "call-1"
        )
        .toArray()[0]
    ).toMatchObject({
      terminal_kind: "cancelled",
      delivery_status: "cancelled",
      recovery_error: "user_interrupted",
    });
  });

  it("marks dispatch failures durably and retains forensic partials", async () => {
    const { instance, sql } = await createTestDO(TestAgentWorker, {
      __objectKey: "agent-test",
    });
    const cancelCall = vi.fn().mockResolvedValue(undefined);
    const worker = instance as unknown as {
      subscriptions: {
        getParticipantId(channelId: string): string | null;
      };
      createChannelClient: ReturnType<typeof vi.fn>;
      invokeChannelMethod(
        channelId: string,
        toolCallId: string,
        participantHandle: string,
        method: string,
        args: unknown,
        signal?: AbortSignal,
        onStreamUpdate?: (content: unknown) => void,
        turnId?: string
      ): Promise<unknown>;
      appendMethodSuspensionUpdate(callId: string, content: unknown): void;
    };
    worker.subscriptions.getParticipantId = vi.fn().mockReturnValue("do:agent");
    worker.createChannelClient = vi.fn().mockReturnValue({
      getParticipants: vi.fn().mockResolvedValue([
        {
          participantId: "panel:panel-1",
          metadata: { handle: "user", type: "panel" },
        },
      ]),
      callMethod: vi.fn(async (_callerId, _targetId, callId) => {
        worker.appendMethodSuspensionUpdate(callId, { partial: "retained" });
        throw new Error("dispatch exploded");
      }),
      cancelCall,
    });

    await expect(
      worker.invokeChannelMethod("chat-1", "tool-1", "user", "eval", { code: "1" })
    ).rejects.toThrow("dispatch exploded");

    const row = sql.exec(`SELECT * FROM agent_method_suspensions`).toArray()[0]!;
    expect(row).toMatchObject({
      terminal_kind: "failed",
      delivery_status: "dispatch_failed",
      recovery_error: "dispatch_failed: dispatch exploded",
    });
    expect(
      sql.exec(`SELECT COUNT(*) AS count FROM agent_method_suspension_updates`).toArray()[0]
    ).toMatchObject({ count: 1 });
    expect(cancelCall).toHaveBeenCalledTimes(1);
  });

  it("activation cleanup clears stale typing for persisted subscriptions", async () => {
    const { instance, sql } = await createTestDO(TestAgentWorker, {
      __objectKey: "agent-test",
    });
    const setTypingState = vi.fn().mockResolvedValue(undefined);
    const worker = instance as unknown as {
      createChannelClient: ReturnType<typeof vi.fn>;
      ensureAgentActivationReady(): Promise<void>;
    };
    sql.exec(
      `INSERT INTO subscriptions (channel_id, context_id, subscribed_at, config, participant_id)
       VALUES (?, ?, ?, NULL, ?)`,
      "chat-1",
      "ctx-1",
      Date.now(),
      "do:agent"
    );
    worker.createChannelClient = vi.fn().mockReturnValue({ setTypingState });

    await worker.ensureAgentActivationReady();

    expect(setTypingState).toHaveBeenCalledWith("do:agent", false);
    const debug = await (
      instance as unknown as { getDebugState(): Promise<Record<string, unknown>> }
    ).getDebugState();
    expect(
      (debug["volatile"] as { suspensions?: { lastActivationTypingCleanup?: { count?: number } } })
        .suspensions?.lastActivationTypingCleanup?.count
    ).toBe(1);
  });
});

describe("AgentWorkerBase interrupt recovery", () => {
  it("resets dispatcher and force-closes the turn without awaiting a stuck runner interrupt", async () => {
    const { instance } = await createTestDO(InterruptTestAgentWorker, {
      __objectKey: "agent-test",
    });
    const reset = vi.fn();
    const forceCloseCurrentTurn = vi.fn().mockResolvedValue(true);
    const interrupt = vi.fn(() => new Promise<void>(() => {}));
    const worker = instance as unknown as {
      runners: Map<string, unknown>;
      dispatchers: Map<string, unknown>;
      abortContexts: Map<string, { reason: string }>;
      testInterruptRunner(channelId: string): Promise<void>;
    };

    worker.runners.set("chat-1", {
      runner: {
        forceCloseCurrentTurn,
        interrupt,
      },
    });
    worker.dispatchers.set("chat-1", { reset });

    await worker.testInterruptRunner("chat-1");

    expect(reset).toHaveBeenCalledTimes(1);
    expect(forceCloseCurrentTurn).toHaveBeenCalledWith(
      "user_interrupted",
      "Agent turn interrupted by user"
    );
    expect(interrupt).toHaveBeenCalledTimes(1);
    expect(worker.abortContexts.get("chat-1")?.reason).toBe("interrupt-channel");
  });

  it("still asks the runner to interrupt if force-close fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { instance } = await createTestDO(InterruptTestAgentWorker, {
      __objectKey: "agent-test",
    });
    const forceCloseCurrentTurn = vi.fn().mockRejectedValue(new Error("close failed"));
    const interrupt = vi.fn().mockResolvedValue(undefined);
    const worker = instance as unknown as {
      runners: Map<string, unknown>;
      dispatchers: Map<string, unknown>;
      testInterruptRunner(channelId: string): Promise<void>;
    };

    worker.runners.set("chat-1", {
      runner: {
        forceCloseCurrentTurn,
        interrupt,
      },
    });
    worker.dispatchers.set("chat-1", { reset: vi.fn() });

    await expect(worker.testInterruptRunner("chat-1")).resolves.toBeUndefined();

    expect(interrupt).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      "[TrajectoryVesselBase] forceCloseCurrentTurn failed for channel=chat-1:",
      expect.any(Error)
    );
    warn.mockRestore();
  });

  it("preserves interrupt-all abort reason while using the same reset path", async () => {
    const { instance } = await createTestDO(InterruptTestAgentWorker, {
      __objectKey: "agent-test",
    });
    const worker = instance as unknown as {
      runners: Map<string, unknown>;
      dispatchers: Map<string, unknown>;
      abortContexts: Map<string, { reason: string }>;
      testInterruptAllRunners(): Promise<void>;
    };

    for (const channelId of ["chat-1", "chat-2"]) {
      worker.runners.set(channelId, {
        runner: {
          forceCloseCurrentTurn: vi.fn().mockResolvedValue(true),
          interrupt: vi.fn().mockResolvedValue(undefined),
        },
      });
      worker.dispatchers.set(channelId, { reset: vi.fn() });
    }

    await worker.testInterruptAllRunners();

    expect(worker.abortContexts.get("chat-1")?.reason).toBe("interrupt-all");
    expect(worker.abortContexts.get("chat-2")?.reason).toBe("interrupt-all");
  });
});

describe("AgentWorkerBase typed transcript input", () => {
  it("submits panel-authored message.completed events to the runner", async () => {
    const { instance } = await createTestDO(TestAgentWorker, {
      __objectKey: "agent-test",
    });
    const submit = vi.fn();
    const worker = instance as unknown as {
      subscriptions: {
        getParticipantId(channelId: string): string | null;
      };
      getOrCreateDispatcher: ReturnType<typeof vi.fn>;
      processChannelEvent(channelId: string, event: unknown): Promise<void>;
    };

    worker.subscriptions.getParticipantId = vi.fn().mockReturnValue("do:agent");
    worker.getOrCreateDispatcher = vi.fn().mockReturnValue({ submit });

    await worker.processChannelEvent("chat-1", {
      id: 1,
      messageId: "env-1",
      type: AGENTIC_EVENT_PAYLOAD_KIND,
      senderId: "panel:panel-1",
      senderMetadata: { name: "User", type: "panel", handle: "user" },
      payload: {
        kind: "message.completed",
        actor: { kind: "panel", id: "panel:panel-1" },
        causality: { messageId: "initial-prompt" },
        payload: {
          protocol: "agentic.trajectory.v1",
          role: "user",
          content: "Read the onboarding docs first",
        },
        createdAt: "2026-05-21T08:00:00.000Z",
      },
      ts: Date.now(),
    });

    expect(submit).toHaveBeenCalledWith({ content: "Read the onboarding docs first" }, undefined);
  });
});

describe("TrajectoryVesselBase respond policy", () => {
  it("mentioned-strict does not use the 1:1 fallback", async () => {
    const { instance } = await createTestDO(StrictMentionTestAgentWorker, {
      __objectKey: "agent-test",
    });
    const worker = instance as unknown as {
      subscriptions: {
        getParticipantId(channelId: string): string | null;
      };
      cachedParticipants: Map<string, Array<{ participantId: string }>>;
      testShouldRespond(channelId: string, event: unknown): Promise<boolean>;
    };

    worker.subscriptions.getParticipantId = vi.fn().mockReturnValue("do:agent");
    worker.cachedParticipants.set("chat-1", [
      { participantId: "panel:panel-1" },
      { participantId: "do:agent" },
    ]);

    await expect(
      worker.testShouldRespond("chat-1", {
        id: 1,
        messageId: "msg-1",
        type: AGENTIC_EVENT_PAYLOAD_KIND,
        senderId: "panel:panel-1",
        payload: {
          kind: "message.completed",
          payload: { protocol: "agentic.trajectory.v1", content: "hello" },
        },
        ts: Date.now(),
      })
    ).resolves.toBe(false);

    await expect(
      worker.testShouldRespond("chat-1", {
        id: 2,
        messageId: "msg-2",
        type: AGENTIC_EVENT_PAYLOAD_KIND,
        senderId: "panel:panel-1",
        payload: {
          kind: "message.completed",
          payload: {
            protocol: "agentic.trajectory.v1",
            content: "@gmail hello",
            mentions: ["do:agent"],
          },
        },
        ts: Date.now(),
      })
    ).resolves.toBe(true);
  });

  it("covers multi-agent gating for custom updates and mention combinations", async () => {
    const { instance: chatInstance } = await createTestDO(MentionedTestAgentWorker, {
      __objectKey: "chat-agent",
    });
    const { instance: gmailInstance } = await createTestDO(StrictMentionTestAgentWorker, {
      __objectKey: "gmail-agent",
    });
    const chat = chatInstance as unknown as {
      subscriptions: { getParticipantId(channelId: string): string | null };
      cachedParticipants: Map<string, Array<{ participantId: string }>>;
      testShouldProcess(event: ChannelEvent): boolean;
      testShouldRespond(channelId: string, event: ChannelEvent): Promise<boolean>;
    };
    const gmail = gmailInstance as unknown as {
      subscriptions: { getParticipantId(channelId: string): string | null };
      cachedParticipants: Map<string, Array<{ participantId: string }>>;
      testShouldProcess(event: ChannelEvent): boolean;
      testShouldRespond(channelId: string, event: ChannelEvent): Promise<boolean>;
    };
    chat.subscriptions.getParticipantId = vi.fn().mockReturnValue("do:chat");
    gmail.subscriptions.getParticipantId = vi.fn().mockReturnValue("do:gmail");
    const participants = [
      { participantId: "panel:user" },
      { participantId: "do:chat" },
      { participantId: "do:gmail" },
    ];
    chat.cachedParticipants.set("chat-1", participants);
    gmail.cachedParticipants.set("chat-1", participants);

    const customUpdate = {
      id: 1,
      messageId: "custom-update",
      type: AGENTIC_EVENT_PAYLOAD_KIND,
      senderId: "do:gmail",
      senderMetadata: { type: "agent", handle: "gmail" },
      payload: {
        kind: "custom.updated",
        payload: { protocol: "agentic.trajectory.v1", messageId: "gmail-thread", update: {} },
      },
      ts: Date.now(),
    } satisfies ChannelEvent;
    expect(chat.testShouldProcess(customUpdate)).toBe(false);
    expect(gmail.testShouldProcess(customUpdate)).toBe(false);

    const userMessage = (mentions?: string[]) =>
      ({
        id: 2,
        messageId: crypto.randomUUID(),
        type: AGENTIC_EVENT_PAYLOAD_KIND,
        senderId: "panel:user",
        senderMetadata: { type: "panel", handle: "user" },
        payload: {
          kind: "message.completed",
          payload: {
            protocol: "agentic.trajectory.v1",
            content: "hello",
            mentions,
          },
        },
        ts: Date.now(),
      }) satisfies ChannelEvent;

    await expect(chat.testShouldRespond("chat-1", userMessage())).resolves.toBe(false);
    await expect(gmail.testShouldRespond("chat-1", userMessage())).resolves.toBe(false);
    await expect(chat.testShouldRespond("chat-1", userMessage(["do:chat"]))).resolves.toBe(true);
    await expect(gmail.testShouldRespond("chat-1", userMessage(["do:chat"]))).resolves.toBe(false);
    await expect(chat.testShouldRespond("chat-1", userMessage(["do:gmail"]))).resolves.toBe(false);
    await expect(gmail.testShouldRespond("chat-1", userMessage(["do:gmail"]))).resolves.toBe(true);
    await expect(
      chat.testShouldRespond("chat-1", userMessage(["do:chat", "do:gmail"]))
    ).resolves.toBe(true);
    await expect(
      gmail.testShouldRespond("chat-1", userMessage(["do:chat", "do:gmail"]))
    ).resolves.toBe(true);
  });
});

describe("TrajectoryVesselBase custom message recovery", () => {
  it("indexes own custom messages across paginated channel replay and folds reducers", async () => {
    const { instance } = await createTestDO(CustomMessageIndexTestAgentWorker, {
      __objectKey: "agent-test",
    });
    const worker = instance as unknown as {
      subscriptions: {
        getParticipantId(channelId: string): string | null;
      };
      createChannelClient: ReturnType<typeof vi.fn>;
      testIndexOwnCustomMessages(
        channelId: string,
        reducerLookup?: (typeId: string) => CustomMessageReducer | undefined | null
      ): Promise<Map<string, Map<string, unknown>>>;
    };

    (instance as unknown as {
      _rpc: {
        call: ReturnType<typeof vi.fn>;
        streamCall: ReturnType<typeof vi.fn>;
        emit: ReturnType<typeof vi.fn>;
        onEvent: ReturnType<typeof vi.fn>;
        handleIncomingPost: ReturnType<typeof vi.fn>;
      };
    })._rpc = {
      call: vi.fn(async (_target: string, method: string, args: unknown[]) => {
        if (method === "blobstore.getText" && args[0] === "custom-initial-digest") {
          return JSON.stringify({ count: 0 });
        }
        if (method === "blobstore.getText" && args[0] === "custom-update-digest") {
          return JSON.stringify({ delta: 1 });
        }
        return null;
      }),
      streamCall: vi.fn(),
      emit: vi.fn(),
      onEvent: vi.fn(),
      handleIncomingPost: vi.fn(),
    };
    worker.subscriptions.getParticipantId = vi.fn().mockReturnValue("do:agent");

    const events = [
      {
        id: 1,
        messageId: "start-1",
        type: AGENTIC_EVENT_PAYLOAD_KIND,
        senderId: "do:agent",
        payload: {
          kind: "custom.started",
          actor: { kind: "agent", id: "do:agent" },
          payload: {
            protocol: "agentic.trajectory.v1",
            messageId: "custom-1",
            typeId: "gmail.thread",
            initialState: {
              protocol: "natstack.blob-ref.v1",
              digest: "custom-initial-digest",
              size: 11,
              encoding: "json",
              originalBytes: 11,
            },
          },
          createdAt: new Date().toISOString(),
        },
        ts: Date.now(),
      },
      {
        id: 2,
        messageId: "other-start",
        type: AGENTIC_EVENT_PAYLOAD_KIND,
        senderId: "panel:panel-1",
        payload: {
          kind: "custom.started",
          actor: { kind: "panel", id: "panel:panel-1" },
          payload: {
            protocol: "agentic.trajectory.v1",
            messageId: "custom-other",
            typeId: "gmail.thread",
            initialState: { count: 100 },
          },
          createdAt: new Date().toISOString(),
        },
        ts: Date.now(),
      },
      ...Array.from({ length: 501 }, (_, index) => ({
        id: index + 3,
        messageId: `update-${index + 1}`,
        type: AGENTIC_EVENT_PAYLOAD_KIND,
        senderId: "do:agent",
        payload: {
          kind: "custom.updated",
          actor: { kind: "agent", id: "do:agent" },
          payload: {
            protocol: "agentic.trajectory.v1",
            messageId: "custom-1",
            update: {
              protocol: "natstack.blob-ref.v1",
              digest: "custom-update-digest",
              size: 11,
              encoding: "json",
              originalBytes: 11,
            },
          },
          createdAt: new Date().toISOString(),
        },
        ts: Date.now(),
      })),
    ];

    worker.createChannelClient = vi.fn().mockReturnValue({
      getReplayAfter: vi.fn(async (cursor: number) => ({
        mode: "after",
        logEvents: events.filter((event) => event.id > cursor).slice(0, 500),
        snapshots: [],
        ready: { totalCount: events.length, envelopeCount: events.length },
      })),
    });

    const result = await worker.testIndexOwnCustomMessages("chat-1", (typeId) => {
      if (typeId !== "gmail.thread") return undefined;
      return (state, update) => ({
        count:
          ((state as { count?: number } | undefined)?.count ?? 0) +
          ((update as { delta?: number } | undefined)?.delta ?? 0),
      });
    });

    expect(result.get("gmail.thread")?.get("custom-1")).toEqual({ count: 501 });
    expect(result.get("gmail.thread")?.has("custom-other")).toBe(false);
  });
});

describe("AgentWorkerBase fork subscription state", () => {
  it("starts cloned agents after the fork point and subscribes without replay", async () => {
    const { instance, sql } = await createTestDO(CloneTestAgentWorker, {
      __objectKey: "agent-fork",
      WORKER_SOURCE: "workers/test-agent",
      WORKER_CLASS_NAME: "TestAgentWorker",
    });
    const gadCall = vi.fn().mockResolvedValue({
      copied: 1,
      headEventHash: "hash-fork",
      headStateHash: "state-fork",
      lineage: [],
    });
    (instance as unknown as { gad: { call: typeof gadCall } }).gad = { call: gadCall };

    sql.exec(
      `INSERT INTO subscriptions (channel_id, context_id, subscribed_at, config, participant_id)
       VALUES (?, ?, ?, ?, ?)`,
      "channel-parent",
      "ctx-1",
      Date.now(),
      JSON.stringify({ approvalLevel: 2 }),
      "do:workers/test-agent:TestAgentWorker:agent-parent"
    );
    sql.exec(
      `INSERT INTO delivery_cursor (channel_id, last_delivered_seq) VALUES (?, ?)`,
      "channel-parent",
      10
    );

    await instance.postClone("agent-parent", "channel-fork", "channel-parent", 42);

    expect(gadCall).toHaveBeenCalledWith(
      "forkTrajectoryBranch",
      expect.objectContaining({
        fromTrajectoryId: "branch:channel:channel-parent",
        fromBranchId: "branch:channel:channel-parent",
        toTrajectoryId: "branch:channel:channel-fork",
        toBranchId: "branch:channel:channel-fork",
        throughPublishedChannelId: "channel-parent",
        throughPublishedChannelSeq: 42,
        toPublishedChannelId: "channel-fork",
      })
    );
    expect(instance.subscribeCalls).toEqual([
      expect.objectContaining({
        channelId: "channel-fork",
        contextId: "ctx-1",
        replay: false,
      }),
    ]);
    expect(sql.exec(`SELECT * FROM delivery_cursor`).toArray()).toEqual([
      { channel_id: "channel-fork", last_delivered_seq: 42 },
    ]);
  });
});

describe("AgentWorkerBase dispatched method results", () => {
  it("waits for the canonical invocation completion before completing the tool call", async () => {
    const { instance } = await createTestDO(TestAgentWorker, {
      __objectKey: "agent-test",
    });
    let capturedCallId = "";
    let capturedOpts:
      | { invocationId?: string; transportCallId?: string; turnId?: string }
      | undefined;
    const worker = instance as unknown as {
      subscriptions: {
        getParticipantId(channelId: string): string | null;
      };
      runners: Map<string, { runner: { abort: ReturnType<typeof vi.fn> } }>;
      createChannelClient: ReturnType<typeof vi.fn>;
      handleIncomingChannelEvent(channelId: string, event: unknown): Promise<void>;
      invokeChannelMethod(
        channelId: string,
        toolCallId: string,
        participantHandle: string,
        method: string,
        args: unknown,
        signal?: AbortSignal,
        onStreamUpdate?: (content: unknown) => void,
        turnId?: string
      ): Promise<unknown>;
    };

    worker.subscriptions.getParticipantId = vi.fn().mockReturnValue("do:agent");
    worker.createChannelClient = vi.fn().mockReturnValue({
      getParticipants: vi.fn().mockResolvedValue([
        {
          participantId: "panel:panel-1",
          metadata: { handle: "user", type: "panel" },
        },
      ]),
      callMethod: vi.fn(async (_callerId, _targetId, callId, _method, _args, opts) => {
        capturedCallId = callId;
        capturedOpts = opts;
        await worker.handleIncomingChannelEvent("chat-1", {
          id: 1,
          messageId: "result-1",
          type: AGENTIC_EVENT_PAYLOAD_KIND,
          payload: {
            kind: "invocation.completed",
            actor: { kind: "panel", id: "panel:panel-1" },
            causality: { invocationId: opts.invocationId, transportCallId: opts.transportCallId },
            payload: { protocol: "agentic.trajectory.v1", result: { ok: true } },
            createdAt: new Date().toISOString(),
          },
          senderId: "panel:panel-1",
          ts: Date.now(),
        });
      }),
    });
    const abort = vi.fn().mockResolvedValue(undefined);
    worker.runners.set("chat-1", { runner: { abort } });

    const result = await worker.invokeChannelMethod(
      "chat-1",
      "tool-1",
      "user",
      "eval",
      { code: "1 + 1" },
      undefined,
      undefined,
      "turn-1"
    );

    expect(result).toEqual({
      content: [{ type: "text", text: '{"ok":true}' }],
      details: undefined,
    });
    expect(abort).not.toHaveBeenCalled();
    expect(capturedCallId).toEqual(expect.any(String));
    expect(capturedCallId).not.toBe("tool-1");
    expect(capturedOpts).toEqual({
      invocationId: "tool-1",
      transportCallId: capturedCallId,
      turnId: "turn-1",
    });
  });

  it("returns participant method failures as tool error results", async () => {
    const { instance } = await createTestDO(TestAgentWorker, {
      __objectKey: "agent-test",
    });
    const worker = instance as unknown as {
      subscriptions: {
        getParticipantId(channelId: string): string | null;
      };
      createChannelClient: ReturnType<typeof vi.fn>;
      handleIncomingChannelEvent(channelId: string, event: unknown): Promise<void>;
      invokeChannelMethod(
        channelId: string,
        toolCallId: string,
        participantHandle: string,
        method: string,
        args: unknown,
        signal?: AbortSignal,
        onStreamUpdate?: (content: unknown) => void,
        turnId?: string
      ): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>;
    };

    worker.subscriptions.getParticipantId = vi.fn().mockReturnValue("do:agent");
    worker.createChannelClient = vi.fn().mockReturnValue({
      getParticipants: vi.fn().mockResolvedValue([
        {
          participantId: "panel:panel-1",
          metadata: { handle: "user", type: "panel" },
        },
      ]),
      callMethod: vi.fn(async (_callerId, _targetId, _callId, _method, _args, opts) => {
        await worker.handleIncomingChannelEvent("chat-1", {
          id: 1,
          messageId: "result-failed",
          type: AGENTIC_EVENT_PAYLOAD_KIND,
          payload: {
            kind: "invocation.failed",
            actor: { kind: "panel", id: "panel:panel-1" },
            causality: { invocationId: opts.invocationId, transportCallId: opts.transportCallId },
            payload: {
              protocol: "agentic.trajectory.v1",
              reason: "method failed",
              error: { error: "Authentication failed for internal push" },
            },
            createdAt: new Date().toISOString(),
          },
          senderId: "panel:panel-1",
          ts: Date.now(),
        });
      }),
    });

    const result = await worker.invokeChannelMethod(
      "chat-1",
      "tool-1",
      "user",
      "eval",
      { code: "throw new Error()" },
      undefined,
      undefined,
      "turn-1"
    );

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toBe("Authentication failed for internal push");
  });

  it("clears stale typing and ignores method results without a durable suspension row", async () => {
    const { instance } = await createTestDO(TestAgentWorker, {
      __objectKey: "agent-test",
    });
    const setTypingState = vi.fn().mockResolvedValue(undefined);
    const worker = instance as unknown as {
      subscriptions: {
        getParticipantId(channelId: string): string | null;
      };
      createChannelClient: ReturnType<typeof vi.fn>;
      handleIncomingChannelEvent(channelId: string, event: unknown): Promise<void>;
      runners: Map<string, unknown>;
    };

    worker.subscriptions.getParticipantId = vi.fn().mockReturnValue("do:agent");
    worker.createChannelClient = vi.fn().mockReturnValue({
      setTypingState,
    });

    await worker.handleIncomingChannelEvent("chat-1", {
      id: 1,
      messageId: "orphan-result",
      type: AGENTIC_EVENT_PAYLOAD_KIND,
      payload: {
        kind: "invocation.failed",
        actor: { kind: "panel", id: "panel:panel-1" },
        causality: { invocationId: "tool-1", transportCallId: "transport-lost" },
        payload: {
          protocol: "agentic.trajectory.v1",
          reason: "method failed",
          error: "Authentication failed",
        },
        createdAt: new Date().toISOString(),
      },
      senderId: "panel:panel-1",
      ts: Date.now(),
    });

    expect(setTypingState).toHaveBeenCalledWith("do:agent", false);
    expect(worker.runners.has("chat-1")).toBe(false);
  });

  it("does not treat local invocation completion events as channel method results", async () => {
    const { instance } = await createTestDO(TestAgentWorker, {
      __objectKey: "agent-test",
    });
    const setTypingState = vi.fn().mockResolvedValue(undefined);
    const worker = instance as unknown as {
      subscriptions: {
        getParticipantId(channelId: string): string | null;
      };
      createChannelClient: ReturnType<typeof vi.fn>;
      handleIncomingChannelEvent(channelId: string, event: unknown): Promise<void>;
      runners: Map<string, unknown>;
    };

    worker.subscriptions.getParticipantId = vi.fn().mockReturnValue("do:agent");
    worker.createChannelClient = vi.fn().mockReturnValue({
      setTypingState,
    });

    await worker.handleIncomingChannelEvent("chat-1", {
      id: 1,
      messageId: "local-result",
      type: AGENTIC_EVENT_PAYLOAD_KIND,
      payload: {
        kind: "invocation.completed",
        actor: { kind: "agent", id: "do:agent" },
        causality: { invocationId: "tool-1" },
        payload: {
          protocol: "agentic.trajectory.v1",
          result: { ok: true },
        },
        createdAt: new Date().toISOString(),
      },
      senderId: "do:agent",
      ts: Date.now(),
    });

    expect(setTypingState).not.toHaveBeenCalled();
    expect(worker.runners.has("chat-1")).toBe(false);
  });

  it("cancels the channel pending call when an in-flight method call aborts", async () => {
    const { instance } = await createTestDO(TestAgentWorker, {
      __objectKey: "agent-test",
    });
    const controller = new AbortController();
    const cancelCall = vi.fn().mockResolvedValue(undefined);
    let capturedCallId = "";
    let resolveCallStarted!: () => void;
    const callStarted = new Promise<void>((resolve) => {
      resolveCallStarted = resolve;
    });
    const worker = instance as unknown as {
      subscriptions: {
        getParticipantId(channelId: string): string | null;
      };
      createChannelClient: ReturnType<typeof vi.fn>;
      invokeChannelMethod(
        channelId: string,
        toolCallId: string,
        participantHandle: string,
        method: string,
        args: unknown,
        signal?: AbortSignal
      ): Promise<unknown>;
    };

    worker.subscriptions.getParticipantId = vi.fn().mockReturnValue("do:agent");
    worker.createChannelClient = vi.fn().mockReturnValue({
      getParticipants: vi.fn().mockResolvedValue([
        {
          participantId: "panel:panel-1",
          metadata: { handle: "user", type: "panel" },
        },
      ]),
      callMethod: vi.fn(async (_callerId, _targetId, callId) => {
        capturedCallId = callId;
        resolveCallStarted();
      }),
      cancelCall,
    });

    const pending = worker.invokeChannelMethod(
      "chat-1",
      "tool-1",
      "user",
      "eval",
      { code: "1 + 1" },
      controller.signal
    );
    await callStarted;
    controller.abort();

    await expect(pending).rejects.toThrow("Request was aborted");
    expect(cancelCall).toHaveBeenCalledWith(capturedCallId);
  });

  it("exposes an open dispatched method call in debug state without timing it out", async () => {
    const { instance } = await createTestDO(TestAgentWorker, {
      __objectKey: "agent-test",
    });
    const controller = new AbortController();
    let capturedCallId = "";
    let resolveCallStarted!: () => void;
    const callStarted = new Promise<void>((resolve) => {
      resolveCallStarted = resolve;
    });
    const worker = instance as unknown as {
      subscriptions: {
        getParticipantId(channelId: string): string | null;
      };
      createChannelClient: ReturnType<typeof vi.fn>;
      invokeChannelMethod(
        channelId: string,
        toolCallId: string,
        participantHandle: string,
        method: string,
        args: unknown,
        signal?: AbortSignal,
        onStreamUpdate?: (content: unknown) => void,
        turnId?: string
      ): Promise<unknown>;
      getDebugState(channelId?: string): Promise<Record<string, unknown>>;
      runners: Map<string, { runner: { getDebugState(): Promise<Record<string, unknown>> } }>;
    };

    worker.subscriptions.getParticipantId = vi.fn().mockReturnValue("do:agent");
    worker.runners.set("chat-1", {
      runner: {
        getDebugState: vi.fn(async () => ({
          running: true,
          currentTurnId: "turn-open",
          phase: {
            currentOperation: { kind: "prompt", startedAt: "2026-05-23T00:00:00.000Z" },
            awaitingProviderFirstEvent: true,
          },
        })),
      },
    });
    worker.createChannelClient = vi.fn().mockReturnValue({
      getParticipants: vi.fn().mockResolvedValue([
        {
          participantId: "panel:panel-1",
          metadata: { handle: "user", type: "panel" },
        },
      ]),
      callMethod: vi.fn(async (_callerId, _targetId, callId, _method, _args, opts) => {
        capturedCallId = callId;
        expect(opts).not.toHaveProperty("timeoutMs");
        resolveCallStarted();
      }),
      cancelCall: vi.fn().mockResolvedValue(undefined),
    });

    const pending = worker.invokeChannelMethod(
      "chat-1",
      "tool-open",
      "user",
      "eval",
      { code: "await forever()" },
      controller.signal,
      undefined,
      "turn-open"
    );
    await callStarted;

    const debug = (await worker.getDebugState("chat-1")) as {
      volatile?: {
        methodResultWaiters?: Array<Record<string, unknown>>;
        runners?: Record<string, Record<string, unknown>>;
      };
    };
    expect(debug.volatile?.runners?.["chat-1"]).toEqual(
      expect.objectContaining({
        running: true,
        currentTurnId: "turn-open",
        phase: expect.objectContaining({ awaitingProviderFirstEvent: true }),
      })
    );
    expect(debug.volatile?.methodResultWaiters).toEqual([
      expect.objectContaining({
        callId: capturedCallId,
        channelId: "chat-1",
        invocationId: "tool-open",
        method: "eval",
        participantHandle: "user",
        targetParticipantId: "panel:panel-1",
        turnId: "turn-open",
        argsSummary: { code: "await forever()" },
      }),
    ]);

    controller.abort();
    await expect(pending).rejects.toThrow("Request was aborted");
  });
});

describe("AgentWorkerBase model credential resume", () => {
  it("does not wait on interruption diagnostics or credential card delivery before failing auth", async () => {
    const { instance } = await createTestDO(TestAgentWorker, {
      __objectKey: "agent-test",
    });
    const sendSignal = vi.fn(() => new Promise<void>(() => undefined));
    const channelClient = {
      getParticipants: vi.fn(() => new Promise(() => undefined)),
      sendSignal,
    };
    const worker = instance as unknown as {
      _rpc: {
        call: ReturnType<typeof vi.fn>;
        streamCall: ReturnType<typeof vi.fn>;
        emit: ReturnType<typeof vi.fn>;
        onEvent: ReturnType<typeof vi.fn>;
        handleIncomingPost: ReturnType<typeof vi.fn>;
      };
      subscriptions: {
        getParticipantId(channelId: string): string | null;
      };
      runners: Map<string, unknown>;
      createChannelClient: ReturnType<typeof vi.fn>;
      getModelBaseUrl(channelId: string): string;
      getApiKeyForChannel(channelId: string): () => Promise<string>;
      readRunnerMessages(channelId: string): Promise<AgentMessage[]>;
    };

    worker._rpc = {
      call: vi.fn(async () => null),
      streamCall: vi.fn(),
      emit: vi.fn(),
      onEvent: vi.fn(),
      handleIncomingPost: vi.fn(),
    };
    worker.subscriptions.getParticipantId = vi.fn().mockReturnValue("do:agent");
    worker.createChannelClient = vi.fn().mockReturnValue(channelClient);
    worker.getModelBaseUrl = vi.fn().mockReturnValue("https://model.example/v1");
    worker.readRunnerMessages = vi.fn(() => new Promise<AgentMessage[]>(() => undefined));
    worker.runners.set("chat-1", { runner: {} });

    await expect(worker.getApiKeyForChannel("chat-1")()).rejects.toThrow(
      "No URL-bound model credential is configured for model provider: test"
    );

    expect(worker.readRunnerMessages).toHaveBeenCalledWith("chat-1");
    expect(channelClient.getParticipants).not.toHaveBeenCalled();
    expect(sendSignal).toHaveBeenCalledTimes(1);
  });

  it("propagates user interruption to in-flight model credential resolution", async () => {
    const { instance } = await createTestDO(TestAgentWorker, {
      __objectKey: "agent-test",
    });
    let capturedSignal: AbortSignal | undefined;
    let markCallStarted!: () => void;
    const callStarted = new Promise<void>((resolve) => {
      markCallStarted = resolve;
    });
    const worker = instance as unknown as {
      _rpc: {
        call: ReturnType<typeof vi.fn>;
        streamCall: ReturnType<typeof vi.fn>;
        emit: ReturnType<typeof vi.fn>;
        onEvent: ReturnType<typeof vi.fn>;
        handleIncomingPost: ReturnType<typeof vi.fn>;
      };
      getModelBaseUrl(channelId: string): string;
      getApiKeyForChannel(channelId: string): () => Promise<string>;
      interruptRunner(channelId: string): Promise<void>;
    };

    worker._rpc = {
      call: vi.fn((_target, _method, _args, opts?: { signal?: AbortSignal }) => {
        capturedSignal = opts?.signal;
        markCallStarted();
        return new Promise((_resolve, reject) => {
          opts?.signal?.addEventListener(
            "abort",
            () => reject(opts.signal?.reason ?? new Error("aborted")),
            { once: true }
          );
        });
      }),
      streamCall: vi.fn(),
      emit: vi.fn(),
      onEvent: vi.fn(),
      handleIncomingPost: vi.fn(),
    };
    worker.getModelBaseUrl = vi.fn().mockReturnValue("https://model.example/v1");

    const pending = worker.getApiKeyForChannel("chat-1")();
    await callStarted;
    await worker.interruptRunner("chat-1");

    expect(capturedSignal?.aborted).toBe(true);
    await expect(pending).rejects.toThrow(/aborted/i);
  });

  it("resumes from the saved interruption cursor after an assistant error is appended", async () => {
    const { instance } = await createTestDO(TestAgentWorker, {
      __objectKey: "agent-test",
    });
    const userMessage = { role: "user", content: "hello", timestamp: 1 } as AgentMessage;
    const assistantError = {
      role: "assistant",
      content: [],
      timestamp: 2,
      api: "openai",
      provider: "test",
      model: "model",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: 0,
        },
      },
      stopReason: "error",
      errorMessage: "model auth failed",
    } as AgentMessage;
    let transcript: AgentMessage[] = [userMessage];
    const moveTo = vi.fn().mockResolvedValue(undefined);
    const submitContinue = vi.fn();
    const worker = instance as unknown as {
      subscriptions: {
        getParticipantId(channelId: string): string | null;
      };
      runners: Map<string, unknown>;
      createChannelClient: ReturnType<typeof vi.fn>;
      getOrCreateDispatcher: ReturnType<typeof vi.fn>;
      recordModelCredentialInterruption(
        channelId: string,
        providerId: string,
        modelBaseUrl: string
      ): Promise<void>;
      resumeAfterModelCredentialConnected(
        channelId: string,
        opts?: { providerId?: string; modelBaseUrl?: string }
      ): Promise<boolean>;
    };

    worker.subscriptions.getParticipantId = vi.fn().mockReturnValue("do:agent");
    worker.createChannelClient = vi.fn().mockReturnValue({
      getParticipants: vi.fn().mockResolvedValue([]),
    });
    worker.runners.set("chat-1", {
      runner: {
        session: {
          buildContext: vi.fn(async () => ({ messages: transcript })),
          getEntries: vi.fn(async () => [
            { id: "entry-user", type: "message" },
            { id: "entry-assistant-error", type: "message" },
          ]),
          moveTo,
        },
      },
    });
    worker.getOrCreateDispatcher = vi.fn().mockReturnValue({ submitContinue });

    await worker.recordModelCredentialInterruption("chat-1", "test", "https://model.example/v1");
    transcript = [userMessage, assistantError];

    await expect(
      worker.resumeAfterModelCredentialConnected("chat-1", {
        providerId: "test",
        modelBaseUrl: "https://model.example/v1",
      })
    ).resolves.toBe(true);

    expect(moveTo).toHaveBeenCalledWith("entry-user");
    expect(submitContinue).toHaveBeenCalledTimes(1);
  });
});
