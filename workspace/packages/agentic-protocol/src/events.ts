import { AGENTIC_PROTOCOL_VERSION } from "./constants.js";
import type { InvocationOutcome, MessageOutcome, TurnReasonCode } from "./constants.js";
import type {
  ApprovalId,
  BlockId,
  BranchId,
  ChannelId,
  EnvelopeId,
  EventId,
  InvocationId,
  MessageId,
  StateHash,
  TrajectoryId,
  TurnId,
} from "./ids.js";

export type ActorKind = "user" | "agent" | "system" | "panel" | "external";

export interface ActorRef {
  kind: ActorKind;
  id: string;
  displayName?: string;
  metadata?: Record<string, unknown>;
}

export interface ParticipantRef extends ActorRef {
  participantId?: string;
}

export interface ParticipantSelector {
  kind: "all" | "role" | "participant";
  role?: string;
  participantId?: string;
}

export type EventKind =
  | "message.started"
  | "message.delta"
  | "message.completed"
  | "message.failed"
  | "invocation.started"
  | "invocation.progress"
  | "invocation.output"
  | "invocation.completed"
  | "invocation.failed"
  | "invocation.cancelled"
  | "invocation.abandoned"
  | "approval.requested"
  | "approval.resolved"
  | "ui.inline_rendered"
  | "ui.action_bar.updated"
  | "messageType.registered"
  | "messageType.cleared"
  | "custom.started"
  | "custom.updated"
  | "state.file_observed"
  | "state.file_mutation_intended"
  | "state.file_mutation_applied"
  | "state.transition_recorded"
  | "external.envelope_published"
  | "external.envelope_observed"
  | "external.participant_observed"
  | "branch.created"
  | "branch.forked"
  | "branch.head_changed"
  | "turn.opened"
  | "turn.waiting"
  | "turn.closed"
  | "system.event"
  | "system.compaction_recorded"
  | "knowledge.claim_recorded"
  | "knowledge.claim_updated"
  | "knowledge.claim_retracted"
  | "knowledge.theory_proposed"
  | "knowledge.theory_versioned"
  | "knowledge.theory_superseded"
  | "knowledge.claim_edge_added"
  | "knowledge.claim_edge_removed"
  | "knowledge.contradiction_recorded"
  | "knowledge.contradiction_resolved";

export interface EventCausality {
  parentEventId?: EventId;
  messageId?: MessageId;
  blockId?: BlockId;
  invocationId?: InvocationId;
  transportCallId?: string;
  approvalId?: ApprovalId;
  modelToolCallId?: string;
}

export type MessageRole = "user" | "assistant" | "system" | "tool" | "panel";

export type { StoredValueRef as BlobRefPayload } from "./stored-values.js";

export type StoredAgenticEvent = Omit<AgenticEvent, "payload"> & { payload: unknown };

export type MessagePayload =
  | {
      protocol: "agentic.trajectory.v1";
      role: MessageRole;
      blocks?: MessageBlockInput[];
      mentions?: string[];
      replyTo?: MessageId;
    }
  | {
      // Streaming content update. Deltas stream incremental text/thinking content
      // ONLY; structural blocks (invocation/attachment/data/diagnostic) are never
      // streamed — they arrive via their own events and the authoritative `blocks`
      // on `message.completed`. `text` is appended to the block, or replaces its
      // content when `replace` is set.
      protocol: "agentic.trajectory.v1";
      blockId: BlockId;
      type: "text" | "thinking";
      text: string;
      replace?: boolean;
    }
  | {
      protocol: "agentic.trajectory.v1";
      role?: MessageRole;
      blocks?: MessageBlockInput[];
      outcome: MessageOutcome;
      usage?: UsagePayload;
      mentions?: string[];
      replyTo?: MessageId;
    }
  | { protocol: "agentic.trajectory.v1"; reason: string; recoverable?: boolean };

export interface MessageBlockInput {
  blockId?: BlockId;
  type: "text" | "thinking" | "invocation" | "attachment" | "data" | "diagnostic";
  content?: string;
  invocationId?: InvocationId;
  metadata?: Record<string, unknown>;
}

export type DiagnosticSeverity = "info" | "warning" | "error";

/**
 * Typed metadata carried by a `diagnostic` block. Written by the reducer when it
 * synthesizes a diagnostic block (empty/failed messages) and read back by the
 * projection. `MessageBlockInput.metadata` stays an open record on the wire;
 * `readDiagnosticMetadata` is the single boundary that narrows it.
 */
export interface DiagnosticBlockMetadata {
  code: string;
  severity: DiagnosticSeverity;
  reason?: string;
  recoverable?: boolean;
}

export function readDiagnosticMetadata(
  metadata: Record<string, unknown> | undefined
): DiagnosticBlockMetadata {
  const record = metadata && typeof metadata === "object" ? metadata : {};
  const severity = record["severity"];
  const reason = record["reason"];
  const code = record["code"];
  return {
    code: typeof code === "string" ? code : "diagnostic",
    severity:
      severity === "error" || severity === "info" || severity === "warning"
        ? severity
        : "warning",
    reason: typeof reason === "string" && reason.trim() ? reason : undefined,
    recoverable: typeof record["recoverable"] === "boolean" ? record["recoverable"] : undefined,
  };
}

export interface UsagePayload {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  costUsd?: number;
  metadata?: Record<string, unknown>;
}

export type InvocationTransport =
  | { kind: "local"; awaiterId: string }
  | { kind: "channel"; channelId: ChannelId; target: ParticipantRef; transportCallId?: string }
  | { kind: "http"; targetUrl: string; idempotencyKey: string };

export type InvocationCompletedPayload = {
  protocol: "agentic.trajectory.v1";
  result?: unknown;
  usage?: UsagePayload;
  summary?: string;
  terminalOutcome: "success";
  terminalReasonCode?: string;
};

export type InvocationTerminalFailureOutcome = Exclude<InvocationOutcome, "success">;

type InvocationFailurePayloadBase<Outcome extends InvocationTerminalFailureOutcome> = {
  protocol: "agentic.trajectory.v1";
  reason: string;
  error?: unknown;
  recoverable?: boolean;
  terminalOutcome: Outcome;
  terminalReasonCode?: string;
};

export type InvocationFailedPayload = InvocationFailurePayloadBase<
  Extract<InvocationOutcome, "tool_error" | "infrastructure_error">
>;

export type InvocationCancelledPayload = InvocationFailurePayloadBase<
  Extract<InvocationOutcome, "cancelled" | "stale_dispatch">
>;

export type InvocationAbandonedPayload = InvocationFailurePayloadBase<"abandoned">;

export type InvocationFailurePayload =
  | InvocationFailedPayload
  | InvocationCancelledPayload
  | InvocationAbandonedPayload;

export type InvocationTerminalPayload = InvocationCompletedPayload | InvocationFailurePayload;

export type InvocationPayload =
  | {
      protocol: "agentic.trajectory.v1";
      name: string;
      invocationType?: "tool" | "panel" | "agent" | "user" | "http" | "system";
      request?: unknown;
      transport?: InvocationTransport;
      requiresApproval?: boolean;
      userVisible?: boolean;
      summary?: string;
    }
  | { protocol: "agentic.trajectory.v1"; message?: string; progress?: number; data?: unknown }
  | { protocol: "agentic.trajectory.v1"; output: unknown; channel?: "stdout" | "stderr" | "data" }
  | InvocationCompletedPayload
  | InvocationFailurePayload;

export function invocationCompletedPayload(
  opts: Omit<InvocationCompletedPayload, "protocol" | "terminalOutcome"> = {}
): InvocationCompletedPayload {
  return {
    protocol: AGENTIC_PROTOCOL_VERSION,
    ...opts,
    terminalOutcome: "success",
  };
}

function invocationFailurePayload<Outcome extends InvocationTerminalFailureOutcome>(
  outcome: Outcome,
  reason: string,
  opts: Omit<InvocationFailurePayloadBase<Outcome>, "protocol" | "terminalOutcome" | "reason"> = {}
): InvocationFailurePayloadBase<Outcome> {
  return {
    protocol: AGENTIC_PROTOCOL_VERSION,
    reason,
    ...opts,
    terminalOutcome: outcome,
  };
}

export function invocationFailedPayload(
  outcome: Extract<InvocationOutcome, "tool_error" | "infrastructure_error">,
  reason: string,
  opts: Omit<InvocationFailedPayload, "protocol" | "terminalOutcome" | "reason"> = {}
): InvocationFailedPayload {
  return invocationFailurePayload(outcome, reason, opts);
}

export function invocationCancelledPayload(
  outcome: Extract<InvocationOutcome, "cancelled" | "stale_dispatch">,
  reason: string,
  opts: Omit<InvocationCancelledPayload, "protocol" | "terminalOutcome" | "reason"> = {}
): InvocationCancelledPayload {
  return invocationFailurePayload(outcome, reason, opts);
}

export function invocationAbandonedPayload(
  reason: string,
  opts: Omit<InvocationAbandonedPayload, "protocol" | "terminalOutcome" | "reason"> = {}
): InvocationAbandonedPayload {
  return invocationFailurePayload("abandoned", reason, opts);
}

export type ApprovalPayload =
  | {
      protocol: "agentic.trajectory.v1";
      question: string;
      requestedBy?: ActorRef;
      approver?: ParticipantRef | ParticipantSelector;
      details?: unknown;
    }
  | {
      protocol: "agentic.trajectory.v1";
      granted: boolean;
      resolvedBy: ActorRef;
      reason?: string;
      details?: unknown;
    };

export type SandboxSourcePayload =
  | { type: "code"; code: string }
  | { type: "file"; path: string }
  | StoredValueRef;

export type CustomMessageDisplayMode = "inline" | "row";

export interface MessageTypeRegisteredPayload {
  protocol: "agentic.trajectory.v1";
  typeId: string;
  displayMode: CustomMessageDisplayMode;
  source: SandboxSourcePayload;
  imports?: Record<string, string>;
  schemaSourceOrPath?: unknown;
  registeredBy?: ActorRef;
}

export interface MessageTypeClearedPayload {
  protocol: "agentic.trajectory.v1";
  typeId: string;
}

export interface CustomStartedPayload {
  protocol: "agentic.trajectory.v1";
  messageId: MessageId;
  typeId: string;
  displayMode?: CustomMessageDisplayMode;
  initialState?: unknown;
  by?: ActorRef;
}

export interface CustomUpdatedPayload {
  protocol: "agentic.trajectory.v1";
  messageId: MessageId;
  update: unknown;
}

export type UiPayload =
  | {
      protocol: "agentic.trajectory.v1";
      uiType: "inline";
      id: string;
      source: SandboxSourcePayload;
      imports?: Record<string, string>;
      props?: Record<string, unknown>;
    }
  | {
      protocol: "agentic.trajectory.v1";
      uiType: "action_bar";
      id?: string;
      source?: SandboxSourcePayload;
      imports?: Record<string, string>;
      props?: Record<string, unknown>;
      maxHeight?: number;
      cleared?: boolean;
      result?: { ok: boolean; error?: string };
    };

export interface ExternalEnvelopePublishedPayload {
  protocol: "agentic.trajectory.v1";
  publications: Array<{
    channelId: ChannelId;
    envelopeId: EnvelopeId;
    payloadKind?: string;
    eventId?: EventId;
    summary?: string;
  }>;
}

export interface ExternalEnvelopeObservedPayload {
  protocol: "agentic.trajectory.v1";
  channelId: ChannelId;
  envelopeId: EnvelopeId;
  from: ParticipantRef;
  payloadKind?: string;
  body?: unknown;
}

export interface ExternalParticipantObservedPayload {
  protocol: "agentic.trajectory.v1";
  channelId: ChannelId;
  participant: ParticipantRef;
  action: "joined" | "left" | "updated";
  roles?: string[];
}

export interface TurnPayload {
  protocol: "agentic.trajectory.v1";
  summary?: string;
  reason?: TurnReasonCode;
}

export interface BranchPayload {
  protocol: "agentic.trajectory.v1";
  branchId?: BranchId;
  parentBranchId?: BranchId;
  headEventId?: EventId;
  headStateHash?: StateHash;
  forkEventId?: EventId;
  name?: string;
}

export interface StatePayload {
  protocol: "agentic.trajectory.v1";
  mutationId?: string;
  observationId?: string;
  path?: string;
  paths?: string[];
  operation?: string;
  diff?: string;
  inputStateHash?: StateHash;
  outputStateHash?: StateHash;
  stateHash?: StateHash;
  invocationId?: InvocationId;
  contentHash?: string;
  beforeHash?: string;
  afterHash?: string;
  hunks?: unknown[];
  size?: number;
  mimeType?: string;
  summary?: string;
  error?: string;
  rationale?: string;
  metadata?: Record<string, unknown>;
}

export interface SystemPayload {
  protocol: "agentic.trajectory.v1";
  kind?: string;
  summary?: string;
  details?: unknown;
}

export interface CompactionPayload {
  protocol: "agentic.trajectory.v1";
  summary: string;
  rangeStart: EventId;
  rangeEnd: EventId;
  replacement?: unknown;
}

export interface KnowledgePayload {
  protocol: "agentic.trajectory.v1";
  id?: string;
  subject?: string;
  predicate?: string;
  object?: string;
  claimId?: string;
  theoryId?: string;
  contradictionId?: string;
  status?: string;
  body?: unknown;
  metadata?: Record<string, unknown>;
}

export type InvocationPayloadFor<K extends EventKind> = K extends "invocation.completed"
  ? InvocationCompletedPayload
  : K extends "invocation.failed"
    ? InvocationFailedPayload
    : K extends "invocation.cancelled"
      ? InvocationCancelledPayload
      : K extends "invocation.abandoned"
        ? InvocationAbandonedPayload
        : InvocationPayload;

export type PayloadFor<K extends EventKind> = K extends `message.${string}`
  ? MessagePayload
  : K extends `invocation.${string}`
    ? InvocationPayloadFor<K>
    : K extends `approval.${string}`
      ? ApprovalPayload
      : K extends `ui.${string}`
        ? UiPayload
        : K extends "messageType.registered"
          ? MessageTypeRegisteredPayload
          : K extends "messageType.cleared"
            ? MessageTypeClearedPayload
            : K extends "custom.started"
              ? CustomStartedPayload
              : K extends "custom.updated"
                ? CustomUpdatedPayload
                : K extends "external.envelope_published"
                  ? ExternalEnvelopePublishedPayload
                  : K extends "external.envelope_observed"
                    ? ExternalEnvelopeObservedPayload
                    : K extends "external.participant_observed"
                      ? ExternalParticipantObservedPayload
                      : K extends `branch.${string}`
                        ? BranchPayload
                        : K extends `turn.${string}`
                          ? TurnPayload
                          : K extends `state.${string}`
                            ? StatePayload
                            : K extends "system.compaction_recorded"
                              ? CompactionPayload
                              : K extends "system.event"
                                ? SystemPayload
                                : K extends `knowledge.${string}`
                                  ? KnowledgePayload
                                  : never;

export interface AgenticEvent<K extends EventKind = EventKind> {
  kind: K;
  actor: ActorRef;
  turnId?: TurnId;
  causality?: EventCausality;
  payload: PayloadFor<K>;
  createdAt: string;
}

export interface TrajectoryEvent<K extends EventKind = EventKind> extends AgenticEvent<K> {
  eventId: EventId;
  trajectoryId: TrajectoryId;
  branchId: BranchId;
  seq: number;
  prevEventHash: string;
  eventHash: string;
}

export function agenticSlice<K extends EventKind>(event: TrajectoryEvent<K>): AgenticEvent<K> {
  return {
    kind: event.kind,
    actor: event.actor,
    ...(event.turnId ? { turnId: event.turnId } : {}),
    ...(event.causality ? { causality: event.causality } : {}),
    payload: event.payload,
    createdAt: event.createdAt,
  };
}
import type { StoredValueRef } from "./stored-values.js";
