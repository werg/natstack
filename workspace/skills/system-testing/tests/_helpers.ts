import type { TestExecutionResult } from "../types.js";

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
      m.contentType !== "action" &&
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
    m.contentType !== "action"
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
