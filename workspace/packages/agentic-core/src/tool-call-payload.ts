/**
 * Structured payload for channel messages with contentType "toolCall".
 *
 * A single channel message is published per Pi toolCall content block. Its
 * `content` is a JSON-encoded `ToolCallPayload` that evolves through the
 * block's lifecycle:
 *
 *   toolcall_start → send(payload with execution.status="pending")
 *   tool_execution_update (console) → update(payload with consoleOutput)
 *   tool_execution_end → update(payload with execution.status="complete"|"error"
 *                                result + resultImages) + complete
 *
 * Semantics are "replace" — each update carries the full current payload.
 */
export interface ToolCallPayload {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  execution: ToolExecutionState;
}

export interface ToolExecutionState {
  status: "pending" | "complete" | "error";
  description: string;
  consoleOutput?: string;
  result?: unknown;
  isError?: boolean;
  resultTruncated?: boolean;
  resultImages?: ReadonlyArray<{ mimeType: string; data: string }>;
}

/** Parse a ToolCallPayload from a channel message's `content` string.
 *  Returns null on malformed input so consumers can fall back gracefully. */
export function parseToolCallPayload(content: string): ToolCallPayload | null {
  if (!content) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;
  if (typeof obj["id"] !== "string" || typeof obj["name"] !== "string") return null;
  if (!obj["execution"] || typeof obj["execution"] !== "object") return null;
  const exec = obj["execution"] as Record<string, unknown>;
  const status = exec["status"];
  if (status !== "pending" && status !== "complete" && status !== "error") {
    return null;
  }
  if (typeof exec["description"] !== "string") return null;
  return parsed as ToolCallPayload;
}
