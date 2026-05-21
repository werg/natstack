/**
 * Shared wire-event → ChatMessage merge logic.
 *
 * Consumed by both `useChannelMessages` (React) and `HeadlessSession`. Before
 * this module, each consumer re-implemented the same merge with the same
 * latent bugs (append-vs-replace, invocation card parsing, etc). Centralizing
 * here keeps the two paths in lockstep.
 *
 * Wire-level shapes are minimally typed — consumers may pass their richer raw
 * event objects; extra fields are ignored.
 */

import type { ActionBarPayload, ApprovalCardPayload, ChatMessage, InlineUiCardPayload } from "./derived-types.js";
import type {
  ChannelViewState,
  ProjectedApproval,
  ProjectedInvocation,
  ProjectedMessage,
  ProjectedTurn,
} from "@workspace/agentic-protocol";
import type { InvocationCardPayload } from "./invocation-card-payload.js";

export function chatMessagesFromChannelView(state: ChannelViewState): ChatMessage[] {
  const messages = Object.values(state.messages)
    .map(projectedMessageToChatMessage);
  const invocations = Object.values(state.invocations).map(projectedInvocationToChatMessage);
  const approvals = Object.values(state.approvals).map(projectedApprovalToChatMessage);
  const activeStreamingTurns = new Set(
    Object.values(state.messages)
      .filter((message) => message.turnId && message.role === "assistant" && (message.status === "started" || message.status === "streaming"))
      .map((message) => message.turnId as string),
  );
  const turns = Object.values(state.turns).flatMap((turn) => activeStreamingTurns.has(turn.turnId)
    ? []
    : projectedTurnToTypingMessage(turn));
  const inlineUi = Object.entries(state.inlineUi).flatMap(([participantId, map]) =>
    Object.values(map).map((item) => projectedInlineUiToChatMessage(participantId, item)),
  );
  return [...messages, ...invocations, ...approvals, ...turns, ...inlineUi].sort((a, b) =>
    Number((a as ChatMessage & { sortTime?: number }).sortTime ?? 0) -
      Number((b as ChatMessage & { sortTime?: number }).sortTime ?? 0) ||
    a.id.localeCompare(b.id)
  ).map((message) => {
    const { sortTime: _sortTime, ...rest } = message as ChatMessage & { sortTime?: number };
    return rest;
  });
}

export function actionBarPayloadFromChannelView(state: ChannelViewState): ActionBarPayload | null {
  const latest = Object.values(state.actionBars)
    .filter((item): item is NonNullable<typeof item> => Boolean(item))
    .sort((a, b) => Date.parse(a.updatedAt) - Date.parse(b.updatedAt));
  const latestItem = latest[latest.length - 1];
  if (!latestItem || latestItem.cleared || !latestItem.source) return null;
  const payload: ActionBarPayload = {
    source: latestItem.source,
  };
  if (latestItem.id !== undefined) payload.id = latestItem.id;
  if (latestItem.imports !== undefined) payload.imports = latestItem.imports;
  if (latestItem.props !== undefined) payload.props = latestItem.props;
  if (latestItem.maxHeight !== undefined) payload.maxHeight = latestItem.maxHeight;
  if (latestItem.result !== undefined) payload.result = latestItem.result;
  return payload;
}

function projectedTurnToTypingMessage(turn: ProjectedTurn): ChatMessage[] {
  if (turn.status !== "open") return [];
  return [{
    id: `turn:${turn.turnId}`,
    senderId: turn.actor.id,
    content: "",
    contentType: "typing",
    kind: "message",
    complete: false,
    senderMetadata: {
      name: turn.actor.displayName ?? turn.actor.id,
      type: turn.actor.kind,
      handle: turn.actor.id,
    },
    sortTime: Date.parse(turn.updatedAt ?? turn.openedAt) || 0,
  } as ChatMessage & { sortTime: number }];
}

function projectedMessageToChatMessage(message: ProjectedMessage): ChatMessage {
  return {
    id: message.messageId,
    senderId: message.actor.id,
    content: message.content,
    kind: "message",
    complete: message.status === "completed" || message.status === "failed",
    error: message.status === "failed" ? "Message failed" : undefined,
    senderMetadata: {
      name: message.actor.displayName ?? message.actor.id,
      type: message.actor.kind,
      handle: message.actor.id,
    },
    sortTime: Date.parse(message.updatedAt ?? message.completedAt ?? message.startedAt ?? "") || 0,
  } as ChatMessage & { sortTime: number };
}

function projectedApprovalToChatMessage(approval: ProjectedApproval): ChatMessage {
  const payload: ApprovalCardPayload = {
    id: approval.approvalId,
    status: approval.status,
  };
  if (approval.invocationId !== undefined) payload.invocationId = approval.invocationId;
  if (approval.question !== undefined) payload.question = approval.question;
  if (approval.granted !== undefined) payload.granted = approval.granted;
  if (approval.reason !== undefined) payload.reason = approval.reason;
  return {
    id: `approval:${approval.approvalId}`,
    senderId: approval.actor.id,
    content: JSON.stringify(payload),
    contentType: "approval",
    kind: "message",
    complete: approval.status !== "requested",
    approval: payload,
    senderMetadata: {
      name: approval.actor.displayName ?? approval.actor.id,
      type: approval.actor.kind,
      handle: approval.actor.id,
    },
    sortTime: Date.parse(approval.updatedAt ?? approval.resolvedAt ?? approval.requestedAt ?? "") || 0,
  } as ChatMessage & { sortTime: number };
}

function projectedInvocationToChatMessage(invocation: ProjectedInvocation): ChatMessage {
  const status = invocation.status === "failed"
    ? "error"
    : invocation.status === "cancelled" || invocation.status === "abandoned"
      ? invocation.status
    : invocation.status === "completed"
      ? "complete"
      : "pending";
  const inferred = inferInvocationDisplay(invocation.result);
  const name = meaningfulInvocationName(invocation.name)
    ?? meaningfulInvocationName(inferred.name)
    ?? "invocation";
  const payload: InvocationCardPayload = {
    id: invocation.invocationId,
    name,
    arguments: recordOrEmpty(invocation.request ?? inferred.request),
    execution: {
      status,
      description: invocation.terminalReason ?? (invocation.status === "completed" ? "" : inferred.summary ?? ""),
      result: invocation.result,
      isError: invocation.status === "failed" || invocation.status === "cancelled" || invocation.status === "abandoned",
      consoleOutput: invocation.outputs.length > 0
        ? invocation.outputs.map((output) => stringifyOutput(output)).join("\n")
        : undefined,
    },
  };
  return {
    id: `invocation:${invocation.invocationId}`,
    senderId: invocation.actor.id,
    content: JSON.stringify(payload),
    contentType: "invocation",
    kind: "message",
    complete: status !== "pending",
    invocation: payload,
    senderMetadata: {
      name: invocation.actor.displayName ?? invocation.actor.id,
      type: invocation.actor.kind,
      handle: invocation.actor.id,
    },
    sortTime: Date.parse(invocation.updatedAt ?? invocation.completedAt ?? invocation.startedAt ?? "") || 0,
  } as ChatMessage & { sortTime: number };
}

function projectedInlineUiToChatMessage(
  participantId: string,
  inlineUi: {
    id: string;
    actor: { id: string; kind: string; displayName?: string };
    source: InlineUiCardPayload["source"];
    imports?: Record<string, string>;
    props?: Record<string, unknown>;
    renderedAt: string;
  },
): ChatMessage {
  const payload: InlineUiCardPayload = {
    id: inlineUi.id,
    source: inlineUi.source,
  };
  if (inlineUi.imports !== undefined) payload.imports = inlineUi.imports;
  if (inlineUi.props !== undefined) payload.props = inlineUi.props;
  return {
    id: `inline-ui:${participantId}:${inlineUi.id}`,
    senderId: inlineUi.actor.id,
    content: JSON.stringify(payload),
    contentType: "inline_ui",
    kind: "message",
    complete: true,
    inlineUi: payload,
    senderMetadata: {
      name: inlineUi.actor.displayName ?? inlineUi.actor.id,
      type: inlineUi.actor.kind,
      handle: inlineUi.actor.id,
    },
    sortTime: Date.parse(inlineUi.renderedAt) || 0,
  } as ChatMessage & { sortTime: number };
}

function recordOrEmpty(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : {};
}

function meaningfulInvocationName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed && trimmed !== "unknown" && trimmed !== "invocation" ? trimmed : undefined;
}

function inferInvocationDisplay(value: unknown): {
  name?: string;
  request?: unknown;
  summary?: string;
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const record = value as Record<string, unknown>;
  const name = meaningfulInvocationName(record["toolName"]) ?? meaningfulInvocationName(record["name"]);
  const summary = typeof record["summary"] === "string" ? record["summary"] : undefined;
  const details = record["details"];
  if (!details || typeof details !== "object" || Array.isArray(details)) return { name, summary };
  const detailRecord = details as Record<string, unknown>;
  return {
    name,
    summary,
    request: detailRecord["input"] ?? detailRecord["args"] ?? detailRecord["arguments"],
  };
}

function stringifyOutput(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}
