import type {
  AggregatedEvent,
  AggregatedMessage,
  AggregatedMethodCall,
  AggregatedMethodResult,
  FormatOptions,
  IncomingEvent,
  IncomingNewMessage,
  IncomingMethodCallEvent,
  IncomingMethodResultEvent,
  IncomingUpdateMessage,
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

function extractSenderFields(event: IncomingEvent): {
  senderName?: string;
  senderType?: string;
  senderHandle?: string;
} {
  const metadata = event.senderMetadata;
  return {
    senderName: metadata?.name,
    senderType: metadata?.type,
    senderHandle: metadata?.handle,
  };
}

function aggregateMessage(
  initial: IncomingNewMessage,
  updates: IncomingUpdateMessage[],
  error?: string
): AggregatedMessage | null {
  if (initial.pubsubId === undefined) return null;
  let content = initial.content;
  let hasCompletionUpdate = false;

  for (const update of updates) {
    if (update.content) {
      content += update.content;
    }
    if (update.complete) {
      hasCompletionUpdate = true;
    }
  }

  const sender = extractSenderFields(initial);

  // Completion logic:
  // - Error implies completion (matches live-path: { complete: true, error })
  // - Zero updates = one-shot message (user/panel), inherently complete
  // - Has completion update = streaming finished normally
  const hasError = !!error;
  const isOneShot = updates.length === 0;
  const complete = hasError || isOneShot || hasCompletionUpdate;

  return {
    type: "message",
    kind: "replay",
    aggregated: true,
    pubsubId: initial.pubsubId,
    senderId: initial.senderId,
    senderName: sender.senderName,
    senderType: sender.senderType,
    senderHandle: sender.senderHandle,
    ts: initial.ts,
    id: initial.id,
    content,
    complete,
    incomplete: !complete,
    replyTo: initial.replyTo,
    contentType: initial.contentType,
    metadata: initial.metadata,
    error,
  };
}

function aggregateMethodCall(call: IncomingMethodCallEvent): AggregatedMethodCall | null {
  if (call.pubsubId === undefined) return null;
  const sender = extractSenderFields(call);
  return {
    type: "method-call",
    kind: "replay",
    aggregated: true,
    pubsubId: call.pubsubId,
    senderId: call.senderId,
    senderName: sender.senderName,
    senderType: sender.senderType,
    senderHandle: sender.senderHandle,
    ts: call.ts,
    callId: call.callId,
    methodName: call.methodName,
    providerId: call.providerId,
    args: call.args,
  };
}

function extractErrorMessage(content: unknown): string | undefined {
  if (!content || typeof content !== "object") return undefined;
  const error = (content as { error?: unknown }).error;
  return typeof error === "string" ? error : undefined;
}

function aggregateMethodResult(
  callId: string,
  chunks: IncomingMethodResultEvent[],
  methodName?: string
): AggregatedMethodResult | null {
  if (chunks.length === 0) return null;
  const finalChunk = chunks.find((chunk) => chunk.complete);
  const firstChunk = chunks[0];
  if (!firstChunk) return null;
  const pubsubId = finalChunk?.pubsubId ?? firstChunk.pubsubId;
  if (pubsubId === undefined) return null;

  const sender = extractSenderFields(finalChunk ?? firstChunk);
  const status = finalChunk
    ? finalChunk.isError
      ? "error"
      : "success"
    : "incomplete";

  return {
    type: "method-result",
    kind: "replay",
    aggregated: true,
    pubsubId,
    senderId: firstChunk.senderId,
    senderName: sender.senderName,
    senderType: sender.senderType,
    senderHandle: sender.senderHandle,
    ts: firstChunk.ts,
    callId,
    methodName,
    status,
    content: finalChunk?.content,
    errorMessage: finalChunk?.isError ? extractErrorMessage(finalChunk.content) : undefined,
  };
}

export function aggregateReplayEvents(events: IncomingEvent[]): AggregatedEvent[] {
  const messageGroups = new Map<
    string,
    { initial?: IncomingNewMessage; updates: IncomingUpdateMessage[]; error?: string }
  >();
  const methodCalls = new Map<string, IncomingMethodCallEvent>();
  const methodResults = new Map<string, IncomingMethodResultEvent[]>();

  for (const event of events) {
    switch (event.type) {
      case "message": {
        const group = messageGroups.get(event.id) ?? { updates: [] };
        group.initial = event;
        messageGroups.set(event.id, group);
        break;
      }
      case "update-message": {
        const group = messageGroups.get(event.id) ?? { updates: [] };
        group.updates.push(event);
        messageGroups.set(event.id, group);
        break;
      }
      case "error": {
        const group = messageGroups.get(event.id) ?? { updates: [] };
        group.error = event.error;
        messageGroups.set(event.id, group);
        break;
      }
      case "method-call":
        methodCalls.set(event.callId, event);
        break;
      case "method-result": {
        const group = methodResults.get(event.callId) ?? [];
        group.push(event);
        methodResults.set(event.callId, group);
        break;
      }
      default:
        break;
    }
  }

  const aggregated: AggregatedEvent[] = [];

  for (const group of messageGroups.values()) {
    if (!group.initial) continue;
    const result = aggregateMessage(group.initial, group.updates, group.error);
    if (result) aggregated.push(result);
  }

  for (const call of methodCalls.values()) {
    const result = aggregateMethodCall(call);
    if (result) aggregated.push(result);
  }

  for (const [callId, chunks] of methodResults.entries()) {
    const methodName = methodCalls.get(callId)?.methodName;
    const result = aggregateMethodResult(callId, chunks, methodName);
    if (result) aggregated.push(result);
  }

  aggregated.sort((a, b) => a.pubsubId - b.pubsubId);
  return aggregated;
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
