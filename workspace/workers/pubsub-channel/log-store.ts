/**
 * Channel log access on the unified-log core (WS2 §2).
 *
 * Appends and forks target the Stage-0 core surface (`appendLogEvent`,
 * `forkLog`, `getLogEvent`) directly; replay windows ride the lineage-aware
 * `getChannelReplayWindow` read (server-side windowing over `log_events` —
 * one round trip per page instead of N). Blob spill/hydrate stays here; all
 * schema validation and participant sanitization happens inside the GAD
 * append txn.
 */

import type { ChannelEvent } from "@workspace/harness";
import {
  createGadServiceClient,
  type DurableObjectServiceClient,
} from "@workspace/runtime/workerd-client";
import type { BootstrapSnapshot, ChannelReplayEnvelope, ServerLogEvent } from "@workspace/pubsub";
import {
  encodeChannelPayloadStoredValues,
  hydrateStoredValueRefs,
  participantRefFromMetadata,
  publicParticipantMetadata,
  type AppendIdempotency,
  type LogEnvelope,
} from "@workspace/agentic-protocol";
import type { StoredAttachment } from "./types.js";
import { buildChannelEvent } from "./broadcast.js";

export const CHANNEL_LOG_HEAD = "main";

export interface ChannelAppendInput {
  /** payloadKind: "agentic.trajectory.v1/event" | "presence" | "error" | ... */
  type: string;
  payload: unknown;
  senderId: string;
  senderMetadata?: Record<string, unknown>;
  /** Deterministic ids welcome: invocationId, `terminal:{id}`, `ik:{key}`. */
  messageId?: string;
  /** Append intent (see AppendIdempotency in agentic-protocol). Default
   *  "exact" — divergent duplicates are integrity errors. ONLY the client
   *  publish path passes "idempotent-by-id" (stable retry token, volatile
   *  payload fields → first write wins). */
  idempotency?: AppendIdempotency;
  /** Policy annotations (agentHops, ...). */
  annotations?: Record<string, unknown>;
  attachments?: StoredAttachment[];
}

export interface MessageTypeDefinition {
  typeId: string;
  displayMode: "inline" | "row";
  source: { type: "code"; code: string } | { type: "file"; path: string };
  imports?: Record<string, string>;
  stateSchema?: Record<string, unknown>;
  updateSchema?: Record<string, unknown>;
  registeredBy?: Record<string, unknown>;
  updatedAtSeq: number;
  clearedAtSeq?: number;
}

export interface ChannelReplayContext {
  contextId?: string;
  channelConfig?: Record<string, unknown>;
  snapshots?: BootstrapSnapshot[];
}

interface RpcCallerLike {
  call<T = unknown>(targetId: string, method: string, args: unknown[]): Promise<T>;
}

interface GadReplayWindow {
  envelopes: GadChannelEnvelopeView[];
  totalCount: number;
  firstEnvelopeSeq?: number;
  replayFromId?: number;
  replayToId?: number;
  hasMoreBefore?: boolean;
}

/** The ChannelEnvelope view shape the gad replay-window read returns. */
interface GadChannelEnvelopeView {
  envelopeId: string;
  channelId: string;
  seq: number;
  from: { id: string; participantId?: string; metadata?: Record<string, unknown> };
  payload: unknown;
  payloadKind?: string;
  metadata?: Record<string, unknown>;
  attachments?: unknown[];
  publishedAt: string;
}

interface AppendLogEventResultLike {
  headSeq: number;
  headHash: string;
  envelopes: LogEnvelope[];
}

/** annotations minus the metadata/attachments carriers. */
function policyAnnotations(
  annotations: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  if (!annotations) return undefined;
  const { metadata: _metadata, attachments: _attachments, ...rest } = annotations;
  return Object.keys(rest).length > 0 ? rest : undefined;
}

export class ChannelLog {
  private readonly gad: DurableObjectServiceClient;
  private static readonly REPLAY_AFTER_LIMIT = 500;

  constructor(
    private readonly rpc: RpcCallerLike,
    private readonly channelId: string
  ) {
    this.gad = createGadServiceClient(rpc);
  }

  async append(input: ChannelAppendInput): Promise<ChannelEvent> {
    const payload = await this.encodePayload(input.payload);
    const annotations: Record<string, unknown> = { ...(input.annotations ?? {}) };
    const publicMetadata = publicParticipantMetadata(input.senderMetadata);
    if (publicMetadata !== undefined) annotations["metadata"] = publicMetadata;
    if (input.attachments !== undefined) annotations["attachments"] = input.attachments;
    // Idempotency intent is the STORE's contract now (no error-string
    // matching here): "idempotent-by-id" callers get the journaled original
    // back as a replayed envelope; everyone else gets hard typed errors.
    const result = await this.gad.call<AppendLogEventResultLike>("appendLogEvent", {
      logId: this.channelId,
      head: CHANNEL_LOG_HEAD,
      logKind: "channel",
      ...(input.idempotency ? { idempotency: input.idempotency } : {}),
      events: [
        {
          envelopeId: input.messageId ?? null,
          actor: participantRefFromMetadata(input.senderId, input.senderMetadata),
          payloadKind: input.type,
          payload,
          ...(Object.keys(annotations).length > 0 ? { annotations } : {}),
        },
      ],
    });
    const envelope = result.envelopes[result.envelopes.length - 1]!;
    return this.eventFromLogEnvelope(await this.hydrate(envelope));
  }

  async forkFrom(parentChannelId: string, throughSeq: number | null): Promise<void> {
    await this.gad.call("forkLog", {
      fromLogId: parentChannelId,
      fromHead: CHANNEL_LOG_HEAD,
      toLogId: this.channelId,
      toHead: CHANNEL_LOG_HEAD,
      atSeq: throughSeq,
    });
  }

  async headSeq(): Promise<number> {
    const head = await this.gad.call<{ seq: number } | null>("getLogHead", {
      logId: this.channelId,
      head: CHANNEL_LOG_HEAD,
    });
    return head?.seq ?? 0;
  }

  async listMessageTypes(): Promise<MessageTypeDefinition[]> {
    const rows = await this.gad.call<MessageTypeDefinition[]>("listMessageTypes", {
      channelId: this.channelId,
    });
    return Promise.all(rows.map((row) => this.hydrate(row)));
  }

  async getMessageType(typeId: string): Promise<MessageTypeDefinition | null> {
    const row = await this.gad.call<MessageTypeDefinition | null>("getMessageType", {
      channelId: this.channelId,
      typeId,
    });
    return row ? this.hydrate(row) : null;
  }

  async hasEnvelope(envelopeId: string): Promise<boolean> {
    const envelope = await this.gad.call<LogEnvelope | null>("getLogEvent", {
      logId: this.channelId,
      head: CHANNEL_LOG_HEAD,
      envelopeId,
    });
    return envelope != null;
  }

  async getEventByEnvelopeId(envelopeId: string): Promise<ChannelEvent | null> {
    const envelope = await this.gad.call<LogEnvelope | null>("getLogEvent", {
      logId: this.channelId,
      head: CHANNEL_LOG_HEAD,
      envelopeId,
    });
    if (!envelope) return null;
    return this.eventFromLogEnvelope(await this.hydrate(envelope));
  }

  /** Lineage-aware ascending page over durable envelopes (policy folds,
   *  derivePendingCalls). Payloads are NOT hydrated (policies must not depend
   *  on blob-spilled fields). */
  async read(opts: {
    afterSeq?: number;
    beforeSeq?: number;
    limit?: number;
    payloadKind?: string;
  }): Promise<LogEnvelope[]> {
    return this.gad.call<LogEnvelope[]>("readLog", {
      logId: this.channelId,
      head: CHANNEL_LOG_HEAD,
      afterSeq: opts.afterSeq ?? 0,
      beforeSeq: opts.beforeSeq ?? null,
      limit: opts.limit ?? 500,
      payloadKind: opts.payloadKind ?? null,
    });
  }

  async replayAfter(sinceId: number, context: ChannelReplayContext): Promise<ChannelReplayEnvelope> {
    const window = await this.hydrateReplayWindow(
      await this.gad.call<GadReplayWindow>("getChannelReplayWindow", {
        channelId: this.channelId,
        mode: "after",
        sinceSeq: sinceId,
        limit: ChannelLog.REPLAY_AFTER_LIMIT,
      })
    );
    return this.replayFromWindow("after", window, context);
  }

  async replayBefore(
    beforeSeq: number,
    limit: number,
    context: ChannelReplayContext
  ): Promise<ChannelReplayEnvelope> {
    const window = await this.hydrateReplayWindow(
      await this.gad.call<GadReplayWindow>("getChannelReplayWindow", {
        channelId: this.channelId,
        mode: "before",
        beforeSeq,
        limit,
      })
    );
    return this.replayFromWindow("before", window, context);
  }

  async replayInitial(limit: number, context: ChannelReplayContext): Promise<ChannelReplayEnvelope> {
    const window = await this.hydrateReplayWindow(
      await this.gad.call<GadReplayWindow>("getChannelReplayWindow", {
        channelId: this.channelId,
        mode: "initial",
        limit,
      })
    );
    return this.replayFromWindow("initial", window, context);
  }

  async inspectRows(opts: {
    afterId?: number;
    beforeId?: number;
    limit?: number;
  }): Promise<Record<string, unknown>[]> {
    const mode = opts.beforeId != null ? "before" : opts.afterId != null ? "after" : "initial";
    const window = await this.gad.call<GadReplayWindow>("getChannelReplayWindow", {
      channelId: this.channelId,
      mode,
      sinceSeq: opts.afterId,
      beforeSeq: opts.beforeId,
      limit: opts.limit,
    });
    return window.envelopes.map((envelope) => this.inspectionRow(envelope));
  }

  async inspectEnvelope(envelopeId: string): Promise<Record<string, unknown>[]> {
    const envelope = await this.gad.call<LogEnvelope | null>("getLogEvent", {
      logId: this.channelId,
      head: CHANNEL_LOG_HEAD,
      envelopeId,
    });
    if (!envelope) return [];
    return [
      this.inspectionRow({
        envelopeId: String(envelope.envelopeId),
        channelId: this.channelId,
        seq: envelope.seq,
        from: envelope.actor as GadChannelEnvelopeView["from"],
        payload: envelope.payload,
        payloadKind: envelope.payloadKind,
        metadata: envelope.annotations?.["metadata"] as Record<string, unknown> | undefined,
        attachments: envelope.annotations?.["attachments"] as unknown[] | undefined,
        publishedAt: envelope.appendedAt,
      }),
    ];
  }

  private inspectionRow(envelope: GadChannelEnvelopeView): Record<string, unknown> {
    return {
      seq: envelope.seq,
      envelope_id: envelope.envelopeId,
      payload_kind: envelope.payloadKind,
      payload: JSON.stringify(envelope.payload),
      from_id: envelope.from.participantId ?? envelope.from.id,
      from_json: JSON.stringify(envelope.metadata ?? envelope.from.metadata ?? {}),
      attachments: envelope.attachments ? JSON.stringify(envelope.attachments) : null,
      published_at: Date.parse(envelope.publishedAt),
    };
  }

  private replayFromWindow(
    mode: ChannelReplayEnvelope["mode"],
    window: GadReplayWindow,
    context: ChannelReplayContext
  ): ChannelReplayEnvelope {
    return {
      mode,
      logEvents: window.envelopes.map(
        (envelope): ServerLogEvent => this.eventFromChannelView(envelope)
      ),
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

  private eventFromChannelView(envelope: GadChannelEnvelopeView): ChannelEvent {
    return buildChannelEvent(
      envelope.seq,
      envelope.envelopeId,
      envelope.payloadKind ?? "message",
      JSON.stringify(envelope.payload),
      envelope.from.participantId ?? envelope.from.id,
      envelope.metadata ?? envelope.from.metadata,
      Date.parse(envelope.publishedAt),
      envelope.attachments as StoredAttachment[] | undefined,
      policyAnnotations(
        (envelope as { annotations?: Record<string, unknown> }).annotations
      )
    );
  }

  eventFromLogEnvelope(envelope: LogEnvelope): ChannelEvent {
    const annotations = envelope.annotations ?? {};
    return buildChannelEvent(
      envelope.seq,
      String(envelope.envelopeId),
      envelope.payloadKind,
      JSON.stringify(envelope.payload),
      (envelope.actor as { participantId?: string }).participantId ?? envelope.actor.id,
      (annotations["metadata"] as Record<string, unknown> | undefined) ??
        (envelope.actor as { metadata?: Record<string, unknown> }).metadata,
      Date.parse(envelope.appendedAt),
      annotations["attachments"] as StoredAttachment[] | undefined,
      policyAnnotations(envelope.annotations)
    );
  }

  private async encodePayload(payload: unknown): Promise<unknown> {
    return encodeChannelPayloadStoredValues(payload, {
      putText: (value) =>
        this.rpc.call<{ digest: string; size: number }>("main", "blobstore.putText", [value]),
    });
  }

  private async hydrateReplayWindow(window: GadReplayWindow): Promise<GadReplayWindow> {
    return {
      ...window,
      envelopes: await Promise.all(window.envelopes.map((envelope) => this.hydrate(envelope))),
    };
  }

  private async hydrate<T>(value: T): Promise<T> {
    return hydrateStoredValueRefs(value, {
      getText: (digest) => this.rpc.call<string | null>("main", "blobstore.getText", [digest]),
    }) as Promise<T>;
  }
}
