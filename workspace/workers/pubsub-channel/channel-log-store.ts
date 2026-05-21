import type { ChannelEvent } from "@natstack/harness/types";
import { createGadServiceClient, type DurableObjectServiceClient } from "@workspace/runtime/workerd-client";
import type { BootstrapSnapshot, ChannelReplayEnvelope, ServerLogEvent } from "@workspace/pubsub";
import {
  AGENTIC_EVENT_PAYLOAD_KIND,
  brandId,
  type ChannelEnvelope,
  type ChannelId,
  type EnvelopeId,
  type ParticipantRef,
} from "@workspace/agentic-protocol";
import type { StoredAttachment } from "./types.js";
import { buildChannelEvent } from "./broadcast.js";

export interface AppendChannelLogInput {
  type: string;
  payload: unknown;
  senderId: string;
  senderMetadata?: Record<string, unknown>;
  messageId?: string;
  attachments?: StoredAttachment[];
}

export interface ChannelReplayContext {
  contextId?: string;
  channelConfig?: Record<string, unknown>;
  snapshots?: BootstrapSnapshot[];
}

export interface ChannelLogStore {
  append(input: AppendChannelLogInput): Promise<ChannelEvent>;
  hasEnvelope(envelopeId: string): Promise<boolean>;
  getEventByEnvelopeId(envelopeId: string): Promise<ChannelEvent | null>;
  replayAfter(sinceId: number, context: ChannelReplayContext): Promise<ChannelReplayEnvelope>;
  replayBefore(beforeSeq: number, limit: number, context: ChannelReplayContext): Promise<ChannelReplayEnvelope>;
  replayInitial(limit: number, context: ChannelReplayContext): Promise<ChannelReplayEnvelope>;
  inspectRows(opts: { afterId?: number; beforeId?: number; limit?: number }): Promise<Record<string, unknown>[]>;
  inspectEnvelope(envelopeId: string): Promise<Record<string, unknown>[]>;
}

interface RpcCallerLike {
  call<T = unknown>(targetId: string, method: string, args: unknown[]): Promise<T>;
}

interface GadReplayWindow {
  envelopes: ChannelEnvelope[];
  totalCount: number;
  firstEnvelopeSeq?: number;
  replayFromId?: number;
  replayToId?: number;
  hasMoreBefore?: boolean;
}

function participantRefForSender(senderId: string, metadata?: Record<string, unknown>): ParticipantRef {
  const declaredKind = metadata?.["kind"] ?? metadata?.["type"];
  const kind = declaredKind === "user" ||
    declaredKind === "agent" ||
    declaredKind === "system" ||
    declaredKind === "panel" ||
    declaredKind === "external"
      ? declaredKind
      : senderId === "system"
        ? "system"
        : senderId.startsWith("panel:")
          ? "panel"
          : senderId.startsWith("do:")
            ? "agent"
            : "external";
  const displayName = typeof metadata?.["name"] === "string"
    ? metadata["name"]
    : typeof metadata?.["displayName"] === "string"
      ? metadata["displayName"]
      : undefined;
  return {
    kind,
    id: senderId,
    participantId: senderId,
    ...(displayName ? { displayName } : {}),
    ...(metadata ? { metadata } : {}),
  };
}

function eventFromGadEnvelope(envelope: ChannelEnvelope): ChannelEvent {
  return buildChannelEvent(
    envelope.seq,
    String(envelope.envelopeId),
    envelope.payloadKind ?? "message",
    JSON.stringify(envelope.payload),
    envelope.from.participantId ?? envelope.from.id,
    envelope.metadata ?? envelope.from.metadata,
    Date.parse(envelope.publishedAt),
    envelope.attachments as StoredAttachment[] | undefined,
  );
}

function replayFromGadWindow(
  mode: ChannelReplayEnvelope["mode"],
  window: GadReplayWindow,
  context: ChannelReplayContext,
): ChannelReplayEnvelope {
  return {
    mode,
    logEvents: window.envelopes.map((envelope): ServerLogEvent => eventFromGadEnvelope(envelope)),
    snapshots: context.snapshots ?? [],
    ready: {
      contextId: context.contextId,
      channelConfig: context.channelConfig,
      totalCount: window.totalCount,
      envelopeCount: window.totalCount,
      firstEnvelopeSeq: window.firstEnvelopeSeq,
      replayFromId: window.replayFromId,
      replayToId: window.replayToId,
      ...(window.hasMoreBefore !== undefined ? { hasMoreBefore: window.hasMoreBefore } : {}),
    },
  };
}

export class GadChannelLogStore implements ChannelLogStore {
  private readonly gad: DurableObjectServiceClient;

  constructor(
    rpc: RpcCallerLike,
    private readonly channelId: string,
  ) {
    this.gad = createGadServiceClient(rpc);
  }

  async append(input: AppendChannelLogInput): Promise<ChannelEvent> {
    const envelope = await this.gad.call<ChannelEnvelope>("appendChannelEnvelope", {
      channelId: brandId<ChannelId>(this.channelId),
      envelopeId: brandId<EnvelopeId>(input.messageId ?? crypto.randomUUID()),
      from: participantRefForSender(input.senderId, input.senderMetadata),
      payload: input.payload,
      payloadKind: input.type,
      metadata: input.senderMetadata,
      attachments: input.attachments,
    });
    return eventFromGadEnvelope(envelope);
  }

  async hasEnvelope(envelopeId: string): Promise<boolean> {
    const envelope = await this.gad.call<ChannelEnvelope | null>("getChannelEnvelope", { envelopeId });
    return envelope != null;
  }

  async getEventByEnvelopeId(envelopeId: string): Promise<ChannelEvent | null> {
    const envelope = await this.gad.call<ChannelEnvelope | null>("getChannelEnvelope", { envelopeId });
    if (!envelope || String(envelope.channelId) !== this.channelId) return null;
    return eventFromGadEnvelope(envelope);
  }

  async replayAfter(sinceId: number, context: ChannelReplayContext): Promise<ChannelReplayEnvelope> {
    const window = await this.gad.call<GadReplayWindow>("getChannelReplayWindow", {
      channelId: this.channelId,
      mode: "after",
      sinceSeq: sinceId,
    });
    return replayFromGadWindow("after", window, context);
  }

  async replayBefore(
    beforeSeq: number,
    limit: number,
    context: ChannelReplayContext,
  ): Promise<ChannelReplayEnvelope> {
    const window = await this.gad.call<GadReplayWindow>("getChannelReplayWindow", {
      channelId: this.channelId,
      mode: "before",
      beforeSeq,
      limit,
    });
    return replayFromGadWindow("before", window, context);
  }

  async replayInitial(limit: number, context: ChannelReplayContext): Promise<ChannelReplayEnvelope> {
    const window = await this.gad.call<GadReplayWindow>("getChannelReplayWindow", {
      channelId: this.channelId,
      mode: "initial",
      limit,
    });
    return replayFromGadWindow("initial", window, context);
  }

  async inspectRows(opts: { afterId?: number; beforeId?: number; limit?: number }): Promise<Record<string, unknown>[]> {
    const mode = opts.beforeId != null ? "before" : opts.afterId != null ? "after" : "initial";
    const window = await this.gad.call<GadReplayWindow>("getChannelReplayWindow", {
      channelId: this.channelId,
      mode,
      sinceSeq: opts.afterId,
      beforeSeq: opts.beforeId,
      limit: opts.limit,
    });
    return window.envelopes.map((envelope) => ({
      seq: envelope.seq,
      envelope_id: envelope.envelopeId,
      payload_kind: envelope.payloadKind,
      payload: JSON.stringify(envelope.payload),
      from_id: envelope.from.participantId ?? envelope.from.id,
      from_json: JSON.stringify(envelope.metadata ?? envelope.from.metadata ?? {}),
      attachments: envelope.attachments ? JSON.stringify(envelope.attachments) : null,
      published_at: Date.parse(envelope.publishedAt),
    }));
  }

  async inspectEnvelope(envelopeId: string): Promise<Record<string, unknown>[]> {
    const envelope = await this.gad.call<ChannelEnvelope | null>("getChannelEnvelope", { envelopeId });
    if (!envelope) return [];
    return [{
      seq: envelope.seq,
      envelope_id: envelope.envelopeId,
      payload_kind: envelope.payloadKind,
      payload: JSON.stringify(envelope.payload),
      from_id: envelope.from.participantId ?? envelope.from.id,
      from_json: JSON.stringify(envelope.metadata ?? envelope.from.metadata ?? {}),
      attachments: envelope.attachments ? JSON.stringify(envelope.attachments) : null,
      published_at: Date.parse(envelope.publishedAt),
    }];
  }
}
