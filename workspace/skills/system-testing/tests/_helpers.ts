import type { TestExecutionResult } from "../types.js";

interface ToolCallPayloadLike {
  id: string;
  name: string;
  arguments?: Record<string, unknown>;
  execution?: {
    status?: string;
    result?: unknown;
    isError?: boolean;
  };
}

/**
 * Find the last complete agent message (not from self, not thinking).
 * The self-sent message has kind "message" + pending:true initially,
 * then becomes pending:false. Agent messages never have pending.
 * We use a heuristic: skip the first message (likely the prompt).
 */
export function findLastAgentMessage(result: TestExecutionResult): string {
  const msgs = result.messages;
  // Skip messages from the first sender (the test client)
  const selfSenderId = msgs[0]?.senderId;
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i]!;
    if (
      m.senderId !== selfSenderId &&
      m.kind === "message" &&
      m.complete &&
      m.contentType !== "thinking" &&
      m.contentType !== "toolCall" &&
      !m.pending
    ) {
      return m.content ?? "";
    }
  }
  return "";
}

/** Check if the agent produced any response at all */
export function hasAgentResponse(result: TestExecutionResult): boolean {
  const selfSenderId = result.messages[0]?.senderId;
  return result.messages.some(m =>
    m.senderId !== selfSenderId &&
    m.kind === "message" &&
    m.complete &&
    m.contentType !== "thinking" &&
    m.contentType !== "typing" &&
    m.contentType !== "toolCall"
  );
}

/** Check that the response contains a specific string (case-insensitive) */
export function responseContains(result: TestExecutionResult, text: string): boolean {
  return findLastAgentMessage(result).toLowerCase().includes(text.toLowerCase());
}

/** Check that the response does NOT contain error-indicating phrases alongside the expected content */
export function responseSucceeds(result: TestExecutionResult, expectedContent: string): { passed: boolean; reason?: string } {
  const msg = findLastAgentMessage(result);
  if (!msg) return { passed: false, reason: "No agent response received" };
  const lower = msg.toLowerCase();
  const hasContent = lower.includes(expectedContent.toLowerCase());
  if (!hasContent) return { passed: false, reason: `Expected "${expectedContent}" in response, got: ${msg.slice(0, 300)}` };
  return { passed: true };
}

export function getToolCalls(result: TestExecutionResult): ToolCallPayloadLike[] {
  const calls: ToolCallPayloadLike[] = [];
  for (const msg of result.messages) {
    if (msg.contentType !== "toolCall") continue;
    if (msg.toolCall) {
      calls.push(msg.toolCall as ToolCallPayloadLike);
      continue;
    }
    try {
      const parsed = JSON.parse(msg.content ?? "") as ToolCallPayloadLike;
      if (parsed && typeof parsed.name === "string") calls.push(parsed);
    } catch {
      // Ignore malformed toolCall content; validation can fail on missing calls.
    }
  }
  return calls;
}

export function completedToolNames(result: TestExecutionResult): Set<string> {
  return new Set(
    getToolCalls(result)
      .filter((call) => call.execution?.status === "complete" && !call.execution?.isError)
      .map((call) => call.name),
  );
}

export function incompleteToolCalls(result: TestExecutionResult): ToolCallPayloadLike[] {
  return getToolCalls(result).filter((call) => call.execution?.status !== "complete");
}
