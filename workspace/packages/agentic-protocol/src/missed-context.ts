/**
 * Missed context formatting for replay events.
 *
 * This module contains the formatting logic for presenting missed context
 * (events that occurred while a participant was disconnected) in a
 * human-readable format.
 *
 * Note: aggregateReplayEvents() lives in @workspace/agentic-messaging
 * as it's implementation-scope event aggregation logic.
 */

import type {
  AggregatedEvent,
  FormatOptions,
  MissedContext,
} from "./types.js";

/** Default maximum characters for formatted missed context */
export const DEFAULT_MISSED_CONTEXT_MAX_CHARS = 20000;

/** Default maximum characters for method result content in missed context */
export const DEFAULT_METHOD_RESULT_MAX_CHARS = 20000;

function formatSender(event: AggregatedEvent): string {
  if (event.senderHandle) return `@${event.senderHandle}`;
  if (event.senderName) return event.senderName;
  return event.senderId;
}

function stringifyValue(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function indentLines(value: string, spaces: number): string {
  const pad = " ".repeat(spaces);
  return value
    .split("\n")
    .map((line) => `${pad}${line}`)
    .join("\n");
}

function truncate(value: string, maxChars: number): { text: string; wasTruncated: boolean } {
  if (value.length <= maxChars) return { text: value, wasTruncated: false };
  return { text: `${value.slice(0, Math.max(0, maxChars - 3))}...`, wasTruncated: true };
}

export function formatMissedContext(
  events: AggregatedEvent[],
  options: FormatOptions = {}
): MissedContext {
  const maxChars = options.maxChars ?? DEFAULT_MISSED_CONTEXT_MAX_CHARS;
  const format = options.format ?? "yaml";
  const includeMethodArgs = options.includeMethodArgs ?? true;
  const includeMethodResults = options.includeMethodResults ?? true;
  const maxMethodResultChars = options.maxMethodResultChars ?? DEFAULT_METHOD_RESULT_MAX_CHARS;

  const included: AggregatedEvent[] = [];
  let formatted = "";
  let wasElided = false;
  let lastPubsubId = 0;

  const appendEntry = (entry: string, event: AggregatedEvent): boolean => {
    const next = formatted ? `${formatted}\n${entry}` : entry;
    if (next.length > maxChars) {
      wasElided = true;
      return false;
    }
    formatted = next;
    included.push(event);
    lastPubsubId = event.pubsubId;
    return true;
  };

  for (const event of events) {
    let entry = "";
    const sender = formatSender(event);

    if (format === "markdown") {
      if (event.type === "message") {
        entry = `- message from ${sender}:\n  ${event.content.replace(/\n/g, "\n  ")}`;
      } else if (event.type === "method-call") {
        const args = includeMethodArgs ? stringifyValue(event.args) : "omitted";
        entry = `- method-call from ${sender}: ${event.methodName}\n  args: ${args.replace(/\n/g, "\n  ")}`;
      } else if (event.type === "method-result") {
        const content = includeMethodResults
          ? truncate(stringifyValue(event.content), maxMethodResultChars).text
          : "omitted";
        const statusLine = `status: ${event.status}`;
        const contentLine = `content: ${content.replace(/\n/g, "\n  ")}`;
        const errorLine = event.errorMessage ? `error: ${event.errorMessage}` : "";
        entry = `- method-result from ${sender}: ${event.methodName ?? event.callId}\n  ${statusLine}\n  ${contentLine}`;
        if (errorLine) entry += `\n  ${errorLine}`;
      }
    } else {
      if (event.type === "message") {
        entry = [
          "- type: message",
          `  from: ${sender}`,
          "  content: |",
          indentLines(event.content, 4),
        ].join("\n");
      } else if (event.type === "method-call") {
        const argsText = includeMethodArgs ? stringifyValue(event.args) : "omitted";
        entry = [
          "- type: method-call",
          `  from: ${sender}`,
          `  method: ${event.methodName}`,
          `  providerId: ${event.providerId}`,
          "  args: |",
          indentLines(argsText, 4),
        ].join("\n");
      } else if (event.type === "method-result") {
        const contentText = includeMethodResults
          ? truncate(stringifyValue(event.content), maxMethodResultChars).text
          : "omitted";
        entry = [
          "- type: method-result",
          `  from: ${sender}`,
          `  method: ${event.methodName ?? event.callId}`,
          `  status: ${event.status}`,
          "  content: |",
          indentLines(contentText, 4),
          event.errorMessage ? `  error: ${event.errorMessage}` : "",
        ]
          .filter(Boolean)
          .join("\n");
      }
    }

    if (!appendEntry(entry, event)) break;
  }

  return {
    count: included.length,
    formatted,
    lastPubsubId,
    wasElided,
    events: included,
  };
}
