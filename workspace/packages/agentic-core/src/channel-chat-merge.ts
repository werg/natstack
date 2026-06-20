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
  MessageTier,
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
  // The open-turn typing pill stays visible for the WHOLE open turn — including while an assistant
  // message streams — so the "agent is working" signal is stable instead of flickering off every time
  // the agent emits a message bubble. It sorts to the bottom (by turn.updatedAt), beneath the stream.
  const turns = Object.values(state.turns).flatMap(projectedTurnToTypingMessage);
  const waitingTurns = Object.values(state.turns).flatMap(projectedWaitingTurnMessage);
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
  const credentialRequests = Object.values(state.credentialRequests ?? {}).map(
    (request): ChatMessage & { sortTime: number } => ({
      id: `credential:${request.credKey}`,
      senderId: request.participantId,
      content: `Model credential required (${request.providerId})`,
      contentType: "credential-connect",
      kind: "system",
      complete: false,
      credentialRequest: {
        credKey: request.credKey,
        providerId: request.providerId,
        connectSpec: request.connectSpec,
        modelBaseUrl: request.modelBaseUrl,
        reason: request.reason,
        failureCode: request.failureCode,
        expiresAt: request.expiresAt,
        agentParticipantId: request.participantId,
      },
      sortTime: Date.parse(request.publishedAt ?? "") || 0,
    })
  );
  return [
    ...messages,
    ...invocations,
    ...approvals,
    ...turns,
    ...waitingTurns,
    ...silentClosedTurns,
    ...inlineUi,
    ...custom,
    ...credentialRequests,
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
    if (item.stateSchema !== undefined) definition.stateSchema = item.stateSchema;
    if (item.updateSchema !== undefined) definition.updateSchema = item.updateSchema;
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

/**
 * A turn that parked on an out-of-band wait (e.g. a deferred model-credential
 * approval) projects to a first-class "Waiting" lifecycle notice — the agent's
 * failure message for the pause is suppressed upstream, so this is the user's
 * "waiting for approval" signal (with the right call-to-action via the reason).
 */
function projectedWaitingTurnMessage(turn: ProjectedTurn): ChatMessage[] {
  if (turn.status !== "waiting") return [];
  if (turn.actor.kind !== "agent") return [];
  const title = turn.summary ?? "Waiting for input";
  const lifecycle: LifecycleNotice = {
    status: "waiting",
    title,
    ...(turn.reason ? { reason: lifecycleReasonValue(turn.reason) } : {}),
  };
  return [
    {
      id: `turn:${turn.turnId}:waiting`,
      senderId: turn.actor.id,
      content: title,
      contentType: "lifecycle",
      kind: "system",
      complete: false,
      lifecycle,
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
    turn.reason === "turn_superseded" ||
    turn.reason === "model_credential_required" ||
    turn.reason === "model_credential_reconnect_required"
  );
}

/**
 * Resolve a message's salience tier. The sender stamps `tier` explicitly
 * (the agent runtime for assistant turns, the client for user/UI sends), so
 * that value wins. The fallback only catches messages that predate explicit
 * tiering: an assistant step that carried tool calls (the turn continued after
 * it) — or produced no content at all — is a secondary intermediate step;
 * everything else (final answers, user input, still-streaming messages) is
 * primary. This mirrors the runtime's stamping rule so old transcripts tier
 * the same way fresh ones do.
 */
function messageTier(message: ProjectedMessage): MessageTier {
  if (message.tier) return message.tier;
  if (message.role === "assistant" && assistantMessageIsIntermediate(message)) {
    return "secondary";
  }
  return "primary";
}

function assistantMessageIsIntermediate(message: ProjectedMessage): boolean {
  if (message.outcome === "interrupted") return false;
  if (message.outcome === "tool_calls_only" || message.outcome === "empty") return true;
  return (message.blocks ?? []).some((block) => {
    const type = (block as { type?: unknown }).type;
    return type === "invocation" || type === "toolCall" || type === "tool_call";
  });
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
    if (block.type !== "thinking") return [];
    // Reasoning summaries stream as live deltas, so a contentless thinking
    // block is pure noise (e.g. a reasoning phase whose summary never
    // arrived) — drop it rather than rendering an empty pill.
    const content = typeof block.content === "string" ? block.content : "";
    if (!content) return [];
    return [
      {
        id: `thinking:${message.messageId}:${block.blockId ?? index}`,
        senderId: message.actor.id,
        content,
        contentType: "thinking",
        kind: "message",
        complete,
        senderMetadata,
        sortTime: sortTime - 0.5 + index / 1000,
      } as ChatMessage & { sortTime: number },
    ];
  });
  const failureReason = message.status === "failed" ? message.failureReason : undefined;
  if (isCredentialSuspensionReason(failureReason)) return thinking;
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
        error:
          diagnostic.severity === "error" ? (diagnostic.detail ?? diagnostic.title) : undefined,
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
      tier: messageTier(message),
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

function isCredentialSuspensionReason(reason: string | undefined): boolean {
  return reason === "model_credential_required" || reason === "model_credential_reconnect_required";
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
    messageId: message.messageId as string,
    code: metadata.code,
    failureCode: metadata.failureCode,
    severity: metadata.severity,
    title:
      metadata.code === "max_model_calls_per_turn"
        ? "Model call limit reached"
        : metadata.failureCode === "usage_limit_terminal"
          ? "Model usage limit reached"
          : metadata.severity === "error"
            ? "Message failed"
            : "No assistant response",
    detail: content,
    reason: metadata.reason,
    recoverable: metadata.recoverable,
    resetAt: metadata.resetAt,
    retryAfterMs: metadata.retryAfterMs,
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
  if (invocation.terminalReason) return invocation.terminalReason;
  const uiDescription = uiInvocationDescription(invocation);
  if (uiDescription) return uiDescription;
  return invocation.status === "completed" ? "" : (inferredSummary ?? "");
}

function uiInvocationDescription(invocation: ProjectedInvocation): string | undefined {
  switch (invocation.name) {
    case "inline_ui":
      return inlineUiInvocationDescription(invocation);
    case "load_action_bar":
      return actionBarInvocationDescription(invocation);
    case "feedback_form":
      return feedbackInvocationDescription(invocation, "feedback");
    case "feedback_custom":
      return feedbackInvocationDescription(invocation, "custom feedback");
    case "ui_prompt":
      return uiPromptInvocationDescription(invocation);
    case "inspect_card":
      return inspectCardInvocationDescription(invocation);
    default:
      return undefined;
  }
}

function inlineUiInvocationDescription(invocation: ProjectedInvocation): string {
  const request = recordOrEmpty(invocation.request);
  const result = recordOrEmpty(invocation.result);
  const source = uiSourceLabel(request);
  const error = methodError(result);
  if (error) return `Inline UI failed: ${error}`;
  if (invocation.status === "completed") {
    const id = stringValue(result["id"]);
    return id
      ? `Rendered inline UI (${id})`
      : `Rendered inline UI${source ? ` from ${source}` : ""}`;
  }
  return `Rendering inline UI${source ? ` from ${source}` : ""}`;
}

function actionBarInvocationDescription(invocation: ProjectedInvocation): string {
  const request = recordOrEmpty(invocation.request);
  const result = recordOrEmpty(invocation.result);
  const clear = request["clear"] === true || result["cleared"] === true;
  const error = methodError(result);
  if (error) return `Action bar failed: ${error}`;
  if (clear)
    return invocation.status === "completed" ? "Cleared action bar" : "Clearing action bar";
  const source = uiSourceLabel(request);
  return invocation.status === "completed"
    ? `Loaded action bar${source ? ` from ${source}` : ""}`
    : `Loading action bar${source ? ` from ${source}` : ""}`;
}

function feedbackInvocationDescription(
  invocation: ProjectedInvocation,
  label: "feedback" | "custom feedback"
): string {
  const request = recordOrEmpty(invocation.request);
  const result = recordOrEmpty(invocation.result);
  const title = feedbackTitle(request, label);
  if (invocation.status !== "completed") return `Waiting for ${label}: ${title}`;
  return completedFeedbackDescription(result, title);
}

function uiPromptInvocationDescription(invocation: ProjectedInvocation): string {
  const request = recordOrEmpty(invocation.request);
  const title = stringValue(request["title"]) ?? "prompt";
  const kind = stringValue(request["kind"]);
  if (invocation.status !== "completed") {
    return `Waiting for ${kind ? `${kind} ` : ""}prompt: ${title}`;
  }
  return `Prompt answered: ${title}`;
}

function inspectCardInvocationDescription(invocation: ProjectedInvocation): string {
  const request = recordOrEmpty(invocation.request);
  const result = recordOrEmpty(invocation.result);
  const messageId = stringValue(request["messageId"]);
  const suffix = messageId ? ` ${messageId}` : "";
  const error = methodError(result);
  if (error) return `Custom message inspection failed: ${error}`;
  return invocation.status === "completed"
    ? `Inspected custom message${suffix}`
    : `Inspecting custom message${suffix}`;
}

function completedFeedbackDescription(result: Record<string, unknown>, title: string): string {
  const type = stringValue(result["type"]);
  if (type === "submit") return `Feedback submitted: ${title}`;
  if (type === "cancel") return `Feedback cancelled: ${title}`;
  if (type === "error") {
    return `Feedback error: ${stringValue(result["message"]) ?? title}`;
  }
  return `Feedback completed: ${title}`;
}

function feedbackTitle(request: Record<string, unknown>, fallback: string): string {
  return stringValue(request["title"]) ?? uiSourceLabel(request) ?? fallback;
}

function uiSourceLabel(request: Record<string, unknown>): string | undefined {
  const path = stringValue(request["path"]);
  if (path) return path;
  return stringValue(request["code"]) ? "inline code" : undefined;
}

function methodError(result: Record<string, unknown>): string | undefined {
  if (result["ok"] !== false && stringValue(result["type"]) !== "error") return undefined;
  return stringValue(result["error"]) ?? stringValue(result["message"]) ?? "Unknown error";
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
  if (custom.by) {
    payload.by = {
      kind: custom.by.kind,
      id: custom.by.id,
      ...(custom.by.displayName ? { displayName: custom.by.displayName } : {}),
    };
  }
  if (custom.failed) {
    payload.failed = true;
    payload.error = custom.error ?? { message: "card failed" };
  }
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
  if (isStoredValueRef(value)) {
    return storedValuePreview(value) ?? `[stored ${value.encoding} blob ${value.digest}]`;
  }
  if (typeof value === "string") return value;
  const consoleLine = formatConsoleStreamOutput(value);
  if (consoleLine !== undefined) return consoleLine;
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

function formatConsoleStreamOutput(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (record["type"] !== "console") return undefined;

  const content = record["content"];
  const text =
    typeof content === "string" ? content : content == null ? "" : stringifyOutput(content);
  const level = typeof record["level"] === "string" ? record["level"].toLowerCase() : "";
  if (!level || level === "log") return text;
  return `[${level.toUpperCase()}] ${text}`;
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
