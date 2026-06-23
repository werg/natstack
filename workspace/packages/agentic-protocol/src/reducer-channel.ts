import { AGENTIC_EVENT_PAYLOAD_KIND, CREDENTIAL_CONNECT_PAYLOAD_KIND } from "./constants.js";
import type {
  ActorRef,
  AgenticEvent,
  CustomStartedPayload,
  CustomUpdatedPayload,
  CustomMessageDisplayMode,
  MessageTypeClearedPayload,
  MessageTypeRegisteredPayload,
  SandboxSourcePayload,
} from "./events.js";
import type { ChannelEnvelope, ChannelRosterEntry } from "./envelopes.js";
import type {
  ApprovalMap,
  InlineUiMap,
  InvocationMap,
  MessageMap,
  ProjectedActionBar,
  TurnMap,
} from "./handlers.js";
import {
  applyApprovalEvent,
  applyInvocationEvent,
  applyMessageEvent,
  applyUiEvent,
  participantKey,
  resolveIntendedRecipients,
} from "./handlers.js";
import { agenticEventEnvelopeSchema } from "./schemas.js";
import { assertNoStoredValueRefs } from "./stored-values.js";

export interface ChannelTimelineEntry {
  envelopeId: string;
  seq: number;
  participantId: string;
  kind: string;
  createdAt: string;
}

export interface ProjectedMessageTypeDefinition {
  typeId: string;
  displayMode?: CustomMessageDisplayMode;
  source?: SandboxSourcePayload;
  imports?: Record<string, string>;
  stateSchema?: Record<string, unknown>;
  updateSchema?: Record<string, unknown>;
  registeredBy?: ActorRef;
  updatedAtSeq: number;
  clearedAtSeq?: number;
}

export interface ProjectedCustomMessageUpdate {
  update: unknown;
  seq: number;
}

export interface ProjectedCustomMessage {
  messageId: string;
  typeId?: string;
  displayMode?: CustomMessageDisplayMode;
  initialState?: unknown;
  by?: ActorRef;
  startedAtSeq?: number;
  startedAt?: string;
  updatedAt?: string;
  updates: ProjectedCustomMessageUpdate[];
  lastSeq: number;
  /** Set when the owner published a terminal failure for this card. */
  failed?: true;
  error?: { message: string; details?: unknown };
}

/** An unresolved model-credential connect request (one per credKey). */
export interface ProjectedCredentialRequest {
  credKey: string;
  providerId: string;
  /** Connect-preset props for the credential card (ModelCredentialSetupProps). */
  connectSpec: Record<string, unknown>;
  modelBaseUrl?: string;
  reason?: string;
  failureCode?: string;
  expiresAt?: string;
  envelopeId: string;
  seq: number;
  /** The requesting agent's participant id (card method-call target). */
  participantId: string;
  publishedAt?: string;
}

export interface ChannelViewState {
  channelId?: string;
  cursor?: number;
  credentialRequests: Record<string, ProjectedCredentialRequest>;
  messages: MessageMap;
  invocations: InvocationMap;
  approvals: ApprovalMap;
  inlineUi: Record<string, InlineUiMap>;
  actionBars: Record<string, ProjectedActionBar | undefined>;
  messageTypes: Record<string, ProjectedMessageTypeDefinition>;
  customMessages: Record<string, ProjectedCustomMessage>;
  turns: TurnMap;
  /** Intended-recipient snapshot per message, resolved against the roster AT
   *  the moment the message was first projected (send time) and never
   *  recomputed — a later join/leave must not change a message's recipients.
   *  Keyed by messageId; values are participant keys. */
  intendedRecipientsByMessage: Record<string, string[]>;
  roster: Record<string, ChannelRosterEntry>;
  timeline: ChannelTimelineEntry[];
  seenEnvelopeIds: Record<string, true>;
  ignoredEnvelopeIds: string[];
  ignoredEnvelopeErrors: Record<string, string>;
}

export function createInitialChannelViewState(): ChannelViewState {
  return {
    credentialRequests: {},
    messages: {},
    invocations: {},
    approvals: {},
    inlineUi: {},
    actionBars: {},
    messageTypes: {},
    customMessages: {},
    turns: {},
    intendedRecipientsByMessage: {},
    roster: {},
    timeline: [],
    seenEnvelopeIds: {},
    ignoredEnvelopeIds: [],
    ignoredEnvelopeErrors: {},
  };
}

export function reduceChannelView(
  state: ChannelViewState,
  envelope: ChannelEnvelope
): ChannelViewState {
  if (state.seenEnvelopeIds[envelope.envelopeId]) {
    return state;
  }

  if (envelope.payloadKind === CREDENTIAL_CONNECT_PAYLOAD_KIND) {
    const payload = (envelope.payload ?? {}) as Record<string, unknown>;
    const credKey = typeof payload["credKey"] === "string" ? payload["credKey"] : "";
    const base = {
      ...state,
      channelId: envelope.channelId,
      cursor: envelope.seq,
      seenEnvelopeIds: { ...state.seenEnvelopeIds, [envelope.envelopeId]: true as const },
    };
    if (!credKey) return base;
    return {
      ...base,
      credentialRequests: {
        ...state.credentialRequests,
        [credKey]: {
          credKey,
          providerId: String(payload["providerId"] ?? ""),
          connectSpec: (payload["connectSpec"] ?? {}) as Record<string, unknown>,
          modelBaseUrl:
            typeof payload["modelBaseUrl"] === "string" ? payload["modelBaseUrl"] : undefined,
          reason: typeof payload["reason"] === "string" ? payload["reason"] : undefined,
          failureCode:
            typeof payload["failureCode"] === "string" ? payload["failureCode"] : undefined,
          expiresAt: typeof payload["expiresAt"] === "string" ? payload["expiresAt"] : undefined,
          envelopeId: String(envelope.envelopeId),
          seq: envelope.seq,
          participantId: participantKey(envelope.from),
          publishedAt: envelope.publishedAt,
        },
      },
    };
  }

  if (envelope.payloadKind !== AGENTIC_EVENT_PAYLOAD_KIND) {
    return {
      ...state,
      channelId: envelope.channelId,
      cursor: envelope.seq,
      seenEnvelopeIds: { ...state.seenEnvelopeIds, [envelope.envelopeId]: true },
      ignoredEnvelopeIds: [...state.ignoredEnvelopeIds, envelope.envelopeId],
      ignoredEnvelopeErrors: {
        ...state.ignoredEnvelopeErrors,
        [envelope.envelopeId]: `unsupported payloadKind: ${envelope.payloadKind ?? "<missing>"}`,
      },
    };
  }

  const result = agenticEventEnvelopeSchema.safeParse(envelope);
  if (!result.success) {
    const message = result.error.issues
      .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
      .join("; ");
    return {
      ...state,
      channelId: envelope.channelId,
      cursor: envelope.seq,
      seenEnvelopeIds: { ...state.seenEnvelopeIds, [envelope.envelopeId]: true },
      ignoredEnvelopeIds: [...state.ignoredEnvelopeIds, envelope.envelopeId],
      ignoredEnvelopeErrors: {
        ...state.ignoredEnvelopeErrors,
        [envelope.envelopeId]: message,
      },
    };
  }
  const parsed = result.data;
  const event = parsed.payload as AgenticEvent;
  assertNoStoredValueRefs(event, "channel view reducer input");
  const participantId = participantKey(parsed.from);
  let next: ChannelViewState = {
    ...state,
    channelId: parsed.channelId,
    cursor: parsed.seq,
    seenEnvelopeIds: { ...state.seenEnvelopeIds, [parsed.envelopeId]: true },
    timeline: [
      ...state.timeline,
      {
        envelopeId: parsed.envelopeId,
        seq: parsed.seq,
        participantId,
        kind: event.kind,
        createdAt: event.createdAt,
      },
    ],
  };

  if (event.kind.startsWith("message.")) {
    next = { ...next, messages: applyMessageEvent(next.messages, event as never, parsed.seq) };
    // Snapshot intended recipients the first time a message is projected (send
    // time). Stored once; never recomputed against a later roster.
    const messageId = event.causality?.messageId;
    if (
      messageId &&
      (event.kind === "message.started" || event.kind === "message.completed") &&
      next.intendedRecipientsByMessage[messageId] === undefined
    ) {
      const projected = next.messages[messageId];
      const payload = event.payload as { mentions?: string[] };
      next = {
        ...next,
        intendedRecipientsByMessage: {
          ...next.intendedRecipientsByMessage,
          [messageId]: resolveIntendedRecipients({
            to: projected?.to,
            mentions: projected?.mentions ?? payload.mentions,
            roster: Object.values(next.roster),
            senderKey: participantKey(event.actor),
          }),
        },
      };
    }
  } else if (event.kind.startsWith("invocation.")) {
    next = {
      ...next,
      invocations: applyInvocationEvent(next.invocations, event as never),
    };
  } else if (event.kind.startsWith("approval.")) {
    next = {
      ...next,
      approvals: applyApprovalEvent(next.approvals, event as never),
    };
  } else if (event.kind === "ui.feedback") {
    // Feedback is for the targeted agent's harness, not the channel view;
    // it lands in the timeline only.
  } else if (event.kind.startsWith("ui.")) {
    const inlineUi = next.inlineUi[participantId] ?? {};
    const { inlineUi: nextInlineUi, actionBar } = applyUiEvent(
      inlineUi,
      next.actionBars[participantId],
      event as never
    );
    next = {
      ...next,
      inlineUi: {
        ...next.inlineUi,
        [participantId]: nextInlineUi,
      },
      actionBars: {
        ...next.actionBars,
        [participantId]: actionBar,
      },
    };
  } else if (event.kind === "messageType.registered") {
    const payload = event.payload as MessageTypeRegisteredPayload;
    const existing = next.messageTypes[payload.typeId];
    const clearedAtSeq = existing?.clearedAtSeq;
    if (parsed.seq > (existing?.updatedAtSeq ?? -1) && parsed.seq > (clearedAtSeq ?? -1)) {
      next = {
        ...next,
        messageTypes: {
          ...next.messageTypes,
          [payload.typeId]: {
            typeId: payload.typeId,
            displayMode: payload.displayMode,
            source: payload.source,
            imports: payload.imports,
            stateSchema: payload.stateSchema,
            updateSchema: payload.updateSchema,
            registeredBy: payload.registeredBy,
            updatedAtSeq: parsed.seq,
            ...(clearedAtSeq !== undefined ? { clearedAtSeq } : {}),
          },
        },
      };
    }
  } else if (event.kind === "messageType.cleared") {
    const payload = event.payload as MessageTypeClearedPayload;
    const existing = next.messageTypes[payload.typeId];
    const clearedAtSeq = Math.max(existing?.clearedAtSeq ?? -1, parsed.seq);
    const cleared = existing
      ? { ...existing, clearedAtSeq }
      : { typeId: payload.typeId, updatedAtSeq: -1, clearedAtSeq };
    next = {
      ...next,
      messageTypes: {
        ...next.messageTypes,
        [payload.typeId]: cleared,
      },
    };
  } else if (event.kind === "custom.started") {
    const payload = event.payload as CustomStartedPayload;
    const existing: ProjectedCustomMessage = next.customMessages[payload.messageId] ?? {
      messageId: payload.messageId,
      updates: [],
      lastSeq: -1,
    };
    const shouldFillStart = existing.startedAtSeq === undefined;
    if (shouldFillStart) {
      next = {
        ...next,
        customMessages: {
          ...next.customMessages,
          [payload.messageId]: {
            ...existing,
            typeId: payload.typeId,
            displayMode: payload.displayMode,
            initialState: payload.initialState,
            by: payload.by ?? event.actor,
            startedAtSeq: parsed.seq,
            startedAt: event.createdAt,
            updatedAt: existing.updatedAt ?? event.createdAt,
            lastSeq: existing.lastSeq,
          },
        },
      };
    }
  } else if (event.kind === "custom.updated") {
    const payload = event.payload as CustomUpdatedPayload;
    const existing: ProjectedCustomMessage = next.customMessages[payload.messageId] ?? {
      messageId: payload.messageId,
      updates: [],
      lastSeq: -1,
    };
    if (existing.updates.some((update) => update.seq === parsed.seq)) {
      next = next.customMessages[payload.messageId]
        ? next
        : {
            ...next,
            customMessages: {
              ...next.customMessages,
              [payload.messageId]: existing,
            },
          };
    } else {
      const updates = [...existing.updates, { update: payload.update, seq: parsed.seq }].sort(
        (a, b) => a.seq - b.seq
      );
      const isNewest = parsed.seq >= existing.lastSeq;
      const updated: ProjectedCustomMessage = {
        ...existing,
        updates,
        updatedAt: isNewest ? event.createdAt : existing.updatedAt,
        lastSeq: Math.max(existing.lastSeq, parsed.seq),
      };
      // A failure marks the card; a newer successful update clears it.
      if (isNewest) {
        if (payload.status === "failed") {
          updated.failed = true;
          updated.error = payload.error ?? { message: "card failed" };
        } else {
          delete updated.failed;
          delete updated.error;
        }
      }
      next = {
        ...next,
        customMessages: {
          ...next.customMessages,
          [payload.messageId]: updated,
        },
      };
    }
  } else if (
    event.kind === "turn.opened" ||
    event.kind === "turn.waiting" ||
    event.kind === "turn.closed"
  ) {
    const turnId = event.turnId;
    // Seq-monotonic turn lifecycle: ignore a stale/out-of-order status event
    // (lower seq than already applied) so a replayed turn.opened or a late
    // turn.waiting can never resurrect a closed turn.
    const existingTurn = turnId ? next.turns[turnId] : undefined;
    const staleTurnEvent = existingTurn?.lastSeq !== undefined && parsed.seq < existingTurn.lastSeq;
    if (turnId && !staleTurnEvent) {
      const existing = existingTurn;
      const summary = "summary" in event.payload ? event.payload.summary : existing?.summary;
      const reason = "reason" in event.payload ? event.payload.reason : existing?.reason;
      next = {
        ...next,
        turns: {
          ...next.turns,
          [turnId]: {
            turnId,
            actor: existing?.actor ?? event.actor,
            status:
              event.kind === "turn.closed"
                ? "closed"
                : event.kind === "turn.waiting"
                  ? "waiting"
                  : "open",
            openedAt: existing?.openedAt ?? event.createdAt,
            ...(event.kind === "turn.closed" ? { closedAt: event.createdAt } : {}),
            updatedAt: event.createdAt,
            lastSeq: parsed.seq,
            ...(summary ? { summary } : {}),
            ...(reason ? { reason } : {}),
          },
        },
      };
    }
  } else if (event.kind === "system.event") {
    const payload = event.payload as Record<string, unknown>;
    const details = (payload["details"] ?? {}) as Record<string, unknown>;
    const sysKind = String(payload["kind"] ?? details["kind"] ?? "");
    if (sysKind === "credential.wait_resolved" || sysKind === "credential.wait_expired") {
      const credKey = String(payload["credKey"] ?? details["credKey"] ?? "");
      if (credKey && credKey in next.credentialRequests) {
        const { [credKey]: _resolved, ...rest } = next.credentialRequests;
        next = { ...next, credentialRequests: rest };
      }
    }
  } else if (event.kind === "external.participant_observed") {
    const payload = event.payload;
    if ("participant" in payload) {
      const key = participantKey(payload.participant);
      const existing = next.roster[key];
      next = {
        ...next,
        roster: {
          ...next.roster,
          [key]: {
            participant: payload.participant,
            joinedAt:
              payload.action === "joined"
                ? event.createdAt
                : (existing?.joinedAt ?? event.createdAt),
            leftAt: payload.action === "left" ? event.createdAt : existing?.leftAt,
            roles: payload.roles ?? existing?.roles ?? [],
          },
        },
      };
    }
  }

  if (event.turnId && event.kind !== "turn.closed" && event.kind !== "turn.waiting") {
    const existing = next.turns[event.turnId];
    if (
      (existing?.status === "open" ||
        (existing?.status === "waiting" && reactivatesWaitingTurn(event))) &&
      existing.updatedAt !== event.createdAt
    ) {
      next = {
        ...next,
        turns: {
          ...next.turns,
          [event.turnId]: {
            ...existing,
            status: "open",
            updatedAt: event.createdAt,
          },
        },
      };
    }
  }

  return next;
}

function reactivatesWaitingTurn(event: AgenticEvent): boolean {
  return (
    event.kind === "message.started" ||
    event.kind === "message.delta" ||
    event.kind === "invocation.started"
  );
}
