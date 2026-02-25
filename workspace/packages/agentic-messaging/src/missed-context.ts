/**
 * Missed context utilities.
 *
 * formatMissedContext and related formatting has moved to @workspace/agentic-protocol.
 * This file retains aggregateReplayEvents (implementation-scope event aggregation).
 */

import type {
  AggregatedEvent,
  AggregatedMessage,
  AggregatedMethodCall,
  AggregatedMethodResult,
  IncomingEvent,
  IncomingNewMessage,
  IncomingMethodCallEvent,
  IncomingMethodResultEvent,
  IncomingUpdateMessage,
} from "./types.js";

// Re-export formatting utilities from protocol
export {
  formatMissedContext,
  DEFAULT_MISSED_CONTEXT_MAX_CHARS,
  DEFAULT_METHOD_RESULT_MAX_CHARS,
} from "@workspace/agentic-protocol/missed-context";

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
