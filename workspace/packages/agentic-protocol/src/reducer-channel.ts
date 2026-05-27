import { AGENTIC_EVENT_PAYLOAD_KIND } from "./constants.js";
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
import type { ApprovalMap, InlineUiMap, InvocationMap, MessageMap, ProjectedActionBar, TurnMap } from "./handlers.js";
import {
  applyApprovalEvent,
  applyInvocationEvent,
  applyMessageEvent,
  applyUiEvent,
  participantKey,
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
  schemaSourceOrPath?: unknown;
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
}

export interface ChannelViewState {
  channelId?: string;
  cursor?: number;
  messages: MessageMap;
  invocations: InvocationMap;
  approvals: ApprovalMap;
  inlineUi: Record<string, InlineUiMap>;
  actionBars: Record<string, ProjectedActionBar | undefined>;
  messageTypes: Record<string, ProjectedMessageTypeDefinition>;
  customMessages: Record<string, ProjectedCustomMessage>;
  turns: TurnMap;
  roster: Record<string, ChannelRosterEntry>;
  timeline: ChannelTimelineEntry[];
  seenEnvelopeIds: Record<string, true>;
  ignoredEnvelopeIds: string[];
}

export function createInitialChannelViewState(): ChannelViewState {
  return {
    messages: {},
    invocations: {},
    approvals: {},
    inlineUi: {},
    actionBars: {},
    messageTypes: {},
    customMessages: {},
    turns: {},
    roster: {},
    timeline: [],
    seenEnvelopeIds: {},
    ignoredEnvelopeIds: [],
  };
}

export function reduceChannelView(
  state: ChannelViewState,
  envelope: ChannelEnvelope,
): ChannelViewState {
  if (state.seenEnvelopeIds[envelope.envelopeId]) {
    return state;
  }

  if (envelope.payloadKind !== AGENTIC_EVENT_PAYLOAD_KIND) {
    return {
      ...state,
      channelId: envelope.channelId,
      cursor: envelope.seq,
      seenEnvelopeIds: { ...state.seenEnvelopeIds, [envelope.envelopeId]: true },
      ignoredEnvelopeIds: [...state.ignoredEnvelopeIds, envelope.envelopeId],
    };
  }

  const result = agenticEventEnvelopeSchema.safeParse(envelope);
  if (!result.success) {
    return {
      ...state,
      channelId: envelope.channelId,
      cursor: envelope.seq,
      seenEnvelopeIds: { ...state.seenEnvelopeIds, [envelope.envelopeId]: true },
      ignoredEnvelopeIds: [...state.ignoredEnvelopeIds, envelope.envelopeId],
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
    next = { ...next, messages: applyMessageEvent(next.messages, event as never) };
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
  } else if (event.kind.startsWith("ui.")) {
    const inlineUi = next.inlineUi[participantId] ?? {};
    const { inlineUi: nextInlineUi, actionBar } = applyUiEvent(
      inlineUi,
      next.actionBars[participantId],
      event as never,
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
            schemaSourceOrPath: payload.schemaSourceOrPath,
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
      next = next.customMessages[payload.messageId] ? next : {
        ...next,
        customMessages: {
          ...next.customMessages,
          [payload.messageId]: existing,
        },
      };
    } else {
      const updates = [...existing.updates, { update: payload.update, seq: parsed.seq }]
        .sort((a, b) => a.seq - b.seq);
      next = {
        ...next,
        customMessages: {
          ...next.customMessages,
          [payload.messageId]: {
            ...existing,
            updates,
            updatedAt: parsed.seq >= existing.lastSeq ? event.createdAt : existing.updatedAt,
            lastSeq: Math.max(existing.lastSeq, parsed.seq),
          },
        },
      };
    }
  } else if (event.kind === "turn.opened" || event.kind === "turn.closed") {
    const turnId = event.turnId;
    if (turnId) {
      const existing = next.turns[turnId];
      const summary = "summary" in event.payload ? event.payload.summary : existing?.summary;
      const reason = "reason" in event.payload ? event.payload.reason : existing?.reason;
      next = {
        ...next,
        turns: {
          ...next.turns,
          [turnId]: {
            turnId,
            actor: existing?.actor ?? event.actor,
            status: event.kind === "turn.closed" ? "closed" : "open",
            openedAt: existing?.openedAt ?? event.createdAt,
            ...(event.kind === "turn.closed" ? { closedAt: event.createdAt } : {}),
            updatedAt: event.createdAt,
            ...(summary ? { summary } : {}),
            ...(reason ? { reason } : {}),
          },
        },
      };
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
            joinedAt: payload.action === "joined" ? event.createdAt : existing?.joinedAt ?? event.createdAt,
            leftAt: payload.action === "left" ? event.createdAt : existing?.leftAt,
            roles: payload.roles ?? existing?.roles ?? [],
          },
        },
      };
    }
  }

  if (event.turnId && event.kind !== "turn.closed") {
    const existing = next.turns[event.turnId];
    if (existing?.status === "open" && existing.updatedAt !== event.createdAt) {
      next = {
        ...next,
        turns: {
          ...next.turns,
          [event.turnId]: {
            ...existing,
            updatedAt: event.createdAt,
          },
        },
      };
    }
  }

  return next;
}
