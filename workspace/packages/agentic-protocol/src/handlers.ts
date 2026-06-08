import type {
  ActorRef,
  AgenticEvent,
  DiagnosticBlockMetadata,
  EventKind,
  MessageBlockInput,
  ParticipantRef,
  SandboxSourcePayload,
  UsagePayload,
} from "./events.js";
import type { ApprovalId, InvocationId, MessageId, TurnId } from "./ids.js";
import type { InvocationOutcome, MessageOutcome } from "./constants.js";

export type MessageStatus = "started" | "streaming" | "completed" | "failed";
export type InvocationStatus =
  | "started"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "abandoned";
export type ApprovalStatus = "requested" | "granted" | "denied";

export interface ProjectedMessage {
  messageId: MessageId;
  actor: ActorRef;
  turnId?: TurnId;
  role: string;
  blocks?: MessageBlockInput[];
  mentions?: string[];
  replyTo?: MessageId;
  status: MessageStatus;
  outcome?: MessageOutcome;
  startedAt?: string;
  completedAt?: string;
  failedAt?: string;
  failureReason?: string;
  updatedAt?: string;
  usage?: UsagePayload;
}

export interface ProjectedInvocation {
  invocationId: InvocationId;
  transportCallId?: string;
  actor: ActorRef;
  turnId?: TurnId;
  name?: string;
  status: InvocationStatus;
  request?: unknown;
  result?: unknown;
  outputs: unknown[];
  progress: Array<{ at: string; message?: string; progress?: number; data?: unknown }>;
  requiresApproval?: boolean;
  userVisible?: boolean;
  startedAt?: string;
  completedAt?: string;
  updatedAt?: string;
  terminalReason?: string;
  terminalOutcome?: InvocationOutcome;
  terminalReasonCode?: string;
}

export interface ProjectedApproval {
  approvalId: ApprovalId;
  invocationId?: InvocationId;
  actor: ActorRef;
  status: ApprovalStatus;
  question?: string;
  granted?: boolean;
  reason?: string;
  requestedAt?: string;
  resolvedAt?: string;
  updatedAt?: string;
}

export interface ProjectedInlineUi {
  id: string;
  turnId?: TurnId;
  actor: ActorRef;
  source: SandboxSourcePayload;
  imports?: Record<string, string>;
  props?: Record<string, unknown>;
  renderedAt: string;
}

export interface ProjectedActionBar {
  id?: string;
  actor: ActorRef;
  source?: SandboxSourcePayload;
  imports?: Record<string, string>;
  props?: Record<string, unknown>;
  maxHeight?: number;
  cleared?: boolean;
  result?: { ok: boolean; error?: string };
  updatedAt: string;
}

export interface ProjectedTurn {
  turnId: TurnId;
  actor: ActorRef;
  status: "open" | "waiting" | "closed";
  openedAt: string;
  closedAt?: string;
  updatedAt?: string;
  summary?: string;
  reason?: string;
  /** Highest envelope seq applied to this turn's status — the monotonicity guard
   *  that stops an out-of-order/replayed event from resurrecting a closed turn. */
  lastSeq?: number;
}

export type MessageMap = Record<string, ProjectedMessage>;
export type InvocationMap = Record<string, ProjectedInvocation>;
export type ApprovalMap = Record<string, ProjectedApproval>;
export type InlineUiMap = Record<string, ProjectedInlineUi>;
export type TurnMap = Record<string, ProjectedTurn>;

function isTerminalInvocationStatus(status: InvocationStatus | undefined): boolean {
  return (
    status === "completed" ||
    status === "failed" ||
    status === "cancelled" ||
    status === "abandoned"
  );
}

function requireMessageId(event: AgenticEvent): MessageId {
  const messageId = event.causality?.messageId;
  if (!messageId) throw new Error(`${event.kind} requires causality.messageId`);
  return messageId;
}

function requireInvocationId(event: AgenticEvent): InvocationId {
  const invocationId = event.causality?.invocationId;
  if (!invocationId) throw new Error(`${event.kind} requires causality.invocationId`);
  return invocationId;
}

function requireApprovalId(event: AgenticEvent): ApprovalId {
  const approvalId = event.causality?.approvalId;
  if (!approvalId) throw new Error(`${event.kind} requires causality.approvalId`);
  return approvalId;
}

function diagnosticBlock(
  blockId: string,
  content: string,
  metadata: DiagnosticBlockMetadata
): MessageBlockInput {
  return {
    blockId: blockId as never,
    type: "diagnostic",
    content,
    metadata: { ...metadata },
  };
}

function blocksWithDiagnostic(
  blocks: MessageBlockInput[] | undefined,
  diagnostic: MessageBlockInput
): MessageBlockInput[] {
  const existing = blocks ?? [];
  if (existing.some((block) => block.blockId === diagnostic.blockId)) return existing;
  return [...existing, diagnostic];
}

function upsertContentBlock(
  blocks: MessageBlockInput[] | undefined,
  blockId: string,
  type: "text" | "thinking",
  text: string,
  replace: boolean | undefined
): MessageBlockInput[] {
  const existing = blocks ?? [];
  const index = existing.findIndex((block) => block.blockId === blockId);
  if (index === -1) {
    return [...existing, { blockId: blockId as never, type, content: text }];
  }
  return existing.map((block, blockIndex) =>
    blockIndex === index
      ? { ...block, content: replace ? text : `${block.content ?? ""}${text}` }
      : block
  );
}

export function applyMessageEvent(
  messages: MessageMap,
  event: AgenticEvent<Extract<EventKind, `message.${string}`>>
): MessageMap {
  const messageId = requireMessageId(event);
  const existing = messages[messageId] ?? {
    messageId,
    actor: event.actor,
    role: event.actor.kind,
    status: "started" as const,
  };

  if (event.kind === "message.started") {
    const payload = event.payload;
    const role = ("role" in payload ? payload.role : undefined) ?? existing.role;
    const blocks = "blocks" in payload ? payload.blocks : existing.blocks;
    const mentions = "mentions" in payload ? payload.mentions : existing.mentions;
    const replyTo = "replyTo" in payload ? payload.replyTo : existing.replyTo;
    return {
      ...messages,
      [messageId]: {
        ...existing,
        actor: event.actor,
        turnId: existing.turnId ?? event.turnId,
        role,
        blocks,
        mentions,
        replyTo,
        status: "started",
        startedAt: event.createdAt,
        updatedAt: event.createdAt,
      },
    };
  }

  if (event.kind === "message.delta") {
    const payload = event.payload;
    const blockId = "blockId" in payload ? String(payload.blockId) : "";
    const type = "type" in payload ? payload.type : "text";
    const text = "text" in payload && typeof payload.text === "string" ? payload.text : "";
    const replace = "replace" in payload ? payload.replace : undefined;
    return {
      ...messages,
      [messageId]: {
        ...existing,
        actor: event.actor,
        turnId: existing.turnId ?? event.turnId,
        blocks: upsertContentBlock(existing.blocks, blockId, type, text, replace),
        status: "streaming",
        updatedAt: event.createdAt,
      },
    };
  }

  if (event.kind === "message.completed") {
    const payload = event.payload;
    const role = ("role" in payload ? payload.role : undefined) ?? existing.role;
    const outcome = "outcome" in payload ? payload.outcome : existing.outcome;
    let blocks = "blocks" in payload ? payload.blocks : existing.blocks;
    if (outcome === "empty") {
      blocks = blocksWithDiagnostic(
        blocks,
        diagnosticBlock(`${messageId}:diagnostic:empty`, "Assistant message had no visible content.", {
          code: "message_empty",
          severity: "warning",
          reason: "empty",
        })
      );
    }
    const mentions = "mentions" in payload ? payload.mentions : existing.mentions;
    const replyTo = "replyTo" in payload ? payload.replyTo : existing.replyTo;
    return {
      ...messages,
      [messageId]: {
        ...existing,
        actor: event.actor,
        turnId: existing.turnId ?? event.turnId,
        role,
        blocks,
        mentions,
        replyTo,
        status: "completed",
        outcome,
        completedAt: event.createdAt,
        updatedAt: event.createdAt,
        usage: "usage" in payload ? payload.usage : existing.usage,
      },
    };
  }

  return {
    ...messages,
    [messageId]: {
      ...existing,
      actor: event.actor,
      turnId: existing.turnId ?? event.turnId,
      status: "failed",
      blocks: blocksWithDiagnostic(
        existing.blocks,
        diagnosticBlock(
          `${messageId}:diagnostic:failed`,
          "reason" in event.payload ? event.payload.reason : "Assistant message failed.",
          {
            code: "message_failed",
            severity: "error",
            reason: "reason" in event.payload ? event.payload.reason : undefined,
            recoverable: "recoverable" in event.payload ? event.payload.recoverable : undefined,
          }
        )
      ),
      failedAt: event.createdAt,
      failureReason: "reason" in event.payload ? event.payload.reason : existing.failureReason,
      updatedAt: event.createdAt,
    },
  };
}

export function applyInvocationEvent(
  invocations: InvocationMap,
  event: AgenticEvent<Extract<EventKind, `invocation.${string}`>>
): InvocationMap {
  const invocationId = requireInvocationId(event);
  const existing = invocations[invocationId] ?? {
    invocationId,
    actor: event.actor,
    status: "started" as const,
    outputs: [],
    progress: [],
  };

  if (event.kind === "invocation.started") {
    if (isTerminalInvocationStatus(existing.status)) return invocations;
    const payload = event.payload;
    return {
      ...invocations,
      [invocationId]: {
        ...existing,
        transportCallId: existing.transportCallId ?? event.causality?.transportCallId,
        actor: existing.actor ?? event.actor,
        turnId: existing.turnId ?? event.turnId,
        name: existing.name ?? ("name" in payload ? payload.name : undefined),
        request: existing.request ?? ("request" in payload ? payload.request : undefined),
        requiresApproval:
          existing.requiresApproval ??
          ("requiresApproval" in payload ? payload.requiresApproval : undefined),
        userVisible:
          existing.userVisible === true
            ? true
            : "userVisible" in payload
              ? payload.userVisible
              : existing.userVisible,
        status: "started",
        startedAt: existing.startedAt ?? event.createdAt,
        updatedAt: event.createdAt,
      },
    };
  }

  if (event.kind === "invocation.progress") {
    if (isTerminalInvocationStatus(existing.status)) return invocations;
    const payload = event.payload;
    return {
      ...invocations,
      [invocationId]: {
        ...existing,
        transportCallId: existing.transportCallId ?? event.causality?.transportCallId,
        actor: event.actor,
        turnId: existing.turnId ?? event.turnId,
        status: "running",
        updatedAt: event.createdAt,
        progress: [
          ...existing.progress,
          {
            at: event.createdAt,
            message: "message" in payload ? payload.message : undefined,
            progress: "progress" in payload ? payload.progress : undefined,
            data: "data" in payload ? payload.data : undefined,
          },
        ],
      },
    };
  }

  if (event.kind === "invocation.output") {
    if (isTerminalInvocationStatus(existing.status)) return invocations;
    const payload = event.payload;
    return {
      ...invocations,
      [invocationId]: {
        ...existing,
        transportCallId: existing.transportCallId ?? event.causality?.transportCallId,
        actor: event.actor,
        turnId: existing.turnId ?? event.turnId,
        status: "running",
        updatedAt: event.createdAt,
        outputs: [...existing.outputs, "output" in payload ? payload.output : payload],
      },
    };
  }

  if (event.kind === "invocation.completed") {
    if (isTerminalInvocationStatus(existing.status)) return invocations;
    const payload = event.payload;
    const result = "result" in payload ? payload.result : undefined;
    const inferred = inferInvocationMetadata(result);
    return {
      ...invocations,
      [invocationId]: {
        ...existing,
        transportCallId: existing.transportCallId ?? event.causality?.transportCallId,
        actor: existing.actor ?? event.actor,
        turnId: existing.turnId ?? event.turnId,
        name: existing.name ?? inferred.name,
        request: existing.request ?? inferred.request,
        status: "completed",
        result,
        terminalReason: "summary" in payload ? payload.summary : existing.terminalReason,
        terminalOutcome:
          "terminalOutcome" in payload ? payload.terminalOutcome : existing.terminalOutcome,
        terminalReasonCode:
          "terminalReasonCode" in payload
            ? payload.terminalReasonCode
            : existing.terminalReasonCode,
        completedAt: event.createdAt,
        updatedAt: event.createdAt,
      },
    };
  }

  const payload = event.payload;
  if (isTerminalInvocationStatus(existing.status)) return invocations;
  const result = "error" in payload ? payload.error : undefined;
  const inferred = inferInvocationMetadata(result);
  return {
    ...invocations,
    [invocationId]: {
      ...existing,
      transportCallId: existing.transportCallId ?? event.causality?.transportCallId,
      actor: existing.actor ?? event.actor,
      turnId: existing.turnId ?? event.turnId,
      name: existing.name ?? inferred.name,
      request: existing.request ?? inferred.request,
      status: event.kind.replace("invocation.", "") as InvocationStatus,
      completedAt: event.createdAt,
      updatedAt: event.createdAt,
      result,
      terminalReason: "reason" in payload ? payload.reason : undefined,
      terminalOutcome:
        "terminalOutcome" in payload ? payload.terminalOutcome : existing.terminalOutcome,
      terminalReasonCode:
        "terminalReasonCode" in payload ? payload.terminalReasonCode : existing.terminalReasonCode,
    },
  };
}

function inferInvocationMetadata(value: unknown): { name?: string; request?: unknown } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const record = value as Record<string, unknown>;
  const name =
    typeof record["toolName"] === "string"
      ? record["toolName"]
      : typeof record["name"] === "string"
        ? record["name"]
        : undefined;
  let request: unknown;
  const details = record["details"];
  if (details && typeof details === "object" && !Array.isArray(details)) {
    const detailsRecord = details as Record<string, unknown>;
    request = detailsRecord["input"] ?? detailsRecord["args"] ?? detailsRecord["arguments"];
  }
  return { name, request };
}

export function applyApprovalEvent(
  approvals: ApprovalMap,
  event: AgenticEvent<Extract<EventKind, `approval.${string}`>>
): ApprovalMap {
  const approvalId = requireApprovalId(event);
  const existing = approvals[approvalId] ?? {
    approvalId,
    invocationId: event.causality?.invocationId,
    actor: event.actor,
    status: "requested" as const,
  };

  if (event.kind === "approval.requested") {
    const payload = event.payload;
    return {
      ...approvals,
      [approvalId]: {
        ...existing,
        actor: event.actor,
        question: "question" in payload ? payload.question : existing.question,
        status: "requested",
        requestedAt: event.createdAt,
        updatedAt: event.createdAt,
      },
    };
  }

  const payload = event.payload;
  const granted = "granted" in payload ? payload.granted : false;
  return {
    ...approvals,
    [approvalId]: {
      ...existing,
      actor: event.actor,
      granted,
      status: granted ? "granted" : "denied",
      reason: "reason" in payload ? payload.reason : undefined,
      resolvedAt: event.createdAt,
      updatedAt: event.createdAt,
    },
  };
}

export function applyUiEvent(
  inlineUi: InlineUiMap,
  actionBar: ProjectedActionBar | undefined,
  event: AgenticEvent<Extract<EventKind, `ui.${string}`>>
): { inlineUi: InlineUiMap; actionBar?: ProjectedActionBar } {
  const payload = event.payload;
  if (event.kind === "ui.inline_rendered" && payload.uiType === "inline") {
    const item: ProjectedInlineUi = {
      id: payload.id,
      turnId: event.turnId,
      actor: event.actor,
      source: payload.source,
      renderedAt: event.createdAt,
    };
    if (payload.imports !== undefined) item.imports = payload.imports;
    if (payload.props !== undefined) item.props = payload.props;
    return {
      inlineUi: {
        ...inlineUi,
        [payload.id]: item,
      },
      actionBar,
    };
  }
  if (event.kind === "ui.action_bar.updated" && payload.uiType === "action_bar") {
    const nextActionBar: ProjectedActionBar = {
      actor: event.actor,
      updatedAt: event.createdAt,
    };
    if (payload.id !== undefined) nextActionBar.id = payload.id;
    if (payload.source !== undefined) nextActionBar.source = payload.source;
    if (payload.imports !== undefined) nextActionBar.imports = payload.imports;
    if (payload.props !== undefined) nextActionBar.props = payload.props;
    if (payload.maxHeight !== undefined) nextActionBar.maxHeight = payload.maxHeight;
    if (payload.cleared !== undefined) nextActionBar.cleared = payload.cleared;
    if (payload.result !== undefined) nextActionBar.result = payload.result;
    return {
      inlineUi,
      actionBar: nextActionBar,
    };
  }
  return { inlineUi, actionBar };
}

export function participantKey(participant: ParticipantRef | ActorRef): string {
  return "participantId" in participant && participant.participantId
    ? participant.participantId
    : `${participant.kind}:${participant.id}`;
}
