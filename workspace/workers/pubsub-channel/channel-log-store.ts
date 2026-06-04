import type { ChannelEvent } from "@workspace/harness";
import { createGadServiceClient, type DurableObjectServiceClient } from "@workspace/runtime/workerd-client";
import type { BootstrapSnapshot, ChannelReplayEnvelope, ServerLogEvent } from "@workspace/pubsub";
import {
  AGENTIC_EVENT_PAYLOAD_KIND,
  brandId,
  encodeChannelPayloadStoredValues,
  hydrateStoredValueRefs,
  participantRefFromMetadata,
  publicParticipantMetadata,
  sanitizeAgenticEventParticipantRefs,
  type AgenticEvent,
  type ChannelEnvelope,
  type ChannelId,
  type EnvelopeId,
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

export type RegistryMutationInput =
  | {
      kind: "upsertMessageType";
      typeId: string;
      row: {
        displayMode: "inline" | "row";
        source: { type: "code"; code: string } | { type: "file"; path: string };
        imports?: Record<string, string>;
        schemaSourceOrPath?: unknown;
        registeredBy?: Record<string, unknown>;
      };
    }
  | { kind: "clearMessageType"; typeId: string };

export interface MessageTypeDefinition {
  typeId: string;
  displayMode: "inline" | "row";
  source: { type: "code"; code: string } | { type: "file"; path: string };
  imports?: Record<string, string>;
  schemaSourceOrPath?: unknown;
  registeredBy?: Record<string, unknown>;
  updatedAtSeq: number;
  clearedAtSeq?: number;
}

export interface ChannelReplayContext {
  contextId?: string;
  channelConfig?: Record<string, unknown>;
  snapshots?: BootstrapSnapshot[];
}

export interface ChannelLogStore {
  append(input: AppendChannelLogInput): Promise<ChannelEvent>;
  forkFrom(parentChannelId: string, throughSeq: number | null): Promise<void>;
  appendWithRegistryMutation(input: AppendChannelLogInput, mutation: RegistryMutationInput): Promise<ChannelEvent>;
  listMessageTypes(): Promise<MessageTypeDefinition[]>;
  getMessageType(typeId: string): Promise<MessageTypeDefinition | null>;
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
  private static readonly REPLAY_AFTER_LIMIT = 500;

  constructor(
    private readonly rpc: RpcCallerLike,
    private readonly channelId: string,
  ) {
    this.gad = createGadServiceClient(rpc);
  }

  async append(input: AppendChannelLogInput): Promise<ChannelEvent> {
    const payload = await this.encodePayload(input.payload);
    const envelope = await this.hydrateEnvelope(await this.gad.call<ChannelEnvelope>("appendChannelEnvelope", {
      channelId: brandId<ChannelId>(this.channelId),
      envelopeId: brandId<EnvelopeId>(input.messageId ?? crypto.randomUUID()),
      from: participantRefFromMetadata(input.senderId, input.senderMetadata),
      payload,
      payloadKind: input.type,
      metadata: publicParticipantMetadata(input.senderMetadata),
      attachments: input.attachments,
    }));
    return eventFromGadEnvelope(envelope);
  }

  async forkFrom(parentChannelId: string, throughSeq: number | null): Promise<void> {
    await this.gad.call("forkChannelLog", {
      fromChannelId: parentChannelId,
      toChannelId: this.channelId,
      throughSeq,
    });
  }

  async appendWithRegistryMutation(input: AppendChannelLogInput, mutation: RegistryMutationInput): Promise<ChannelEvent> {
    const payload = await this.encodePayload(input.payload);
    const envelope = await this.hydrateEnvelope(await this.gad.call<ChannelEnvelope>("appendChannelEnvelopeWithRegistryMutation", {
      channelId: brandId<ChannelId>(this.channelId),
      envelopeId: brandId<EnvelopeId>(input.messageId ?? crypto.randomUUID()),
      from: participantRefFromMetadata(input.senderId, input.senderMetadata),
      payload,
      payloadKind: input.type,
      metadata: publicParticipantMetadata(input.senderMetadata),
      attachments: input.attachments,
      registryMutation: mutation,
    }));
    return eventFromGadEnvelope(envelope);
  }

  async listMessageTypes(): Promise<MessageTypeDefinition[]> {
    return this.gad.call<MessageTypeDefinition[]>("listMessageTypes", { channelId: this.channelId });
  }

  async getMessageType(typeId: string): Promise<MessageTypeDefinition | null> {
    return this.gad.call<MessageTypeDefinition | null>("getMessageType", { channelId: this.channelId, typeId });
  }

  async hasEnvelope(envelopeId: string): Promise<boolean> {
    const envelope = await this.gad.call<ChannelEnvelope | null>("getChannelEnvelope", { envelopeId });
    return envelope != null;
  }

  async getEventByEnvelopeId(envelopeId: string): Promise<ChannelEvent | null> {
    const envelope = await this.hydrateNullableEnvelope(await this.gad.call<ChannelEnvelope | null>("getChannelEnvelope", { envelopeId }));
    if (!envelope || String(envelope.channelId) !== this.channelId) return null;
    return eventFromGadEnvelope(envelope);
  }

  async replayAfter(sinceId: number, context: ChannelReplayContext): Promise<ChannelReplayEnvelope> {
    const window = await this.hydrateReplayWindow(await this.gad.call<GadReplayWindow>("getChannelReplayWindow", {
      channelId: this.channelId,
      mode: "after",
      sinceSeq: sinceId,
      limit: GadChannelLogStore.REPLAY_AFTER_LIMIT,
    }));
    return replayFromGadWindow("after", window, context);
  }

  async replayBefore(
    beforeSeq: number,
    limit: number,
    context: ChannelReplayContext,
  ): Promise<ChannelReplayEnvelope> {
    const window = await this.hydrateReplayWindow(await this.gad.call<GadReplayWindow>("getChannelReplayWindow", {
      channelId: this.channelId,
      mode: "before",
      beforeSeq,
      limit,
    }));
    return replayFromGadWindow("before", window, context);
  }

  async replayInitial(limit: number, context: ChannelReplayContext): Promise<ChannelReplayEnvelope> {
    const window = await this.hydrateReplayWindow(await this.gad.call<GadReplayWindow>("getChannelReplayWindow", {
      channelId: this.channelId,
      mode: "initial",
      limit,
    }));
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

  private async encodePayload(payload: unknown): Promise<unknown> {
    const semanticPayload = isAgenticEventPayload(payload)
      ? sanitizeAgenticEventParticipantRefs(payload)
      : payload;
    return encodeChannelPayloadStoredValues(semanticPayload, {
      putText: (value) =>
        this.rpc.call<{ digest: string; size: number }>("main", "blobstore.putText", [value]),
    });
  }

  private async hydrateEnvelope(envelope: ChannelEnvelope): Promise<ChannelEnvelope> {
    return hydrateStoredValueRefs(envelope, {
      getText: (digest) => this.rpc.call<string | null>("main", "blobstore.getText", [digest]),
    }) as Promise<ChannelEnvelope>;
  }

  private async hydrateNullableEnvelope(envelope: ChannelEnvelope | null): Promise<ChannelEnvelope | null> {
    return envelope ? this.hydrateEnvelope(envelope) : null;
  }

  private async hydrateReplayWindow(window: GadReplayWindow): Promise<GadReplayWindow> {
    return {
      ...window,
      envelopes: await Promise.all(window.envelopes.map((envelope) => this.hydrateEnvelope(envelope))),
    };
  }
}

function isAgenticEventPayload(payload: unknown): payload is AgenticEvent {
  return !!payload &&
    typeof payload === "object" &&
    !Array.isArray(payload) &&
    typeof (payload as Record<string, unknown>)["kind"] === "string" &&
    typeof (payload as Record<string, unknown>)["actor"] === "object" &&
    typeof (payload as Record<string, unknown>)["createdAt"] === "string";
}
