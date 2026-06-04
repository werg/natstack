import { describe, expect, it } from "vitest";
import { vi } from "vitest";
import { createTestDO } from "@workspace/runtime/worker/test-utils";
import type { AgentMessage } from "@earendil-works/pi-agent-core";

import { AgentWorkerBase } from "./agent-worker-base.js";
import type { RespondPolicy, CustomMessageReducer } from "./trajectory-vessel-base.js";
import type { TurnDispatcherRunner } from "./turn-dispatcher.js";
import type { ChannelEvent } from "@workspace/harness";
import type { PiRunner, PiRunnerOptions } from "@workspace/harness";
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

  public testHandleRunnerMessageEndForTurnLedger(
    channelId: string,
    runner: Pick<PiRunner, "getCurrentTurnId" | "session">,
    message: AgentMessage
  ): Promise<void> {
    return this.handleRunnerMessageEndForTurnLedger(channelId, runner, message);
  }

  public testHandleRunnerAgentEndForTurnLedger(channelId: string, runner: PiRunner): Promise<void> {
    return this.handleRunnerAgentEndForTurnLedger(channelId, runner);
  }

  public testHandleRunnerAgentEndEventForTurnLedger(
    channelId: string,
    runner: PiRunner,
    event: Parameters<TestAgentWorker["handleRunnerAgentEndForTurnLedger"]>[2]
  ): Promise<void> {
    return this.handleRunnerAgentEndForTurnLedger(channelId, runner, event);
  }

  public testResizeAttachments(
    channelId: string,
    attachments: ChannelEvent["attachments"]
  ): Promise<unknown> {
    return (
      this as unknown as {
        resizeAttachments(
          channelId: string,
          attachments: ChannelEvent["attachments"]
        ): Promise<unknown>;
      }
    ).resizeAttachments(channelId, attachments);
  }

  public testInsertTurnRunWithCheckpoint(
    channelId: string,
    turnId: string,
    checkpoint?: { entryId?: string | null; phase?: "turn_open" | "model_start" }
  ): void {
    (
      this as unknown as {
        insertTurnRun(
          channelId: string,
          turnId: string,
          checkpoint?: { entryId?: string | null; phase?: "turn_open" | "model_start" }
        ): void;
      }
    ).insertTurnRun(channelId, turnId, checkpoint);
  }

  public testCaptureTurnCheckpoint(
    channelId: string,
    turnId: string,
    runner: Pick<PiRunner, "session">,
    phase: "turn_open" | "model_start"
  ): Promise<string | null> {
    return (
      this as unknown as {
        captureTurnCheckpoint(
          channelId: string,
          turnId: string,
          runner: Pick<PiRunner, "session">,
          phase: "turn_open" | "model_start"
        ): Promise<string | null>;
      }
    ).captureTurnCheckpoint(channelId, turnId, runner, phase);
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

class ReplayEnabledTestAgentWorker extends TestAgentWorker {
  protected override canReplayInterruptedModelTurn(): boolean {
    return true;
  }

  protected override getBuiltInTools(
    _channelId: string
  ): NonNullable<PiRunnerOptions["extraTools"]> {
    return [];
  }

  protected override getRunnerToolFilter(_channelId: string): PiRunnerOptions["toolFilter"] {
    const unsafeHarnessTools = new Set(["edit", "write", "web_search", "web_fetch", "web_read"]);
    return (toolName) => !unsafeHarnessTools.has(toolName);
  }
}

class ReplayEnabledUnfilteredAgentWorker extends TestAgentWorker {
  protected override canReplayInterruptedModelTurn(): boolean {
    return true;
  }

  protected override getBuiltInTools(
    _channelId: string
  ): NonNullable<PiRunnerOptions["extraTools"]> {
    return [];
  }
}

class ReplayEnabledUnsafeToolAgentWorker extends ReplayEnabledTestAgentWorker {
  protected override getRunnerTools(_channelId: string): PiRunnerOptions["extraTools"] {
    return [
      {
        name: "unsafe_mutation",
        label: "unsafe_mutation",
        description: "Mutates external state without durable journaling.",
        parameters: { type: "object", properties: {}, additionalProperties: false } as never,
        execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
      },
    ];
  }
}

class LeaseBarrierTestAgentWorker extends TestAgentWorker {
  leaseStarted = 0;
  resolveLease: (() => void) | null = null;
  private leasePromise = new Promise<void>((resolve) => {
    this.resolveLease = resolve;
  });

  protected override markCheckpointableWorkActive(_detail?: unknown): Promise<void> {
    this.leaseStarted += 1;
    return this.leasePromise;
  }

  public testDispatcher(channelId: string, runner: TurnDispatcherRunner) {
    return this.getOrCreateDispatcher(channelId, runner as PiRunner);
  }

  public testTransitionCurrentTurnToWaiting(channelId: string, turnId: string): Promise<string> {
    return (
      this as unknown as {
        transitionCurrentTurnToWaiting(channelId: string, turnId?: string): Promise<string>;
      }
    ).transitionCurrentTurnToWaiting(channelId, turnId);
  }
}

class ReplayEnabledSafeToolAgentWorker extends ReplayEnabledTestAgentWorker {
  protected override getRunnerTools(_channelId: string): PiRunnerOptions["extraTools"] {
    return [
      {
        name: "safe_lookup",
        label: "safe_lookup",
        description: "Pure read tool.",
        parameters: { type: "object", properties: {}, additionalProperties: false } as never,
        natstackReplay: { safety: "pure-read" },
        execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
      } as NonNullable<PiRunnerOptions["extraTools"]>[number] & {
        natstackReplay: { safety: "pure-read" };
      },
    ];
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

class GatingTestAgentWorker extends StrictMentionTestAgentWorker {
  refreshCount = 0;
  runnerCount = 0;

  protected override async refreshRoster(channelId: string): Promise<void> {
    this.refreshCount++;
    await super.refreshRoster(channelId);
  }

  protected override async getOrCreateRunner(channelId: string): Promise<PiRunner> {
    this.runnerCount++;
    return super.getOrCreateRunner(channelId);
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

class ExpectedToolGateTestWorker extends AgentWorkerBase {
  public readonly prompt = vi.fn(async () => undefined);
  public readonly emittedDiagnostics: string[] = [];

  protected override getExpectedChannelToolNames(_channelId: string): readonly string[] {
    return ["eval"];
  }

  protected override getExpectedChannelToolReadinessTimeoutMs(_channelId: string): number {
    return 0;
  }

  protected override async getOrCreateRunner(channelId: string): Promise<PiRunner> {
    const runners = (this as unknown as { runners: Map<string, { runner: PiRunner }> }).runners;
    const existing = runners.get(channelId)?.runner;
    if (existing) return existing;
    const runner = {
      subscribe: vi.fn(() => vi.fn()),
      buildUserMessage: vi.fn((input: { content: string }) => ({
        role: "user",
        content: [{ type: "text", text: input.content }],
      })),
      prompt: this.prompt,
      continueAgent: vi.fn(async () => undefined),
      steerMessage: vi.fn(async () => undefined),
      clearSteeringQueue: vi.fn(async () => undefined),
    } as unknown as PiRunner;
    runners.set(channelId, { runner });
    this.getOrCreateDispatcher(channelId, runner);
    return runner;
  }

  protected override createChannelClient(_channelId: string): never {
    return {
      getParticipants: vi.fn(async () => []),
      send: vi.fn(async (_participantId: string, _messageId: string, content: string) => {
        this.emittedDiagnostics.push(content);
      }),
      setTypingState: vi.fn(async () => undefined),
    } as never;
  }
}

class RunnerInitGateTestWorker extends AgentWorkerBase {
  public createRunnerCalls = 0;

  protected override getExpectedChannelToolNames(_channelId: string): readonly string[] {
    return ["eval"];
  }

  protected override getExpectedChannelToolReadinessTimeoutMs(_channelId: string): number {
    return 0;
  }

  protected override createRunner(channelId: string, opts: PiRunnerOptions): PiRunner {
    this.createRunnerCalls++;
    return super.createRunner(channelId, opts);
  }

  protected override createChannelClient(_channelId: string): never {
    return {
      getParticipants: vi.fn(async () => []),
    } as never;
  }

  public testGetOrCreateRunner(channelId: string): Promise<PiRunner> {
    return this.getOrCreateRunner(channelId);
  }
}

class SingleFlightRunnerInitTestWorker extends AgentWorkerBase {
  public createRunnerCalls = 0;
  private resolveInitStarted: () => void = () => undefined;
  private resolveInitGate: () => void = () => undefined;

  public readonly initStarted = new Promise<void>((resolve) => {
    this.resolveInitStarted = resolve;
  });

  private readonly initGate = new Promise<void>((resolve) => {
    this.resolveInitGate = resolve;
  });

  protected override getDefaultModel(): string {
    return "test:model";
  }

  protected override createRunner(_channelId: string, _opts: PiRunnerOptions): PiRunner {
    this.createRunnerCalls++;
    return {
      init: vi.fn(async () => {
        this.resolveInitStarted();
        await this.initGate;
      }),
      hooks: { on: vi.fn(() => vi.fn()) },
      subscribe: vi.fn(() => vi.fn()),
      repairDurableOpenState: vi.fn(async () => undefined),
      getDebugState: vi.fn(() => ({})),
      session: null,
    } as unknown as PiRunner;
  }

  protected override createChannelClient(_channelId: string): never {
    return {
      getParticipants: vi.fn(async () => []),
    } as never;
  }

  public releaseRunnerInit(): void {
    this.resolveInitGate();
  }

  public testGetOrCreateRunner(channelId: string): Promise<PiRunner> {
    return this.getOrCreateRunner(channelId);
  }

  public testDispatcher(channelId: string, runner: PiRunner): TurnDispatcherRunner {
    return this.getOrCreateDispatcher(channelId, runner) as unknown as TurnDispatcherRunner;
  }

  public testDispatcherRunner(channelId: string): PiRunner | undefined {
    return (this as unknown as { dispatcherRunners: Map<string, PiRunner> }).dispatcherRunners.get(
      channelId
    );
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

  it("refuses to initialize a runner when required channel tools are absent", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { instance } = await createTestDO(RunnerInitGateTestWorker, {
      __objectKey: "agent-test",
    });

    await expect(instance.testGetOrCreateRunner("chat-1")).rejects.toThrow(
      "Cannot start agent model turn: missing expected channel tool(s): eval"
    );

    expect(instance.createRunnerCalls).toBe(0);
    expect(error).toHaveBeenCalledWith(
      "[TrajectoryVesselBase] Expected channel tools were not available",
      expect.objectContaining({
        reason: "runner.init",
        missingExpectedChannelToolNames: ["eval"],
        rosterToolNames: [],
        participantCount: 0,
      })
    );
    error.mockRestore();
  });

  it("single-flights concurrent runner initialization for the same channel", async () => {
    const { instance, sql } = await createTestDO(SingleFlightRunnerInitTestWorker, {
      __objectKey: "agent-test",
    });
    sql.exec(
      `INSERT INTO subscriptions (channel_id, context_id, subscribed_at, config, participant_id)
       VALUES (?, ?, ?, ?, ?)`,
      "chat-1",
      "ctx-1",
      Date.now(),
      null,
      "do:agent"
    );

    const first = instance.testGetOrCreateRunner("chat-1");
    await instance.initStarted;
    const second = instance.testGetOrCreateRunner("chat-1");

    expect(instance.createRunnerCalls).toBe(1);

    instance.releaseRunnerInit();
    const [firstRunner, secondRunner] = await Promise.all([first, second]);
    const thirdRunner = await instance.testGetOrCreateRunner("chat-1");

    expect(firstRunner).toBe(secondRunner);
    expect(thirdRunner).toBe(firstRunner);
    expect(instance.testDispatcherRunner("chat-1")).toBe(firstRunner);
    await expect(instance.getDebugState("chat-1")).resolves.toMatchObject({
      volatile: {
        dispatcherBindings: {
          "chat-1": {
            matchesCanonicalRunner: true,
            hasCanonicalRunner: true,
          },
        },
      },
    });
    expect(instance.createRunnerCalls).toBe(1);
  });

  it("rebinds a stale dispatcher to the canonical channel runner", async () => {
    const { instance } = await createTestDO(SingleFlightRunnerInitTestWorker, {
      __objectKey: "agent-test",
    });
    const staleUnsubscribe = vi.fn();
    const staleRunner = {
      subscribe: vi.fn(() => staleUnsubscribe),
      clearSteeringQueue: vi.fn(async () => undefined),
      getDebugState: vi.fn(() => ({})),
    } as unknown as PiRunner;
    const canonicalRunner = {
      subscribe: vi.fn(() => vi.fn()),
      clearSteeringQueue: vi.fn(async () => undefined),
      getDebugState: vi.fn(() => ({})),
    } as unknown as PiRunner;
    const worker = instance as unknown as {
      runners: Map<string, { runner: PiRunner }>;
    };

    const staleDispatcher = instance.testDispatcher("chat-1", staleRunner);
    expect(instance.testDispatcherRunner("chat-1")).toBe(staleRunner);

    worker.runners.set("chat-1", { runner: canonicalRunner });
    const canonicalDispatcher = instance.testDispatcher("chat-1", staleRunner);

    expect(canonicalDispatcher).not.toBe(staleDispatcher);
    expect(staleUnsubscribe).toHaveBeenCalledTimes(1);
    expect(instance.testDispatcherRunner("chat-1")).toBe(canonicalRunner);
    await expect(instance.getDebugState("chat-1")).resolves.toMatchObject({
      volatile: {
        dispatcherBindings: {
          "chat-1": {
            matchesCanonicalRunner: true,
            hasCanonicalRunner: true,
          },
        },
        recentInvariantViolations: [
          expect.objectContaining({
            channelId: "chat-1",
            code: "dispatcher_runner_mismatch",
          }),
        ],
      },
    });
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
      turnId?: string | null;
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
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      opts.callId,
      channelId,
      invocationId,
      invocationId,
      "assistant-1",
      opts.toolCallIndex ?? 0,
      opts.toolName ?? "eval",
      opts.turnId ?? "turn-1",
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

  function insertTurnRun(
    sql: { exec(query: string, ...bindings: unknown[]): { toArray(): Record<string, unknown>[] } },
    opts: {
      turnId: string;
      channelId?: string;
      status?: string;
      resumeCursorEntryId?: string | null;
    }
  ) {
    const now = Date.now();
    sql.exec(
      `INSERT INTO agent_turn_runs (
         turn_id, channel_id, status, resume_cursor_entry_id,
         opened_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?)`,
      opts.turnId,
      opts.channelId ?? "chat-1",
      opts.status ?? "starting",
      opts.resumeCursorEntryId ?? null,
      now,
      now
    );
  }

  function turnStatus(
    sql: { exec(query: string, ...bindings: unknown[]): { toArray(): Record<string, unknown>[] } },
    turnId: string
  ): Record<string, unknown> {
    return sql.exec(`SELECT * FROM agent_turn_runs WHERE turn_id = ?`, turnId).toArray()[0]!;
  }

  function diagnosticChannel(send = vi.fn().mockResolvedValue(undefined)) {
    return {
      getParticipants: vi.fn().mockResolvedValue([]),
      send,
      callMethod: vi.fn(),
      cancelCall: vi.fn(),
      setTypingState: vi.fn(),
    };
  }

  it("awaits lifecycle lease activation before starting model work", async () => {
    const { instance } = await createTestDO(LeaseBarrierTestAgentWorker, {
      __objectKey: "agent-test",
    });
    const worker = instance as LeaseBarrierTestAgentWorker;
    const prompt = vi.fn(async () => undefined);
    const runner: TurnDispatcherRunner = {
      subscribe: vi.fn(() => () => undefined),
      buildUserMessage: vi.fn(() => ({ role: "user", content: "hello" }) as AgentMessage),
      prompt,
      continueAgent: vi.fn(async () => undefined),
      steerMessage: vi.fn(async () => undefined),
      clearSteeringQueue: vi.fn(async () => undefined),
    };

    worker.testDispatcher("chat-1", runner).submit({ text: "hello" } as never);

    await expect.poll(() => worker.leaseStarted).toBe(1);
    expect(prompt).not.toHaveBeenCalled();

    worker.resolveLease?.();

    await expect.poll(() => prompt.mock.calls.length).toBe(1);
  });

  it("awaits lifecycle lease activation when external-wait recovery creates a missing turn row", async () => {
    const { instance } = await createTestDO(LeaseBarrierTestAgentWorker, {
      __objectKey: "agent-test",
    });
    const worker = instance as LeaseBarrierTestAgentWorker;
    let settled = false;

    const promise = worker
      .testTransitionCurrentTurnToWaiting("chat-1", "turn-missing")
      .then((turnId) => {
        settled = true;
        return turnId;
      });

    await expect.poll(() => worker.leaseStarted).toBe(1);
    expect(settled).toBe(false);

    worker.resolveLease?.();

    await expect(promise).resolves.toBe("turn-missing");
    expect(settled).toBe(true);
  });

  it("CASes suspension delivery status against the caller-observed state", async () => {
    const { instance, sql } = await createTestDO(TestAgentWorker, {
      __objectKey: "agent-test",
    });
    const worker = instance as unknown as {
      markSuspensionDeliveryStatus(
        callId: string,
        from: string,
        to: string,
        intent: string
      ): boolean;
    };

    insertSuspension(sql, { callId: "call-cas", deliveryStatus: "pending" });

    expect(
      worker.markSuspensionDeliveryStatus(
        "call-cas",
        "pending",
        "delivered_live",
        "delivered_to_live_waiter"
      )
    ).toBe(true);
    expect(
      sql
        .exec(
          `SELECT delivery_status FROM agent_method_suspensions WHERE transport_call_id = ?`,
          "call-cas"
        )
        .toArray()[0]
    ).toMatchObject({ delivery_status: "delivered_live" });

    expect(
      worker.markSuspensionDeliveryStatus("call-cas", "pending", "recovering", "resume_started")
    ).toBe(false);
    expect(
      sql
        .exec(
          `SELECT delivery_status FROM agent_method_suspensions WHERE transport_call_id = ?`,
          "call-cas"
        )
        .toArray()[0]
    ).toMatchObject({ delivery_status: "delivered_live" });

    expect(
      worker.markSuspensionDeliveryStatus(
        "call-cas",
        "delivered_live",
        "delivered_live",
        "delivered_to_live_waiter"
      )
    ).toBe(true);
    expect(() =>
      worker.markSuspensionDeliveryStatus("call-cas", "delivered_live", "pending", "resume_started")
    ).toThrow("illegal method suspension transition");
  });

  it("keeps assistant tool-call messages open so external waits can be recorded", async () => {
    const { instance, sql } = await createTestDO(TestAgentWorker, {
      __objectKey: "agent-test",
    });
    const runner = {
      getCurrentTurnId: () => "turn-tool-call",
      session: null,
    } as unknown as Pick<PiRunner, "getCurrentTurnId" | "session">;
    insertTurnRun(sql, { turnId: "turn-tool-call", status: "running_model" });

    await instance.testHandleRunnerMessageEndForTurnLedger("chat-1", runner, {
      role: "assistant",
      content: [
        { type: "text", text: "I need to run a check." },
        { type: "tool_call", tool_call_id: "call-eval", name: "eval", input: {} },
      ],
      timestamp: Date.now(),
    } as AgentMessage);

    expect(turnStatus(sql, "turn-tool-call")).toMatchObject({ status: "running_model" });
    expect(
      sql.exec(`SELECT * FROM agent_turn_outbox WHERE turn_id = ?`, "turn-tool-call").toArray()
    ).toEqual([]);
  });

  it("keeps final assistant messages open until the agent loop ends", async () => {
    const { instance, sql } = await createTestDO(TestAgentWorker, {
      __objectKey: "agent-test",
    });
    const runner = {
      getCurrentTurnId: () => "turn-final",
      session: null,
    } as unknown as Pick<PiRunner, "getCurrentTurnId" | "session">;
    insertTurnRun(sql, { turnId: "turn-final", status: "running_model" });

    await instance.testHandleRunnerMessageEndForTurnLedger("chat-1", runner, {
      role: "assistant",
      content: [{ type: "text", text: "Done." }],
      timestamp: Date.now(),
    } as AgentMessage);

    expect(turnStatus(sql, "turn-final")).toMatchObject({ status: "running_model" });
    expect(
      sql
        .exec(`SELECT kind, status FROM agent_turn_outbox WHERE turn_id = ?`, "turn-final")
        .toArray()
    ).toEqual([]);
  });

  it("moves active turns to closing and queues the durable close projection on agent end", async () => {
    const { instance, sql } = await createTestDO(TestAgentWorker, {
      __objectKey: "agent-test",
    });
    const repairDurableOpenState = vi.fn().mockResolvedValue(undefined);
    const runner = {
      getCurrentTurnId: () => "turn-final",
      repairDurableOpenState,
      session: null,
    } as unknown as PiRunner;
    insertTurnRun(sql, { turnId: "turn-final", status: "running_model" });

    await instance.testHandleRunnerAgentEndForTurnLedger("chat-1", runner);

    expect(repairDurableOpenState).toHaveBeenCalledWith({ closeOpenTurns: true });
    expect(turnStatus(sql, "turn-final")).toMatchObject({ status: "closed" });
    expect(
      sql
        .exec(`SELECT kind, status FROM agent_turn_outbox WHERE turn_id = ?`, "turn-final")
        .toArray()
    ).toEqual([expect.objectContaining({ kind: "close_turn_projection", status: "done" })]);
  });

  it("marks starting turns interrupted on agent end instead of closing them", async () => {
    const { instance, sql } = await createTestDO(TestAgentWorker, {
      __objectKey: "agent-test",
    });
    const send = vi.fn().mockResolvedValue(undefined);
    const worker = instance as unknown as {
      subscriptions: { getParticipantId(channelId: string): string | null };
      sendTurnLedgerDiagnostic(channelId: string, turnId: string, message: string): Promise<void>;
    };
    worker.subscriptions.getParticipantId = vi.fn().mockReturnValue("do:agent");
    worker.sendTurnLedgerDiagnostic = send;
    const runner = {
      getCurrentTurnId: () => "turn-starting",
      repairDurableOpenState: vi.fn().mockResolvedValue(undefined),
      session: null,
    } as unknown as PiRunner;
    (instance as unknown as { runners: Map<string, { runner: PiRunner }> }).runners.set("chat-1", {
      runner,
    });
    insertTurnRun(sql, { turnId: "turn-starting", status: "starting" });

    await instance.testHandleRunnerAgentEndEventForTurnLedger("chat-1", runner, {
      type: "agent_end",
      messages: [],
      natstack: { turnId: "turn-starting", operationId: "op-1", lifecycleMatched: true },
    } as never);

    expect(turnStatus(sql, "turn-starting")).toMatchObject({
      status: "interrupted",
      failure_code: "runner_ended_before_model",
    });
    expect(send).toHaveBeenCalledWith(
      "chat-1",
      "turn-starting",
      "Agent turn ended before model generation began."
    );
  });

  it("surfaces runner errors that happen before model generation starts", async () => {
    const { instance, sql } = await createTestDO(TestAgentWorker, {
      __objectKey: "agent-test",
    });
    const send = vi.fn().mockResolvedValue(undefined);
    const worker = instance as unknown as {
      subscriptions: { getParticipantId(channelId: string): string | null };
      sendTurnLedgerDiagnostic(channelId: string, turnId: string, message: string): Promise<void>;
    };
    worker.subscriptions.getParticipantId = vi.fn().mockReturnValue("do:agent");
    worker.sendTurnLedgerDiagnostic = send;
    const runner = {
      getCurrentTurnId: () => "turn-starting",
      repairDurableOpenState: vi.fn().mockResolvedValue(undefined),
      session: null,
    } as unknown as PiRunner;
    (instance as unknown as { runners: Map<string, { runner: PiRunner }> }).runners.set("chat-1", {
      runner,
    });
    insertTurnRun(sql, { turnId: "turn-starting", status: "starting" });

    await instance.testHandleRunnerAgentEndEventForTurnLedger("chat-1", runner, {
      type: "agent_end",
      messages: [
        {
          role: "assistant",
          content: [{ type: "text", text: "" }],
          stopReason: "error",
          errorMessage: "[credentials.resolveCredential] Credential approval denied",
        },
      ],
      natstack: { turnId: "turn-starting", operationId: "op-1", lifecycleMatched: true },
    } as never);

    expect(turnStatus(sql, "turn-starting")).toMatchObject({
      status: "failed",
      failure_code: "runner_failed_before_model",
      failure_message: "[credentials.resolveCredential] Credential approval denied",
    });
    expect(send).toHaveBeenCalledWith(
      "chat-1",
      "turn-starting",
      "Agent turn failed before model generation began: [credentials.resolveCredential] Credential approval denied"
    );
  });

  it("surfaces runner errors instead of closing running model turns", async () => {
    const { instance, sql } = await createTestDO(TestAgentWorker, {
      __objectKey: "agent-test",
    });
    const send = vi.fn().mockResolvedValue(undefined);
    const worker = instance as unknown as {
      subscriptions: { getParticipantId(channelId: string): string | null };
      sendTurnLedgerDiagnostic(channelId: string, turnId: string, message: string): Promise<void>;
    };
    worker.subscriptions.getParticipantId = vi.fn().mockReturnValue("do:agent");
    worker.sendTurnLedgerDiagnostic = send;
    const runner = {
      getCurrentTurnId: () => "turn-running",
      repairDurableOpenState: vi.fn().mockResolvedValue(undefined),
      session: null,
    } as unknown as PiRunner;
    (instance as unknown as { runners: Map<string, { runner: PiRunner }> }).runners.set("chat-1", {
      runner,
    });
    insertTurnRun(sql, { turnId: "turn-running", status: "running_model" });

    await instance.testHandleRunnerAgentEndEventForTurnLedger("chat-1", runner, {
      type: "agent_end",
      messages: [
        {
          role: "assistant",
          content: [],
          stopReason: "error",
          errorMessage: "provider stream failed",
        },
      ],
      natstack: { turnId: "turn-running", operationId: "op-1", lifecycleMatched: true },
    } as never);

    expect(turnStatus(sql, "turn-running")).toMatchObject({
      status: "failed",
      failure_code: "runner_failed",
      failure_message: "provider stream failed",
    });
    expect(send).not.toHaveBeenCalled();
  });

  it("emits a reconnect credential card for expired model auth failures", async () => {
    const { instance, sql } = await createTestDO(TestAgentWorker, {
      __objectKey: "agent-test",
    });
    const send = vi.fn().mockResolvedValue(undefined);
    const emitCard = vi.fn();
    const publishWaiting = vi.fn();
    const worker = instance as unknown as {
      subscriptions: { getParticipantId(channelId: string): string | null };
      sendTurnLedgerDiagnostic(channelId: string, turnId: string, message: string): Promise<void>;
      getModelProviderId(channelId: string): string;
      getModelBaseUrl(channelId: string): string;
      publishTurnWaitingEvent(
        channelId: string,
        turnId: string,
        payload: { reason: string; summary: string }
      ): void;
      emitModelCredentialRequiredCard(
        channelId: string,
        providerId: string,
        modelBaseUrl: string,
        opts?: {
          resumeAfterConnect?: boolean;
          reason?: string;
          diagnosticReason?: string;
          failureCode?: string;
          turnId?: string;
        }
      ): void;
    };
    worker.subscriptions.getParticipantId = vi.fn().mockReturnValue("do:agent");
    worker.sendTurnLedgerDiagnostic = send;
    worker.getModelProviderId = vi.fn().mockReturnValue("openai-codex");
    worker.getModelBaseUrl = vi.fn().mockReturnValue("https://chatgpt.com/backend-api/codex");
    worker.emitModelCredentialRequiredCard = emitCard;
    worker.publishTurnWaitingEvent = publishWaiting;
    const runner = {
      getCurrentTurnId: () => "turn-expired",
      repairDurableOpenState: vi.fn().mockResolvedValue(undefined),
      getStateSnapshot: vi.fn().mockResolvedValue({ messages: [] }),
      session: null,
    } as unknown as PiRunner;
    (instance as unknown as { runners: Map<string, { runner: PiRunner }> }).runners.set("chat-1", {
      runner,
    });
    insertTurnRun(sql, { turnId: "turn-expired", status: "running_model" });
    const errorMessage = "Provided authentication token is expired. Please try signing in again.";

    await instance.testHandleRunnerAgentEndEventForTurnLedger("chat-1", runner, {
      type: "agent_end",
      messages: [
        {
          role: "assistant",
          content: [],
          stopReason: "error",
          code: "client_not_authorized",
          errorMessage,
        },
      ],
      natstack: { turnId: "turn-expired", operationId: "op-1", lifecycleMatched: true },
    } as never);

    expect(turnStatus(sql, "turn-expired")).toMatchObject({
      status: "waiting_external",
      failure_code: "model_credential_reconnect_required",
      failure_message: errorMessage,
    });
    expect(emitCard).toHaveBeenCalledWith(
      "chat-1",
      "openai-codex",
      "https://chatgpt.com/backend-api/codex",
      {
        resumeAfterConnect: true,
        reason: "Your model sign-in needs to be refreshed before this turn can continue.",
        diagnosticReason: errorMessage,
        failureCode: "client_not_authorized",
        turnId: "turn-expired",
      }
    );
    expect(publishWaiting).toHaveBeenCalledWith("chat-1", "turn-expired", {
      reason: "model_credential_reconnect_required",
      summary: "Waiting for model credential refresh",
    });
    expect(
      sql
        .exec(
          `SELECT provider_id, model_base_url, turn_id
           FROM model_credential_interruptions
           WHERE channel_id = ?`,
          "chat-1"
        )
        .toArray()
    ).toEqual([
      {
        provider_id: "openai-codex",
        model_base_url: "https://chatgpt.com/backend-api/codex",
        turn_id: "turn-expired",
      },
    ]);
    expect(send).not.toHaveBeenCalled();
  });

  it("emits a reconnect credential card for expired model auth failures without provider codes", async () => {
    const { instance, sql } = await createTestDO(TestAgentWorker, {
      __objectKey: "agent-test",
    });
    const send = vi.fn().mockResolvedValue(undefined);
    const emitCard = vi.fn();
    const publishWaiting = vi.fn();
    const worker = instance as unknown as {
      subscriptions: { getParticipantId(channelId: string): string | null };
      sendTurnLedgerDiagnostic(channelId: string, turnId: string, message: string): Promise<void>;
      getModelProviderId(channelId: string): string;
      getModelBaseUrl(channelId: string): string;
      publishTurnWaitingEvent(
        channelId: string,
        turnId: string,
        payload: { reason: string; summary: string }
      ): void;
      emitModelCredentialRequiredCard(
        channelId: string,
        providerId: string,
        modelBaseUrl: string,
        opts?: {
          resumeAfterConnect?: boolean;
          reason?: string;
          diagnosticReason?: string;
          failureCode?: string;
          turnId?: string;
        }
      ): void;
    };
    worker.subscriptions.getParticipantId = vi.fn().mockReturnValue("do:agent");
    worker.sendTurnLedgerDiagnostic = send;
    worker.getModelProviderId = vi.fn().mockReturnValue("openai-codex");
    worker.getModelBaseUrl = vi.fn().mockReturnValue("https://chatgpt.com/backend-api/codex");
    worker.emitModelCredentialRequiredCard = emitCard;
    worker.publishTurnWaitingEvent = publishWaiting;
    const runner = {
      getCurrentTurnId: () => "turn-expired-message-only",
      repairDurableOpenState: vi.fn().mockResolvedValue(undefined),
      getStateSnapshot: vi.fn().mockResolvedValue({ messages: [] }),
      session: null,
    } as unknown as PiRunner;
    (instance as unknown as { runners: Map<string, { runner: PiRunner }> }).runners.set("chat-1", {
      runner,
    });
    insertTurnRun(sql, { turnId: "turn-expired-message-only", status: "running_model" });
    const errorMessage = "Provided authentication token is expired. Please try signing in again.";

    await instance.testHandleRunnerAgentEndEventForTurnLedger("chat-1", runner, {
      type: "agent_end",
      messages: [
        {
          role: "assistant",
          content: [],
          stopReason: "error",
          errorMessage,
        },
      ],
      natstack: {
        turnId: "turn-expired-message-only",
        operationId: "op-1",
        lifecycleMatched: true,
      },
    } as never);

    expect(turnStatus(sql, "turn-expired-message-only")).toMatchObject({
      status: "waiting_external",
      failure_code: "model_credential_reconnect_required",
      failure_message: errorMessage,
    });
    expect(emitCard).toHaveBeenCalledWith(
      "chat-1",
      "openai-codex",
      "https://chatgpt.com/backend-api/codex",
      {
        resumeAfterConnect: true,
        reason: "Your model sign-in needs to be refreshed before this turn can continue.",
        diagnosticReason: errorMessage,
        failureCode: undefined,
        turnId: "turn-expired-message-only",
      }
    );
    expect(publishWaiting).toHaveBeenCalledWith("chat-1", "turn-expired-message-only", {
      reason: "model_credential_reconnect_required",
      summary: "Waiting for model credential refresh",
    });
    expect(send).not.toHaveBeenCalled();
  });

  it("emits a reconnect credential card for aborted auth failures", async () => {
    const { instance, sql } = await createTestDO(TestAgentWorker, {
      __objectKey: "agent-test",
    });
    const send = vi.fn().mockResolvedValue(undefined);
    const emitCard = vi.fn();
    const publishWaiting = vi.fn();
    const worker = instance as unknown as {
      subscriptions: { getParticipantId(channelId: string): string | null };
      sendTurnLedgerDiagnostic(channelId: string, turnId: string, message: string): Promise<void>;
      getModelProviderId(channelId: string): string;
      getModelBaseUrl(channelId: string): string;
      publishTurnWaitingEvent(
        channelId: string,
        turnId: string,
        payload: { reason: string; summary: string }
      ): void;
      emitModelCredentialRequiredCard(
        channelId: string,
        providerId: string,
        modelBaseUrl: string,
        opts?: {
          resumeAfterConnect?: boolean;
          reason?: string;
          diagnosticReason?: string;
          failureCode?: string;
          turnId?: string;
        }
      ): void;
    };
    worker.subscriptions.getParticipantId = vi.fn().mockReturnValue("do:agent");
    worker.sendTurnLedgerDiagnostic = send;
    worker.getModelProviderId = vi.fn().mockReturnValue("openai-codex");
    worker.getModelBaseUrl = vi.fn().mockReturnValue("https://chatgpt.com/backend-api/codex");
    worker.emitModelCredentialRequiredCard = emitCard;
    worker.publishTurnWaitingEvent = publishWaiting;
    const runner = {
      getCurrentTurnId: () => "turn-aborted-auth",
      repairDurableOpenState: vi.fn().mockResolvedValue(undefined),
      getStateSnapshot: vi.fn().mockResolvedValue({ messages: [] }),
      session: null,
    } as unknown as PiRunner;
    (instance as unknown as { runners: Map<string, { runner: PiRunner }> }).runners.set("chat-1", {
      runner,
    });
    insertTurnRun(sql, { turnId: "turn-aborted-auth", status: "running_model" });
    const errorMessage = "client_not_authorized";

    await instance.testHandleRunnerAgentEndEventForTurnLedger("chat-1", runner, {
      type: "agent_end",
      messages: [
        {
          role: "assistant",
          content: [],
          stopReason: "aborted",
          code: "client_not_authorized",
          errorMessage,
        },
      ],
      natstack: {
        turnId: "turn-aborted-auth",
        operationId: "op-1",
        lifecycleMatched: true,
      },
    } as never);

    expect(turnStatus(sql, "turn-aborted-auth")).toMatchObject({
      status: "waiting_external",
      failure_code: "model_credential_reconnect_required",
      failure_message: errorMessage,
    });
    expect(emitCard).toHaveBeenCalledWith(
      "chat-1",
      "openai-codex",
      "https://chatgpt.com/backend-api/codex",
      {
        resumeAfterConnect: true,
        reason: "Your model sign-in needs to be refreshed before this turn can continue.",
        diagnosticReason: errorMessage,
        failureCode: "client_not_authorized",
        turnId: "turn-aborted-auth",
      }
    );
    expect(publishWaiting).toHaveBeenCalledWith("chat-1", "turn-aborted-auth", {
      reason: "model_credential_reconnect_required",
      summary: "Waiting for model credential refresh",
    });
    expect(send).not.toHaveBeenCalled();
  });

  it("ignores unmatched agent_end events for the active turn", async () => {
    const { instance, sql } = await createTestDO(TestAgentWorker, {
      __objectKey: "agent-test",
    });
    const runner = {
      getCurrentTurnId: () => "turn-starting",
      repairDurableOpenState: vi.fn().mockResolvedValue(undefined),
      session: null,
    } as unknown as PiRunner;
    (instance as unknown as { runners: Map<string, { runner: PiRunner }> }).runners.set("chat-1", {
      runner,
    });
    insertTurnRun(sql, { turnId: "turn-starting", status: "starting" });

    await instance.testHandleRunnerAgentEndEventForTurnLedger("chat-1", runner, {
      type: "agent_end",
      messages: [],
      natstack: { turnId: "turn-starting", operationId: "op-1", lifecycleMatched: false },
    } as never);

    expect(turnStatus(sql, "turn-starting")).toMatchObject({ status: "starting" });
    expect(
      sql.exec(`SELECT * FROM agent_turn_outbox WHERE turn_id = ?`, "turn-starting").toArray()
    ).toEqual([]);
  });

  it("ignores agent_end events for a different turn", async () => {
    const { instance, sql } = await createTestDO(TestAgentWorker, {
      __objectKey: "agent-test",
    });
    const runner = {
      getCurrentTurnId: () => "turn-current",
      repairDurableOpenState: vi.fn().mockResolvedValue(undefined),
      session: null,
    } as unknown as PiRunner;
    insertTurnRun(sql, { turnId: "turn-current", status: "running_model" });

    await instance.testHandleRunnerAgentEndEventForTurnLedger("chat-1", runner, {
      type: "agent_end",
      messages: [],
      natstack: { turnId: "turn-old", operationId: "op-old", lifecycleMatched: true },
    } as never);

    expect(turnStatus(sql, "turn-current")).toMatchObject({ status: "running_model" });
    expect(
      sql.exec(`SELECT * FROM agent_turn_outbox WHERE turn_id = ?`, "turn-current").toArray()
    ).toEqual([]);
  });

  it("rejects UI prompt dispatch before creating a live waiter when durable recording is skipped", async () => {
    const { instance } = await createTestDO(TestAgentWorker, {
      __objectKey: "agent-test",
    });
    const callMethod = vi.fn();
    const worker = instance as unknown as {
      subscriptions: { getParticipantId(channelId: string): string | null };
      createChannelClient: ReturnType<typeof vi.fn>;
      runners: Map<string, { runner: unknown }>;
      methodResultWaiters: Map<string, unknown>;
      dispatchUiPrompt(
        channelId: string,
        toolCallId: string,
        kind: "confirm",
        params: Record<string, unknown>
      ): Promise<unknown>;
    };
    worker.subscriptions.getParticipantId = vi.fn().mockReturnValue("do:agent");
    worker.createChannelClient = vi.fn().mockReturnValue({
      getParticipants: vi
        .fn()
        .mockResolvedValue([{ participantId: "panel-1", metadata: { type: "panel" } }]),
      callMethod,
    });
    worker.runners.set("chat-1", {
      runner: {
        getCurrentTurnId: () => "turn-ui",
        getOpenInvocation: () => undefined,
        session: { getLeafId: async () => "leaf-1" },
      },
    });

    await expect(
      worker.dispatchUiPrompt("chat-1", "tool-1", "confirm", { title: "Proceed?" })
    ).rejects.toThrow("durable suspension");

    expect(worker.methodResultWaiters.size).toBe(0);
    expect(callMethod).not.toHaveBeenCalled();
  });

  it("models open external waits from turn-scoped suspensions and credentials", async () => {
    const { instance, sql } = await createTestDO(TestAgentWorker, {
      __objectKey: "agent-test",
    });
    const worker = instance as unknown as {
      insertTurnRun(channelId: string, turnId: string): void;
      turnHasOpenExternalWait(turnId: string): boolean;
      transitionTurn(turnId: string, from: string[], to: string): boolean;
    };
    worker.insertTurnRun("chat-1", "turn-wait");
    expect(worker.transitionTurn("turn-wait", ["starting"], "waiting_external")).toBe(true);

    insertSuspension(sql, {
      callId: "resolved",
      turnId: "turn-wait",
      deliveryStatus: "transcript_admitted",
    });
    expect(worker.turnHasOpenExternalWait("turn-wait")).toBe(false);

    insertSuspension(sql, { callId: "pending", turnId: "turn-wait", deliveryStatus: "pending" });
    expect(worker.turnHasOpenExternalWait("turn-wait")).toBe(true);
    sql.exec(
      `UPDATE agent_method_suspensions
       SET delivery_status = 'transcript_admitted'
       WHERE transport_call_id = ?`,
      "pending"
    );
    expect(worker.turnHasOpenExternalWait("turn-wait")).toBe(false);

    sql.exec(
      `INSERT INTO model_credential_interruptions
       (channel_id, provider_id, model_base_url, turn_id, resume_count, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      "chat-1",
      "provider",
      "https://model.example/v1",
      "turn-wait",
      0,
      Date.now()
    );
    expect(worker.turnHasOpenExternalWait("turn-wait")).toBe(true);
  });

  it("enforces turn transition legality and terminal absorption", async () => {
    const { instance, sql } = await createTestDO(TestAgentWorker, {
      __objectKey: "agent-test",
    });
    const worker = instance as unknown as {
      transitionTurn(turnId: string, from: string[], to: string): boolean;
    };
    const legal: Array<[string, string]> = [
      ["starting", "running_model"],
      ["starting", "waiting_external"],
      ["starting", "continuing"],
      ["starting", "failed"],
      ["starting", "interrupted"],
      ["running_model", "waiting_external"],
      ["running_model", "continuing"],
      ["running_model", "closing"],
      ["running_model", "failed"],
      ["running_model", "interrupted"],
      ["waiting_external", "continuing"],
      ["waiting_external", "running_model"],
      ["waiting_external", "failed"],
      ["waiting_external", "interrupted"],
      ["continuing", "running_model"],
      ["continuing", "waiting_external"],
      ["continuing", "closing"],
      ["continuing", "failed"],
      ["continuing", "interrupted"],
      ["closing", "closed"],
      ["closing", "failed"],
      ["closing", "interrupted"],
    ];
    for (const [from, to] of legal) {
      const turnId = `legal-${from}-${to}`;
      insertTurnRun(sql, { turnId, status: from });
      expect(worker.transitionTurn(turnId, [from], to)).toBe(true);
      expect(turnStatus(sql, turnId)).toMatchObject({ status: to });
    }

    insertTurnRun(sql, { turnId: "illegal", status: "running_model" });
    expect(() => worker.transitionTurn("illegal", ["running_model"], "starting")).toThrow(
      "illegal turn transition"
    );
    insertTurnRun(sql, { turnId: "terminal", status: "failed" });
    expect(worker.transitionTurn("terminal", ["failed"], "failed")).toBe(true);
    expect(() => worker.transitionTurn("terminal", ["failed"], "running_model")).toThrow(
      "illegal turn transition"
    );
  });

  it("persists turn-open and model-start replay checkpoints", async () => {
    const { instance, sql } = await createTestDO(TestAgentWorker, {
      __objectKey: "agent-test",
    });
    const worker = instance as TestAgentWorker;

    worker.testInsertTurnRunWithCheckpoint("chat-1", "turn-checkpoint", {
      phase: "turn_open",
      entryId: "leaf-open",
    });
    await worker.testCaptureTurnCheckpoint(
      "chat-1",
      "turn-checkpoint",
      { session: { getLeafId: vi.fn().mockResolvedValue("leaf-model") } } as unknown as PiRunner,
      "model_start"
    );

    expect(turnStatus(sql, "turn-checkpoint")).toMatchObject({
      turn_open_cursor_entry_id: "leaf-open",
      model_start_cursor_entry_id: "leaf-model",
      checkpoint_phase: "model_start",
      checkpoint_entry_id: "leaf-model",
    });
  });

  it("returns false (never throws) when the current status is outside expectedFrom", async () => {
    const { instance, sql } = await createTestDO(TestAgentWorker, {
      __objectKey: "agent-test",
    });
    const worker = instance as unknown as {
      transitionTurn(turnId: string, from: string[], to: string): boolean;
    };

    // The credential-required path leaves the turn at waiting_external, then the
    // assistant message_end handler attempts ["running_model","continuing"] -> closing.
    // That must be a no-op, not an illegal-transition throw, so the turn stays a
    // recoverable waiting_external and credential resume works.
    insertTurnRun(sql, { turnId: "cred-wait", status: "waiting_external" });
    let result: boolean | undefined;
    expect(() => {
      result = worker.transitionTurn("cred-wait", ["running_model", "continuing"], "closing");
    }).not.toThrow();
    expect(result).toBe(false);
    expect(turnStatus(sql, "cred-wait")).toMatchObject({ status: "waiting_external" });

    // Interrupt race: a turn already interrupted must absorb a late closing
    // attempt from the message_end handler without throwing in the async listener.
    insertTurnRun(sql, { turnId: "raced", status: "interrupted" });
    expect(() =>
      worker.transitionTurn("raced", ["running_model", "continuing"], "closing")
    ).not.toThrow();
    expect(worker.transitionTurn("raced", ["running_model", "continuing"], "closing")).toBe(false);
    expect(turnStatus(sql, "raced")).toMatchObject({ status: "interrupted" });
  });

  it("recovers starting turns with credential waits as waiting_external", async () => {
    const { instance, sql } = await createTestDO(TestAgentWorker, {
      __objectKey: "agent-test",
    });
    const worker = instance as unknown as {
      recoverFromTurnLedger(channelId: string, runner: PiRunner): Promise<boolean>;
    };
    insertTurnRun(sql, { turnId: "turn-start-credential", status: "starting" });
    sql.exec(
      `INSERT INTO model_credential_interruptions
       (channel_id, provider_id, model_base_url, turn_id, resume_count, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      "chat-1",
      "provider",
      "https://model.example/v1",
      "turn-start-credential",
      0,
      Date.now()
    );

    await worker.recoverFromTurnLedger("chat-1", {} as PiRunner);

    expect(turnStatus(sql, "turn-start-credential")).toMatchObject({
      status: "waiting_external",
    });
  });

  it("marks bare starting turns interrupted and emits through the outbox", async () => {
    const { instance, sql } = await createTestDO(TestAgentWorker, {
      __objectKey: "agent-test",
    });
    const send = vi.fn().mockResolvedValue(undefined);
    const worker = instance as unknown as {
      subscriptions: { getParticipantId(channelId: string): string | null };
      createChannelClient: ReturnType<typeof vi.fn>;
      recoverFromTurnLedger(channelId: string, runner: PiRunner): Promise<boolean>;
    };
    worker.subscriptions.getParticipantId = vi.fn().mockReturnValue("do:agent");
    worker.createChannelClient = vi.fn().mockReturnValue(diagnosticChannel(send));
    insertTurnRun(sql, { turnId: "turn-start-bare", status: "starting" });

    await worker.recoverFromTurnLedger("chat-1", {} as PiRunner);

    expect(turnStatus(sql, "turn-start-bare")).toMatchObject({
      status: "interrupted",
      failure_code: "runner_restarted_before_model",
    });
    expect(send).toHaveBeenCalledWith(
      "do:agent",
      expect.any(String),
      "Agent turn was interrupted before model generation began.",
      expect.objectContaining({ idempotencyKey: "turn-ledger-diagnostic:turn-start-bare" })
    );
    expect(
      sql
        .exec(`SELECT status FROM agent_turn_outbox WHERE turn_id = ?`, "turn-start-bare")
        .toArray()
    ).toEqual([expect.objectContaining({ status: "done" })]);
  });

  it("keeps waiting_external while any turn-scoped wait remains open", async () => {
    const { instance, sql } = await createTestDO(TestAgentWorker, {
      __objectKey: "agent-test",
    });
    const worker = instance as unknown as {
      sweepStuckDelivery: ReturnType<typeof vi.fn>;
      recoverDeliveredAndOrphanedSuspensions: ReturnType<typeof vi.fn>;
      recoverFromTurnLedger(channelId: string, runner: PiRunner): Promise<boolean>;
    };
    worker.sweepStuckDelivery = vi.fn().mockResolvedValue(undefined);
    worker.recoverDeliveredAndOrphanedSuspensions = vi.fn().mockResolvedValue(false);
    insertTurnRun(sql, { turnId: "turn-wait-open", status: "waiting_external" });
    insertSuspension(sql, {
      callId: "wait-open",
      turnId: "turn-wait-open",
      deliveryStatus: "pending",
    });

    await worker.recoverFromTurnLedger("chat-1", {} as PiRunner);

    expect(turnStatus(sql, "turn-wait-open")).toMatchObject({ status: "waiting_external" });
    expect(worker.sweepStuckDelivery).toHaveBeenCalled();
    expect(worker.recoverDeliveredAndOrphanedSuspensions).toHaveBeenCalled();
  });

  it("ingests a replayed invocation terminal for a pending suspension on wake", async () => {
    const { instance, sql } = await createTestDO(TestAgentWorker, {
      __objectKey: "agent-test",
    });
    const worker = instance as unknown as {
      channelsInReplay: Set<string>;
      handleCompletedMethodResult(
        channelId: string,
        callId: string,
        result: unknown,
        isError: boolean,
        terminalKind?: string,
        eventId?: number
      ): Promise<void>;
    };

    insertTurnRun(sql, { turnId: "turn-missed", status: "waiting_external" });
    insertSuspension(sql, {
      callId: "missed-call",
      turnId: "turn-missed",
      deliveryStatus: "pending",
    });

    // Replay re-delivers the terminal that settled while the agent was asleep.
    // (channelsInReplay defers the recovery continuation to the ready hook.)
    worker.channelsInReplay.add("chat-1");
    await worker.handleCompletedMethodResult("chat-1", "missed-call", { ok: true }, false, "completed", 5);

    const row = sql
      .exec(
        `SELECT terminal_kind, result_is_error FROM agent_method_suspensions WHERE transport_call_id = ?`,
        "missed-call"
      )
      .toArray()[0]!;
    expect(row["terminal_kind"]).toBe("completed");
    expect(row["result_is_error"]).toBe(0);
  });

  it("leaves a genuinely-pending suspension untouched when no terminal has replayed", async () => {
    const { instance, sql } = await createTestDO(TestAgentWorker, {
      __objectKey: "agent-test",
    });
    const worker = instance as unknown as {
      sweepStuckDelivery: ReturnType<typeof vi.fn>;
      recoverDeliveredAndOrphanedSuspensions: ReturnType<typeof vi.fn>;
      getOrCreateRunner: ReturnType<typeof vi.fn>;
      recoverFromTurnLedger(channelId: string, runner: PiRunner): Promise<boolean>;
    };
    worker.sweepStuckDelivery = vi.fn().mockResolvedValue(undefined);
    worker.recoverDeliveredAndOrphanedSuspensions = vi.fn().mockResolvedValue(false);
    worker.getOrCreateRunner = vi.fn().mockResolvedValue({} as PiRunner);

    insertTurnRun(sql, { turnId: "turn-still-waiting", status: "waiting_external" });
    insertSuspension(sql, {
      callId: "still-waiting",
      turnId: "turn-still-waiting",
      deliveryStatus: "pending",
    });

    await worker.recoverFromTurnLedger("chat-1", {} as PiRunner);

    // No terminal has replayed — the call is genuinely in flight. The suspension
    // must stay pending (waiting, not fabricated, not hung). Recovery does not
    // read any channel side-table.
    const row = sql
      .exec(
        `SELECT terminal_kind, delivery_status FROM agent_method_suspensions WHERE transport_call_id = ?`,
        "still-waiting"
      )
      .toArray()[0]!;
    expect(row["terminal_kind"]).toBe("none");
    expect(row["delivery_status"]).toBe("pending");
  });

  it("reconciles admitted waiting_external turns to continuing with the exact cursor", async () => {
    const { instance, sql } = await createTestDO(TestAgentWorker, {
      __objectKey: "agent-test",
    });
    const worker = instance as unknown as {
      sweepStuckDelivery: ReturnType<typeof vi.fn>;
      recoverDeliveredAndOrphanedSuspensions: ReturnType<typeof vi.fn>;
      recoverFromTurnLedger(channelId: string, runner: PiRunner): Promise<boolean>;
    };
    worker.sweepStuckDelivery = vi.fn().mockResolvedValue(undefined);
    worker.recoverDeliveredAndOrphanedSuspensions = vi.fn().mockResolvedValue(false);
    insertTurnRun(sql, { turnId: "turn-wait-admitted", status: "waiting_external" });
    insertSuspension(sql, {
      callId: "wait-admitted",
      turnId: "turn-wait-admitted",
      deliveryStatus: "transcript_admitted",
    });
    sql.exec(
      `UPDATE agent_method_suspensions
       SET admitted_entry_id = ?
       WHERE transport_call_id = ?`,
      "entry-exact",
      "wait-admitted"
    );

    await worker.recoverFromTurnLedger("chat-1", {} as PiRunner);

    expect(turnStatus(sql, "turn-wait-admitted")).toMatchObject({
      status: "continuing",
      resume_cursor_entry_id: "entry-exact",
    });
  });

  // Characterization (Phase 1 keystone): an interrupted turn is terminal and
  // must never be resurrected by recovery, even if an in-flight suspension was
  // admitted before the user stopped it. The consolidated RunController gate
  // must preserve exactly this invariant.
  it("does not resume an interrupted turn even when a suspension was admitted", async () => {
    const { instance, sql } = await createTestDO(TestAgentWorker, {
      __objectKey: "agent-test",
    });
    const worker = instance as unknown as {
      sweepStuckDelivery: ReturnType<typeof vi.fn>;
      recoverDeliveredAndOrphanedSuspensions: ReturnType<typeof vi.fn>;
      recoverFromTurnLedger(channelId: string, runner: PiRunner): Promise<boolean>;
    };
    worker.sweepStuckDelivery = vi.fn().mockResolvedValue(undefined);
    worker.recoverDeliveredAndOrphanedSuspensions = vi.fn().mockResolvedValue(false);
    insertTurnRun(sql, { turnId: "turn-interrupted", status: "interrupted" });
    insertSuspension(sql, {
      callId: "wait-after-interrupt",
      turnId: "turn-interrupted",
      deliveryStatus: "transcript_admitted",
    });
    sql.exec(
      `UPDATE agent_method_suspensions SET admitted_entry_id = ? WHERE transport_call_id = ?`,
      "entry-exact",
      "wait-after-interrupt"
    );

    const resumed = await worker.recoverFromTurnLedger("chat-1", {} as PiRunner);

    expect(resumed).toBe(false);
    expect(turnStatus(sql, "turn-interrupted")).toMatchObject({ status: "interrupted" });
  });

  // Phase 1 Step 1: the RunController shadow projection must mirror the durable
  // status set by the authoritative `transitionTurn` chokepoint.
  it("shadow-projects the durable turn phase into the RunController", async () => {
    const { instance, sql } = await createTestDO(TestAgentWorker, {
      __objectKey: "agent-test",
    });
    const worker = instance as unknown as {
      sweepStuckDelivery: ReturnType<typeof vi.fn>;
      recoverDeliveredAndOrphanedSuspensions: ReturnType<typeof vi.fn>;
      recoverFromTurnLedger(channelId: string, runner: PiRunner): Promise<boolean>;
      getDebugState(channelId?: string): Promise<Record<string, unknown>>;
    };
    worker.sweepStuckDelivery = vi.fn().mockResolvedValue(undefined);
    worker.recoverDeliveredAndOrphanedSuspensions = vi.fn().mockResolvedValue(false);
    insertTurnRun(sql, { turnId: "turn-proj", status: "waiting_external" });
    insertSuspension(sql, {
      callId: "proj-1",
      turnId: "turn-proj",
      deliveryStatus: "transcript_admitted",
    });
    sql.exec(
      `UPDATE agent_method_suspensions SET admitted_entry_id = ? WHERE transport_call_id = ?`,
      "entry-x",
      "proj-1"
    );

    await worker.recoverFromTurnLedger("chat-1", {} as PiRunner);

    const debug = await worker.getDebugState("chat-1");
    const controllers = (
      debug["volatile"] as {
        runControllers?: Record<string, { phase?: string; turnId?: string }>;
      }
    ).runControllers;
    expect(controllers?.["chat-1"]).toMatchObject({ turnId: "turn-proj", phase: "continuing" });
  });

  // Phase 1 Step 4/5: the RunController gate is the single authoritative
  // admission point — a recovery continue for a user-interrupted turn is dropped
  // at `submitRecoveryContinue`, so a late suspension result cannot resurrect a
  // stopped agent.
  it("gates a recovery continue for an interrupted turn at the single chokepoint", async () => {
    const { instance } = await createTestDO(TestAgentWorker, {
      __objectKey: "agent-test",
    });
    const submitContinue = vi.fn();
    const worker = instance as unknown as {
      runControllerFor(channelId: string): { gateInterrupt(turnId: string): void };
      submitRecoveryContinue(
        channelId: string,
        runner: unknown,
        reason: string,
        turnId?: string
      ): void;
      dispatchers: Map<string, unknown>;
    };
    worker.dispatchers.set("chat-1", { submitContinue, getDebugState: () => ({ busy: false }) });

    // Not gated yet → the continue is admitted.
    worker.submitRecoveryContinue("chat-1", {} as never, "test", "turn-x");
    expect(submitContinue).toHaveBeenCalledTimes(1);

    // After the user interrupt gates the turn → further continues are dropped.
    worker.runControllerFor("chat-1").gateInterrupt("turn-x");
    worker.submitRecoveryContinue("chat-1", {} as never, "late-result", "turn-x");
    expect(submitContinue).toHaveBeenCalledTimes(1);
  });

  it("fails waiting_external turns whose child waits resolved without a cursor", async () => {
    const { instance, sql } = await createTestDO(TestAgentWorker, {
      __objectKey: "agent-test",
    });
    const send = vi.fn().mockResolvedValue(undefined);
    const worker = instance as unknown as {
      subscriptions: { getParticipantId(channelId: string): string | null };
      createChannelClient: ReturnType<typeof vi.fn>;
      sweepStuckDelivery: ReturnType<typeof vi.fn>;
      recoverDeliveredAndOrphanedSuspensions: ReturnType<typeof vi.fn>;
      recoverFromTurnLedger(channelId: string, runner: PiRunner): Promise<boolean>;
    };
    worker.subscriptions.getParticipantId = vi.fn().mockReturnValue("do:agent");
    worker.createChannelClient = vi.fn().mockReturnValue(diagnosticChannel(send));
    worker.sweepStuckDelivery = vi.fn().mockResolvedValue(undefined);
    worker.recoverDeliveredAndOrphanedSuspensions = vi.fn().mockResolvedValue(false);
    insertTurnRun(sql, { turnId: "turn-wait-stale", status: "waiting_external" });
    insertSuspension(sql, {
      callId: "wait-stale",
      turnId: "turn-wait-stale",
      deliveryStatus: "stale",
    });

    await worker.recoverFromTurnLedger("chat-1", {} as PiRunner);

    expect(turnStatus(sql, "turn-wait-stale")).toMatchObject({
      status: "failed",
      failure_code: "external_wait_unrecoverable",
    });
    expect(send).toHaveBeenCalledWith(
      "do:agent",
      expect.any(String),
      "External wait resolved without a resumable cursor.",
      expect.objectContaining({ idempotencyKey: "turn-ledger-diagnostic:turn-wait-stale" })
    );
  });

  it("resumes continuing turns from a valid explicit cursor", async () => {
    const { instance, sql } = await createTestDO(TestAgentWorker, {
      __objectKey: "agent-test",
    });
    const submitContinue = vi.fn();
    const moveTo = vi.fn().mockResolvedValue(undefined);
    const worker = instance as unknown as {
      dispatchers: Map<string, unknown>;
      recoverFromTurnLedger(channelId: string, runner: PiRunner): Promise<boolean>;
    };
    worker.dispatchers.set("chat-1", { submitContinue, getDebugState: () => ({ busy: false }) });
    insertTurnRun(sql, {
      turnId: "turn-continuing",
      status: "continuing",
      resumeCursorEntryId: "entry-ok",
    });
    const runner = {
      session: {
        getEntries: vi.fn().mockResolvedValue([{ id: "entry-ok", type: "message" }]),
        moveTo,
      },
      subscribe: () => () => undefined,
    } as unknown as PiRunner;

    await expect(worker.recoverFromTurnLedger("chat-1", runner)).resolves.toBe(true);

    expect(moveTo).toHaveBeenCalledWith("entry-ok");
    expect(submitContinue).toHaveBeenCalledTimes(1);
    expect(submitContinue).toHaveBeenCalledWith({ turnId: "turn-continuing" });
  });

  it("fails continuing turns with an invalid explicit cursor", async () => {
    const { instance, sql } = await createTestDO(TestAgentWorker, {
      __objectKey: "agent-test",
    });
    const send = vi.fn().mockResolvedValue(undefined);
    const worker = instance as unknown as {
      subscriptions: { getParticipantId(channelId: string): string | null };
      createChannelClient: ReturnType<typeof vi.fn>;
      recoverFromTurnLedger(channelId: string, runner: PiRunner): Promise<boolean>;
    };
    worker.subscriptions.getParticipantId = vi.fn().mockReturnValue("do:agent");
    worker.createChannelClient = vi.fn().mockReturnValue(diagnosticChannel(send));
    insertTurnRun(sql, {
      turnId: "turn-continuing-missing",
      status: "continuing",
      resumeCursorEntryId: "entry-missing",
    });
    const runner = {
      session: { getEntries: vi.fn().mockResolvedValue([]) },
    } as unknown as PiRunner;

    await worker.recoverFromTurnLedger("chat-1", runner);

    expect(turnStatus(sql, "turn-continuing-missing")).toMatchObject({
      status: "failed",
      failure_code: "invalid_resume_cursor",
    });
    expect(send).toHaveBeenCalledWith(
      "do:agent",
      expect.any(String),
      "Agent recovery cursor was missing; the turn cannot continue.",
      expect.objectContaining({ idempotencyKey: "turn-ledger-diagnostic:turn-continuing-missing" })
    );
  });

  it("marks running_model turns interrupted on activation", async () => {
    const { instance, sql } = await createTestDO(TestAgentWorker, {
      __objectKey: "agent-test",
    });
    const send = vi.fn().mockResolvedValue(undefined);
    const worker = instance as unknown as {
      subscriptions: { getParticipantId(channelId: string): string | null };
      createChannelClient: ReturnType<typeof vi.fn>;
      recoverFromTurnLedger(channelId: string, runner: PiRunner): Promise<boolean>;
    };
    worker.subscriptions.getParticipantId = vi.fn().mockReturnValue("do:agent");
    worker.createChannelClient = vi.fn().mockReturnValue(diagnosticChannel(send));
    insertTurnRun(sql, { turnId: "turn-running", status: "running_model" });

    await worker.recoverFromTurnLedger("chat-1", {} as PiRunner);

    expect(turnStatus(sql, "turn-running")).toMatchObject({
      status: "interrupted",
      failure_code: "runner_restarted_mid_model",
    });
    expect(send).toHaveBeenCalledWith(
      "do:agent",
      expect.any(String),
      "Agent turn was interrupted during model generation.",
      expect.objectContaining({ idempotencyKey: "turn-ledger-diagnostic:turn-running" })
    );
  });

  it("replays running_model turns only when the subclass opts in and a cursor exists", async () => {
    const { instance, sql, call } = await createTestDO(ReplayEnabledTestAgentWorker, {
      __objectKey: "agent-test",
      WORKER_SOURCE: "workers/test-agent",
      WORKER_CLASS_NAME: "ReplayEnabledTestAgentWorker",
      WORKERD_SESSION_ID: "session-1",
      WORKERD_BOOT_GENERATION: "42",
    });
    await call("getState");
    const submitContinue = vi.fn();
    const moveTo = vi.fn().mockResolvedValue(undefined);
    const worker = instance as unknown as {
      dispatchers: Map<string, unknown>;
      recoverFromTurnLedger(channelId: string, runner: PiRunner): Promise<boolean>;
    };
    worker.dispatchers.set("chat-1", { submitContinue, getDebugState: () => ({ busy: false }) });
    insertTurnRun(sql, { turnId: "turn-replay", status: "running_model" });
    sql.exec(
      `UPDATE agent_turn_runs
       SET model_start_cursor_entry_id = ?, checkpoint_entry_id = ?, checkpoint_generation = ?
       WHERE turn_id = ?`,
      "entry-model",
      "entry-model",
      42,
      "turn-replay"
    );
    const runner = {
      session: {
        getEntries: vi.fn().mockResolvedValue([{ id: "entry-model", type: "message" }]),
        moveTo,
      },
    } as unknown as PiRunner;

    await expect(worker.recoverFromTurnLedger("chat-1", runner)).resolves.toBe(true);
    await expect(worker.recoverFromTurnLedger("chat-1", runner)).resolves.toBe(false);

    expect(moveTo).toHaveBeenCalledWith("entry-model");
    expect(submitContinue).toHaveBeenCalledTimes(1);
    expect(submitContinue).toHaveBeenCalledWith({ turnId: "turn-replay" });
    expect(turnStatus(sql, "turn-replay")).toMatchObject({
      status: "continuing",
      resume_cursor_entry_id: "entry-model",
    });
    expect(
      sql
        .exec(
          `SELECT turn_id, generation, reason FROM agent_turn_resume_attempts WHERE turn_id = ?`,
          "turn-replay"
        )
        .toArray()
    ).toEqual([{ turn_id: "turn-replay", generation: 42, reason: "running_model_replay" }]);
  });

  it("does not replay running_model turns when a reachable tool is unsafe", async () => {
    const { instance, sql, call } = await createTestDO(ReplayEnabledUnsafeToolAgentWorker, {
      __objectKey: "agent-test",
      WORKER_SOURCE: "workers/test-agent",
      WORKER_CLASS_NAME: "ReplayEnabledUnsafeToolAgentWorker",
      WORKERD_BOOT_GENERATION: "42",
    });
    await call("getState");
    const send = vi.fn().mockResolvedValue(undefined);
    const submitContinue = vi.fn();
    const worker = instance as unknown as {
      subscriptions: { getParticipantId(channelId: string): string | null };
      createChannelClient: ReturnType<typeof vi.fn>;
      dispatchers: Map<string, unknown>;
      recoverFromTurnLedger(channelId: string, runner: PiRunner): Promise<boolean>;
    };
    worker.subscriptions.getParticipantId = vi.fn().mockReturnValue("do:agent");
    worker.createChannelClient = vi.fn().mockReturnValue(diagnosticChannel(send));
    worker.dispatchers.set("chat-1", { submitContinue, getDebugState: () => ({ busy: false }) });
    insertTurnRun(sql, { turnId: "turn-unsafe", status: "running_model" });
    sql.exec(
      `UPDATE agent_turn_runs SET model_start_cursor_entry_id = ? WHERE turn_id = ?`,
      "entry-model",
      "turn-unsafe"
    );

    await expect(
      worker.recoverFromTurnLedger("chat-1", {
        session: {
          getEntries: vi.fn().mockResolvedValue([{ id: "entry-model", type: "message" }]),
          moveTo: vi.fn(),
        },
      } as unknown as PiRunner)
    ).resolves.toBe(false);

    expect(submitContinue).not.toHaveBeenCalled();
    expect(turnStatus(sql, "turn-unsafe")).toMatchObject({
      status: "interrupted",
      failure_code: "runner_restarted_mid_model",
    });
    expect(send).toHaveBeenCalledWith(
      "do:agent",
      expect.any(String),
      "Agent turn was interrupted during model generation.",
      expect.objectContaining({ idempotencyKey: "turn-ledger-diagnostic:turn-unsafe" })
    );
  });

  it("does not replay when unsafe default harness tools remain reachable", async () => {
    const { instance, sql, call } = await createTestDO(ReplayEnabledUnfilteredAgentWorker, {
      __objectKey: "agent-test",
      WORKER_SOURCE: "workers/test-agent",
      WORKER_CLASS_NAME: "ReplayEnabledUnfilteredAgentWorker",
      WORKERD_BOOT_GENERATION: "42",
    });
    await call("getState");
    const send = vi.fn().mockResolvedValue(undefined);
    const submitContinue = vi.fn();
    const worker = instance as unknown as {
      subscriptions: { getParticipantId(channelId: string): string | null };
      createChannelClient: ReturnType<typeof vi.fn>;
      dispatchers: Map<string, unknown>;
      recoverFromTurnLedger(channelId: string, runner: PiRunner): Promise<boolean>;
    };
    worker.subscriptions.getParticipantId = vi.fn().mockReturnValue("do:agent");
    worker.createChannelClient = vi.fn().mockReturnValue(diagnosticChannel(send));
    worker.dispatchers.set("chat-1", { submitContinue, getDebugState: () => ({ busy: false }) });
    insertTurnRun(sql, { turnId: "turn-harness-unsafe", status: "running_model" });
    sql.exec(
      `UPDATE agent_turn_runs SET model_start_cursor_entry_id = ? WHERE turn_id = ?`,
      "entry-model",
      "turn-harness-unsafe"
    );

    await expect(
      worker.recoverFromTurnLedger("chat-1", {
        session: {
          getEntries: vi.fn().mockResolvedValue([{ id: "entry-model", type: "message" }]),
          moveTo: vi.fn(),
        },
      } as unknown as PiRunner)
    ).resolves.toBe(false);

    expect(submitContinue).not.toHaveBeenCalled();
    expect(turnStatus(sql, "turn-harness-unsafe")).toMatchObject({
      status: "interrupted",
      failure_code: "runner_restarted_mid_model",
    });
  });

  it("allows running_model replay when every reachable tool is annotated safe", async () => {
    const { instance, sql, call } = await createTestDO(ReplayEnabledSafeToolAgentWorker, {
      __objectKey: "agent-test",
      WORKER_SOURCE: "workers/test-agent",
      WORKER_CLASS_NAME: "ReplayEnabledSafeToolAgentWorker",
      WORKERD_BOOT_GENERATION: "42",
    });
    await call("getState");
    const submitContinue = vi.fn();
    const moveTo = vi.fn().mockResolvedValue(undefined);
    const worker = instance as unknown as {
      dispatchers: Map<string, unknown>;
      recoverFromTurnLedger(channelId: string, runner: PiRunner): Promise<boolean>;
    };
    worker.dispatchers.set("chat-1", { submitContinue, getDebugState: () => ({ busy: false }) });
    insertTurnRun(sql, { turnId: "turn-safe", status: "running_model" });
    sql.exec(
      `UPDATE agent_turn_runs SET model_start_cursor_entry_id = ? WHERE turn_id = ?`,
      "entry-model",
      "turn-safe"
    );

    await expect(
      worker.recoverFromTurnLedger("chat-1", {
        session: {
          getEntries: vi.fn().mockResolvedValue([{ id: "entry-model", type: "message" }]),
          moveTo,
        },
      } as unknown as PiRunner)
    ).resolves.toBe(true);

    expect(moveTo).toHaveBeenCalledWith("entry-model");
    expect(submitContinue).toHaveBeenCalledWith({ turnId: "turn-safe" });
    expect(turnStatus(sql, "turn-safe")).toMatchObject({
      status: "continuing",
      resume_cursor_entry_id: "entry-model",
    });
  });

  it("keeps running_model replay disabled by default even with a valid cursor", async () => {
    const { instance, sql } = await createTestDO(TestAgentWorker, {
      __objectKey: "agent-test",
    });
    const send = vi.fn().mockResolvedValue(undefined);
    const submitContinue = vi.fn();
    const worker = instance as unknown as {
      subscriptions: { getParticipantId(channelId: string): string | null };
      createChannelClient: ReturnType<typeof vi.fn>;
      dispatchers: Map<string, unknown>;
      recoverFromTurnLedger(channelId: string, runner: PiRunner): Promise<boolean>;
    };
    worker.subscriptions.getParticipantId = vi.fn().mockReturnValue("do:agent");
    worker.createChannelClient = vi.fn().mockReturnValue(diagnosticChannel(send));
    worker.dispatchers.set("chat-1", { submitContinue, getDebugState: () => ({ busy: false }) });
    insertTurnRun(sql, { turnId: "turn-no-replay", status: "running_model" });
    sql.exec(
      `UPDATE agent_turn_runs SET model_start_cursor_entry_id = ? WHERE turn_id = ?`,
      "entry-model",
      "turn-no-replay"
    );

    await worker.recoverFromTurnLedger("chat-1", {
      session: {
        getEntries: vi.fn().mockResolvedValue([{ id: "entry-model", type: "message" }]),
        moveTo: vi.fn(),
      },
    } as unknown as PiRunner);

    expect(submitContinue).not.toHaveBeenCalled();
    expect(turnStatus(sql, "turn-no-replay")).toMatchObject({
      status: "interrupted",
      failure_code: "runner_restarted_mid_model",
    });
  });

  it("drains close_turn_projection for closing turns and marks them closed", async () => {
    const { instance, sql } = await createTestDO(TestAgentWorker, {
      __objectKey: "agent-test",
    });
    const repairDurableOpenState = vi.fn().mockResolvedValue(undefined);
    const worker = instance as unknown as {
      recoverFromTurnLedger(channelId: string, runner: PiRunner): Promise<boolean>;
    };
    insertTurnRun(sql, { turnId: "turn-closing", status: "closing" });

    await worker.recoverFromTurnLedger("chat-1", {
      repairDurableOpenState,
    } as unknown as PiRunner);

    expect(repairDurableOpenState).toHaveBeenCalledWith({ closeOpenTurns: true });
    expect(turnStatus(sql, "turn-closing")).toMatchObject({ status: "closed" });
    expect(
      sql.exec(`SELECT status FROM agent_turn_outbox WHERE turn_id = ?`, "turn-closing").toArray()
    ).toEqual([expect.objectContaining({ status: "done" })]);
  });

  it("does nothing for terminal turn ledger rows during recovery", async () => {
    const { instance, sql } = await createTestDO(TestAgentWorker, {
      __objectKey: "agent-test",
    });
    const worker = instance as unknown as {
      recoverFromTurnLedger(channelId: string, runner: PiRunner): Promise<boolean>;
    };
    insertTurnRun(sql, { turnId: "turn-closed", status: "closed" });
    insertTurnRun(sql, { turnId: "turn-failed", status: "failed" });
    insertTurnRun(sql, { turnId: "turn-interrupted", status: "interrupted" });

    await expect(worker.recoverFromTurnLedger("chat-1", {} as PiRunner)).resolves.toBe(false);

    expect(turnStatus(sql, "turn-closed")).toMatchObject({ status: "closed" });
    expect(turnStatus(sql, "turn-failed")).toMatchObject({ status: "failed" });
    expect(turnStatus(sql, "turn-interrupted")).toMatchObject({ status: "interrupted" });
  });

  it("deduplicates done outbox diagnostics and retries failed outbox rows", async () => {
    const { instance, sql } = await createTestDO(TestAgentWorker, {
      __objectKey: "agent-test",
    });
    const failingSend = vi.fn().mockRejectedValueOnce(new Error("send failed"));
    const channel = diagnosticChannel(failingSend);
    const worker = instance as unknown as {
      subscriptions: { getParticipantId(channelId: string): string | null };
      createChannelClient: ReturnType<typeof vi.fn>;
      enqueueTurnOutbox(opts: {
        channelId: string;
        turnId: string;
        kind: "emit_diagnostic";
        dedupKey: string;
        payload: unknown;
      }): Promise<void>;
      drainTurnOutbox(channelId: string, runner?: PiRunner): Promise<void>;
    };
    worker.subscriptions.getParticipantId = vi.fn().mockReturnValue("do:agent");
    worker.createChannelClient = vi.fn().mockReturnValue(channel);

    await worker.enqueueTurnOutbox({
      channelId: "chat-1",
      turnId: "turn-outbox",
      kind: "emit_diagnostic",
      dedupKey: "same-diagnostic",
      payload: { message: "diagnostic once" },
    });
    await worker.enqueueTurnOutbox({
      channelId: "chat-1",
      turnId: "turn-outbox",
      kind: "emit_diagnostic",
      dedupKey: "same-diagnostic",
      payload: { message: "diagnostic once" },
    });
    expect(sql.exec(`SELECT COUNT(*) AS count FROM agent_turn_outbox`).toArray()[0]).toMatchObject({
      count: 1,
    });

    await worker.drainTurnOutbox("chat-1");
    expect(
      sql.exec(`SELECT status, attempts, last_error FROM agent_turn_outbox`).toArray()[0]
    ).toMatchObject({ status: "failed", attempts: 1, last_error: "send failed" });

    failingSend.mockResolvedValueOnce(undefined);
    await worker.drainTurnOutbox("chat-1");
    expect(
      sql.exec(`SELECT status, attempts, last_error FROM agent_turn_outbox`).toArray()[0]
    ).toMatchObject({ status: "done", attempts: 1, last_error: null });
    await worker.drainTurnOutbox("chat-1");
    expect(failingSend).toHaveBeenCalledTimes(2);
  });

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
      ): Promise<void>;
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

    await worker.markMethodSuspensionTerminal("call-1", {
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

    insertTurnRun(sql, { turnId: "turn-live-admit", status: "waiting_external" });
    insertSuspension(sql, {
      callId: "approval-call",
      invocationId: "tool-1",
      kind: "approval",
      deliveryStatus: "delivered_live",
      terminalKind: "completed",
      result: true,
      createdAt: 100,
      toolName: "bash",
      turnId: "turn-live-admit",
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
      turnId: "turn-live-admit",
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
    expect(turnStatus(sql, "turn-live-admit")).toMatchObject({ status: "continuing" });
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
    const submitContinue = vi.fn(() => {
      expect(turnStatus(sql, "turn-recovered")).toMatchObject({
        status: "continuing",
        resume_cursor_entry_id: "entry-recovered",
      });
    });
    const worker = instance as unknown as {
      runners: Map<string, { runner: unknown }>;
      dispatchers: Map<string, unknown>;
      recoverDeliveredAndOrphanedSuspensions(channelId: string): Promise<void>;
    };
    worker.runners.set("chat-1", {
      runner: {
        isInvocationOpen: () => true,
        hasToolResult: async () => false,
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
    insertTurnRun(sql, { turnId: "turn-recovered", status: "waiting_external" });

    insertSuspension(sql, {
      callId: "approval-call",
      invocationId: "tool-1",
      kind: "approval",
      deliveryStatus: "pending",
      terminalKind: "completed",
      result: true,
      createdAt: 100,
      toolName: "bash",
      turnId: "turn-recovered",
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
      turnId: "turn-recovered",
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
    expect(submitContinue).toHaveBeenCalledWith({ turnId: "turn-recovered" });
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
        hasToolResult: async () => false,
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
        hasToolResult: async () => false,
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
      turnId: "turn-approval",
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
    expect(submitContinue).toHaveBeenCalledWith({ turnId: "turn-approval" });
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
        hasToolResult: async () => false,
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

  it("hydrates a spilled blob-ref ui prompt reply before replaying it into the resumed tool", async () => {
    const { instance, sql } = await createTestDO(TestAgentWorker, {
      __objectKey: "agent-test",
    });
    const appended: AgentMessage[] = [];
    const submitContinue = vi.fn();
    const rpcCall = vi.fn(async (_target: string, method: string, args: unknown[]) => {
      if (method === "blobstore.getText" && args[0] === "ui-reply-digest") {
        return JSON.stringify("approved-via-blob");
      }
      return null;
    });
    let replayed: unknown;
    const worker = instance as unknown as {
      _rpc: {
        call: ReturnType<typeof vi.fn>;
        stream: ReturnType<typeof vi.fn>;
        emit: ReturnType<typeof vi.fn>;
        on: ReturnType<typeof vi.fn>;
        handleIncomingPost: ReturnType<typeof vi.fn>;
      };
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
    worker._rpc = {
      call: rpcCall,
      stream: vi.fn(),
      emit: vi.fn(),
      on: vi.fn(),
      handleIncomingPost: vi.fn(),
    };
    const executeToolDirect = vi.fn(async () => {
      replayed = await worker.dispatchUiPrompt("chat-1", "tool-1", "input", {
        title: "Name?",
      });
      return {
        content: [{ type: "text", text: `replayed=${String(replayed)}` }],
      };
    });
    worker.runners.set("chat-1", {
      runner: {
        isInvocationOpen: () => true,
        hasToolResult: async () => false,
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
      // The reply was spilled to the blobstore and the ledger keeps the raw
      // ref inline (result-preserving). Recovery must hydrate it before
      // replaying; otherwise the resumed tool receives a raw blob ref, which
      // coerceUiPromptResult would JSON.stringify instead of yielding the value.
      result: {
        protocol: "natstack.blob-ref.v1",
        digest: "ui-reply-digest",
        size: 32,
        encoding: "json",
        originalBytes: 32,
      },
      createdAt: 100,
      toolName: "custom_tool",
      args: {
        prompt: { kind: "input", title: "Name?" },
        resumeToolInput: { value: 7 },
      },
    });

    await worker.recoverDeliveredAndOrphanedSuspensions("chat-1");

    expect(rpcCall).toHaveBeenCalledWith("main", "blobstore.getText", ["ui-reply-digest"]);
    expect(replayed).toBe("approved-via-blob");
    expect(appended).toHaveLength(1);
    expect(appended[0]).toMatchObject({
      role: "toolResult",
      toolCallId: "tool-1",
      toolName: "custom_tool",
      content: [{ type: "text", text: "replayed=approved-via-blob" }],
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
        hasToolResult: async () => false,
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

  it("settles a live waiter even when its durable suspension row is missing", async () => {
    const { instance } = await createTestDO(TestAgentWorker, {
      __objectKey: "agent-test",
    });
    const worker = instance as unknown as {
      createMethodResultWaiter(
        channelId: string,
        callId: string,
        invocationId: string,
        opts: { method: string }
      ): { promise: Promise<{ result: unknown; isError: boolean }> };
      handleCompletedMethodResult(
        channelId: string,
        callId: string,
        result: unknown,
        isError: boolean
      ): Promise<void>;
    };

    const waiter = worker.createMethodResultWaiter("chat-1", "call-1", "tool-1", {
      method: "ui_prompt",
    });

    await worker.handleCompletedMethodResult("chat-1", "call-1", { approved: true }, false);

    await expect(waiter.promise).resolves.toEqual({
      result: { approved: true },
      isError: false,
    });
  });

  it("spills large live method results before storing suspension terminals", async () => {
    const { instance, sql } = await createTestDO(TestAgentWorker, {
      __objectKey: "agent-test",
    });
    const largeText = "x".repeat(300 * 1024);
    const rpcCall = vi.fn(async (_target: string, method: string, args: unknown[]) => {
      if (method === "blobstore.putText") {
        expect(args[0]).toContain(largeText);
        return { digest: "large-result-digest", size: String(args[0]).length };
      }
      return null;
    });
    const worker = instance as unknown as {
      _rpc: {
        call: ReturnType<typeof vi.fn>;
        stream: ReturnType<typeof vi.fn>;
        emit: ReturnType<typeof vi.fn>;
        on: ReturnType<typeof vi.fn>;
        handleIncomingPost: ReturnType<typeof vi.fn>;
      };
      createMethodResultWaiter(
        channelId: string,
        callId: string,
        invocationId: string,
        opts: { method: string }
      ): { promise: Promise<{ result: unknown; isError: boolean }> };
      handleCompletedMethodResult(
        channelId: string,
        callId: string,
        result: unknown,
        isError: boolean
      ): Promise<void>;
    };
    worker._rpc = {
      call: rpcCall,
      stream: vi.fn(),
      emit: vi.fn(),
      on: vi.fn(),
      handleIncomingPost: vi.fn(),
    };
    insertSuspension(sql, {
      callId: "call-1",
      terminalKind: "none",
      deliveryStatus: "pending",
    });
    const waiter = worker.createMethodResultWaiter("chat-1", "call-1", "tool-1", {
      method: "eval",
    });

    await worker.handleCompletedMethodResult(
      "chat-1",
      "call-1",
      { content: [{ type: "text", text: largeText }] },
      false
    );

    await expect(waiter.promise).resolves.toMatchObject({
      result: { content: [{ type: "text", text: largeText }] },
      isError: false,
    });
    const row = sql
      .exec(
        `SELECT result_json, result_ref_json, delivery_status FROM agent_method_suspensions WHERE transport_call_id = ?`,
        "call-1"
      )
      .toArray()[0]!;
    const stored = JSON.parse(row["result_ref_json"] as string) as Record<string, unknown>;
    expect(stored).toMatchObject({
      protocol: "natstack.blob-ref.v1",
      digest: "large-result-digest",
      encoding: "json",
    });
    expect(row).toMatchObject({ delivery_status: "delivered_live" });
    expect(row["result_json"]).toBeNull();
    expect(row["result_ref_json"]).not.toContain(largeText);
  });

  it("does not stall when large method result blob persistence fails", async () => {
    const { instance, sql } = await createTestDO(TestAgentWorker, {
      __objectKey: "agent-test",
    });
    const largeText = "x".repeat(300 * 1024);
    const worker = instance as unknown as {
      _rpc: {
        call: ReturnType<typeof vi.fn>;
        stream: ReturnType<typeof vi.fn>;
        emit: ReturnType<typeof vi.fn>;
        on: ReturnType<typeof vi.fn>;
        handleIncomingPost: ReturnType<typeof vi.fn>;
      };
      createMethodResultWaiter(
        channelId: string,
        callId: string,
        invocationId: string,
        opts: { method: string }
      ): { promise: Promise<{ result: unknown; isError: boolean }> };
      handleCompletedMethodResult(
        channelId: string,
        callId: string,
        result: unknown,
        isError: boolean
      ): Promise<void>;
    };
    worker._rpc = {
      call: vi.fn(async (_target: string, method: string) => {
        if (method === "blobstore.putText") throw new Error("blobstore down");
        return null;
      }),
      stream: vi.fn(),
      emit: vi.fn(),
      on: vi.fn(),
      handleIncomingPost: vi.fn(),
    };
    insertSuspension(sql, {
      callId: "call-blob-fail",
      terminalKind: "none",
      deliveryStatus: "pending",
    });
    const waiter = worker.createMethodResultWaiter("chat-1", "call-blob-fail", "tool-blob-fail", {
      method: "eval",
    });

    await worker.handleCompletedMethodResult(
      "chat-1",
      "call-blob-fail",
      { content: [{ type: "text", text: largeText }] },
      false
    );

    await expect(waiter.promise).resolves.toMatchObject({ isError: false });
    const row = sql
      .exec(
        `SELECT result_json, result_ref_json, delivery_status, recovery_error FROM agent_method_suspensions WHERE transport_call_id = ?`,
        "call-blob-fail"
      )
      .toArray()[0]!;
    expect(row["result_ref_json"]).toBeNull();
    expect(JSON.parse(row["result_json"] as string)).toMatchObject({
      omitted: true,
      reason: "large suspension result could not be stored",
    });
    expect(row).toMatchObject({ delivery_status: "delivered_live" });
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
        hasToolResult: async () => false,
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
        stream: ReturnType<typeof vi.fn>;
        emit: ReturnType<typeof vi.fn>;
        on: ReturnType<typeof vi.fn>;
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
      stream: vi.fn(),
      emit: vi.fn(),
      on: vi.fn(),
      handleIncomingPost: vi.fn(),
    };
    worker.runners.set("chat-1", {
      runner: {
        isInvocationOpen: () => true,
        hasToolResult: async () => false,
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

    const storedRef = {
      protocol: "natstack.blob-ref.v1",
      digest: "stored-result-digest",
      size: 128,
      encoding: "json",
      originalBytes: 128,
    };
    await worker.handleCompletedMethodResult("chat-1", "call-1", storedRef, false);

    expect(rpcCall).toHaveBeenCalledWith("main", "blobstore.getText", ["stored-result-digest"]);
    expect(appended).toHaveLength(1);
    // The admitted tool result is hydrated for the model.
    expect(appended[0]).toMatchObject({
      role: "toolResult",
      toolCallId: "tool-1",
      content: [{ type: "text", text: "stored eval output" }],
      details: { bytes: 18 },
    });
    // The suspension ledger keeps the blob ref, not the inlined payload, so
    // large results stay in the blobstore rather than being hydrated and
    // re-spilled into a duplicate blob by encodeSuspensionStorage.
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
      result_json: JSON.stringify(storedRef),
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
        stream: ReturnType<typeof vi.fn>;
        emit: ReturnType<typeof vi.fn>;
        on: ReturnType<typeof vi.fn>;
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
      stream: vi.fn(),
      emit: vi.fn(),
      on: vi.fn(),
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
    ).rejects.toThrow(
      "method result channel=chat-1 call=call-1 invocation=tool-1 stored value missing at $: missing-digest"
    );
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

  it("rejects stored refs that reach transcript admission", async () => {
    const { instance } = await createTestDO(TestAgentWorker, {
      __objectKey: "agent-test",
    });
    const worker = instance as unknown as {
      runners: Map<string, { runner: unknown }>;
      readRunnerMessages(channelId: string): Promise<AgentMessage[]>;
    };
    worker.runners.set("chat-1", {
      runner: {
        getStateSnapshot: async () => ({
          messages: [
            {
              role: "toolResult",
              toolCallId: "tool-1",
              toolName: "eval",
              content: [
                {
                  type: "text",
                  text: {
                    protocol: "natstack.blob-ref.v1",
                    digest: "leaked-digest",
                    size: 32,
                    encoding: "json",
                    originalBytes: 32,
                  },
                },
              ],
            },
          ],
        }),
      },
    });

    await expect(worker.readRunnerMessages("chat-1")).rejects.toThrow(
      "runner.getStateSnapshot channel=chat-1[0] contains unresolved stored value refs: $.content[0].text -> leaked-digest"
    );
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
        hasToolResult: async () => false,
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
      subscriptions: { getParticipantId(channelId: string): string | null };
      createChannelClient: ReturnType<typeof vi.fn>;
      recoverDeliveredAndOrphanedSuspensions(channelId: string): Promise<void>;
    };
    const send = vi.fn().mockResolvedValue(undefined);
    worker.subscriptions.getParticipantId = vi.fn().mockReturnValue("do:agent");
    worker.createChannelClient = vi.fn().mockReturnValue({ send });
    worker.runners.set("chat-1", {
      runner: {
        isInvocationOpen: () => false,
        hasToolResult: async () => true,
        isLeafDescendantOf: async () => true,
        getSessionBranchEntryIds: async () => ["entry-1"],
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
    expect(send).toHaveBeenCalledWith(
      "do:agent",
      expect.any(String),
      expect.stringContaining("Tool result could not be safely resumed"),
      expect.objectContaining({
        idempotencyKey: "method-recovery-stale:chat-1:call-1",
      })
    );
  });

  it("records branch diagnostics and surfaces an error when completed recovery is unsafe to replay", async () => {
    const { instance, sql } = await createTestDO(TestAgentWorker, {
      __objectKey: "agent-test",
    });
    const appendToolResult = vi.fn();
    const send = vi.fn().mockResolvedValue(undefined);
    const worker = instance as unknown as {
      runners: Map<string, { runner: unknown }>;
      dispatchers: Map<string, unknown>;
      subscriptions: { getParticipantId(channelId: string): string | null };
      createChannelClient: ReturnType<typeof vi.fn>;
      getDebugState(channelId?: string): Promise<Record<string, unknown>>;
      recoverDeliveredAndOrphanedSuspensions(channelId: string): Promise<void>;
    };
    worker.subscriptions.getParticipantId = vi.fn().mockReturnValue("do:agent");
    worker.createChannelClient = vi.fn().mockReturnValue({ send });
    worker.runners.set("chat-1", {
      runner: {
        isInvocationOpen: () => false,
        hasToolResult: async () => false,
        isLeafDescendantOf: async () => false,
        getSessionBranchEntryIds: async () => ["root", "active-leaf"],
        getDebugState: async () => ({ restoredBranch: ["root", "active-leaf"] }),
        appendToolResult,
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
      sessionLeafBeforeCall: "old-leaf",
    });

    await worker.recoverDeliveredAndOrphanedSuspensions("chat-1");

    expect(appendToolResult).not.toHaveBeenCalled();
    expect(
      sql
        .exec(
          `SELECT delivery_status, recovery_error
             FROM agent_method_suspensions
             WHERE transport_call_id = ?`,
          "call-1"
        )
        .toArray()[0]
    ).toMatchObject({ delivery_status: "stale", recovery_error: "session branch moved" });
    expect(send).toHaveBeenCalledWith(
      "do:agent",
      expect.any(String),
      expect.stringContaining("session branch moved"),
      expect.objectContaining({
        idempotencyKey: "method-recovery-stale:chat-1:call-1",
      })
    );
    const debugState = await worker.getDebugState("chat-1");
    expect(JSON.stringify(debugState)).toContain("active-leaf");
  });

  it("recovers an open invocation even when the session leaf moved", async () => {
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
        hasToolResult: async () => false,
        isLeafDescendantOf: async () => false,
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
      callId: "call-1",
      terminalKind: "completed",
      result: { content: [{ type: "text", text: "done" }] },
      sessionLeafBeforeCall: "old-leaf",
    });

    await worker.recoverDeliveredAndOrphanedSuspensions("chat-1");

    expect(appended).toHaveLength(1);
    expect(appended[0]).toMatchObject({
      role: "toolResult",
      toolCallId: "tool-1",
      content: [{ type: "text", text: "done" }],
    });
    expect(submitContinue).toHaveBeenCalledTimes(1);
    expect(
      sql
        .exec(
          `SELECT delivery_status, recovery_error, recovered_entry_id
             FROM agent_method_suspensions
             WHERE transport_call_id = ?`,
          "call-1"
        )
        .toArray()[0]
    ).toMatchObject({
      delivery_status: "recovered",
      recovery_error: null,
      recovered_entry_id: "entry-recovered",
    });
  });

  it("recovers a completed invocation after restart when the restored session branch still contains the call leaf", async () => {
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
        isInvocationOpen: () => false,
        hasToolResult: async () => false,
        isLeafDescendantOf: async (entryId: string) => entryId === "call-leaf",
        getSessionBranchEntryIds: async () => ["root", "call-leaf"],
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
      callId: "call-1",
      terminalKind: "completed",
      result: { content: [{ type: "text", text: "done" }] },
      sessionLeafBeforeCall: "call-leaf",
    });

    await worker.recoverDeliveredAndOrphanedSuspensions("chat-1");

    expect(appended).toHaveLength(1);
    expect(appended[0]).toMatchObject({
      role: "toolResult",
      toolCallId: "tool-1",
      content: [{ type: "text", text: "done" }],
    });
    expect(submitContinue).toHaveBeenCalledTimes(1);
    expect(
      sql
        .exec(
          `SELECT delivery_status, recovery_error, recovered_entry_id
             FROM agent_method_suspensions
             WHERE transport_call_id = ?`,
          "call-1"
        )
        .toArray()[0]
    ).toMatchObject({
      delivery_status: "recovered",
      recovery_error: null,
      recovered_entry_id: "entry-recovered",
    });
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
        hasToolResult: async () => false,
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
      worker.invokeChannelMethod(
        "chat-1",
        "tool-1",
        "user",
        "eval",
        { code: "1" },
        undefined,
        undefined,
        "turn-dispatch-failed"
      )
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

  it("cancels stale tool dispatches after a turn was interrupted without leaking ledger errors", async () => {
    const { instance, sql } = await createTestDO(TestAgentWorker, {
      __objectKey: "agent-test",
    });
    const callMethod = vi.fn().mockResolvedValue(undefined);
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
    };
    worker.subscriptions.getParticipantId = vi.fn().mockReturnValue("do:agent");
    worker.createChannelClient = vi.fn().mockReturnValue({
      getParticipants: vi.fn().mockResolvedValue([
        {
          participantId: "panel:panel-1",
          metadata: { handle: "user", type: "panel" },
        },
      ]),
      callMethod,
    });
    insertTurnRun(sql, { turnId: "turn-interrupted-dispatch", status: "interrupted" });

    await expect(
      worker.invokeChannelMethod(
        "chat-1",
        "tool-interrupted",
        "user",
        "eval",
        { code: "1" },
        undefined,
        undefined,
        "turn-interrupted-dispatch"
      )
    ).resolves.toMatchObject({
      isError: true,
      content: [{ type: "text", text: "Agent turn was interrupted before tool dispatch." }],
      details: {
        __natstack_terminal: {
          outcome: "stale_dispatch",
          reasonCode: "aborted_before_dispatch",
        },
      },
    });

    expect(callMethod).not.toHaveBeenCalled();
    expect(sql.exec(`SELECT COUNT(*) AS count FROM agent_method_suspensions`).toArray()[0]).toEqual(
      { count: 0 }
    );
  });

  it("throws instead of returning a tool error when the live turn signal is already aborted", async () => {
    const { instance, sql } = await createTestDO(TestAgentWorker, {
      __objectKey: "agent-test",
    });
    const callMethod = vi.fn();
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
    };
    worker.subscriptions.getParticipantId = vi.fn().mockReturnValue("do:agent");
    worker.createChannelClient = vi.fn().mockReturnValue({
      getParticipants: vi.fn().mockResolvedValue([
        {
          participantId: "panel:panel-1",
          metadata: { handle: "user", type: "panel" },
        },
      ]),
      callMethod,
    });
    const controller = new AbortController();
    controller.abort(new Error("Request was aborted"));

    await expect(
      worker.invokeChannelMethod(
        "chat-1",
        "tool-aborted",
        "user",
        "eval",
        { code: "1" },
        controller.signal
      )
    ).rejects.toThrow("Request was aborted");

    expect(callMethod).not.toHaveBeenCalled();
    expect(sql.exec(`SELECT COUNT(*) AS count FROM agent_method_suspensions`).toArray()[0]).toEqual(
      { count: 0 }
    );
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

  it("serves debug state without waiting for activation cleanup", async () => {
    const { instance, sql } = await createTestDO(TestAgentWorker, {
      __objectKey: "agent-test",
    });
    const setTypingState = vi.fn(() => new Promise<void>(() => undefined));
    const worker = instance as unknown as {
      createChannelClient: ReturnType<typeof vi.fn>;
      getDebugState(channelId?: string): Promise<Record<string, unknown>>;
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

    const debug = await worker.getDebugState("chat-1");

    expect(debug["requestedChannelId"]).toBe("chat-1");
    expect(worker.createChannelClient).not.toHaveBeenCalled();
    expect(setTypingState).not.toHaveBeenCalled();
  });
});

describe("AgentWorkerBase interrupt recovery", () => {
  it("force-closes an open turn before disposing a runner during channel unsubscribe", async () => {
    const { instance } = await createTestDO(InterruptTestAgentWorker, {
      __objectKey: "agent-test",
    });
    const calls: string[] = [];
    const forceCloseCurrentTurn = vi.fn().mockImplementation(async () => {
      calls.push("forceCloseCurrentTurn");
      return true;
    });
    const dispose = vi.fn().mockImplementation(() => {
      calls.push("dispose");
    });
    const dispatcherDispose = vi.fn();
    const worker = instance as unknown as {
      runners: Map<string, unknown>;
      dispatchers: Map<string, unknown>;
      abortContexts: Map<string, { reason: string }>;
      unsubscribeChannel(channelId: string): Promise<unknown>;
    };

    worker.runners.set("chat-1", {
      runner: {
        forceCloseCurrentTurn,
        dispose,
      },
    });
    worker.dispatchers.set("chat-1", { dispose: dispatcherDispose });

    await worker.unsubscribeChannel("chat-1");

    expect(dispatcherDispose).toHaveBeenCalledTimes(1);
    expect(forceCloseCurrentTurn).toHaveBeenCalledWith(
      "channel_unsubscribe",
      "Turn closed after channel unsubscribe"
    );
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(["forceCloseCurrentTurn", "dispose"]);
    expect(worker.runners.has("chat-1")).toBe(false);
    expect(worker.abortContexts.has("chat-1")).toBe(false);
  });

  it("resets dispatcher and force-closes the turn without awaiting a stuck runner interrupt", async () => {
    const { instance } = await createTestDO(InterruptTestAgentWorker, {
      __objectKey: "agent-test",
    });
    const order: string[] = [];
    const dispatcherInterrupt = vi.fn(() => order.push("dispatcher_interrupt"));
    const abort = vi.fn(() => {
      order.push("runner_abort");
      return new Promise<void>(() => {});
    });
    const forceCloseCurrentTurn = vi.fn().mockResolvedValue(true);
    const interrupt = vi.fn(() => new Promise<void>(() => {}));
    const worker = instance as unknown as {
      runners: Map<string, unknown>;
      dispatchers: Map<string, unknown>;
      abortContexts: Map<string, { reason: string }>;
      notifyDispatchesInterrupted(channelId: string): Promise<void>;
      testInterruptRunner(channelId: string): Promise<void>;
    };
    worker.notifyDispatchesInterrupted = vi.fn(async () => {
      order.push("notify_dispatches_interrupted");
    });

    worker.runners.set("chat-1", {
      runner: {
        abort,
        forceCloseCurrentTurn,
        interrupt,
        getDebugState: vi.fn(async () => ({})),
      },
    });
    worker.dispatchers.set("chat-1", { interrupt: dispatcherInterrupt });

    await worker.testInterruptRunner("chat-1");

    expect(dispatcherInterrupt).toHaveBeenCalledTimes(1);
    expect(abort).toHaveBeenCalledTimes(1);
    expect(order.slice(0, 3)).toEqual([
      "dispatcher_interrupt",
      "runner_abort",
      "notify_dispatches_interrupted",
    ]);
    expect(forceCloseCurrentTurn).toHaveBeenCalledWith(
      "user_interrupted",
      "Turn closed after user interruption"
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
      getDebugState(channelId?: string): Promise<Record<string, unknown>>;
    };

    worker.runners.set("chat-1", {
      runner: {
        forceCloseCurrentTurn,
        interrupt,
        getDebugState: vi.fn(async () => ({})),
      },
    });
    worker.dispatchers.set("chat-1", { interrupt: vi.fn(), getDebugState: vi.fn(() => ({})) });

    await expect(worker.testInterruptRunner("chat-1")).resolves.toBeUndefined();

    expect(interrupt).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      "[TrajectoryVesselBase] forceCloseCurrentTurn failed for channel=chat-1:",
      expect.any(Error)
    );
    const debug = await worker.getDebugState("chat-1");
    expect((debug["volatile"] as { lastErrors?: unknown[] }).lastErrors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          channelId: "chat-1",
          scope: "runner.force_close",
          message: "close failed",
        }),
      ])
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
      worker.dispatchers.set(channelId, { interrupt: vi.fn() });
    }

    await worker.testInterruptAllRunners();

    expect(worker.abortContexts.get("chat-1")?.reason).toBe("interrupt-all");
    expect(worker.abortContexts.get("chat-2")?.reason).toBe("interrupt-all");
  });
});

describe("AgentWorkerBase typed transcript input", () => {
  it("normalizes object-shaped image attachment data before and after resize", async () => {
    const { instance } = await createTestDO(TestAgentWorker, {
      __objectKey: "agent-test",
    });
    const original = Buffer.from([1, 2, 3, 4]);
    const resized = Buffer.from([4, 3, 2, 1]);
    const call = vi.fn(async (_target: string, method: string, args: unknown[]) => {
      if (method === "extensions.streamingMethods") return [];
      if (method === "extensions.invoke") {
        const [extensionName, functionName, invokeArgs] = args as [string, string, unknown[]];
        expect(extensionName).toBe("@workspace-extensions/image-service");
        expect(functionName).toBe("resize");
        expect(Buffer.from(invokeArgs[0] as Uint8Array)).toEqual(original);
        return {
          data: { __bin: true, data: resized.toString("base64") },
          mimeType: "image/png",
        };
      }
      return null;
    });
    const worker = instance as unknown as {
      _rpc: {
        call: ReturnType<typeof vi.fn>;
        stream: ReturnType<typeof vi.fn>;
        emit: ReturnType<typeof vi.fn>;
        on: ReturnType<typeof vi.fn>;
        handleIncomingPost: ReturnType<typeof vi.fn>;
      };
      testResizeAttachments(
        channelId: string,
        attachments: ChannelEvent["attachments"]
      ): Promise<unknown>;
    };
    worker._rpc = {
      call,
      stream: vi.fn(),
      emit: vi.fn(),
      on: vi.fn(),
      handleIncomingPost: vi.fn(),
    };

    await expect(
      worker.testResizeAttachments("chat-1", [
        {
          id: "att-1",
          type: "image",
          data: { __bin: true, data: original.toString("base64") } as unknown as string,
          mimeType: "image/png",
          size: original.byteLength,
        },
      ])
    ).resolves.toEqual([
      { type: "image", mimeType: "image/png", data: resized.toString("base64") },
    ]);
  });

  it("normalizes JSON-serialized Uint8Array image attachment data", async () => {
    const { instance } = await createTestDO(TestAgentWorker, {
      __objectKey: "agent-test",
    });
    const original = Buffer.from([137, 80, 78, 71]);
    const resized = Buffer.from([1, 2, 3]);
    const call = vi.fn(async (_target: string, method: string, args: unknown[]) => {
      if (method === "extensions.streamingMethods") return [];
      if (method === "extensions.invoke") {
        const [extensionName, functionName, invokeArgs] = args as [string, string, unknown[]];
        expect(extensionName).toBe("@workspace-extensions/image-service");
        expect(functionName).toBe("resize");
        expect(Buffer.from(invokeArgs[0] as Uint8Array)).toEqual(original);
        return {
          data: resized,
          mimeType: "image/png",
        };
      }
      return null;
    });
    const worker = instance as unknown as {
      _rpc: {
        call: ReturnType<typeof vi.fn>;
        stream: ReturnType<typeof vi.fn>;
        emit: ReturnType<typeof vi.fn>;
        on: ReturnType<typeof vi.fn>;
        handleIncomingPost: ReturnType<typeof vi.fn>;
      };
      testResizeAttachments(
        channelId: string,
        attachments: ChannelEvent["attachments"]
      ): Promise<unknown>;
    };
    worker._rpc = {
      call,
      stream: vi.fn(),
      emit: vi.fn(),
      on: vi.fn(),
      handleIncomingPost: vi.fn(),
    };

    await expect(
      worker.testResizeAttachments("chat-1", [
        {
          id: "att-1",
          type: "image",
          data: JSON.parse(JSON.stringify(original)) as unknown as string,
          mimeType: "image/png",
          size: original.byteLength,
        },
      ])
    ).resolves.toEqual([
      { type: "image", mimeType: "image/png", data: resized.toString("base64") },
    ]);
  });

  it("falls back to normalized original image data when resize fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { instance } = await createTestDO(TestAgentWorker, {
      __objectKey: "agent-test",
    });
    const original = Buffer.from([9, 8, 7]);
    const worker = instance as unknown as {
      _rpc: {
        call: ReturnType<typeof vi.fn>;
        stream: ReturnType<typeof vi.fn>;
        emit: ReturnType<typeof vi.fn>;
        on: ReturnType<typeof vi.fn>;
        handleIncomingPost: ReturnType<typeof vi.fn>;
      };
      testResizeAttachments(
        channelId: string,
        attachments: ChannelEvent["attachments"]
      ): Promise<unknown>;
    };
    worker._rpc = {
      call: vi.fn(async (_target: string, method: string) => {
        if (method === "extensions.streamingMethods") return [];
        if (method === "extensions.invoke") throw new Error("resize unavailable");
        return null;
      }),
      stream: vi.fn(),
      emit: vi.fn(),
      on: vi.fn(),
      handleIncomingPost: vi.fn(),
    };

    await expect(
      worker.testResizeAttachments("chat-1", [
        {
          id: "att-1",
          type: "image",
          data: { type: "Buffer", data: [...original] } as unknown as string,
          mimeType: "image/png",
          size: original.byteLength,
        },
      ])
    ).resolves.toEqual([
      { type: "image", mimeType: "image/png", data: original.toString("base64") },
    ]);
    expect(warn).toHaveBeenCalledWith(
      "[TrajectoryVesselBase] image-service.resize failed for channel=chat-1; passing original:",
      expect.any(Error)
    );
    warn.mockRestore();
  });

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

  it("does not call the runner when required channel tools are absent", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { instance } = await createTestDO(ExpectedToolGateTestWorker, {
      __objectKey: "agent-test",
    });
    const worker = instance as unknown as ExpectedToolGateTestWorker & {
      subscriptions: {
        getParticipantId(channelId: string): string | null;
      };
      processChannelEvent(channelId: string, event: unknown): Promise<void>;
    };
    worker.subscriptions.getParticipantId = vi.fn().mockReturnValue("do:agent");

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
          content: "run with eval",
        },
        createdAt: "2026-05-21T08:00:00.000Z",
      },
      ts: Date.now(),
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(worker.prompt).not.toHaveBeenCalled();
    expect(worker.emittedDiagnostics).toEqual([
      "Agent turn failed while running: Cannot start agent model turn: missing expected channel tool(s): eval",
    ]);
    expect(error).toHaveBeenCalledWith(
      "[TrajectoryVesselBase] Expected channel tools were not available",
      expect.objectContaining({
        missingExpectedChannelToolNames: ["eval"],
        rosterToolNames: [],
        participantCount: 0,
      })
    );
    error.mockRestore();
    warn.mockRestore();
  });
});

describe("TrajectoryVesselBase respond policy", () => {
  it("does not create a runner for non-addressed channel events", async () => {
    const { instance } = await createTestDO(GatingTestAgentWorker, {
      __objectKey: "agent-test",
    });
    const worker = instance as unknown as {
      subscriptions: { getParticipantId(channelId: string): string | null };
      processChannelEvent(channelId: string, event: ChannelEvent): Promise<void>;
      refreshCount: number;
      runnerCount: number;
    };
    worker.subscriptions.getParticipantId = vi.fn().mockReturnValue("do:agent");

    await worker.processChannelEvent("chat-1", {
      id: 1,
      messageId: "msg-1",
      type: AGENTIC_EVENT_PAYLOAD_KIND,
      senderId: "panel:panel-1",
      senderMetadata: { name: "User", type: "panel", handle: "user" },
      payload: {
        kind: "message.completed",
        actor: { kind: "panel", id: "panel:panel-1" },
        causality: { messageId: "msg-1" },
        payload: {
          protocol: "agentic.trajectory.v1",
          role: "user",
          content: "not addressed to the agent",
        },
        createdAt: "2026-05-21T08:00:00.000Z",
      },
      ts: Date.now(),
    } as unknown as ChannelEvent);

    expect(worker.refreshCount).toBe(1);
    expect(worker.runnerCount).toBe(0);
  });

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

    const blobstoreGetText = vi.fn(async (_target: string, method: string, args: unknown[]) => {
      if (method === "blobstore.getText" && args[0] === "custom-initial-digest") {
        return JSON.stringify({ count: 0 });
      }
      if (method === "blobstore.getText" && args[0] === "custom-update-digest") {
        return JSON.stringify({ delta: 1 });
      }
      return null;
    });
    (
      instance as unknown as {
        _rpc: {
          call: ReturnType<typeof vi.fn>;
          stream: ReturnType<typeof vi.fn>;
          emit: ReturnType<typeof vi.fn>;
          on: ReturnType<typeof vi.fn>;
          handleIncomingPost: ReturnType<typeof vi.fn>;
        };
      }
    )._rpc = {
      call: blobstoreGetText,
      stream: vi.fn(),
      emit: vi.fn(),
      on: vi.fn(),
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
    expect(blobstoreGetText).toHaveBeenCalledWith("main", "blobstore.getText", [
      "custom-initial-digest",
    ]);
    expect(blobstoreGetText).toHaveBeenCalledWith("main", "blobstore.getText", [
      "custom-update-digest",
    ]);
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

/** Build a {kind:"log"} channel envelope carrying a durable invocation.* terminal. */
function invocationTerminalEnvelope(opts: {
  terminal: "invocation.completed" | "invocation.failed" | "invocation.cancelled" | "invocation.abandoned";
  invocationId: string;
  transportCallId: string;
  content: unknown;
  terminalReasonCode?: string;
}) {
  const outcome =
    opts.terminal === "invocation.completed"
      ? "success"
      : opts.terminal === "invocation.failed"
        ? "tool_error"
        : opts.terminal === "invocation.abandoned"
          ? "abandoned"
          : "cancelled";
  const payload =
    opts.terminal === "invocation.completed"
      ? { protocol: "agentic.trajectory.v1", terminalOutcome: outcome, result: opts.content }
      : {
          protocol: "agentic.trajectory.v1",
          terminalOutcome: outcome,
          reason: typeof opts.content === "string" ? opts.content : "method failed",
          error: opts.content,
          ...(opts.terminalReasonCode ? { terminalReasonCode: opts.terminalReasonCode } : {}),
        };
  return {
    kind: "log" as const,
    phase: "live" as const,
    event: {
      id: 1,
      messageId: "",
      type: AGENTIC_EVENT_PAYLOAD_KIND,
      payload: {
        kind: opts.terminal,
        actor: { kind: "panel", id: "panel:panel-1" },
        causality: { invocationId: opts.invocationId, transportCallId: opts.transportCallId },
        payload,
        createdAt: new Date().toISOString(),
      },
      senderId: "panel:panel-1",
      ts: Date.now(),
    },
  };
}

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
      onChannelEnvelope(channelId: string, envelope: unknown): Promise<void>;
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
        await worker.onChannelEnvelope("chat-1", invocationTerminalEnvelope({
          terminal: "invocation.completed",
          invocationId: opts.invocationId,
          transportCallId: opts.transportCallId,
          content: { ok: true },
        }));
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
      onChannelEnvelope(channelId: string, envelope: unknown): Promise<void>;
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
        await worker.onChannelEnvelope("chat-1", invocationTerminalEnvelope({
          terminal: "invocation.failed",
          invocationId: opts.invocationId,
          transportCallId: opts.transportCallId,
          content: { error: "Authentication failed for internal push" },
          terminalReasonCode: "method_failed",
        }));
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

  it("returns abandoned participant method results as terminal tool errors", async () => {
    const { instance } = await createTestDO(TestAgentWorker, {
      __objectKey: "agent-test",
    });
    const worker = instance as unknown as {
      subscriptions: {
        getParticipantId(channelId: string): string | null;
      };
      createChannelClient: ReturnType<typeof vi.fn>;
      handleIncomingChannelEvent(channelId: string, event: unknown): Promise<void>;
      onChannelEnvelope(channelId: string, envelope: unknown): Promise<void>;
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
        await worker.onChannelEnvelope("chat-1", invocationTerminalEnvelope({
          terminal: "invocation.abandoned",
          invocationId: opts.invocationId,
          transportCallId: opts.transportCallId,
          content: "Runner restarted before invocation completed",
          terminalReasonCode: "runner_restarted_before_invocation_completed",
        }));
      }),
    });

    const result = await worker.invokeChannelMethod(
      "chat-1",
      "tool-1",
      "user",
      "eval",
      { code: "await forever()" },
      undefined,
      undefined,
      "turn-1"
    );

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toBe("Runner restarted before invocation completed");
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
      onChannelEnvelope(channelId: string, envelope: unknown): Promise<void>;
      runners: Map<string, unknown>;
    };

    worker.subscriptions.getParticipantId = vi.fn().mockReturnValue("do:agent");
    worker.createChannelClient = vi.fn().mockReturnValue({
      setTypingState,
    });

    await worker.onChannelEnvelope("chat-1", invocationTerminalEnvelope({
      terminal: "invocation.failed",
      invocationId: "tool-1",
      transportCallId: "transport-lost",
      content: "Authentication failed",
      terminalReasonCode: "method_failed",
    }));

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
          terminalOutcome: "success",
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
      controller.signal,
      undefined,
      "turn-abort"
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
      runners: Map<string, { runner: { getDebugState(): Record<string, unknown> } }>;
    };

    worker.subscriptions.getParticipantId = vi.fn().mockReturnValue("do:agent");
    worker.runners.set("chat-1", {
      runner: {
        getDebugState: vi.fn(() => ({
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
    const publishPromises: Promise<void>[] = [];
    const publishAgenticEvent = vi.fn((_participantId: string, _event: unknown) => {
      const promise = new Promise<void>(() => undefined);
      publishPromises.push(promise);
      return promise;
    });
    const waitUntil = vi.fn();
    const channelClient = {
      getParticipants: vi.fn(() => new Promise(() => undefined)),
      publishAgenticEvent,
    };
    const worker = instance as unknown as {
      _rpc: {
        call: ReturnType<typeof vi.fn>;
        stream: ReturnType<typeof vi.fn>;
        emit: ReturnType<typeof vi.fn>;
        on: ReturnType<typeof vi.fn>;
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
      ctx: { waitUntil?: (promise: Promise<unknown>) => void };
    };

    worker.ctx.waitUntil = waitUntil;
    worker._rpc = {
      call: vi.fn(async () => null),
      stream: vi.fn(),
      emit: vi.fn(),
      on: vi.fn(),
      handleIncomingPost: vi.fn(),
    };
    worker.subscriptions.getParticipantId = vi.fn().mockReturnValue("do:agent");
    worker.createChannelClient = vi.fn().mockReturnValue(channelClient);
    worker.getModelBaseUrl = vi.fn().mockReturnValue("https://model.example/v1");
    worker.readRunnerMessages = vi.fn(() => new Promise<AgentMessage[]>(() => undefined));
    worker.runners.set("chat-1", { runner: { getCurrentTurnId: () => "turn-credential-missing" } });

    await expect(worker.getApiKeyForChannel("chat-1")()).rejects.toThrow(
      "No URL-bound model credential is configured for model provider: test"
    );

    expect(worker.readRunnerMessages).toHaveBeenCalledWith("chat-1");
    expect(channelClient.getParticipants).not.toHaveBeenCalled();
    expect(publishAgenticEvent).toHaveBeenCalledTimes(2);
    expect(publishAgenticEvent.mock.calls[0]?.[1]).toMatchObject({
      kind: "turn.waiting",
      payload: {
        reason: "model_credential_required",
        summary: "Waiting for model credential connection",
      },
    });
    expect(publishAgenticEvent.mock.calls[1]?.[1]).toMatchObject({
      kind: "ui.inline_rendered",
      payload: {
        uiType: "inline",
        source: { type: "code" },
        props: {
          providerId: "test",
          modelBaseUrl: "https://model.example/v1",
          resumeAfterConnect: true,
        },
      },
    });
    expect(waitUntil).toHaveBeenCalledWith(publishPromises[0]);
    expect(waitUntil).toHaveBeenCalledWith(publishPromises[1]);
  });

  it("prompts reconnect when credential resolution fails during refresh", async () => {
    const { instance, sql } = await createTestDO(TestAgentWorker, {
      __objectKey: "agent-test",
    });
    const publishedEvents: unknown[] = [];
    const channelClient = {
      getParticipants: vi.fn(() => new Promise(() => undefined)),
      publishAgenticEvent: vi.fn(
        (_participantId: string, event: unknown) =>
          new Promise<void>(() => {
            publishedEvents.push(event);
          })
      ),
    };
    const worker = instance as unknown as {
      _rpc: {
        call: ReturnType<typeof vi.fn>;
        stream: ReturnType<typeof vi.fn>;
        emit: ReturnType<typeof vi.fn>;
        on: ReturnType<typeof vi.fn>;
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
    const refreshError = Object.assign(new Error("client_not_authorized"), {
      code: "client_not_authorized",
    });

    worker._rpc = {
      call: vi.fn(async () => {
        throw refreshError;
      }),
      stream: vi.fn(),
      emit: vi.fn(),
      on: vi.fn(),
      handleIncomingPost: vi.fn(),
    };
    worker.subscriptions.getParticipantId = vi.fn().mockReturnValue("do:agent");
    worker.createChannelClient = vi.fn().mockReturnValue(channelClient);
    worker.getModelBaseUrl = vi.fn().mockReturnValue("https://model.example/v1");
    worker.readRunnerMessages = vi.fn().mockResolvedValue([]);
    worker.runners.set("chat-1", { runner: { getCurrentTurnId: () => "turn-refresh-failed" } });

    await expect(worker.getApiKeyForChannel("chat-1")()).rejects.toThrow("client_not_authorized");

    expect(
      sql
        .exec(`SELECT status FROM agent_turn_runs WHERE turn_id = ?`, "turn-refresh-failed")
        .toArray()[0]
    ).toMatchObject({ status: "waiting_external" });
    expect(publishedEvents).toHaveLength(2);
    expect(publishedEvents[0]).toMatchObject({
      kind: "turn.waiting",
      payload: {
        reason: "model_credential_reconnect_required",
        summary: "Waiting for model credential refresh",
      },
    });
    expect(publishedEvents[1]).toMatchObject({
      kind: "ui.inline_rendered",
      payload: {
        uiType: "inline",
        props: {
          providerId: "test",
          modelBaseUrl: "https://model.example/v1",
          resumeAfterConnect: true,
          reason: "Your model sign-in needs to be refreshed before this turn can continue.",
          diagnosticReason: "client_not_authorized",
          failureCode: "client_not_authorized",
        },
      },
    });
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
        stream: ReturnType<typeof vi.fn>;
        emit: ReturnType<typeof vi.fn>;
        on: ReturnType<typeof vi.fn>;
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
      stream: vi.fn(),
      emit: vi.fn(),
      on: vi.fn(),
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
    const { instance, sql } = await createTestDO(TestAgentWorker, {
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
        getCurrentTurnId: () => "turn-credential",
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
    sql.exec(
      `INSERT INTO agent_turn_runs (
         turn_id, channel_id, status, opened_at, updated_at
       ) VALUES (?, ?, ?, ?, ?)`,
      "turn-credential",
      "chat-1",
      "waiting_external",
      Date.now(),
      Date.now()
    );

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
    expect(submitContinue).toHaveBeenCalledWith({ turnId: "turn-credential" });
  });

  it("rewinds a credential resume cursor that was saved after an assistant error", async () => {
    const { instance, sql } = await createTestDO(TestAgentWorker, {
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
        getCurrentTurnId: () => "turn-credential",
        session: {
          buildContext: vi.fn(async () => ({ messages: [userMessage, assistantError] })),
          getEntries: vi.fn(async () => [
            { id: "entry-user", type: "message" },
            { id: "entry-assistant-error", type: "message" },
          ]),
          moveTo,
        },
      },
    });
    worker.getOrCreateDispatcher = vi.fn().mockReturnValue({ submitContinue });
    sql.exec(
      `INSERT INTO agent_turn_runs (
         turn_id, channel_id, status, opened_at, updated_at
       ) VALUES (?, ?, ?, ?, ?)`,
      "turn-credential",
      "chat-1",
      "waiting_external",
      Date.now(),
      Date.now()
    );

    await worker.recordModelCredentialInterruption("chat-1", "test", "https://model.example/v1");

    await expect(
      worker.resumeAfterModelCredentialConnected("chat-1", {
        providerId: "test",
        modelBaseUrl: "https://model.example/v1",
      })
    ).resolves.toBe(true);

    expect(moveTo).toHaveBeenCalledWith("entry-user");
    expect(submitContinue).toHaveBeenCalledWith({ turnId: "turn-credential" });
  });
});
