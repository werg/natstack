import { describe, expect, it } from "vitest";

import type { TestExecutionResult } from "../types.js";
import {
  failedToolCalls,
  finalMessageHasField,
  finalMessageHasMarkerCount,
  finalMessageHasNumericField,
  incompleteToolCalls,
} from "./_helpers.js";

function executionWithInvocation(status: string, terminalOutcome?: string): TestExecutionResult {
  return {
    duration: 0,
    messages: [
      {
        kind: "message",
        senderId: "user",
        complete: true,
        content: "prompt",
      },
      {
        kind: "message",
        senderId: "agent",
        complete: true,
        contentType: "invocation",
        content: JSON.stringify({
          id: "call-1",
          name: "grep",
          execution: {
            status,
            terminalOutcome,
          },
        }),
      },
    ],
  } as TestExecutionResult;
}

function executionWithInvocationResult(
  status: string,
  result: unknown,
  isError?: boolean
): TestExecutionResult {
  return {
    duration: 0,
    messages: [
      {
        kind: "message",
        senderId: "user",
        complete: true,
        content: "prompt",
      },
      {
        kind: "message",
        senderId: "agent",
        complete: true,
        contentType: "invocation",
        content: JSON.stringify({
          id: "call-1",
          name: "eval",
          execution: {
            status,
            result,
            isError,
          },
        }),
      },
    ],
  } as TestExecutionResult;
}

function executionWithFinalAgentMessage(content: string): TestExecutionResult {
  return {
    duration: 0,
    messages: [
      {
        kind: "message",
        senderId: "user",
        complete: true,
        content: "prompt",
      },
      {
        kind: "message",
        senderId: "agent",
        complete: true,
        content,
      },
    ],
  } as TestExecutionResult;
}

describe("system-testing validation helpers", () => {
  it("does not classify terminal tool errors as incomplete invocations", () => {
    expect(incompleteToolCalls(executionWithInvocation("error", "tool_error"))).toEqual([]);
  });

  it("does not classify completed invocations as incomplete", () => {
    expect(incompleteToolCalls(executionWithInvocation("complete", "success"))).toEqual([]);
  });

  it("classifies pending invocations as incomplete", () => {
    expect(
      incompleteToolCalls(executionWithInvocation("pending")).map((call) => call.name)
    ).toEqual(["grep"]);
  });

  it("accepts marker followed by numeric count", () => {
    expect(
      finalMessageHasMarkerCount(
        executionWithFinalAgentMessage("WORKER_LIST_OK: 0"),
        "WORKER_LIST_OK"
      )
    ).toEqual({
      passed: true,
      reason: undefined,
    });
  });

  it("accepts marker followed by literal count and numeric count", () => {
    expect(
      finalMessageHasMarkerCount(
        executionWithFinalAgentMessage("WORKER_SOURCES_OK count 30"),
        "WORKER_SOURCES_OK"
      )
    ).toEqual({
      passed: true,
      reason: undefined,
    });
  });

  it("accepts explicit field values in final messages", () => {
    expect(
      finalMessageHasField(executionWithFinalAgentMessage("PANEL_OPEN_OK handle=slot-1"), "handle")
    ).toEqual({
      passed: true,
      reason: undefined,
    });
  });

  it("accepts explicit numeric fields in final messages", () => {
    expect(
      finalMessageHasNumericField(
        executionWithFinalAgentMessage("PANEL_SCREENSHOT_OK bytes=135731"),
        "bytes"
      )
    ).toEqual({
      passed: true,
      reason: undefined,
    });
  });

  it("reports failed invocation cards even when a final marker exists", () => {
    expect(
      failedToolCalls(
        executionWithInvocationResult("error", { error: "No CDP-capable host is available" }, true)
      ).map((call) => call.name)
    ).toEqual(["eval"]);
  });
});
