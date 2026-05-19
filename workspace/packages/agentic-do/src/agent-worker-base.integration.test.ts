import { describe, expect, it } from "vitest";
import { vi } from "vitest";
import { createTestDO } from "@workspace/runtime/worker/test-utils";

import { AgentWorkerBase } from "./agent-worker-base.js";
import type { TurnDispatcherRunner } from "./turn-dispatcher.js";

class TestAgentWorker extends AgentWorkerBase {
  protected override getModel(): string {
    return "test:model";
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

describe("AgentWorkerBase dispatched method results", () => {
  it("waits for the canonical method-result event before completing the tool call", async () => {
    const { instance } = await createTestDO(TestAgentWorker, {
      __objectKey: "agent-test",
    });
    let capturedCallId = "";
    const worker = instance as unknown as {
      dispatches: {
        peek(callId: string): { dispatchedAt: number | null } | null;
      };
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
      ): Promise<unknown>;
    };

    worker.subscriptions.getParticipantId = vi.fn().mockReturnValue("do:agent");
    worker.createChannelClient = vi.fn().mockReturnValue({
      getParticipants: vi.fn().mockResolvedValue([{
        participantId: "panel:panel-1",
        metadata: { handle: "user", type: "panel" },
      }]),
      callMethod: vi.fn(async (_callerId, _targetId, callId) => {
        capturedCallId = callId;
        expect(worker.dispatches.peek(callId)?.dispatchedAt).toEqual(expect.any(Number));
        await worker.handleIncomingChannelEvent("chat-1", {
          id: 1,
          messageId: "result-1",
          type: "method-result",
          payload: {
            callId,
            content: { ok: true },
            complete: true,
            isError: false,
          },
          senderId: "panel:panel-1",
          ts: Date.now(),
          persist: true,
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
    );

    expect(result).toEqual({
      content: [{ type: "text", text: "{\"ok\":true}" }],
      details: undefined,
    });
    expect(abort).not.toHaveBeenCalled();
    expect(capturedCallId).toEqual(expect.any(String));
    expect(worker.dispatches.peek(capturedCallId)).toBeNull();
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
      dispatches: {
        peek(callId: string): unknown | null;
      };
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
      ): Promise<unknown>;
    };

    worker.subscriptions.getParticipantId = vi.fn().mockReturnValue("do:agent");
    worker.createChannelClient = vi.fn().mockReturnValue({
      getParticipants: vi.fn().mockResolvedValue([{
        participantId: "panel:panel-1",
        metadata: { handle: "user", type: "panel" },
      }]),
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
    );
    await callStarted;
    controller.abort();

    await expect(pending).rejects.toThrow("Request was aborted");
    expect(cancelCall).toHaveBeenCalledWith(capturedCallId);
    expect(worker.dispatches.peek(capturedCallId)).toBeNull();
  });

  it("persists recovered method results and resumes the runner when no live waiter exists", async () => {
    const { instance } = await createTestDO(TestAgentWorker, {
      __objectKey: "agent-test",
    });
    const appendToolResult = vi.fn().mockResolvedValue("entry-1");
    const submitContinue = vi.fn();
    const worker = instance as unknown as {
      dispatches: {
        store(input: {
          callId: string;
          channelId: string;
          kind: "tool-call";
          toolCallId: string;
          toolName?: string;
          paramsJson?: string;
          targetParticipantId?: string;
          methodName?: string;
          argsJson?: string;
        }): void;
        peek(callId: string): unknown | null;
      };
      runners: Map<string, unknown>;
      getOrCreateProjector: ReturnType<typeof vi.fn>;
      getOrCreateDispatcher: ReturnType<typeof vi.fn>;
      handleCompletedMethodResult(callId: string, result: unknown, isError: boolean): Promise<void>;
    };

    worker.dispatches.store({
      callId: "call-recovered",
      channelId: "chat-1",
      kind: "tool-call",
      toolCallId: "tool-1",
      toolName: "user.eval",
      paramsJson: JSON.stringify({ participantHandle: "user", method: "eval", args: { code: "1 + 1" } }),
      targetParticipantId: "panel:panel-1",
      methodName: "eval",
      argsJson: JSON.stringify({ code: "1 + 1" }),
    });
    worker.runners.set("chat-1", {
      runner: {
        appendToolResult,
        getStateSnapshot: vi.fn().mockResolvedValue({ messages: [] }),
      },
    });
    worker.getOrCreateProjector = vi.fn().mockReturnValue({});
    worker.getOrCreateDispatcher = vi.fn().mockReturnValue({ submitContinue });

    await worker.handleCompletedMethodResult("call-recovered", { ok: true }, false);

    expect(appendToolResult).toHaveBeenCalledWith(expect.objectContaining({
      role: "toolResult",
      toolCallId: "tool-1",
      toolName: "user.eval",
      content: [{ type: "text", text: "{\"ok\":true}" }],
      details: undefined,
      isError: false,
    }));
    expect(worker.dispatches.peek("call-recovered")).toBeNull();
    expect(submitContinue).toHaveBeenCalledTimes(1);
  });

  it("keeps a buffered recovered result when transcript append fails and drains it later", async () => {
    const { instance } = await createTestDO(TestAgentWorker, {
      __objectKey: "agent-test",
    });
    const appendToolResult = vi.fn()
      .mockRejectedValueOnce(new Error("temporary append failure"))
      .mockResolvedValueOnce("entry-1");
    const submitContinue = vi.fn();
    const worker = instance as unknown as {
      dispatches: {
        store(input: {
          callId: string;
          channelId: string;
          kind: "tool-call";
          toolCallId: string;
          toolName?: string;
        }): void;
        peek(callId: string): { pendingResultJson: string | null; pendingIsError: boolean | null } | null;
      };
      runners: Map<string, unknown>;
      getOrCreateProjector: ReturnType<typeof vi.fn>;
      getOrCreateDispatcher: ReturnType<typeof vi.fn>;
      handleCompletedMethodResult(callId: string, result: unknown, isError: boolean): Promise<void>;
      drainBufferedRecoveredResults(channelId: string): Promise<void>;
    };

    worker.dispatches.store({
      callId: "call-buffered",
      channelId: "chat-1",
      kind: "tool-call",
      toolCallId: "tool-1",
      toolName: "user.eval",
    });
    worker.runners.set("chat-1", {
      runner: {
        appendToolResult,
        getStateSnapshot: vi.fn().mockResolvedValue({ messages: [] }),
      },
    });
    worker.getOrCreateProjector = vi.fn().mockReturnValue({});
    worker.getOrCreateDispatcher = vi.fn().mockReturnValue({ submitContinue });

    await expect(
      worker.handleCompletedMethodResult("call-buffered", { ok: true }, false),
    ).rejects.toThrow("temporary append failure");

    expect(worker.dispatches.peek("call-buffered")).toMatchObject({
      pendingResultJson: JSON.stringify({ value: { ok: true } }),
      pendingIsError: false,
    });

    await worker.drainBufferedRecoveredResults("chat-1");

    expect(appendToolResult).toHaveBeenCalledTimes(2);
    expect(worker.dispatches.peek("call-buffered")).toBeNull();
    expect(submitContinue).toHaveBeenCalledTimes(1);
  });

  it("does not duplicate a recovered result that is already in the runner transcript", async () => {
    const { instance } = await createTestDO(TestAgentWorker, {
      __objectKey: "agent-test",
    });
    const appendToolResult = vi.fn().mockResolvedValue("entry-1");
    const submitContinue = vi.fn();
    const worker = instance as unknown as {
      dispatches: {
        store(input: {
          callId: string;
          channelId: string;
          kind: "tool-call";
          toolCallId: string;
          toolName?: string;
        }): void;
        peek(callId: string): unknown | null;
      };
      runners: Map<string, unknown>;
      getOrCreateProjector: ReturnType<typeof vi.fn>;
      getOrCreateDispatcher: ReturnType<typeof vi.fn>;
      handleCompletedMethodResult(callId: string, result: unknown, isError: boolean): Promise<void>;
    };

    worker.dispatches.store({
      callId: "call-duplicate",
      channelId: "chat-1",
      kind: "tool-call",
      toolCallId: "tool-1",
      toolName: "user.eval",
    });
    worker.runners.set("chat-1", {
      runner: {
        appendToolResult,
        getStateSnapshot: vi.fn().mockResolvedValue({
          messages: [{ role: "toolResult", toolCallId: "tool-1", content: [] }],
        }),
      },
    });
    worker.getOrCreateProjector = vi.fn().mockReturnValue({});
    worker.getOrCreateDispatcher = vi.fn().mockReturnValue({ submitContinue });

    await worker.handleCompletedMethodResult("call-duplicate", { ok: true }, false);

    expect(appendToolResult).not.toHaveBeenCalled();
    expect(worker.dispatches.peek("call-duplicate")).toBeNull();
    expect(submitContinue).toHaveBeenCalledTimes(1);
  });
});
