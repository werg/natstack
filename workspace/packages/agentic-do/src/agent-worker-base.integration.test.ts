import { describe, expect, it } from "vitest";
import { vi } from "vitest";
import { createTestDO } from "@workspace/runtime/worker/test-utils";
import type { AgentMessage } from "@earendil-works/pi-agent-core";

import { AgentWorkerBase } from "./agent-worker-base.js";
import type { TurnDispatcherRunner } from "./turn-dispatcher.js";
import type { PiRunner } from "@natstack/harness";
import { AGENTIC_EVENT_PAYLOAD_KIND } from "@workspace/agentic-protocol";

class TestAgentWorker extends AgentWorkerBase {
  protected override getModel(): string {
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

    expect(submit).toHaveBeenCalledWith(
      { content: "Read the onboarding docs first" },
      undefined,
    );
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
      "do:workers/test-agent:TestAgentWorker:agent-parent",
    );
    sql.exec(
      `INSERT INTO delivery_cursor (channel_id, last_delivered_seq) VALUES (?, ?)`,
      "channel-parent",
      10,
    );

    await instance.postClone("agent-parent", "channel-fork", "channel-parent", 42);

    expect(gadCall).toHaveBeenCalledWith("forkTrajectoryBranch", expect.objectContaining({
      fromTrajectoryId: "branch:channel:channel-parent",
      fromBranchId: "branch:channel:channel-parent",
      toTrajectoryId: "branch:channel:channel-fork",
      toBranchId: "branch:channel:channel-fork",
      throughPublishedChannelId: "channel-parent",
      throughPublishedChannelSeq: 42,
      toPublishedChannelId: "channel-fork",
    }));
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
    let capturedOpts: { invocationId?: string; transportCallId?: string; turnId?: string } | undefined;
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
      "turn-1",
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
      timeoutMs: 600000,
    });
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
});

describe("AgentWorkerBase model credential resume", () => {
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
