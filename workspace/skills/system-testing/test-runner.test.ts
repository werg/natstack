import { describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "@workspace/agentic-core";
import { TestRunner } from "./test-runner.js";
import type { HeadlessRunner } from "./runner.js";

describe("TestRunner", () => {
  it("adds pending invocation and lifecycle context to headless timeouts", async () => {
    const lifecycleMessage = {
      id: "turn:waiting",
      senderId: "agent-1",
      content: "Waiting for model credential approval",
      contentType: "lifecycle",
      kind: "system",
      complete: true,
      lifecycle: {
        status: "waiting",
        reason: "model_credential_required",
        title: "Waiting for model credential approval",
      },
    } satisfies ChatMessage;
    const diagnosticMessage = {
      id: "diagnostic:empty",
      senderId: "agent-1",
      content: "Assistant message had no visible content.",
      contentType: "diagnostic",
      kind: "system",
      complete: true,
      diagnostic: {
        code: "message_empty",
        severity: "warning",
        title: "No assistant response",
      },
    } satisfies ChatMessage;
    const messages = [lifecycleMessage, diagnosticMessage];
    const session = {
      channelId: "chat-timeout",
      messages,
      sendAndWait: vi.fn(() => new Promise(() => undefined)),
      snapshot: vi.fn(() => ({
        messages,
        invocations: [{ id: "call-eval", name: "eval", status: "pending" }],
        debugEvents: [],
        cleanupErrors: [],
        participants: {},
        connected: true,
        duration: 10,
      })),
      close: vi.fn(async () => undefined),
    };
    const runner = {
      spawn: vi.fn(async () => session),
      collectDiagnostics: vi.fn(async () => ({})),
    } as unknown as HeadlessRunner;
    const tester = new TestRunner(runner, { testTimeoutMs: 5 });

    const { result, execution } = await tester.runOne({
      name: "timeout-test",
      category: "test",
      description: "timeout",
      prompt: "hang",
      validate: () => ({ passed: true }),
    });

    expect(result.passed).toBe(false);
    expect(execution.error).toContain('Timed out waiting for agent to finish test "timeout-test"');
    expect(execution.error).toContain("Pending invocations: eval:pending.");
    expect(execution.error).toContain(
      'Last lifecycle: waiting reason=model_credential_required "Waiting for model credential approval".'
    );
    expect(execution.error).toContain('Last diagnostic: code=message_empty "No assistant response".');
    expect(runner.collectDiagnostics).toHaveBeenCalledWith({
      channelId: "chat-timeout",
      error: expect.objectContaining({ message: execution.error }),
    });
  });

  it("keeps the original test failure when diagnostics collection fails", async () => {
    const session = {
      channelId: "chat-fetch-failed",
      messages: [],
      sendAndWait: vi.fn(async () => {
        throw new Error("fetch failed");
      }),
      snapshot: vi.fn(() => ({
        messages: [],
        invocations: [],
        debugEvents: [],
        cleanupErrors: [],
        participants: {},
        connected: true,
        duration: 10,
      })),
      close: vi.fn(async () => undefined),
    };
    const runner = {
      spawn: vi.fn(async () => session),
      collectDiagnostics: vi.fn(async () => {
        throw new Error("diagnostics fetch failed");
      }),
    } as unknown as HeadlessRunner;
    const tester = new TestRunner(runner, { testTimeoutMs: 5 });

    const { result, execution } = await tester.runOne({
      name: "fetch-failed-test",
      category: "test",
      description: "fetch failed",
      prompt: "trigger fetch",
      validate: () => ({ passed: true }),
    });

    expect(result.passed).toBe(false);
    expect(execution.error).toBe("fetch failed");
    expect(execution.diagnostics).toMatchObject({
      diagnosticCollectionError: "diagnostics fetch failed",
    });
  });

  it("reports failed tool calls without converting a passing task into a failed test", async () => {
    const messages = [
      {
        id: "prompt-1",
        senderId: "headless",
        kind: "message",
        complete: true,
        content: "prompt",
      },
      {
        id: "invocation:call-1",
        senderId: "agent",
        kind: "message",
        contentType: "invocation",
        complete: true,
        content: JSON.stringify({
          id: "call-1",
          name: "eval",
          execution: {
            status: "error",
            terminalOutcome: "tool_error",
            result: { error: "ReferenceError: missingVar is not defined" },
            isError: true,
          },
        }),
      },
      {
        id: "answer-1",
        senderId: "agent",
        kind: "message",
        complete: true,
        content: "Recovered and finished with TOOL_RECOVERY_OK.",
      },
    ] satisfies ChatMessage[];
    const session = {
      channelId: "chat-tool-error",
      messages,
      sendAndWait: vi.fn(async () => undefined),
      snapshot: vi.fn(() => ({
        messages,
        invocations: [
          {
            id: "call-1",
            name: "eval",
            status: "error",
            execution: {
              status: "error",
              terminalOutcome: "tool_error",
              result: { error: "ReferenceError: missingVar is not defined" },
              isError: true,
            },
          },
        ],
        debugEvents: [],
        cleanupErrors: [],
        participants: {},
        connected: true,
        duration: 10,
      })),
      close: vi.fn(async () => undefined),
    };
    const runner = {
      spawn: vi.fn(async () => session),
      collectDiagnostics: vi.fn(async () => ({})),
    } as unknown as HeadlessRunner;
    const tester = new TestRunner(runner, { testTimeoutMs: 5 });

    const suite = await tester.runSuite([
      {
        name: "tool-error-recovery",
        category: "test",
        description: "tool error recovery",
        prompt: "trigger recovery",
        validate: () => ({ passed: true }),
      },
    ]);

    expect(suite).toMatchObject({
      passed: 1,
      failed: 0,
      errored: 0,
      toolFailureCount: 1,
      testsWithToolFailures: 1,
    });
    expect(suite.results[0]!.execution.error).toBeUndefined();
    expect(suite.results[0]!.execution.toolFailures).toEqual([
      expect.objectContaining({
        name: "eval",
        status: "error",
        terminalOutcome: "tool_error",
        error: "ReferenceError: missingVar is not defined",
      }),
    ]);
  });
});
