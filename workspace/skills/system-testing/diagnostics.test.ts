import { describe, expect, it } from "vitest";
import type { ChatMessage } from "@workspace/agentic-core";
import { summarizeEntry, summarizeFailures } from "./diagnostics.js";
import type { TestSuiteResultEntry } from "./types.js";

function entryWithMessages(messages: ChatMessage[]): TestSuiteResultEntry {
  return {
    test: {
      name: "typed-transcript",
      category: "smoke",
      description: "captures typed transcript rows",
      prompt: "exercise typed transcript",
    },
    result: { passed: false, reason: "validation failed" },
    execution: {
      messages,
      duration: 123,
    },
  };
}

function passingEntryWithToolFailure(messages: ChatMessage[]): TestSuiteResultEntry {
  return {
    ...entryWithMessages(messages),
    result: { passed: true },
    execution: {
      messages,
      duration: 123,
      toolFailures: [
        {
          id: "call-1",
          name: "eval",
          status: "error",
          error: "ReferenceError: missingVar is not defined",
          source: "message",
        },
      ],
    },
  };
}

describe("system-testing diagnostics", () => {
  it("preserves structured invocation payloads for stage report drill-down", () => {
    const invocation = {
      id: "call-1",
      transportCallId: "transport-1",
      name: "read",
      arguments: { path: "README.md" },
      execution: {
        status: "complete" as const,
        terminalOutcome: "success" as const,
        description: "Read README.md",
        result: { bytes: 42, preview: "hello" },
        isError: false,
      },
    };
    const messages: ChatMessage[] = [
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
        content: JSON.stringify(invocation),
        invocation,
        senderMetadata: { name: "Agent", type: "agent", handle: "agent" },
      },
    ];

    const diagnostic = summarizeEntry(entryWithMessages(messages), {
      messages: 10,
      invocations: 10,
      text: 120,
    });

    expect(diagnostic.conversation[1]).toMatchObject({
      uiType: "invocation",
      text: "Read README.md",
      invocation: {
        id: "call-1",
        transportCallId: "transport-1",
        name: "read",
        status: "complete",
        terminalOutcome: "success",
        arguments: { path: "README.md" },
        result: { bytes: 42, preview: "hello" },
      },
    });
    expect(diagnostic.conversation[1]!.rawContent).toContain('"name":"read"');
    expect(diagnostic.invocations).toHaveLength(1);
    expect(diagnostic.invocations[0]).toMatchObject({
      name: "read",
      status: "complete",
      arguments: { path: "README.md" },
      result: { bytes: 42, preview: "hello" },
    });
  });

  it("summarizes non-message transcript payload types", () => {
    const messages: ChatMessage[] = [
      {
        id: "prompt-1",
        senderId: "headless",
        kind: "message",
        complete: true,
        content: "prompt",
      },
      {
        id: "diag-1",
        senderId: "agent",
        kind: "system",
        complete: true,
        content: "",
        diagnostic: {
          severity: "error",
          title: "Model call limit reached",
          detail:
            "Configured maxModelCallsPerTurn reached for t:chan-1:env-1: 96 model call(s) have already run, and the configured limit is 96.",
          code: "max_model_calls_per_turn",
        },
      },
    ];

    const diagnostic = summarizeEntry(entryWithMessages(messages));

    expect(diagnostic.conversation[1]).toMatchObject({
      uiType: "diagnostic",
      type: "system",
      text:
        "Model call limit reached\nConfigured maxModelCallsPerTurn reached for t:chan-1:env-1: 96 model call(s) have already run, and the configured limit is 96.",
      diagnostic: {
        severity: "error",
        code: "max_model_calls_per_turn",
        title: "Model call limit reached",
      },
    });
  });

  it("classifies passing tests with tool failures as investigation items", () => {
    const messages: ChatMessage[] = [
      {
        id: "prompt-1",
        senderId: "headless",
        kind: "message",
        complete: true,
        content: "prompt",
      },
      {
        id: "answer-1",
        senderId: "agent",
        kind: "message",
        complete: true,
        content: "Recovered.",
      },
    ];

    const diagnostic = summarizeEntry(passingEntryWithToolFailure(messages));

    expect(diagnostic.passed).toBe(true);
    expect(diagnostic.likelyIssue).toBe("tool-failure-observed:eval");
    expect(diagnostic.toolFailures).toEqual([
      expect.objectContaining({
        name: "eval",
        status: "error",
      }),
    ]);
  });

  it("includes passing tests with tool failures in bounded failure summaries", () => {
    const messages: ChatMessage[] = [
      {
        id: "prompt-1",
        senderId: "headless",
        kind: "message",
        complete: true,
        content: "prompt",
      },
    ];
    const suite = {
      total: 1,
      passed: 1,
      failed: 0,
      errored: 0,
      skipped: 0,
      duration: 123,
      results: [passingEntryWithToolFailure(messages)],
    };

    const report = summarizeFailures(suite);

    expect(report.failureCount).toBe(1);
    expect(report.failures[0]).toMatchObject({
      name: "typed-transcript",
      passed: true,
      likelyIssue: "tool-failure-observed:eval",
    });
  });
});
