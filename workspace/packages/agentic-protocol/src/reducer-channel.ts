import { AGENTIC_EVENT_PAYLOAD_KIND } from "./constants.js";
import type { AgenticEvent } from "./events.js";
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

export interface ChannelTimelineEntry {
  envelopeId: string;
  seq: number;
  participantId: string;
  kind: string;
  createdAt: string;
}

export interface ChannelViewState {
  channelId?: string;
  cursor?: number;
  messages: MessageMap;
  invocations: InvocationMap;
  approvals: ApprovalMap;
  inlineUi: Record<string, InlineUiMap>;
  actionBars: Record<string, ProjectedActionBar | undefined>;
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
  } else if (event.kind === "turn.opened" || event.kind === "turn.closed") {
    const turnId = event.turnId;
    if (turnId) {
      const existing = next.turns[turnId];
      const summary = "summary" in event.payload ? event.payload.summary : existing?.summary;
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
