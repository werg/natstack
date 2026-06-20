import { z } from "zod";
import {
  AGENTIC_EVENT_PAYLOAD_KIND,
  AGENTIC_PROTOCOL_VERSION,
  INVOCATION_OUTCOMES,
  MESSAGE_OUTCOMES,
  MESSAGE_TIERS,
  TURN_REASON_CODES,
  TURN_SCOPED_OWNER_KINDS,
  validateInvocationTerminalOutcomeForKind,
} from "./constants.js";

const protocolSchema = z.literal(AGENTIC_PROTOCOL_VERSION);

const idSchema = z.string().min(1);
const isoDateSchema = z.string().datetime({ offset: true });

export const actorRefSchema = z
  .object({
    kind: z.enum(["user", "agent", "system", "panel", "external"]),
    id: z.string().min(1),
    displayName: z.string().optional(),
    metadata: z.record(z.unknown()).optional(),
  })
  .passthrough();

export const participantRefSchema = actorRefSchema.extend({
  participantId: z.string().min(1).optional(),
});

export const participantSelectorSchema = z
  .object({
    kind: z.enum(["all", "role", "participant"]),
    role: z.string().min(1).optional(),
    participantId: z.string().min(1).optional(),
  })
  .strict();

export const causalitySchema = z
  .object({
    parentEventId: idSchema.optional(),
    messageId: idSchema.optional(),
    blockId: idSchema.optional(),
    invocationId: idSchema.optional(),
    transportCallId: z.string().optional(),
    approvalId: idSchema.optional(),
    modelToolCallId: z.string().optional(),
    agentHops: z.number().int().nonnegative().optional(),
    /** Originating model attempt (WS1 §1.9) — the duplicate-dispatch guard. */
    attemptId: z.string().optional(),
  })
  .strict();

const usagePayloadSchema = z
  .object({
    inputTokens: z.number().int().nonnegative().optional(),
    outputTokens: z.number().int().nonnegative().optional(),
    totalTokens: z.number().int().nonnegative().optional(),
    costUsd: z.number().nonnegative().optional(),
    metadata: z.record(z.unknown()).optional(),
  })
  .strict();

const blobRefSchema = z
  .object({
    protocol: z.literal("natstack.blob-ref.v1"),
    digest: z.string().min(1),
    size: z.number().int().nonnegative(),
    encoding: z.enum(["json", "text"]),
    originalBytes: z.number().int().nonnegative(),
  })
  .strict();

const blockBaseShape = {
  blockId: idSchema.optional(),
  metadata: z.record(z.unknown()).optional(),
};
const messageBlockInputSchema = z.discriminatedUnion("type", [
  z.object({ ...blockBaseShape, type: z.literal("text"), content: z.string() }).strict(),
  z.object({ ...blockBaseShape, type: z.literal("thinking"), content: z.string() }).strict(),
  z
    .object({ ...blockBaseShape, type: z.literal("invocation"), invocationId: idSchema, content: z.string().optional() })
    .strict(),
  z.object({ ...blockBaseShape, type: z.literal("attachment"), content: z.string().optional() }).strict(),
  z.object({ ...blockBaseShape, type: z.literal("data"), content: z.string().optional() }).strict(),
  z.object({ ...blockBaseShape, type: z.literal("diagnostic"), content: z.string() }).strict(),
]);

const messageStartedPayloadSchema = z
  .object({
    protocol: protocolSchema,
    role: z.enum(["user", "assistant", "system", "tool", "panel"]),
    blocks: z.array(messageBlockInputSchema).optional(),
    mentions: z.array(idSchema).optional(),
    replyTo: idSchema.optional(),
    to: z.array(participantSelectorSchema).optional(),
    tier: z.enum(MESSAGE_TIERS).optional(),
  })
  .strict();

const messageDeltaPayloadSchema = z
  .object({
    protocol: protocolSchema,
    blockId: idSchema,
    type: z.enum(["text", "thinking"]),
    text: z.string(),
    replace: z.boolean().optional(),
  })
  .strict();

const messageCompletedPayloadSchema = z
  .object({
    protocol: protocolSchema,
    role: z.enum(["user", "assistant", "system", "tool", "panel"]).optional(),
    blocks: z.array(messageBlockInputSchema).optional(),
    outcome: z.enum(MESSAGE_OUTCOMES),
    usage: usagePayloadSchema.optional(),
    mentions: z.array(idSchema).optional(),
    replyTo: idSchema.optional(),
    to: z.array(participantSelectorSchema).optional(),
    tier: z.enum(MESSAGE_TIERS).optional(),
  })
  .strict();

const failurePayloadSchema = z
  .object({
    protocol: protocolSchema,
    reason: z.string().min(1),
    error: z.unknown().optional(),
    recoverable: z.boolean().optional(),
    code: z.string().min(1).optional(),
    resetAt: isoDateSchema.optional(),
    retryAfterMs: z.number().nonnegative().optional(),
  })
  .strict();

const invocationOutcomeSchema = z.enum(INVOCATION_OUTCOMES);

const invocationFailurePayloadSchema = failurePayloadSchema
  .extend({
    terminalOutcome: invocationOutcomeSchema.exclude(["success"]),
    terminalReasonCode: z.string().optional(),
  })
  .strict();

const invocationTransportSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("local"), awaiterId: z.string().min(1) }).strict(),
  z
    .object({
      kind: z.literal("channel"),
      channelId: idSchema,
      target: participantRefSchema,
      transportCallId: z.string().optional(),
      deadlineAt: z.number().int().positive().optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("http"),
      targetUrl: z.string().url(),
      idempotencyKey: z.string().min(1),
    })
    .strict(),
]);

const invocationStartedPayloadSchema = z
  .object({
    protocol: protocolSchema,
    name: z.string().min(1),
    invocationType: z.enum(["tool", "panel", "agent", "user", "http", "system"]).optional(),
    request: z.unknown().optional(),
    transport: invocationTransportSchema.optional(),
    requiresApproval: z.boolean().optional(),
    userVisible: z.boolean().optional(),
    summary: z.string().optional(),
  })
  .strict();

const invocationProgressPayloadSchema = z
  .object({
    protocol: protocolSchema,
    message: z.string().optional(),
    progress: z.number().min(0).max(1).optional(),
    data: z.unknown().optional(),
  })
  .strict();

const invocationOutputPayloadSchema = z
  .object({
    protocol: protocolSchema,
    output: z.unknown(),
    channel: z.enum(["stdout", "stderr", "data"]).optional(),
  })
  .strict();

const invocationCompletedPayloadSchema = z
  .object({
    protocol: protocolSchema,
    result: z.unknown().optional(),
    usage: usagePayloadSchema.optional(),
    summary: z.string().optional(),
    terminalOutcome: z.literal("success"),
    terminalReasonCode: z.string().optional(),
  })
  .strict();

const approvalRequestedPayloadSchema = z
  .object({
    protocol: protocolSchema,
    question: z.string().min(1),
    requestedBy: actorRefSchema.optional(),
    approver: z.union([participantRefSchema, participantSelectorSchema]).optional(),
    details: z.unknown().optional(),
  })
  .strict();

const approvalResolvedPayloadSchema = z
  .object({
    protocol: protocolSchema,
    granted: z.boolean(),
    resolvedBy: actorRefSchema,
    reason: z.string().optional(),
    details: z.unknown().optional(),
  })
  .strict();

const sandboxSourceSchema = z.union([
  blobRefSchema,
  z.discriminatedUnion("type", [
    z.object({ type: z.literal("code"), code: z.string() }).strict(),
    z.object({ type: z.literal("file"), path: z.string().min(1) }).strict(),
  ]),
]);

const uiInlineRenderedPayloadSchema = z
  .object({
    protocol: protocolSchema,
    uiType: z.literal("inline"),
    id: z.string().min(1),
    source: sandboxSourceSchema,
    imports: z.record(z.string()).optional(),
    props: z.record(z.unknown()).optional(),
  })
  .strict();

const uiActionBarUpdatedPayloadSchema = z
  .object({
    protocol: protocolSchema,
    uiType: z.literal("action_bar"),
    id: z.string().min(1).optional(),
    source: sandboxSourceSchema.optional(),
    imports: z.record(z.string()).optional(),
    props: z.record(z.unknown()).optional(),
    maxHeight: z.number().optional(),
    cleared: z.boolean().optional(),
    result: z
      .object({
        ok: z.boolean(),
        error: z.string().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

const customMessageDisplayModeSchema = z.enum(["inline", "row"]);

const messageTypeRegisteredPayloadSchema = z
  .object({
    protocol: protocolSchema,
    typeId: z.string().min(1),
    displayMode: customMessageDisplayModeSchema,
    source: sandboxSourceSchema,
    imports: z.record(z.string()).optional(),
    stateSchema: z.record(z.unknown()).optional(),
    updateSchema: z.record(z.unknown()).optional(),
    registeredBy: actorRefSchema.optional(),
  })
  .strict();

const messageTypeClearedPayloadSchema = z
  .object({
    protocol: protocolSchema,
    typeId: z.string().min(1),
  })
  .strict();

const customStartedPayloadSchema = z
  .object({
    protocol: protocolSchema,
    messageId: idSchema,
    typeId: z.string().min(1),
    displayMode: customMessageDisplayModeSchema.optional(),
    initialState: z.unknown().optional(),
    by: actorRefSchema.optional(),
  })
  .strict();

const customUpdatedPayloadSchema = z
  .object({
    protocol: protocolSchema,
    messageId: idSchema,
    update: z.unknown(),
    status: z.literal("failed").optional(),
    error: z
      .object({ message: z.string().min(1), details: z.unknown().optional() })
      .strict()
      .optional(),
  })
  .strict();

const uiFeedbackPayloadSchema = z
  .object({
    protocol: protocolSchema,
    target: participantRefSchema,
    category: z.enum([
      "render_failed",
      "state_invalid",
      "type_not_registered",
      "method_call_failed",
      "suspension_timeout",
      "load_stalled",
    ]),
    refs: z
      .object({
        messageId: idSchema.optional(),
        typeId: z.string().optional(),
        callId: z.string().optional(),
        turnId: idSchema.optional(),
      })
      .strict()
      .optional(),
    error: z
      .object({
        name: z.string().optional(),
        message: z.string().min(1),
        stack: z.string().optional(),
        componentStack: z.string().optional(),
      })
      .strict(),
    occurrenceKey: z.string().min(1),
  })
  .strict();

const externalEnvelopePublishedPayloadSchema = z
  .object({
    protocol: protocolSchema,
    publications: z
      .array(
        z
          .object({
            channelId: idSchema,
            envelopeId: idSchema,
            payloadKind: z.string().optional(),
            eventId: idSchema.optional(),
            summary: z.string().optional(),
          })
          .strict()
      )
      .min(1),
  })
  .strict();

const externalEnvelopeObservedPayloadSchema = z
  .object({
    protocol: protocolSchema,
    channelId: idSchema,
    envelopeId: idSchema,
    from: participantRefSchema,
    payloadKind: z.string().optional(),
    body: z.unknown().optional(),
  })
  .strict();

const externalParticipantObservedPayloadSchema = z
  .object({
    protocol: protocolSchema,
    channelId: idSchema,
    participant: participantRefSchema,
    action: z.enum(["joined", "left", "updated"]),
    roles: z.array(z.string()).optional(),
  })
  .strict();

const statePayloadSchema = z
  .object({
    protocol: protocolSchema,
    mutationId: z.string().optional(),
    observationId: z.string().optional(),
    path: z.string().optional(),
    paths: z.array(z.string()).optional(),
    operation: z.string().optional(),
    diff: z.string().optional(),
    inputStateHash: idSchema.optional(),
    outputStateHash: idSchema.optional(),
    parentStateHashes: z.array(z.string()).optional(),
    files: z
      .array(
        z
          .object({
            path: z.string(),
            contentHash: z.string(),
            size: z.number().optional(),
            mode: z.number().optional(),
          })
          .strict()
      )
      .optional(),
    stateHash: idSchema.optional(),
    invocationId: idSchema.optional(),
    contentHash: z.string().optional(),
    beforeHash: z.string().optional(),
    afterHash: z.string().optional(),
    hunks: z.array(z.unknown()).optional(),
    size: z.number().optional(),
    mimeType: z.string().optional(),
    summary: z.string().optional(),
    error: z.string().optional(),
    rationale: z.string().optional(),
    metadata: z.record(z.unknown()).optional(),
  })
  .strict();

const branchPayloadSchema = z
  .object({
    protocol: protocolSchema,
    branchId: idSchema.optional(),
    parentBranchId: idSchema.optional(),
    headEventId: idSchema.optional(),
    headStateHash: idSchema.optional(),
    forkEventId: idSchema.optional(),
    name: z.string().optional(),
  })
  .strict();

const turnPayloadSchema = z
  .object({
    protocol: protocolSchema,
    summary: z.string().optional(),
    reason: z.enum(TURN_REASON_CODES).optional(),
  })
  .strict();

const systemPayloadSchema = z
  .object({
    protocol: protocolSchema,
    kind: z.string().optional(),
    summary: z.string().optional(),
    details: z.unknown().optional(),
  })
  .strict();

const compactionPayloadSchema = z
  .object({
    protocol: protocolSchema,
    summary: z.string().min(1),
    rangeStart: idSchema,
    rangeEnd: idSchema,
    replacement: z.unknown().optional(),
  })
  .strict();

const memoryRecalledPayloadSchema = z
  .object({
    protocol: protocolSchema,
    query: z.string(),
    results: z.unknown().optional(),
    anchors: z.array(z.unknown()).optional(),
    metadata: z.record(z.unknown()).optional(),
  })
  .strict();

const buildCompletedPayloadSchema = z
  .object({
    protocol: protocolSchema,
    inputStateHash: z.string(),
    subtree: z.string().optional(),
    evHash: z.string().optional(),
    artifactRefs: z.unknown().optional(),
    diagnostics: z.unknown().optional(),
    metadata: z.record(z.unknown()).optional(),
  })
  .strict();

const knowledgePayloadSchema = z
  .object({
    protocol: protocolSchema,
    id: z.string().optional(),
    subject: z.string().optional(),
    predicate: z.string().optional(),
    object: z.string().optional(),
    claimId: z.string().optional(),
    theoryId: z.string().optional(),
    contradictionId: z.string().optional(),
    status: z.string().optional(),
    body: z.unknown().optional(),
    metadata: z.record(z.unknown()).optional(),
  })
  .strict();

function eventSchema<K extends string, P extends z.ZodTypeAny>(kind: K, payload: P) {
  return z
    .object({
      kind: z.literal(kind),
      actor: actorRefSchema,
      turnId: idSchema.optional(),
      causality: causalitySchema.optional(),
      payload,
      createdAt: isoDateSchema,
    })
    .strict();
}

export const eventKindSchemas = {
  "message.started": eventSchema("message.started", messageStartedPayloadSchema),
  "message.delta": eventSchema("message.delta", messageDeltaPayloadSchema),
  "message.completed": eventSchema("message.completed", messageCompletedPayloadSchema),
  "message.failed": eventSchema("message.failed", failurePayloadSchema),
  "invocation.started": eventSchema("invocation.started", invocationStartedPayloadSchema),
  "invocation.progress": eventSchema("invocation.progress", invocationProgressPayloadSchema),
  "invocation.output": eventSchema("invocation.output", invocationOutputPayloadSchema),
  "invocation.completed": eventSchema("invocation.completed", invocationCompletedPayloadSchema),
  "invocation.failed": eventSchema("invocation.failed", invocationFailurePayloadSchema),
  "invocation.cancelled": eventSchema("invocation.cancelled", invocationFailurePayloadSchema),
  "invocation.abandoned": eventSchema("invocation.abandoned", invocationFailurePayloadSchema),
  "approval.requested": eventSchema("approval.requested", approvalRequestedPayloadSchema),
  "approval.resolved": eventSchema("approval.resolved", approvalResolvedPayloadSchema),
  "ui.inline_rendered": eventSchema("ui.inline_rendered", uiInlineRenderedPayloadSchema),
  "ui.action_bar.updated": eventSchema("ui.action_bar.updated", uiActionBarUpdatedPayloadSchema),
  "ui.feedback": eventSchema("ui.feedback", uiFeedbackPayloadSchema),
  "messageType.registered": eventSchema(
    "messageType.registered",
    messageTypeRegisteredPayloadSchema
  ),
  "messageType.cleared": eventSchema("messageType.cleared", messageTypeClearedPayloadSchema),
  "custom.started": eventSchema("custom.started", customStartedPayloadSchema),
  "custom.updated": eventSchema("custom.updated", customUpdatedPayloadSchema),
  "state.file_observed": eventSchema("state.file_observed", statePayloadSchema),
  "state.file_mutation_intended": eventSchema("state.file_mutation_intended", statePayloadSchema),
  "state.file_mutation_applied": eventSchema("state.file_mutation_applied", statePayloadSchema),
  "state.transition_recorded": eventSchema("state.transition_recorded", statePayloadSchema),
  "state.snapshot_ingested": eventSchema("state.snapshot_ingested", statePayloadSchema),
  "state.merge_applied": eventSchema("state.merge_applied", statePayloadSchema),
  "memory.recalled": eventSchema("memory.recalled", memoryRecalledPayloadSchema),
  "build.completed": eventSchema("build.completed", buildCompletedPayloadSchema),
  "external.envelope_published": eventSchema(
    "external.envelope_published",
    externalEnvelopePublishedPayloadSchema
  ),
  "external.envelope_observed": eventSchema(
    "external.envelope_observed",
    externalEnvelopeObservedPayloadSchema
  ),
  "external.participant_observed": eventSchema(
    "external.participant_observed",
    externalParticipantObservedPayloadSchema
  ),
  "branch.created": eventSchema("branch.created", branchPayloadSchema),
  "branch.forked": eventSchema("branch.forked", branchPayloadSchema),
  "branch.head_changed": eventSchema("branch.head_changed", branchPayloadSchema),
  "turn.opened": eventSchema("turn.opened", turnPayloadSchema),
  "turn.waiting": eventSchema("turn.waiting", turnPayloadSchema),
  "turn.closed": eventSchema("turn.closed", turnPayloadSchema),
  "system.event": eventSchema("system.event", systemPayloadSchema),
  "system.compaction_recorded": eventSchema("system.compaction_recorded", compactionPayloadSchema),
  "knowledge.claim_recorded": eventSchema("knowledge.claim_recorded", knowledgePayloadSchema),
  "knowledge.claim_updated": eventSchema("knowledge.claim_updated", knowledgePayloadSchema),
  "knowledge.claim_retracted": eventSchema("knowledge.claim_retracted", knowledgePayloadSchema),
  "knowledge.theory_proposed": eventSchema("knowledge.theory_proposed", knowledgePayloadSchema),
  "knowledge.theory_versioned": eventSchema("knowledge.theory_versioned", knowledgePayloadSchema),
  "knowledge.theory_superseded": eventSchema("knowledge.theory_superseded", knowledgePayloadSchema),
  "knowledge.claim_edge_added": eventSchema("knowledge.claim_edge_added", knowledgePayloadSchema),
  "knowledge.claim_edge_removed": eventSchema(
    "knowledge.claim_edge_removed",
    knowledgePayloadSchema
  ),
  "knowledge.contradiction_recorded": eventSchema(
    "knowledge.contradiction_recorded",
    knowledgePayloadSchema
  ),
  "knowledge.contradiction_resolved": eventSchema(
    "knowledge.contradiction_resolved",
    knowledgePayloadSchema
  ),
} as const;

export const agenticEventSchema = z
  .discriminatedUnion(
    "kind",
    Object.values(eventKindSchemas) as [
      (typeof eventKindSchemas)["message.started"],
      (typeof eventKindSchemas)["message.delta"],
      ...Array<(typeof eventKindSchemas)[keyof typeof eventKindSchemas]>,
    ]
  )
  .superRefine((event, ctx) => {
    const causality = event.causality;
    if (event.kind.startsWith("message.") && !causality?.messageId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["causality", "messageId"],
        message: "message events require causality.messageId",
      });
    }
    if (event.kind.startsWith("invocation.") && !causality?.invocationId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["causality", "invocationId"],
        message: "invocation events require causality.invocationId",
      });
    }
    if (
      event.kind === "invocation.completed" ||
      event.kind === "invocation.failed" ||
      event.kind === "invocation.cancelled" ||
      event.kind === "invocation.abandoned"
    ) {
      const result = validateInvocationTerminalOutcomeForKind(
        event.kind,
        (event.payload as { terminalOutcome?: unknown }).terminalOutcome
      );
      if (!result.valid) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["payload", "terminalOutcome"],
          message: result.message,
        });
      }
    }
    if (event.kind.startsWith("approval.") && !causality?.approvalId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["causality", "approvalId"],
        message: "approval events require causality.approvalId",
      });
    }
    if (
      event.kind === "approval.resolved" &&
      "details" in event.payload &&
      causality?.invocationId === ""
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["causality", "invocationId"],
        message: "causality.invocationId cannot be empty",
      });
    }
  });

const storedEventKindSchema = z.enum(
  Object.keys(eventKindSchemas) as [
    keyof typeof eventKindSchemas,
    ...(keyof typeof eventKindSchemas)[],
  ]
);

const storedPayloadObjectSchema = z
  .object({
    protocol: protocolSchema,
  })
  .passthrough();

const storedEventPayloadSchema = z.union([blobRefSchema, storedPayloadObjectSchema]);

function storedPayloadRecord(payload: unknown): Record<string, unknown> | null {
  return payload &&
    typeof payload === "object" &&
    !Array.isArray(payload) &&
    !blobRefSchema.safeParse(payload).success
    ? (payload as Record<string, unknown>)
    : null;
}

function requireStoredPayloadField(
  payload: Record<string, unknown> | null,
  ctx: z.RefinementCtx,
  field: string,
  check: (value: unknown) => boolean,
  message: string
): void {
  if (!payload) return;
  if (check(payload[field])) return;
  ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["payload", field], message });
}

export const storedAgenticEventSchema = z
  .object({
    kind: storedEventKindSchema,
    actor: actorRefSchema,
    payload: storedEventPayloadSchema,
    createdAt: isoDateSchema,
    turnId: idSchema.optional(),
    causality: causalitySchema.optional(),
  })
  .passthrough()
  .superRefine((event, ctx) => {
    const causality = event.causality;
    const payload = storedPayloadRecord(event.payload);
    if (event.kind.startsWith("message.") && !causality?.messageId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["causality", "messageId"],
        message: "message events require causality.messageId",
      });
    }
    if (event.kind.startsWith("invocation.") && !causality?.invocationId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["causality", "invocationId"],
        message: "invocation events require causality.invocationId",
      });
    }
    if (
      event.kind === "invocation.completed" ||
      event.kind === "invocation.failed" ||
      event.kind === "invocation.cancelled" ||
      event.kind === "invocation.abandoned"
    ) {
      const result = validateInvocationTerminalOutcomeForKind(
        event.kind,
        payload?.["terminalOutcome"]
      );
      if (!result.valid) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["payload", "terminalOutcome"],
          message: result.message,
        });
      }
    }
    if (event.kind.startsWith("approval.") && !causality?.approvalId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["causality", "approvalId"],
        message: "approval events require causality.approvalId",
      });
    }
    if (event.kind === "message.started") {
      requireStoredPayloadField(
        payload,
        ctx,
        "role",
        (value) =>
          value === "user" ||
          value === "assistant" ||
          value === "system" ||
          value === "tool" ||
          value === "panel",
        "message.started requires payload.role"
      );
    } else if (event.kind === "message.delta") {
      requireStoredPayloadField(
        payload,
        ctx,
        "blockId",
        (value) => typeof value === "string",
        "message.delta requires payload.blockId"
      );
      requireStoredPayloadField(
        payload,
        ctx,
        "type",
        (value) => value === "text" || value === "thinking",
        "message.delta requires payload.type of 'text' or 'thinking'"
      );
      requireStoredPayloadField(
        payload,
        ctx,
        "text",
        (value) => typeof value === "string" || blobRefSchema.safeParse(value).success,
        "message.delta requires payload.text"
      );
    } else if (event.kind === "message.completed") {
      requireStoredPayloadField(
        payload,
        ctx,
        "outcome",
        (value) => MESSAGE_OUTCOMES.includes(value as never),
        "message.completed requires payload.outcome"
      );
    } else if (event.kind === "invocation.started") {
      requireStoredPayloadField(
        payload,
        ctx,
        "name",
        (value) => typeof value === "string" && value.length > 0,
        "invocation.started requires payload.name"
      );
    } else if (event.kind === "approval.requested") {
      requireStoredPayloadField(
        payload,
        ctx,
        "question",
        (value) => typeof value === "string" && value.length > 0,
        "approval.requested requires payload.question"
      );
    } else if (event.kind === "approval.resolved") {
      requireStoredPayloadField(
        payload,
        ctx,
        "granted",
        (value) => typeof value === "boolean",
        "approval.resolved requires payload.granted"
      );
      requireStoredPayloadField(
        payload,
        ctx,
        "resolvedBy",
        (value) => actorRefSchema.safeParse(value).success,
        "approval.resolved requires payload.resolvedBy"
      );
    } else if (event.kind === "ui.inline_rendered") {
      requireStoredPayloadField(
        payload,
        ctx,
        "uiType",
        (value) => value === "inline",
        "ui.inline_rendered requires payload.uiType"
      );
      requireStoredPayloadField(
        payload,
        ctx,
        "id",
        (value) => typeof value === "string" && value.length > 0,
        "ui.inline_rendered requires payload.id"
      );
      requireStoredPayloadField(
        payload,
        ctx,
        "source",
        (value) => sandboxSourceSchema.safeParse(value).success,
        "ui.inline_rendered requires payload.source"
      );
    } else if (event.kind === "ui.feedback") {
      requireStoredPayloadField(
        payload,
        ctx,
        "target",
        (value) => participantRefSchema.safeParse(value).success,
        "ui.feedback requires payload.target"
      );
      requireStoredPayloadField(
        payload,
        ctx,
        "occurrenceKey",
        (value) => typeof value === "string" && value.length > 0,
        "ui.feedback requires payload.occurrenceKey"
      );
    } else if (event.kind === "custom.started" || event.kind === "custom.updated") {
      requireStoredPayloadField(
        payload,
        ctx,
        "messageId",
        (value) => typeof value === "string" && value.length > 0,
        `${event.kind} requires payload.messageId`
      );
    } else if (event.kind === "external.envelope_published") {
      requireStoredPayloadField(
        payload,
        ctx,
        "publications",
        (value) => Array.isArray(value) && value.length > 0,
        "external.envelope_published requires payload.publications"
      );
    } else if (event.kind === "system.compaction_recorded") {
      requireStoredPayloadField(
        payload,
        ctx,
        "summary",
        (value) => typeof value === "string" && value.length > 0,
        "system.compaction_recorded requires payload.summary"
      );
    }
  });

const trajectoryStorageSchema = z
  .object({
    eventId: idSchema,
    trajectoryId: idSchema,
    branchId: idSchema,
    seq: z.number().int().nonnegative(),
    prevEventHash: z.string().min(1),
    eventHash: z.string().min(1),
  })
  .passthrough();

function addIssues(ctx: z.RefinementCtx, issues: z.ZodIssue[]): void {
  for (const issue of issues) ctx.addIssue(issue);
}

function stripTrajectoryStorage(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  const {
    eventId: _eventId,
    trajectoryId: _trajectoryId,
    branchId: _branchId,
    seq: _seq,
    prevEventHash: _prevEventHash,
    eventHash: _eventHash,
    ...event
  } = value as Record<string, unknown>;
  return event;
}

export const trajectoryEventSchema = z
  .custom<Record<string, unknown>>(
    (value) => !!value && typeof value === "object" && !Array.isArray(value),
    "trajectory event must be an object"
  )
  .superRefine((value, ctx) => {
    const storageResult = trajectoryStorageSchema.safeParse(value);
    if (!storageResult.success) addIssues(ctx, storageResult.error.issues);

    const eventResult = storedAgenticEventSchema.safeParse(stripTrajectoryStorage(value));
    if (!eventResult.success) {
      addIssues(ctx, eventResult.error.issues);
      return;
    }

    const event = eventResult.data;
    if (
      event.actor.kind === "agent" &&
      TURN_SCOPED_OWNER_KINDS.includes(event.kind as (typeof TURN_SCOPED_OWNER_KINDS)[number]) &&
      !event.turnId
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["turnId"],
        message: "owner-authored turn-scoped trajectory events require turnId",
      });
    }
  });

export const channelEnvelopeSchema = z
  .object({
    envelopeId: idSchema,
    channelId: idSchema,
    seq: z.number().int().nonnegative(),
    from: participantRefSchema,
    to: z.union([z.array(participantRefSchema), participantSelectorSchema]).optional(),
    payload: z.unknown(),
    payloadKind: z.string().optional(),
    metadata: z.record(z.unknown()).optional(),
    attachments: z.array(z.unknown()).optional(),
    annotations: z.record(z.unknown()).optional(),
    publishedAt: isoDateSchema,
  })
  .strict();

export const agenticEventEnvelopeSchema = channelEnvelopeSchema.extend({
  payloadKind: z.literal(AGENTIC_EVENT_PAYLOAD_KIND),
  payload: storedAgenticEventSchema,
});

export const ephemeralSignalSchema = z
  .object({
    channelId: idSchema,
    from: participantRefSchema,
    kind: z.enum(["typing", "presence", "cursor", "custom"]),
    payload: z.unknown().optional(),
    emittedAt: isoDateSchema,
  })
  .strict();
