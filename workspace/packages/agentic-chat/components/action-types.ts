/**
 * RichActionData type and parser.
 *
 * Superset of ActionData from @natstack/pubsub — extra fields are populated
 * by agent-worker-base at tool_execution_start/end and preserved through
 * JSON.parse in parseActionData().
 */

export interface RichActionData {
  type: string;
  description: string;
  toolUseId?: string;
  /** Only two canonical values — errors use isError flag. */
  status: "pending" | "complete";
  /** Populated at tool_execution_start/end. */
  args?: Record<string, unknown>;
  /** Populated at tool_execution_end. */
  result?: unknown;
  /** True when tool execution failed — drives red color scheme. */
  isError?: boolean;
  /** True when the result was too large and was truncated. */
  resultTruncated?: boolean;
  /** Accumulated console output from streaming tool_execution_update events. */
  consoleOutput?: string;
}

/**
 * Parse action data from message content, with fallback for malformed content.
 * Handles edge cases like duplicated JSON objects from update() calls.
 * Normalizes legacy `status: "error"` to `status: "complete"` + `isError: true`.
 */
export function parseActionData(content: string, complete?: boolean): RichActionData {
  let data: RichActionData;
  try {
    data = JSON.parse(content);
  } catch {
    const firstBrace = content.indexOf("{");
    const closingBrace = findMatchingBrace(content, firstBrace);
    if (firstBrace >= 0 && closingBrace > firstBrace) {
      try {
        data = JSON.parse(content.slice(firstBrace, closingBrace + 1));
      } catch {
        data = { type: "Unknown", description: content.slice(0, 100), status: "pending" };
      }
    } else {
      data = { type: "Unknown", description: content.slice(0, 100), status: "pending" };
    }
  }

  // Normalize legacy status: "error" → status: "complete" + isError: true
  if ((data as { status: string }).status === "error") {
    data.status = "complete";
    data.isError = true;
  }

  if (complete && data.status !== "complete") {
    data = { ...data, status: "complete" };
  }

  return data;
}

function findMatchingBrace(str: string, openPos: number): number {
  if (str[openPos] !== "{") return -1;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = openPos; i < str.length; i++) {
    const char = str[i];
    if (escape) { escape = false; continue; }
    if (char === "\\") { escape = true; continue; }
    if (char === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (char === "{") depth++;
    if (char === "}") { depth--; if (depth === 0) return i; }
  }
  return -1;
}
