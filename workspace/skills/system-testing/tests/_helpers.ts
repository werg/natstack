import type { TestExecutionResult } from "../types.js";

interface InvocationCardPayloadLike {
  id: string;
  name: string;
  arguments?: Record<string, unknown>;
  execution?: {
    status?: string;
    terminalOutcome?: string;
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
      m.contentType !== "invocation" &&
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
  return result.messages.some(
    (m) =>
      m.senderId !== selfSenderId &&
      m.kind === "message" &&
      m.complete &&
      m.contentType !== "thinking" &&
      m.contentType !== "typing" &&
      m.contentType !== "invocation"
  );
}

/** Check that the response contains a specific string (case-insensitive) */
export function responseContains(result: TestExecutionResult, text: string): boolean {
  return findLastAgentMessage(result).toLowerCase().includes(text.toLowerCase());
}

export function finalMessageHasAll(
  result: TestExecutionResult,
  tokens: readonly string[]
): { passed: boolean; reason?: string } {
  const msg = findLastAgentMessage(result);
  if (!msg) return { passed: false, reason: "No agent response received" };
  const lower = msg.toLowerCase();
  const missing = tokens.filter((token) => !lower.includes(token.toLowerCase()));
  return {
    passed: missing.length === 0,
    reason:
      missing.length === 0
        ? undefined
        : `Missing ${missing.join(", ")} in response: ${msg.slice(0, 400)}`,
  };
}

export function finalMessageHasAny(
  result: TestExecutionResult,
  tokens: readonly string[]
): { passed: boolean; reason?: string } {
  const msg = findLastAgentMessage(result);
  if (!msg) return { passed: false, reason: "No agent response received" };
  const lower = msg.toLowerCase();
  const found = tokens.some((token) => lower.includes(token.toLowerCase()));
  return {
    passed: found,
    reason: found
      ? undefined
      : `Expected one of ${tokens.join(", ")} in response: ${msg.slice(0, 400)}`,
  };
}

export function finalMessageHasMarkerCount(
  result: TestExecutionResult,
  marker: string
): { passed: boolean; reason?: string } {
  const msg = findLastAgentMessage(result);
  if (!msg) return { passed: false, reason: "No agent response received" };
  const escapedMarker = marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(
    `\\b${escapedMarker}\\b\\s*[:=-]?\\s*(?:count\\s*[:=-]?\\s*)?(\\d+)\\b`,
    "i"
  ).exec(msg);
  return {
    passed: Boolean(match),
    reason: match
      ? undefined
      : `Missing ${marker} followed by a numeric count in response: ${msg.slice(0, 400)}`,
  };
}

export function finalMessageHasNumericField(
  result: TestExecutionResult,
  field: string
): { passed: boolean; reason?: string } {
  const msg = findLastAgentMessage(result);
  if (!msg) return { passed: false, reason: "No agent response received" };
  const escapedField = field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`\\b${escapedField}\\s*[:=]\\s*(\\d+)\\b`, "i").exec(msg);
  return {
    passed: Boolean(match),
    reason: match ? undefined : `Missing ${field}=<number> in response: ${msg.slice(0, 400)}`,
  };
}

export function finalMessageHasField(
  result: TestExecutionResult,
  field: string
): { passed: boolean; reason?: string } {
  const msg = findLastAgentMessage(result);
  if (!msg) return { passed: false, reason: "No agent response received" };
  const escapedField = field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`\\b${escapedField}\\s*[:=]\\s*\\S+`, "i").exec(msg);
  return {
    passed: Boolean(match),
    reason: match ? undefined : `Missing ${field}=<value> in response: ${msg.slice(0, 400)}`,
  };
}

export function noIncompleteInvocations(result: TestExecutionResult): {
  passed: boolean;
  reason?: string;
} {
  const incomplete = incompleteToolCalls(result);
  return {
    passed: incomplete.length === 0,
    reason:
      incomplete.length === 0
        ? undefined
        : `Expected no incomplete tool calls, got ${incomplete.map((c) => `${c.name}:${c.execution?.status ?? "unknown"}`).join(", ")}`,
  };
}

export function noFailedInvocations(result: TestExecutionResult): {
  passed: boolean;
  reason?: string;
} {
  const failed = failedToolCalls(result);
  return {
    passed: true,
    reason:
      failed.length === 0
        ? undefined
        : `Observed failed tool calls: ${failed.map((c) => `${c.name}:${formatInvocationError(c)}`).join(", ")}`,
  };
}

/** Check that the response does NOT contain error-indicating phrases alongside the expected content */
export function responseSucceeds(
  result: TestExecutionResult,
  expectedContent: string
): { passed: boolean; reason?: string } {
  const msg = findLastAgentMessage(result);
  if (!msg) return { passed: false, reason: "No agent response received" };
  const lower = msg.toLowerCase();
  const hasContent = lower.includes(expectedContent.toLowerCase());
  if (!hasContent)
    return {
      passed: false,
      reason: `Expected "${expectedContent}" in response, got: ${msg.slice(0, 300)}`,
    };
  return { passed: true };
}

export function getToolCalls(result: TestExecutionResult): InvocationCardPayloadLike[] {
  const calls: InvocationCardPayloadLike[] = [];
  for (const msg of result.messages) {
    if (msg.contentType !== "invocation") continue;
    if (msg.invocation) {
      calls.push(msg.invocation as InvocationCardPayloadLike);
      continue;
    }
    try {
      const parsed = JSON.parse(msg.content ?? "") as InvocationCardPayloadLike;
      if (parsed && typeof parsed.name === "string") calls.push(parsed);
    } catch {
      // Ignore malformed invocation content; validation can fail on missing calls.
    }
  }
  return calls;
}

export function completedToolNames(result: TestExecutionResult): Set<string> {
  return new Set(
    getToolCalls(result)
      .filter((call) => call.execution?.status === "complete" && !call.execution?.isError)
      .map((call) => call.name)
  );
}

export function incompleteToolCalls(result: TestExecutionResult): InvocationCardPayloadLike[] {
  return getToolCalls(result).filter((call) => !isSettledInvocation(call));
}

export function failedToolCalls(result: TestExecutionResult): InvocationCardPayloadLike[] {
  return getToolCalls(result).filter((call) => {
    const execution = call.execution;
    if (!execution) return false;
    if (execution.isError) return true;
    return execution.status === "error" || execution.status === "failed";
  });
}

function isSettledInvocation(call: InvocationCardPayloadLike): boolean {
  const execution = call.execution;
  if (!execution) return false;
  if (execution.status === "complete" || execution.status === "error") return true;
  return typeof execution.terminalOutcome === "string" && execution.terminalOutcome.length > 0;
}

function formatInvocationError(call: InvocationCardPayloadLike): string {
  const execution = call.execution;
  const raw = execution?.result;
  const message =
    raw && typeof raw === "object" && "error" in raw
      ? String((raw as { error?: unknown }).error)
      : raw === undefined
        ? (execution?.status ?? "unknown")
        : String(raw);
  return message.slice(0, 160);
}
