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

import type {
  ActionBarPayload,
  ApprovalCardPayload,
  ChatMessage,
  CustomMessageCardPayload,
  DiagnosticNotice,
  InlineUiCardPayload,
  LifecycleNotice,
  MessageTypeDefinition,
  SandboxSource,
} from "./derived-types.js";
import type {
  ChannelViewState,
  ProjectedApproval,
  ProjectedCustomMessage,
  ProjectedInvocation,
  ProjectedMessage,
  ProjectedTurn,
} from "@workspace/agentic-protocol";
import {
  assertNoStoredValueRefs,
  isLifecycleMessageReasonCode,
  isStoredValueRef,
  isTurnReasonCode,
  messageDisplayText,
  readDiagnosticMetadata,
  summarizeMessageBlocks,
} from "@workspace/agentic-protocol";
import type { InvocationCardPayload } from "./invocation-card-payload.js";

type StoredValueRefPreview = { preview?: string };

export function chatMessagesFromChannelView(state: ChannelViewState): ChatMessage[] {
  assertNoStoredValueRefs(state, "chat message projection input");
  const closedTurnIds = new Set(
    Object.values(state.turns)
      .filter((turn) => turn.status === "closed")
      .map((turn) => turn.turnId as string)
  );
  const messages = Object.values(state.messages).flatMap((message) =>
    projectedMessageToChatMessages(message)
  );
  const invocations = Object.values(state.invocations).map(projectedInvocationToChatMessage);
  const approvals = Object.values(state.approvals).map(projectedApprovalToChatMessage);
  const activeStreamingTurns = new Set(
    Object.values(state.messages)
      .filter(
        (message) =>
          message.turnId &&
          message.role === "assistant" &&
          (message.status === "started" || message.status === "streaming") &&
          summarizeMessageBlocks(message.blocks).hasText
      )
      .map((message) => message.turnId as string)
  );
  const terminalAssistantMessageTurnIds = new Set(
    Object.values(state.messages)
      .filter(
        (message) =>
          message.turnId &&
          (message.role === "assistant" || message.actor.kind === "agent") &&
          (message.status === "completed" || message.status === "failed")
      )
      .map((message) => message.turnId as string)
  );
  const turnIdsWithInlineUi = new Set(
    Object.values(state.inlineUi)
      .flatMap((map) => Object.values(map))
      .filter((item) => item.turnId)
      .map((item) => item.turnId as string)
  );
  const turnIdsWithInvocations = new Set(
    Object.values(state.invocations)
      .filter((invocation) => invocation.turnId)
      .map((invocation) => invocation.turnId as string)
  );
  const turns = Object.values(state.turns).flatMap((turn) =>
    activeStreamingTurns.has(turn.turnId) ? [] : projectedTurnToTypingMessage(turn)
  );
  const silentClosedTurns = Object.values(state.turns).flatMap((turn) =>
    projectedClosedTurnWithoutResponseMessage(turn, {
      hasAssistantMessage:
        terminalAssistantMessageTurnIds.has(turn.turnId) || turnIdsWithInlineUi.has(turn.turnId),
      hasInvocation: turnIdsWithInvocations.has(turn.turnId),
    })
  );
  const inlineUi = Object.entries(state.inlineUi).flatMap(([participantId, map]) =>
    Object.values(map).flatMap((item) =>
      isStoredValueRef(item.source)
        ? []
        : [
            projectedInlineUiToChatMessage(
              participantId,
              item as Parameters<typeof projectedInlineUiToChatMessage>[1]
            ),
          ]
    )
  );
  const custom = Object.values(state.customMessages).flatMap((item) =>
    projectedCustomMessageToChatMessage(item, state.messageTypes[item.typeId ?? ""])
  );
  return [
    ...messages,
    ...invocations,
    ...approvals,
    ...turns,
    ...silentClosedTurns,
    ...inlineUi,
    ...custom,
  ]
    .sort(
      (a, b) =>
        Number((a as ChatMessage & { sortTime?: number }).sortTime ?? 0) -
          Number((b as ChatMessage & { sortTime?: number }).sortTime ?? 0) ||
        a.id.localeCompare(b.id)
    )
    .map((message) => {
      const { sortTime: _sortTime, ...rest } = message as ChatMessage & { sortTime?: number };
      return rest;
    });
}

export function messageTypeDefinitionsFromChannelView(
  state: ChannelViewState
): MessageTypeDefinition[] {
  return Object.values(state.messageTypes).flatMap((item) => {
    const isCleared = item.updatedAtSeq <= (item.clearedAtSeq ?? -1);
    if (!isCleared && (!item.source || !item.displayMode)) return [];
    if (!isCleared && isStoredValueRef(item.source)) return [];
    const source = item.source as SandboxSource;
    const definition: MessageTypeDefinition = isCleared
      ? {
          typeId: item.typeId,
          updatedAtSeq: item.updatedAtSeq,
          clearedAtSeq: item.clearedAtSeq ?? -1,
          cleared: true,
        }
      : {
          typeId: item.typeId,
          displayMode: item.displayMode!,
          source,
          updatedAtSeq: item.updatedAtSeq,
          cleared: false,
        };
    if (item.displayMode !== undefined && definition.cleared)
      definition.displayMode = item.displayMode;
    if (item.source !== undefined && definition.cleared && !isStoredValueRef(item.source))
      definition.source = item.source;
    if (item.imports !== undefined) definition.imports = item.imports;
    if (item.schemaSourceOrPath !== undefined)
      definition.schemaSourceOrPath = item.schemaSourceOrPath as SandboxSource | string;
    if (item.registeredBy !== undefined) definition.registeredBy = item.registeredBy;
    if (item.clearedAtSeq !== undefined) definition.clearedAtSeq = item.clearedAtSeq;
    return [definition];
  });
}

export function actionBarPayloadFromChannelView(state: ChannelViewState): ActionBarPayload | null {
  const latest = Object.values(state.actionBars)
    .filter((item): item is NonNullable<typeof item> => Boolean(item))
    .sort((a, b) => Date.parse(a.updatedAt) - Date.parse(b.updatedAt));
  const latestItem = latest[latest.length - 1];
  if (
    !latestItem ||
    latestItem.cleared ||
    !latestItem.source ||
    isStoredValueRef(latestItem.source)
  )
    return null;
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
  return [
    {
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
    } as ChatMessage & { sortTime: number },
  ];
}

function projectedClosedTurnWithoutResponseMessage(
  turn: ProjectedTurn,
  opts: { hasAssistantMessage: boolean; hasInvocation: boolean }
): ChatMessage[] {
  if (turn.status !== "closed") return [];
  if (turn.actor.kind !== "agent") return [];
  if (opts.hasAssistantMessage) return [];
  if (isExpectedNoAssistantClose(turn)) return [];
  if (!opts.hasInvocation && !turn.summary) return [];
  if (isRunnerRestartClose(turn)) {
    const lifecycle: LifecycleNotice = {
      status: "recovered",
      title: "Recovered after restart",
      detail: "The turn closed cleanly, but there was no assistant response to show.",
      reason: lifecycleReasonValue(turn.reason),
    };
    return [
      {
        id: `turn:${turn.turnId}:recovered`,
        senderId: turn.actor.id,
        content: lifecycle.detail ?? lifecycle.title,
        contentType: "lifecycle",
        kind: "system",
        complete: true,
        lifecycle,
        senderMetadata: {
          name: turn.actor.displayName ?? turn.actor.id,
          type: turn.actor.kind,
          handle: turn.actor.id,
        },
        sortTime: Date.parse(turn.closedAt ?? turn.updatedAt ?? turn.openedAt) || 0,
      } as ChatMessage & { sortTime: number },
    ];
  }
  const detail = turn.summary ? ` ${turn.summary}` : "";
  return [
    {
      id: `turn:${turn.turnId}:no-response`,
      senderId: turn.actor.id,
      content: `Agent turn closed without an assistant response.${detail}`,
      kind: "message",
      complete: true,
      error: "Agent turn closed without an assistant response",
      senderMetadata: {
        name: turn.actor.displayName ?? turn.actor.id,
        type: turn.actor.kind,
        handle: turn.actor.id,
      },
      sortTime: Date.parse(turn.closedAt ?? turn.updatedAt ?? turn.openedAt) || 0,
    } as ChatMessage & { sortTime: number },
  ];
}

function isRunnerRestartClose(turn: ProjectedTurn): boolean {
  return turn.reason === "runner_restarted";
}

function isExpectedNoAssistantClose(turn: ProjectedTurn): boolean {
  return (
    turn.reason === "user_interrupted" ||
    turn.reason === "channel_unsubscribe" ||
    turn.reason === "model_credential_required" ||
    turn.reason === "model_credential_reconnect_required"
  );
}

function projectedMessageToChatMessages(message: ProjectedMessage): ChatMessage[] {
  const sortTime =
    Date.parse(message.updatedAt ?? message.completedAt ?? message.startedAt ?? "") || 0;
  const lifecycle = lifecycleNoticeFromMessage(message);
  const senderMetadata = {
    name: message.actor.displayName ?? message.actor.id,
    type: message.actor.kind,
    handle: message.actor.id,
  };
  const complete = message.status === "completed" || message.status === "failed";
  const thinking = (message.blocks ?? []).flatMap((block, index) => {
    if (block.type !== "thinking" || !block.content) return [];
    return [
      {
        id: `thinking:${message.messageId}:${block.blockId ?? index}`,
        senderId: message.actor.id,
        content: block.content,
        contentType: "thinking",
        kind: "message",
        complete,
        senderMetadata,
        sortTime: sortTime - 0.5 + index / 1000,
      } as ChatMessage & { sortTime: number },
    ];
  });
  const failureReason = message.status === "failed" ? message.failureReason : undefined;
  const content = messageDisplayText(message.blocks);
  const diagnostic = diagnosticNoticeFromMessage(message);
  if (diagnostic) {
    return [
      ...thinking,
      {
        id: `diagnostic:${message.messageId}`,
        senderId: message.actor.id,
        content: diagnostic.detail ?? diagnostic.title,
        contentType: "diagnostic",
        kind: "system",
        complete: true,
        diagnostic,
        error: diagnostic.severity === "error" ? (diagnostic.detail ?? diagnostic.title) : undefined,
        senderMetadata,
        sortTime,
      } as ChatMessage & { sortTime: number },
    ];
  }
  if (!messageShouldRenderStandalone(message)) return thinking;
  if (lifecycle) {
    return [
      ...thinking,
      {
        id: message.messageId,
        senderId: message.actor.id,
        content,
        contentType: "lifecycle",
        kind: "system",
        complete: true,
        lifecycle,
        senderMetadata,
        sortTime,
      } as ChatMessage & { sortTime: number },
    ];
  }
  return [
    ...thinking,
    {
      id: message.messageId,
      senderId: message.actor.id,
      content,
      kind: "message",
      complete,
      replyTo: message.replyTo,
      mentions: message.mentions,
      error:
        message.status === "failed"
          ? (failureReason ?? "Message failed")
          : message.outcome === "interrupted"
            ? "Interrupted"
            : undefined,
      senderMetadata,
      sortTime,
    } as ChatMessage & { sortTime: number },
  ];
}

// A standalone row renders the message's display text (and inline attachments).
// Thinking, invocations, and diagnostics each own their render path, so row
// existence is purely content-driven; `outcome` only decorates the row (e.g. the
// "Interrupted" marker / failure error). Empty and failed-without-content messages
// are handled earlier by `diagnosticNoticeFromMessage`.
function messageShouldRenderStandalone(message: ProjectedMessage): boolean {
  const summary = summarizeMessageBlocks(message.blocks);
  return summary.hasText || summary.hasAttachmentOrData;
}

function diagnosticNoticeFromMessage(message: ProjectedMessage): DiagnosticNotice | null {
  const blocks = message.blocks ?? [];
  const diagnosticBlocks = blocks.filter((block) => block.type === "diagnostic");
  if (diagnosticBlocks.length === 0) return null;
  const summary = summarizeMessageBlocks(blocks.filter((block) => block.type !== "diagnostic"));
  if (!summary.isEmpty) return null;
  const block =
    diagnosticBlocks.find((item) => readDiagnosticMetadata(item.metadata).severity === "error") ??
    diagnosticBlocks[0]!;
  const metadata = readDiagnosticMetadata(block.metadata);
  const content = block.content?.trim() || "Assistant message had no visible content.";
  return {
    code: metadata.code,
    severity: metadata.severity,
    title: metadata.severity === "error" ? "Message failed" : "No assistant response",
    detail: content,
    reason: metadata.reason,
  };
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function lifecycleReasonValue(value: unknown): LifecycleNotice["reason"] | undefined {
  return isLifecycleMessageReasonCode(value) || isTurnReasonCode(value) ? value : undefined;
}

function lifecycleNoticeFromMessage(message: ProjectedMessage): LifecycleNotice | null {
  const diagnostic = record(record(message.actor.metadata)["natstackDiagnostic"]);
  if (diagnostic["type"] === "lifecycle_recovery") {
    const status = diagnostic["status"];
    if (status === "recovered" || status === "interrupted" || status === "failed") {
      return {
        status,
        title: stringValue(diagnostic["title"]) ?? lifecycleTitleForStatus(status),
        detail: stringValue(diagnostic["detail"]) ?? messageDisplayText(message.blocks),
        reason: lifecycleReasonValue(diagnostic["reason"]),
      };
    }
  }
  return null;
}

function lifecycleTitleForStatus(status: LifecycleNotice["status"]): string {
  if (status === "recovered") return "Recovered after restart";
  if (status === "failed") return "Recovery failed";
  return "Restart interrupted the turn";
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
    sortTime:
      Date.parse(approval.updatedAt ?? approval.resolvedAt ?? approval.requestedAt ?? "") || 0,
  } as ChatMessage & { sortTime: number };
}

function projectedInvocationToChatMessage(invocation: ProjectedInvocation): ChatMessage {
  const status = invocationCardStatus(invocation);
  const inferred = inferInvocationDisplay(invocation.result);
  const name =
    meaningfulInvocationName(invocation.name) ??
    meaningfulInvocationName(inferred.name) ??
    "invocation";
  const payload: InvocationCardPayload = {
    id: invocation.invocationId,
    ...(invocation.transportCallId ? { transportCallId: invocation.transportCallId } : {}),
    name,
    arguments: recordOrEmpty(invocation.request ?? inferred.request),
    execution: {
      status,
      ...(invocation.terminalOutcome ? { terminalOutcome: invocation.terminalOutcome } : {}),
      ...(invocation.terminalReasonCode
        ? { terminalReasonCode: invocation.terminalReasonCode }
        : {}),
      description: invocationDescription(invocation, inferred.summary),
      result: displayStoredValue(
        invocation.result === undefined && status === "error"
          ? invocation.terminalReason
          : invocation.result
      ),
      isError: status === "error",
      consoleOutput:
        invocation.outputs.length > 0
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
    sortTime:
      Date.parse(invocation.updatedAt ?? invocation.completedAt ?? invocation.startedAt ?? "") || 0,
  } as ChatMessage & { sortTime: number };
}

function invocationCardStatus(
  invocation: ProjectedInvocation
): InvocationCardPayload["execution"]["status"] {
  switch (invocation.terminalOutcome) {
    case "success":
      return "complete";
    case "tool_error":
    case "infrastructure_error":
      return "error";
    case "cancelled":
    case "stale_dispatch":
      return "cancelled";
    case "abandoned":
      return "abandoned";
    default:
      if (invocation.status === "failed") return "error";
      if (invocation.status === "cancelled" || invocation.status === "abandoned") {
        return invocation.status;
      }
      if (invocation.status === "completed") return "complete";
      return "pending";
  }
}

function invocationDescription(invocation: ProjectedInvocation, inferredSummary?: string): string {
  return (
    invocation.terminalReason ?? (invocation.status === "completed" ? "" : (inferredSummary ?? ""))
  );
}

function projectedInlineUiToChatMessage(
  participantId: string,
  inlineUi: {
    id: string;
    actor: { id: string; kind: string; displayName?: string };
    turnId?: string;
    source: InlineUiCardPayload["source"];
    imports?: Record<string, string>;
    props?: Record<string, unknown>;
    renderedAt: string;
  }
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

function projectedCustomMessageToChatMessage(
  custom: ProjectedCustomMessage,
  registeredType: ChannelViewState["messageTypes"][string] | undefined
): ChatMessage[] {
  if (!custom.typeId) return [];
  const typeIsReady =
    registeredType?.source && registeredType.updatedAtSeq > (registeredType.clearedAtSeq ?? -1);
  const displayMode =
    custom.displayMode ?? (typeIsReady ? registeredType.displayMode : undefined) ?? "row";
  const payload: CustomMessageCardPayload = {
    messageId: custom.messageId,
    typeId: custom.typeId,
    displayMode,
    initialState: custom.initialState,
    updates: custom.updates,
    lastSeq: custom.lastSeq,
  };
  return [
    {
      id: `custom:${custom.messageId}`,
      senderId: custom.by?.id ?? custom.typeId,
      content: JSON.stringify(payload),
      contentType: "custom",
      kind: "message",
      complete: true,
      custom: payload,
      senderMetadata: custom.by
        ? {
            name: custom.by.displayName ?? custom.by.id,
            type: custom.by.kind,
            handle: custom.by.id,
          }
        : undefined,
      sortTime: Date.parse(custom.updatedAt ?? custom.startedAt ?? "") || custom.lastSeq,
    } as ChatMessage & { sortTime: number },
  ];
}

function recordOrEmpty(value: unknown): Record<string, unknown> {
  if (isStoredValueRef(value)) return {};
  return value && typeof value === "object" && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : {};
}

function parseStoredJsonPreview(value: unknown): unknown {
  if (!isStoredValueRef(value) || value.encoding !== "json") return undefined;
  const preview = (value as StoredValueRefPreview).preview;
  if (typeof preview !== "string") {
    return undefined;
  }
  try {
    return JSON.parse(preview);
  } catch {
    return undefined;
  }
}

function storedValuePreview(value: unknown): string | undefined {
  return isStoredValueRef(value) ? (value as StoredValueRefPreview).preview : undefined;
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
  if (isStoredValueRef(value)) {
    const parsed = parseStoredJsonPreview(value);
    if (parsed !== undefined) return inferInvocationDisplay(parsed);
    return { summary: storedValuePreview(value) ?? `${value.encoding} blob ${value.digest}` };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const record = value as Record<string, unknown>;
  const name =
    meaningfulInvocationName(record["toolName"]) ?? meaningfulInvocationName(record["name"]);
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
  if (isStoredValueRef(value))
    return storedValuePreview(value) ?? `[stored ${value.encoding} blob ${value.digest}]`;
  return typeof value === "string" ? value : JSON.stringify(value);
}

function displayStoredValue(value: unknown): unknown {
  if (!isStoredValueRef(value)) return value;
  return {
    stored: true,
    digest: value.digest,
    size: value.size,
    encoding: value.encoding,
    preview: storedValuePreview(value),
  };
}
