import { AGENTIC_PROTOCOL_VERSION } from "./constants.js";
import type { InvocationOutcome, MessageOutcome, MessageTier, TurnReasonCode } from "./constants.js";
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
  | "message.received"
  | "message.read"
  | "message.edited"
  | "message.retracted"
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
  | "ui.feedback"
  | "messageType.registered"
  | "messageType.cleared"
  | "custom.started"
  | "custom.updated"
  | "state.file_observed"
  | "state.file_mutation_intended"
  | "state.file_mutation_applied"
  | "state.transition_recorded"
  | "state.snapshot_ingested"
  | "state.merge_applied"
  | "memory.recalled"
  | "build.completed"
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
  /**
   * Number of consecutive agent-authored messages in this causal chain.
   * Incremented by each agent reply; the addressing resolver refuses to
   * respond past the channel's hop cap so agents cannot loop forever.
   */
  agentHops?: number;
  /** Originating model attempt (WS1) — invocations record which attempt
   *  produced them so crash recovery never duplicates tool dispatch. */
  attemptId?: string;
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
      to?: ParticipantSelector[];
      /** Salience tier; absent ⇒ "primary". See MessageTier. */
      tier?: MessageTier;
      /** Free-form send intent (e.g. `deliverAfterTurn`). The loop lifts this
       *  into its queue entries via `metadataFromPayload`. */
      metadata?: Record<string, unknown>;
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
      to?: ParticipantSelector[];
      /** Salience tier; absent ⇒ "primary". See MessageTier. */
      tier?: MessageTier;
      /** Free-form send intent (e.g. `deliverAfterTurn`). User messages are
       *  published as `message.completed`, so this is where the client's send
       *  metadata rides; the loop lifts it via `metadataFromPayload`. */
      metadata?: Record<string, unknown>;
    }
  | {
      protocol: "agentic.trajectory.v1";
      reason: string;
      recoverable?: boolean;
      code?: string;
      resetAt?: string;
      retryAfterMs?: number;
    };

/**
 * A delivery receipt — a recipient telling the channel it accepted
 * (`message.received`) or consumed into a model turn (`message.read`) a
 * message. The target message is `event.causality.messageId`; the acking
 * recipient is `event.actor`. Acks are monotone (read implies received).
 */
export interface MessageReceiptPayload {
  protocol: "agentic.trajectory.v1";
  /** The turn that folded the message in, for `message.read`. */
  turnId?: TurnId;
}

/**
 * The original author revising an unread message's blocks. `by` exists because
 * the agent fold replays this from a PRIVATE trajectory whose envelope actor is
 * the agent, not the original sender; the channel reducer additionally requires
 * `by` to match `event.actor`.
 */
export interface MessageEditPayload {
  protocol: "agentic.trajectory.v1";
  by: ParticipantRef;
  blocks: MessageBlockInput[];
}

/** The original author canceling an unread message. See `MessageEditPayload`
 *  for why `by` is carried. */
export interface MessageRetractPayload {
  protocol: "agentic.trajectory.v1";
  by: ParticipantRef;
  reason?: string;
}

export type MessageBlockType =
  | "text"
  | "thinking"
  | "invocation"
  | "attachment"
  | "data"
  | "diagnostic";

interface MessageBlockBase {
  blockId?: BlockId;
  metadata?: Record<string, unknown>;
}

/**
 * A content block within a message. A discriminated union on `type` so each
 * variant carries exactly the fields it needs: text/thinking/diagnostic require
 * `content`; invocation requires `invocationId` (and only invocation may carry
 * one). Illegal shapes — a text block with an `invocationId`, an invocation block
 * with no id — are unrepresentable.
 */
export type MessageBlockInput =
  | (MessageBlockBase & { type: "text" | "thinking"; content: string })
  | (MessageBlockBase & { type: "invocation"; invocationId: InvocationId; content?: string })
  | (MessageBlockBase & { type: "attachment" | "data"; content?: string })
  | (MessageBlockBase & { type: "diagnostic"; content: string });

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
  failureCode?: string;
  resetAt?: string;
  retryAfterMs?: number;
}

export function readDiagnosticMetadata(
  metadata: Record<string, unknown> | undefined
): DiagnosticBlockMetadata {
  const record = metadata && typeof metadata === "object" ? metadata : {};
  const severity = record["severity"];
  const reason = record["reason"];
  const code = record["code"];
  const failureCode = record["failureCode"];
  const resetAt = record["resetAt"];
  const retryAfterMs = record["retryAfterMs"];
  return {
    code: typeof code === "string" ? code : "diagnostic",
    severity:
      severity === "error" || severity === "info" || severity === "warning"
        ? severity
        : "warning",
    reason: typeof reason === "string" && reason.trim() ? reason : undefined,
    recoverable: typeof record["recoverable"] === "boolean" ? record["recoverable"] : undefined,
    failureCode:
      typeof failureCode === "string" && failureCode.trim() ? failureCode : undefined,
    resetAt: typeof resetAt === "string" && resetAt.trim() ? resetAt : undefined,
    retryAfterMs:
      typeof retryAfterMs === "number" && Number.isFinite(retryAfterMs)
        ? retryAfterMs
        : undefined,
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
  | {
      kind: "channel";
      channelId: ChannelId;
      target: ParticipantRef;
      transportCallId?: string;
      /** Epoch ms deadline journaled with the call so it survives cache amnesia. */
      deadlineAt?: number;
    }
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
  /**
   * JSON Schema for the card's full state. Schemas are data, not code: both
   * the emitting agent (at publish time) and the rendering panel (at fold
   * time) validate against this same document, fetched from the channel's
   * message-type registry.
   */
  stateSchema?: Record<string, unknown>;
  /**
   * JSON Schema for incremental updates. Required when the renderer module
   * exports a `reduce` function (updates are patches, not full states);
   * without it, emission-time validation of updates is impossible.
   */
  updateSchema?: Record<string, unknown>;
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
  /** Marks the card as failed; the UI renders a standard failed-card frame. */
  status?: "failed";
  error?: { message: string; details?: unknown };
}

export type UiFeedbackCategory =
  | "render_failed"
  | "state_invalid"
  | "type_not_registered"
  | "method_call_failed"
  | "suspension_timeout"
  /** A registered type's renderer never became ready (fetch/load/compile stalled). */
  | "load_stalled";

/**
 * UI-to-agent feedback: the panel (or channel infrastructure) telling the
 * owning agent that something it published is broken. The harness ingests
 * events targeting itself and injects them into the agent's context; these
 * events never trigger conversational responses.
 */
export interface UiFeedbackPayload {
  protocol: "agentic.trajectory.v1";
  target: ParticipantRef;
  category: UiFeedbackCategory;
  refs?: {
    messageId?: MessageId;
    typeId?: string;
    callId?: string;
    turnId?: TurnId;
  };
  error: { name?: string; message: string; stack?: string; componentStack?: string };
  /** Dedupe key — repeated occurrences of the same failure collapse to one. */
  occurrenceKey: string;
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
  /** Merge parents beyond `inputStateHash` (which stays parent 0). */
  parentStateHashes?: StateHash[];
  /** Optional explicit file list for snapshot events; large lists must be
   *  blob-spilled by callers. */
  files?: Array<{ path: string; contentHash: string; size?: number; mode?: number }>;
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

export interface MemoryRecalledPayload {
  protocol: "agentic.trajectory.v1";
  query: string;
  results?: unknown; // recall results (blob-spilled when large)
  anchors?: unknown[];
  metadata?: Record<string, unknown>;
}

export interface BuildCompletedPayload {
  protocol: "agentic.trajectory.v1";
  inputStateHash: string;
  subtree?: string;
  evHash?: string;
  artifactRefs?: unknown;
  diagnostics?: unknown;
  metadata?: Record<string, unknown>;
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

export type PayloadFor<K extends EventKind> = K extends "message.received" | "message.read"
  ? MessageReceiptPayload
  : K extends "message.edited"
    ? MessageEditPayload
    : K extends "message.retracted"
      ? MessageRetractPayload
      : K extends `message.${string}`
  ? MessagePayload
  : K extends `invocation.${string}`
    ? InvocationPayloadFor<K>
    : K extends `approval.${string}`
      ? ApprovalPayload
      : K extends "ui.feedback"
        ? UiFeedbackPayload
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
                                : K extends "memory.recalled"
                                  ? MemoryRecalledPayload
                                  : K extends "build.completed"
                                    ? BuildCompletedPayload
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
