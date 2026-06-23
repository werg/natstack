/**
 * RPC-based PubSub client.
 *
 * Implements PubSubClient<T> using RPC calls to the manifest-declared channel
 * service DO. Used by panels that communicate through the Electron RPC bridge.
 */

import type {
  ParticipantMetadata,
  Participant,
  RosterUpdate,
  Attachment,
  AttachmentInput,
  ChannelConfig,
  PublishOptions,
  UpdateMetadataOptions,
  PubSubMessage,
  LeaveReason,
  ChannelReplayEnvelope,
  ServerLogEvent,
  BootstrapSnapshot,
  MessageTypeDefinition,
  RegisterMessageTypeInput,
} from "./types.js";
import type { RpcChannelMessage } from "./protocol-wire.js";
import { PubSubError } from "./types.js";
import type {
  IncomingEvent,
  IncomingErrorMessage,
  IncomingSignalEvent,
  IncomingInvocationCallEvent,
  IncomingPresenceEventWithType,
  IncomingAgenticEvent,
  IncomingAgentDebugEvent,
  EventStreamItem,
  EventStreamOptions,
  MethodCallHandle,
  MethodResultChunk,
  MethodResultValue,
  MethodDefinition,
  MethodAdvertisement,
  JsonSchema,
  MethodExecutionContext,
} from "./protocol-types.js";
import {
  AGENTIC_EVENT_PAYLOAD_KIND,
  AGENTIC_PROTOCOL_VERSION,
  CREDENTIAL_CONNECT_PAYLOAD_KIND,
  hydrateStoredValueRefs,
  type AgenticEvent,
  type MessageBlockInput,
  type MessageId,
  type MessageTier,
} from "@workspace/agentic-protocol";
import { AgenticError } from "./protocol-types.js";
import { ErrorMessageSchema, SignalMessageSchema } from "./protocol.js";
import { createFanout } from "./async-queue.js";
import { PARTICIPANT_SESSION_METADATA_KEY } from "./internal-constants.js";
import { base64ToUint8Array } from "./image-utils.js";
import { zodToJsonSchema as convertZodToJsonSchema } from "zod-to-json-schema";
import { z } from "zod";
import type { PubSubClient } from "./client.js";
import type { RecoveryCoordinator } from "@natstack/shared/shell/recoveryCoordinator";

const DEFAULT_CHANNEL_SERVICE_PROTOCOL = "natstack.channel.v1";
/** Wire attachment shape — base64 data string, not Uint8Array. */
interface WireAttachment {
  id: string;
  data: string; // base64
  mimeType: string;
  filename?: string;
  name?: string;
  size: number;
  type?: string;
}

interface ClientIngressMessage {
  stream: "log" | "signal" | "control" | "error";
  phase?: "replay" | "live";
  controlType?: "ready";
  id?: number;
  type?: string;
  payload?: unknown;
  senderId?: string;
  ts?: number;
  ref?: number;
  error?: string;
  attachments?: WireAttachment[];
  senderMetadata?: Record<string, unknown>;
  contextId?: string;
  channelConfig?: ChannelConfig;
  totalCount?: number;
  envelopeCount?: number;
  firstEnvelopeSeq?: number;
  hasMoreBefore?: boolean;
}

interface SubscribeResult {
  ok?: boolean;
  channelConfig?: ChannelConfig;
  envelope?: ChannelReplayEnvelope;
}

interface ResolvedService {
  kind: "durable-object" | "worker";
  targetId?: string;
}

/** Convert wire-format attachments (base64) to client Attachment[] (Uint8Array). */
function convertWireAttachments(wireAtts: WireAttachment[] | undefined): Attachment[] | undefined {
  if (!wireAtts || wireAtts.length === 0) return undefined;
  return wireAtts.map((att) => ({
    id: att.id ?? "",
    data:
      typeof att.data === "string"
        ? base64ToUint8Array(att.data)
        : (att.data as unknown as Uint8Array),
    mimeType: att.mimeType,
    name: att.filename ?? att.name,
    size: att.size,
  }));
}

function eventToClientIngress(
  event: ServerLogEvent,
  phase: "replay" | "live"
): ClientIngressMessage {
  return {
    stream: "log",
    phase,
    id: event.id,
    type: event.type,
    payload: event.payload,
    senderId: event.senderId,
    ts: event.ts,
    senderMetadata: event.senderMetadata,
    attachments: event.attachments as WireAttachment[] | undefined,
  };
}

type PresenceAction = "join" | "leave" | "update";

interface PresencePayload {
  action?: PresenceAction;
  metadata?: Record<string, unknown>;
  leaveReason?: LeaveReason;
}

export interface RpcConnectOptions<T extends ParticipantMetadata = ParticipantMetadata> {
  rpc: {
    call<R = unknown>(targetId: string, method: string, args: unknown[]): Promise<R>;
    on(event: string, listener: (event: { payload: unknown }) => void): () => void;
    selfId: string;
  };
  channel: string;
  contextId?: string;
  channelConfig?: ChannelConfig;
  sinceId?: number;
  replayMessageLimit?: number;
  reconnect?: boolean;
  metadata?: T;
  protocol?: string;
  /** Stable participant id. Panel callers should pass runtime `slotId`, not `rpc.selfId`. */
  clientId?: string;
  name?: string;
  type?: string;
  handle?: string;
  replayMode?: "collect" | "stream" | "skip";
  methods?: Record<string, MethodDefinition>;
  recoveryCoordinator?: Pick<RecoveryCoordinator, "registerColdRecoverHandler">;
}

export function connectViaRpc<T extends ParticipantMetadata = ParticipantMetadata>(
  opts: RpcConnectOptions<T>
): PubSubClient<T> {
  const { rpc, channel, replayMode = "stream", methods: providedMethods } = opts;
  const protocol = opts.protocol ?? DEFAULT_CHANNEL_SERVICE_PROTOCOL;
  const pid = opts.clientId ?? rpc.selfId;
  let doTargetPromise: Promise<string> | null = null;
  const getDoTarget = () => {
    doTargetPromise ??= rpc
      .call<ResolvedService>("main", "workers.resolveService", [protocol, channel])
      .then((service) => {
        if (service.kind !== "durable-object" || !service.targetId) {
          throw new Error("Channel service must resolve to a Durable Object service");
        }
        return service.targetId;
      });
    return doTargetPromise;
  };
  const callChannel = async <R = unknown>(method: string, ...args: unknown[]): Promise<R> =>
    rpc.call<R>(await getDoTarget(), method, args);

  const hydrateStoredTransportValue = async (value: unknown): Promise<unknown> =>
    hydrateStoredValueRefs(value, {
      getText: async (digest) => {
        const text = await rpc.call<string | null>("main", "blobstore.getText", [digest]);
        if (text === null) throw new Error(`Stored transport blob is missing: ${digest}`);
        return text;
      },
    });

  // Convert MethodDefinitions to MethodAdvertisements
  function toMethodAdvertisements(
    methods: Record<string, MethodDefinition>
  ): MethodAdvertisement[] {
    return Object.entries(methods)
      .filter(([, def]) => !def.internal)
      .map(([methodName, def]) => {
        const parameters =
          def.parameters && typeof def.parameters === "object" && !("_def" in def.parameters)
            ? (def.parameters as JsonSchema)
            : (convertZodToJsonSchema(def.parameters as z.ZodTypeAny, {
                target: "openApi3",
              }) as JsonSchema);
        const returns = def.returns
          ? def.returns && typeof def.returns === "object" && !("_def" in def.returns)
            ? (def.returns as JsonSchema)
            : (convertZodToJsonSchema(def.returns as z.ZodTypeAny, {
                target: "openApi3",
              }) as JsonSchema)
          : undefined;
        return {
          name: methodName,
          description: def.description,
          parameters,
          returns,
          streaming: def.streaming,
          menu: def.menu,
        };
      });
  }

  const methodAdvertisements =
    providedMethods && Object.keys(providedMethods).length > 0
      ? toMethodAdvertisements(providedMethods)
      : undefined;

  // State
  let closed = false;
  let lastSeenId: number | undefined = opts.sinceId;
  let serverContextId: string | undefined;
  let serverChannelConfig: ChannelConfig | undefined;
  let serverTotalCount: number | undefined;
  let serverEnvelopeCount: number | undefined;
  let serverFirstEnvelopeSeq: number | undefined;
  let serverHasMoreBefore: boolean | undefined;
  let currentRoster: Record<string, Participant<T>> = {};
  let streamedReplayLogEvents: ServerLogEvent[] = [];
  let streamedReplaySnapshots: BootstrapSnapshot[] = [];

  // Ready promise
  let readyResolve: (() => void) | null = null;
  let readyReject: ((err: Error) => void) | null = null;
  let readyPromise = new Promise<void>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  readyPromise.catch((err) => {
    if (closed) return;
    console.warn("[PubSubClient] Ready promise rejected:", err);
  });

  function resolveReady(): void {
    readyResolve?.();
    readyResolve = null;
    readyReject = null;
  }

  function rejectReady(error: Error): void {
    readyReject?.(error);
    readyResolve = null;
    readyReject = null;
  }

  // Handler sets
  const errorHandlers = new Set<(error: Error) => void>();
  const disconnectHandlers = new Set<() => void>();
  const reconnectHandlers = new Set<() => void>();
  const readyHandlers = new Set<() => void>();
  const rosterHandlers = new Set<(roster: RosterUpdate<T>) => void>();
  const configChangeHandlers = new Set<(config: ChannelConfig) => void>();

  // Events fanout
  const eventsFanout = createFanout<IncomingEvent>();

  // Replay buffering
  let bufferingReplay = replayMode !== "skip";
  let replayComplete = false;
  const replayEvents: IncomingEvent[] = [];
  const replayMessageKeys = new Set<string>();
  const MAX_REPLAY_MESSAGE_KEYS = 2000;

  // Roster dedup
  const rosterOpIds = new Set<number>();
  const MAX_ROSTER_OP_IDS = 1000;

  // Method auto-execution
  const registeredMethods: Record<string, MethodDefinition> = { ...(providedMethods ?? {}) };

  // Track AbortControllers (+ start time) for methods we're executing, keyed by callId. When a caller
  // cancels, we abort the controller so the handler sees signal.aborted; the start time lets us treat
  // a routine redelivery-vs-in-flight race as benign while still surfacing a genuinely WEDGED handler.
  const executingMethods = new Map<string, { controller: AbortController; startedAt: number }>();
  // A redelivery skip is only worth logging when the handler has been running implausibly long (a hung
  // handler), not for the normal at-least-once race against a fast handler.
  const STILL_EXECUTING_WARN_MS = 30_000;
  const submittedMethodTransportCallIds = new Set<string>();
  const MAX_SUBMITTED_METHOD_TRANSPORT_CALL_IDS = 2000;

  function rememberSubmittedMethodTransportCall(transportCallId: string): void {
    submittedMethodTransportCallIds.add(transportCallId);
    if (submittedMethodTransportCallIds.size <= MAX_SUBMITTED_METHOD_TRANSPORT_CALL_IDS) return;
    const overflow =
      submittedMethodTransportCallIds.size - MAX_SUBMITTED_METHOD_TRANSPORT_CALL_IDS;
    const iter = submittedMethodTransportCallIds.values();
    for (let i = 0; i < overflow; i++) {
      const { value } = iter.next();
      if (value !== undefined) submittedMethodTransportCallIds.delete(value);
    }
  }

  // Method call tracking
  interface MethodCallState {
    readonly callId: string;
    readonly invocationId: string;
    readonly transportCallId: string;
    readonly stream: ReturnType<typeof createFanout<MethodResultChunk>>;
    readonly resolve: (value: MethodResultValue) => void;
    readonly reject: (error: Error) => void;
    complete: boolean;
    isError: boolean;
  }
  const methodCallStates = new Map<string, MethodCallState>();
  const methodResultChains = new Map<string, Promise<void>>();

  // Stable for the lifetime of this client instance. Re-subscribe attempts
  // reuse it; a panel reload creates a new one.
  const participantSessionId = crypto.randomUUID();

  function handleError(error: PubSubError): void {
    for (const handler of errorHandlers) handler(error);
  }

  function normalizeSenderMetadata(
    meta: Record<string, unknown> | undefined
  ): { name?: string; type?: string; handle?: string } | undefined {
    if (!meta) return undefined;
    const result: { name?: string; type?: string; handle?: string } = {};
    if (typeof meta["name"] === "string") result.name = meta["name"] as string;
    if (typeof meta["type"] === "string") result.type = meta["type"] as string;
    if (typeof meta["handle"] === "string") result.handle = meta["handle"] as string;
    return Object.keys(result).length > 0 ? result : undefined;
  }

  function parseIncoming(pubsubMsg: PubSubMessage): IncomingEvent | null {
    const {
      type: msgType,
      payload,
      attachments: msgAttachments,
      senderId,
      ts,
      delivery,
      phase,
      id: pubsubId,
      senderMetadata,
    } = pubsubMsg;
    const normalizedSender = normalizeSenderMetadata(senderMetadata);

    if (msgType === "error") {
      const parsed = ErrorMessageSchema.safeParse(payload);
      if (!parsed.success) return null;
      return {
        type: "error",
        delivery,
        phase,
        senderId,
        ts,
        attachments: msgAttachments,
        pubsubId,
        senderMetadata: normalizedSender,
        id: parsed.data.id,
        error: parsed.data.error,
        code: parsed.data.code,
      } as IncomingErrorMessage;
    }

    if (msgType === "signal") {
      const parsed = SignalMessageSchema.safeParse(payload);
      if (!parsed.success) return null;
      return {
        type: "signal",
        delivery,
        phase,
        senderId,
        ts,
        attachments: msgAttachments,
        pubsubId,
        senderMetadata: normalizedSender,
        content: parsed.data.content,
        contentType: parsed.data.contentType,
      } as IncomingSignalEvent;
    }

    if (msgType === AGENTIC_EVENT_PAYLOAD_KIND) {
      const event = payload as AgenticEvent | undefined;
      if (!event || typeof event !== "object") return null;
      return {
        type: AGENTIC_EVENT_PAYLOAD_KIND,
        delivery,
        phase,
        senderId,
        ts,
        attachments: msgAttachments,
        pubsubId,
        senderMetadata: normalizedSender,
        payload: event,
      } as IncomingAgenticEvent;
    }

    if (msgType === CREDENTIAL_CONNECT_PAYLOAD_KIND) {
      if (!payload || typeof payload !== "object") return null;
      return {
        type: CREDENTIAL_CONNECT_PAYLOAD_KIND,
        delivery,
        phase,
        senderId,
        ts,
        attachments: msgAttachments,
        pubsubId,
        senderMetadata: normalizedSender,
        payload,
      } as IncomingEvent;
    }

    if (msgType === "presence") {
      const presencePayload = payload as {
        action?: string;
        metadata?: Record<string, unknown>;
        leaveReason?: string;
      };
      if (!presencePayload.action || !presencePayload.metadata) return null;
      return {
        type: "presence",
        delivery,
        phase,
        senderId,
        ts,
        pubsubId,
        senderMetadata: normalizedSender,
        action: presencePayload.action,
        leaveReason: presencePayload.leaveReason,
        metadata: presencePayload.metadata,
      } as IncomingPresenceEventWithType;
    }

    if (msgType === "agent-debug") {
      return {
        type: "agent-debug",
        delivery,
        phase,
        senderId,
        ts,
        pubsubId,
        senderMetadata: normalizedSender,
        payload,
      } as unknown as IncomingAgentDebugEvent;
    }

    return null;
  }

  function invocationCallFromAgenticEvent(
    event: IncomingAgenticEvent
  ): IncomingInvocationCallEvent | null {
    const payload = event.payload;
    if (payload.kind !== "invocation.started") return null;
    const invocationId = payload.causality?.invocationId;
    if (typeof invocationId !== "string" || invocationId.length === 0) return null;
    const invocationPayload = (payload as AgenticEvent<"invocation.started">).payload;
    if (!("name" in invocationPayload)) return null;
    const transport = invocationPayload.transport;
    if (!transport || transport.kind !== "channel") return null;
    const transportCallId =
      transport.transportCallId ?? payload.causality?.transportCallId ?? invocationId;
    const providerId = transport.target.participantId ?? transport.target.id;
    return {
      type: "invocation-call",
      delivery: event.delivery,
      phase: event.phase,
      senderId: event.senderId,
      ts: event.ts,
      pubsubId: event.pubsubId,
      senderMetadata: event.senderMetadata,
      callId: transportCallId,
      invocationId,
      transportCallId,
      turnId: payload.turnId,
      methodName: invocationPayload.name,
      providerId,
      args: invocationPayload.request,
      ...(typeof (transport as { deadlineAt?: unknown }).deadlineAt === "number"
        ? { deadlineAt: (transport as { deadlineAt: number }).deadlineAt }
        : {}),
    } as IncomingInvocationCallEvent;
  }

  function replayDedupeKey(msg: ClientIngressMessage): string | null {
    if (msg.stream !== "log" || msg.phase !== "replay") return null;
    if (msg.id !== undefined) {
      return `${msg.id}:${msg.type ?? ""}:${msg.senderId ?? ""}`;
    }
    if (msg.type === "presence" && msg.senderId) {
      return `snapshot:${msg.type}:${msg.senderId}`;
    }
    return null;
  }

  function rememberReplayMessage(msg: ClientIngressMessage): boolean {
    const key = replayDedupeKey(msg);
    if (!key) return true;
    if (replayMessageKeys.has(key)) return false;
    replayMessageKeys.add(key);
    if (replayMessageKeys.size > MAX_REPLAY_MESSAGE_KEYS) {
      const toRemove = replayMessageKeys.size - (MAX_REPLAY_MESSAGE_KEYS - 400);
      const iter = replayMessageKeys.values();
      for (let i = 0; i < toRemove; i++) {
        const { value } = iter.next();
        if (value !== undefined) replayMessageKeys.delete(value);
      }
    }
    return true;
  }

  function handleServerMessage(msg: ClientIngressMessage): void {
    if (!rememberReplayMessage(msg)) return;

    switch (msg.stream) {
      case "control": {
        if (msg.controlType !== "ready") break;
        if (typeof msg.contextId === "string") serverContextId = msg.contextId;
        if (msg.channelConfig) serverChannelConfig = msg.channelConfig;
        if (typeof msg.totalCount === "number") serverTotalCount = msg.totalCount;
        if (typeof msg.envelopeCount === "number") serverEnvelopeCount = msg.envelopeCount;
        if (typeof msg.firstEnvelopeSeq === "number") {
          serverFirstEnvelopeSeq = msg.firstEnvelopeSeq;
        } else {
          serverFirstEnvelopeSeq = undefined;
        }
        serverHasMoreBefore =
          typeof msg.hasMoreBefore === "boolean" ? msg.hasMoreBefore : undefined;

        if (replayComplete) {
          break;
        }

        bufferingReplay = false;
        replayComplete = true;

        resolveReady();
        for (const handler of readyHandlers) handler();
        break;
      }

      case "error": {
        const errorMsg = msg.error || "unknown server error";
        const error = new PubSubError(errorMsg, "server");
        if (!replayComplete) rejectReady(error);
        handleError(error);
        break;
      }

      case "log":
      case "signal": {
        if (msg.id !== undefined) {
          lastSeenId = msg.id;
          if (msg.id > 0) lastSeenSeq = msg.id;
        }

        // Method lifecycle (caller settle / provider abort) runs first, before
        // the replayMode:skip short-circuit — a cold reconnect must still settle
        // in-flight calls from replayed invocation.* events.
        if (msg.stream === "log" && msg.type === AGENTIC_EVENT_PAYLOAD_KIND) {
          handleInvocationLifecycle(msg.payload, convertWireAttachments(msg.attachments));
        }

        if (msg.stream === "log" && msg.phase === "replay" && replayMode === "skip") {
          break;
        }

        const isPresence = msg.type === "presence";
        if (msg.type === "config-update" && msg.payload && typeof msg.payload === "object") {
          serverChannelConfig = msg.payload as ChannelConfig;
          for (const handler of configChangeHandlers) handler(serverChannelConfig);
        }

        // Roster dedup
        if (isPresence && msg.id !== undefined) {
          if (rosterOpIds.has(msg.id)) return;
          rosterOpIds.add(msg.id);
          if (rosterOpIds.size > MAX_ROSTER_OP_IDS) {
            const toRemove = rosterOpIds.size - (MAX_ROSTER_OP_IDS - 200);
            const iter = rosterOpIds.values();
            for (let i = 0; i < toRemove; i++) {
              const { value } = iter.next();
              if (value !== undefined) rosterOpIds.delete(value);
            }
          }
        }

        if (isPresence) {
          const payload = msg.payload as PresencePayload;
          const presenceAction = payload?.action;

          if (presenceAction === "join" || presenceAction === "update") {
            if (payload?.metadata) {
              currentRoster = {
                ...currentRoster,
                [msg.senderId!]: { id: msg.senderId!, metadata: payload.metadata as T },
              };
            }
          } else if (presenceAction === "leave") {
            const { [msg.senderId!]: _removed, ...rest } = currentRoster;
            currentRoster = rest;
          }

          if (presenceAction) {
            const rosterUpdate: RosterUpdate<T> = {
              participants: currentRoster,
              ts: msg.ts ?? Date.now(),
              change: {
                type: presenceAction,
                participantId: msg.senderId!,
                metadata: payload?.metadata,
                ...(presenceAction === "leave" &&
                  payload?.leaveReason && { leaveReason: payload.leaveReason }),
              },
              ...(presenceAction === "leave" &&
                msg.senderId && {
                  leaves: {
                    [msg.senderId]: { leaveReason: payload?.leaveReason },
                  },
                }),
            };
            for (const handler of rosterHandlers) handler(rosterUpdate);
          }
        }

        // Build PubSubMessage for events infrastructure.
        // Convert wire-format attachments (base64) to client format (Uint8Array).
        const pubsubMsg: PubSubMessage = {
          delivery: msg.stream,
          phase: msg.phase,
          id: msg.id,
          type: msg.type!,
          payload: msg.payload,
          senderId: msg.senderId!,
          ts: msg.ts!,
          attachments: convertWireAttachments(msg.attachments),
          senderMetadata: msg.senderMetadata,
        };

        const event = parseIncoming(pubsubMsg);
        if (event) {
          const invocationCallEvent =
            event.type === AGENTIC_EVENT_PAYLOAD_KIND
              ? invocationCallFromAgenticEvent(event)
              : null;

          // Auto-execute method calls targeting this client
          if (invocationCallEvent && event.phase !== "replay") {
            handleMethodCallExec(invocationCallEvent).catch((err) =>
              console.error(`[RpcPubSubClient] Method execution failed:`, err)
            );
          }

          // Buffer replay events until the initial ready boundary. If ready was
          // resolved from the subscribe acknowledgment because the ready event
          // was not delivered, late replay events are surfaced directly instead
          // of being stranded in a replay buffer with no future ready boundary.
          if (event.phase === "replay") {
            if (replayComplete) {
              if (replayMode !== "skip") replayEvents.push(event);
              eventsFanout.emit(event);
            } else if (replayMode !== "skip") {
              if (!bufferingReplay) {
                bufferingReplay = true;
              }
              replayEvents.push(event);
            }
          } else {
            // Emit live events
            eventsFanout.emit(event);
          }
        }

        break;
      }
    }
  }

  function applyRosterSnapshot(snapshot: BootstrapSnapshot): void {
    if (snapshot.kind !== "roster-snapshot") return;
    currentRoster = {};
    for (const participant of snapshot.participants) {
      currentRoster[participant.id] = { id: participant.id, metadata: participant.metadata as T };
    }
    for (const handler of rosterHandlers) {
      handler({ participants: currentRoster, ts: snapshot.ts });
    }
  }

  function ingestReplayEnvelope(envelope: ChannelReplayEnvelope, _source: "stream" | "ack"): void {
    if (replayComplete) return;
    if (replayMode !== "skip") {
      for (const event of envelope.logEvents) {
        handleServerMessage(eventToClientIngress(event, "replay"));
      }
      for (const snapshot of envelope.snapshots) {
        applyRosterSnapshot(snapshot);
      }
    } else {
      // Skip drops user-facing replay, but still settle in-flight method calls
      // from replayed invocation.* lifecycle events.
      for (const event of envelope.logEvents) {
        if (isInvocationLifecycleEvent(event)) {
          handleServerMessage(eventToClientIngress(event, "replay"));
        }
      }
    }
    handleServerMessage({
      stream: "control",
      controlType: "ready",
      contextId: envelope.ready.contextId,
      channelConfig: envelope.ready.channelConfig,
      totalCount: envelope.ready.totalCount,
      envelopeCount: envelope.ready.envelopeCount,
      firstEnvelopeSeq: envelope.ready.firstEnvelopeSeq,
      hasMoreBefore: envelope.ready.hasMoreBefore,
    });
    streamedReplayLogEvents = [];
    streamedReplaySnapshots = [];
  }

  function applySubscribeAckFallback(result: SubscribeResult | undefined): void {
    if (!result?.envelope || replayComplete) return;
    ingestReplayEnvelope(result.envelope, "ack");
  }

  /** True for the durable method-lifecycle events the channel emits. */
  function isInvocationLifecycleEvent(event: ServerLogEvent): boolean {
    if (event.type !== AGENTIC_EVENT_PAYLOAD_KIND) return false;
    const kind = (event.payload as { kind?: string } | undefined)?.kind;
    return (
      kind === "invocation.output" ||
      kind === "invocation.completed" ||
      kind === "invocation.failed" ||
      kind === "invocation.cancelled" ||
      kind === "invocation.abandoned"
    );
  }

  /**
   * Settle a pending `callMethod` (caller role) or abort an executing method
   * (provider role) from a durable `invocation.*` log event. This replaces the
   * removed method-`*` wire transports. The feedback-cancel UX is handled
   * separately by observing `invocation.cancelled` on the events stream (see
   * useChatFeedback).
   */
  function handleInvocationLifecycle(
    payload: unknown,
    attachments: Attachment[] | undefined
  ): void {
    const ev = payload as
      | { kind?: string; causality?: { invocationId?: string; transportCallId?: string }; payload?: Record<string, unknown> }
      | undefined;
    if (!ev || typeof ev !== "object") return;
    const kind = ev.kind;
    const callId = ev.causality?.transportCallId ?? ev.causality?.invocationId;
    if (!callId) return;
    const body = ev.payload ?? {};

    // Caller: settle / stream a pending callMethod.
    if (methodCallStates.has(callId)) {
      if (kind === "invocation.output") {
        void enqueueMethodResultChunk({
          callId,
          content: body["output"],
          complete: false,
          isError: false,
          ...(attachments ? { attachments } : {}),
        });
      } else if (
        kind === "invocation.completed" ||
        kind === "invocation.failed" ||
        kind === "invocation.cancelled" ||
        kind === "invocation.abandoned"
      ) {
        const isError = kind !== "invocation.completed";
        const content = isError ? (body["error"] ?? body["reason"]) : body["result"];
        void enqueueMethodResultChunk({
          callId,
          content,
          complete: true,
          isError,
          ...(attachments ? { attachments } : {}),
        });
      }
    }

    // Provider: abort the executing method on cancel/abandon (completion facts
    // are not abort commands). Methods that ignore ctx.signal (e.g. feedback)
    // are resolved by their own observation of invocation.cancelled.
    if (
      (kind === "invocation.cancelled" || kind === "invocation.abandoned") &&
      executingMethods.has(callId)
    ) {
      abortExecutingMethod(callId);
    }
  }

  async function applyMethodResultChunk(result: {
    callId: string;
    content: unknown;
    complete: boolean;
    isError: boolean;
    attachments?: Attachment[];
  }): Promise<void> {
    const state = methodCallStates.get(result.callId);
    if (!state) return;

    let content: unknown;
    try {
      content = await hydrateStoredTransportValue(result.content);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      state.complete = true;
      state.isError = true;
      state.stream.close(error);
      state.reject(new AgenticError(error.message, "execution-error", error));
      methodCallStates.delete(result.callId);
      return;
    }

    const chunk: MethodResultChunk = {
      content,
      ...(result.attachments ? { attachments: result.attachments } : {}),
      complete: result.complete,
      isError: result.isError,
    };

    state.stream.emit(chunk);

    if (!chunk.complete) return;

    state.complete = true;
    state.isError = chunk.isError;
    state.stream.close();

    if (chunk.isError) {
      const content = chunk.content;
      let errorMsg = "method execution failed";
      if (
        content &&
        typeof content === "object" &&
        typeof (content as Record<string, unknown>)["error"] === "string"
      ) {
        errorMsg = (content as Record<string, unknown>)["error"] as string;
      } else if (typeof content === "string" && content.length > 0) {
        errorMsg = content;
      }
      state.reject(new AgenticError(errorMsg, "execution-error", content));
    } else {
      state.resolve({
        content: chunk.content,
        ...(chunk.attachments ? { attachments: chunk.attachments } : {}),
      });
    }
    methodCallStates.delete(result.callId);
  }

  function enqueueMethodResultChunk(
    result: Parameters<typeof applyMethodResultChunk>[0]
  ): Promise<void> {
    const previous = methodResultChains.get(result.callId) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(() => applyMethodResultChunk(result));
    methodResultChains.set(result.callId, next);
    void next
      .catch((err) => {
        const error = err instanceof Error ? err : new Error(String(err));
        console.warn(
          `[PubSubClient] Failed to apply method result chunk for ${result.callId}:`,
          error
        );
      })
      .finally(() => {
        if (methodResultChains.get(result.callId) === next) {
          methodResultChains.delete(result.callId);
        }
      });
    return next;
  }

  async function submitMethodResult(
    invocationId: string,
    transportCallId: string,
    content: unknown,
    isError: boolean,
    opts?: {
      turnId?: string;
      terminalOutcome?: string;
      terminalReasonCode?: string;
      attachments?: AttachmentInput[];
    }
  ): Promise<boolean> {
    if (!pid) {
      throw new Error(
        `Cannot submit result for invocation ${invocationId}: pubsub client is disconnected`
      );
    }
    const response = await callChannel<{ id?: number } | undefined>(
      "submitMethodResult",
      pid,
      transportCallId,
      content,
      isError,
      {
        invocationId,
        ...(opts?.turnId ? { turnId: opts.turnId } : {}),
        ...(opts?.terminalOutcome ? { terminalOutcome: opts.terminalOutcome } : {}),
        ...(opts?.terminalReasonCode ? { terminalReasonCode: opts.terminalReasonCode } : {}),
        ...(opts?.attachments ? { attachments: toStoredAttachments(opts.attachments) } : {}),
      }
    );
    return typeof response?.id === "number";
  }

  async function submitMethodProgress(
    invocationId: string,
    transportCallId: string,
    content: unknown,
    opts?: {
      turnId?: string;
      attachments?: AttachmentInput[];
    }
  ): Promise<void> {
    if (!pid) {
      throw new Error(
        `Cannot submit progress for invocation ${invocationId}: pubsub client is disconnected`
      );
    }
    await callChannel("submitMethodProgress", pid, transportCallId, content, {
      invocationId,
      ...(opts?.turnId ? { turnId: opts.turnId } : {}),
      ...(opts?.attachments ? { attachments: toStoredAttachments(opts.attachments) } : {}),
    });
  }

  async function handleMethodCallExec(event: IncomingInvocationCallEvent): Promise<void> {
    if (!pid || event.providerId !== pid) return;
    if (
      executingMethods.has(event.transportCallId) ||
      submittedMethodTransportCallIds.has(event.transportCallId)
    ) {
      // Redelivery while a previous execution is still running (or already terminally submitted). This
      // is the at-least-once delivery racing our in-flight (or just-settled) handler — the dedup is
      // working and it's benign in the normal case. Only a handler still running WELL past any sane
      // settle time is a real signal (a hung handler), so stay quiet for the routine race and warn
      // only past the wedge threshold — so a genuine wedge stands out instead of drowning in noise.
      const executing = executingMethods.get(event.transportCallId);
      const elapsed = executing ? Date.now() - executing.startedAt : 0;
      if (elapsed > STILL_EXECUTING_WARN_MS) {
        console.warn(
          `[PubSub] Method ${event.methodName} (${event.transportCallId}) still executing after ` +
            `${Math.round(elapsed / 1000)}s — possible hung handler; skipping redelivery`
        );
      }
      return;
    }

    const methodDef = registeredMethods[event.methodName];
    if (!methodDef) {
      try {
        const accepted = await submitMethodResult(
          event.invocationId,
          event.transportCallId,
          `Method "${event.methodName}" not registered on this client`,
          true,
          {
            turnId: event.turnId,
            terminalOutcome: "tool_error",
            terminalReasonCode: "method_not_registered",
          }
        );
        if (accepted) rememberSubmittedMethodTransportCall(event.transportCallId);
      } catch {
        /* best effort */
      }
      return;
    }

    // Single-clock discipline (CH-3): only a journaled deadlineAt can impose
    // a call lifetime. Calls without a deadline can legitimately wait on a
    // human or a long-running agentic continuation.
    const remainingMs =
      typeof event.deadlineAt === "number" ? event.deadlineAt - Date.now() : null;
    if (remainingMs !== null && remainingMs <= 1_000) {
      // Redelivered at/after its deadline: executing now can't beat the
      // channel's own expiry; let the channel settle it.
      console.warn(
        `[PubSub] Skipping method call ${event.methodName} (${event.transportCallId}): ` +
          `journaled deadline already ${remainingMs <= 0 ? "passed" : "imminent"}`
      );
      return;
    }

    const abortController = new AbortController();
    executingMethods.set(event.transportCallId, {
      controller: abortController,
      startedAt: Date.now(),
    });
    let terminalSubmitted = false;
    const pendingStreamSubmissions = new Set<Promise<void>>();
    const trackStreamSubmission = (promise: Promise<void>): Promise<void> => {
      pendingStreamSubmissions.add(promise);
      void promise
        .catch(() => undefined)
        .finally(() => pendingStreamSubmissions.delete(promise));
      return promise;
    };
    const drainStreamSubmissions = async (): Promise<void> => {
      while (pendingStreamSubmissions.size > 0) {
        const batch = [...pendingStreamSubmissions];
        const results = await Promise.allSettled(batch);
        for (const result of results) {
          if (result.status === "rejected") {
            console.warn(
              `[PubSub] Failed to submit method progress for ${event.methodName} ` +
                `(${event.transportCallId}):`,
              result.reason
            );
          }
        }
      }
    };
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    if (remainingMs !== null) {
      watchdog = setTimeout(() => {
        if (terminalSubmitted) return;
        console.warn(
          `[PubSub] Method ${event.methodName} (${event.transportCallId}) did not settle ` +
            `before its journaled deadline — aborting and reporting timeout to the channel`
        );
        abortController.abort();
        void submitMethodResult(
          event.invocationId,
          event.transportCallId,
          `Method "${event.methodName}" reached its journaled deadline`,
          true,
          {
            turnId: event.turnId,
            terminalOutcome: "tool_error",
            terminalReasonCode: "method_execution_timeout",
          }
        )
          .then((accepted) => {
            terminalSubmitted = accepted;
            if (accepted) rememberSubmittedMethodTransportCall(event.transportCallId);
          })
          .catch((e) =>
            console.error(
              `[PubSub] Failed to submit watchdog timeout for ${event.methodName} ` +
                `(${event.transportCallId}) — a later redelivery may retry it:`,
              e
            )
          )
          .finally(() => {
            executingMethods.delete(event.transportCallId);
          });
      }, remainingMs);
    }
    const ctx: MethodExecutionContext = {
      callId: event.callId,
      invocationId: event.invocationId,
      transportCallId: event.transportCallId,
      callerId: event.senderId,
      signal: abortController.signal,
      stream: async (content: unknown) => {
        await trackStreamSubmission(
          submitMethodProgress(event.invocationId, event.transportCallId, content, {
            turnId: event.turnId,
          })
        );
      },
      streamWithAttachments: async (
        content: unknown,
        attachments: AttachmentInput[]
      ) => {
        await trackStreamSubmission(
          submitMethodProgress(event.invocationId, event.transportCallId, content, {
            turnId: event.turnId,
            attachments,
          })
        );
      },
      resultWithAttachments: <R>(
        content: R,
        attachments: AttachmentInput[]
      ) => ({
        content,
        attachments,
      }),
    };

    try {
      let args = await hydrateStoredTransportValue(event.args);
      if (methodDef.parameters && "_def" in methodDef.parameters) {
        args = (methodDef.parameters as z.ZodTypeAny).parse(args);
      }

      const result = await methodDef.execute(args, ctx);
      await drainStreamSubmissions();
      if (abortController.signal.aborted) {
        terminalSubmitted = await submitMethodResult(
          event.invocationId,
          event.transportCallId,
          "cancelled",
          true,
          {
            turnId: event.turnId,
            terminalOutcome: "cancelled",
            terminalReasonCode: "cancelled",
          }
        );
        return;
      }

      if (
        result &&
        typeof result === "object" &&
        "attachments" in (result as Record<string, unknown>) &&
        "content" in (result as Record<string, unknown>)
      ) {
        const withAttachments = result as {
          content: unknown;
          attachments: AttachmentInput[];
        };
        terminalSubmitted = await submitMethodResult(
          event.invocationId,
          event.transportCallId,
          withAttachments.content,
          false,
          {
            turnId: event.turnId,
            attachments: withAttachments.attachments,
          }
        );
      } else {
        terminalSubmitted = await submitMethodResult(
          event.invocationId,
          event.transportCallId,
          result,
          false,
          { turnId: event.turnId }
        );
      }
    } catch (err) {
      await drainStreamSubmissions();
      const errorMsg = err instanceof Error ? err.message : String(err);
      const aborted = abortController.signal.aborted;
      await submitMethodResult(
        event.invocationId,
        event.transportCallId,
        errorMsg || (aborted ? "cancelled" : "method execution failed"),
        true,
        {
          turnId: event.turnId,
          terminalOutcome: aborted ? "cancelled" : "tool_error",
          terminalReasonCode: aborted ? "cancelled" : "eval_exception",
        }
      )
        .then((accepted) => {
          terminalSubmitted = accepted;
        })
        .catch((e) =>
          // If even this fallback terminal cannot be submitted, the caller's
          // pending call would be stranded. The channel settles it on its side
          // when the event is malformed; log with enough context to trace a
          // transport-level failure here.
          console.error(
            `[PubSub] Failed to publish auto-execution error for ` +
              `method=${event.methodName} transportCallId=${event.transportCallId}:`,
            e
          )
        );
    } finally {
      if (watchdog) clearTimeout(watchdog);
      executingMethods.delete(event.transportCallId);
      if (terminalSubmitted) rememberSubmittedMethodTransportCall(event.transportCallId);
    }
  }

  function toStoredAttachments(
    attachments: AttachmentInput[]
  ): Array<{ id: string; data: string; mimeType: string; name?: string; size: number }> {
    return attachments.map((a, i) => ({
      id: `att_${i}`,
      data: uint8ArrayToBase64(a.data),
      mimeType: a.mimeType,
      name: a.name,
      size: a.data.length,
    }));
  }

  function uint8ArrayToBase64(bytes: Uint8Array): string {
    let binary = "";
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]!);
    }
    return btoa(binary);
  }

  // Phase 2C: Gap detection state
  let lastSeenSeq: number | undefined = opts.sinceId;
  let repairingGap = false;
  const gapBuffer: ClientIngressMessage[] = [];
  const MAX_GAP_SIZE = 500;

  // Register event listener for channel messages
  const removeEventListener = rpc.on("channel:message", (event: { payload: unknown }) => {
    if (closed) return;
    const data = event.payload as { channelId?: string; message?: RpcChannelMessage };
    if (data.channelId !== channel) return;
    if (data.message) {
      const raw = data.message;
      if (raw.kind === "control" && raw.type === "ready" && raw.ready) {
        if (!replayComplete) {
          ingestReplayEnvelope(
            {
              mode: opts.sinceId && opts.sinceId > 0 ? "after" : "initial",
              logEvents: streamedReplayLogEvents,
              snapshots: streamedReplaySnapshots,
              ready: raw.ready,
            },
            "stream"
          );
        } else {
          handleServerMessage({
            stream: "control",
            controlType: "ready",
            contextId: raw.ready.contextId,
            channelConfig: raw.ready.channelConfig,
            totalCount: raw.ready.totalCount,
            envelopeCount: raw.ready.envelopeCount,
            firstEnvelopeSeq: raw.ready.firstEnvelopeSeq,
            hasMoreBefore: raw.ready.hasMoreBefore,
          });
        }
        return;
      }
      if (raw.kind === "control" && raw.type === "roster-snapshot") {
        const snapshot: BootstrapSnapshot = {
          kind: "roster-snapshot",
          participants: raw.participants ?? [],
          ts: raw.ts ?? Date.now(),
        };
        if (replayMode === "skip" && !replayComplete) return;
        if (!replayComplete) {
          streamedReplaySnapshots.push(snapshot);
        } else {
          applyRosterSnapshot(snapshot);
        }
        return;
      }
      if (raw.kind === "log" && raw.phase === "replay" && raw.event && !replayComplete) {
        if (replayMode === "skip") {
          // Skip drops user-facing replay, but still settle in-flight method
          // calls from replayed invocation.* lifecycle events.
          if (isInvocationLifecycleEvent(raw.event)) {
            handleServerMessage(eventToClientIngress(raw.event, "replay"));
          }
          return;
        }
        streamedReplayLogEvents.push(raw.event);
        return;
      }
      const msg: ClientIngressMessage | null =
        raw.kind === "log" && raw.event
          ? eventToClientIngress(raw.event, raw.phase === "replay" ? "replay" : "live")
          : raw.kind === "signal"
            ? {
                stream: "signal",
                type: raw.type,
                payload: raw.payload,
                senderId: raw.senderId,
                ts: raw.ts,
              }
            : null;
      if (!msg) return;

      // Buffer events that arrive during gap repair — process them after the gap is filled
      if (repairingGap) {
        gapBuffer.push(msg);
        return;
      }

      // Phase 2C: Gap detection for persisted messages
      if (msg.id !== undefined && msg.id > 0 && lastSeenSeq !== undefined) {
        if (msg.id > lastSeenSeq + 1) {
          const gap = msg.id - lastSeenSeq - 1;
          if (gap <= MAX_GAP_SIZE) {
            repairingGap = true;
            callChannel<ChannelReplayEnvelope>("getReplayAfter", lastSeenSeq)
              .then((envelope) => {
                for (const evt of envelope.logEvents) {
                  if (evt.id !== undefined && lastSeenSeq !== undefined && evt.id <= lastSeenSeq)
                    continue;
                  handleServerMessage(eventToClientIngress(evt, "live"));
                }
              })
              .catch((err) => {
                console.warn("[RpcPubSubClient] Gap repair failed:", err);
              })
              .finally(() => {
                repairingGap = false;
                // Process the triggering message, then any buffered events
                handleServerMessage(msg);
                const buffered = gapBuffer.splice(0);
                for (const bufferedMsg of buffered) {
                  handleServerMessage(bufferedMsg);
                }
              });
            return;
          } else {
            console.warn(`[RpcPubSubClient] Gap too large (${gap} events), skipping repair`);
          }
        }
      }
      if (msg.id !== undefined && msg.id > 0) {
        lastSeenSeq = msg.id;
      }
      handleServerMessage(msg);
    }
  });

  // Subscribe to channel
  const subscribeMetadata: Record<string, unknown> = {
    name: opts.name,
    type: opts.type,
    handle: opts.handle,
    [PARTICIPANT_SESSION_METADATA_KEY]: participantSessionId,
    contextId: opts.contextId,
    channelConfig: opts.channelConfig ? opts.channelConfig : undefined,
    replay: replayMode !== "skip",
    replayMessageLimit: opts.replayMessageLimit ?? 1000,
    sinceId: opts.sinceId,
    ...(opts.metadata ? opts.metadata : {}),
  };
  if (methodAdvertisements) subscribeMetadata["methods"] = methodAdvertisements;

  // Heartbeat to prevent stale participant eviction
  const TOUCH_INTERVAL_MS = 60_000; // 1 minute
  let consecutiveTouchFailures = 0;
  let reconnecting = false;
  let reconnectAttempts = 0;
  const MAX_RECONNECT_ATTEMPTS = 5;

  async function attemptResubscription(): Promise<void> {
    if (reconnecting || closed) return;
    reconnecting = true;
    reconnectAttempts++;
    if (reconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
      handleError(new PubSubError("Max reconnection attempts exceeded", "connection"));
      reconnecting = false;
      return;
    }
    if (closed) {
      reconnecting = false;
      return;
    }
    try {
      // Best-effort unsubscribe old session
      await callChannel("unsubscribe", pid).catch((err) => {
        console.warn(`[PubSubClient] Failed to unsubscribe stale session ${pid}:`, err);
      });
      // Reset local roster and presence dedup state so replayed presence events are accepted
      currentRoster = {};
      rosterOpIds.clear();
      replayMessageKeys.clear();
      replayEvents.length = 0;
      bufferingReplay = replayMode !== "skip";
      replayComplete = false;
      // Re-subscribe with sinceId for catch-up replay
      const resubMeta = { ...subscribeMetadata, sinceId: lastSeenSeq, replay: true };
      const result = await callChannel<SubscribeResult | undefined>("subscribe", pid, resubMeta);
      applySubscribeAckFallback(result);
      // In-flight method calls are recovered from replayed invocation.* events
      // (handleInvocationLifecycle), not a settled-results read-back.
      consecutiveTouchFailures = 0;
      reconnectAttempts = 0;
      reconnecting = false;
      for (const handler of reconnectHandlers) handler();
    } catch (err) {
      console.error("[RpcPubSubClient] Resubscription failed:", err);
      reconnecting = false;
      // Try again on next heartbeat failure
    }
  }

  const unregisterColdRecover = opts.recoveryCoordinator?.registerColdRecoverHandler(
    `pubsub:${channel}:${pid}`,
    attemptResubscription
  );

  const touchInterval = setInterval(() => {
    if (closed) return;
    callChannel("touch", pid)
      .then(() => {
        consecutiveTouchFailures = 0;
      })
      .catch((err) => {
        consecutiveTouchFailures++;
        if (consecutiveTouchFailures >= 3) {
          console.error(`[PubSub] Heartbeat failed ${consecutiveTouchFailures} times:`, err);
          handleError(
            new PubSubError("Channel heartbeat failing — connection may be lost", "connection")
          );
          // Phase 3A: Auto-resubscribe
          void attemptResubscription();
        }
      });
  }, TOUCH_INTERVAL_MS);

  // Fire subscribe. Replay normally arrives through ordered channel events; the
  // result also carries the same ordered initial replay as a fallback so losing
  // the ready event does not let ready resolve ahead of replay delivery.
  callChannel<SubscribeResult | undefined>("subscribe", pid, subscribeMetadata)
    .then((result) => {
      applySubscribeAckFallback(result);
    })
    .catch((err: unknown) => {
      const error = err instanceof Error ? err : new Error(String(err));
      clearInterval(touchInterval);
      const pubsubError = new PubSubError(error.message, "connection");
      rejectReady(pubsubError);
      handleError(pubsubError);
    });

  // ── Public API ──────────────────────────────────────────────────────────

  async function ready(signal?: AbortSignal): Promise<void> {
    if (replayComplete) return;
    if (closed) throw new PubSubError("connection closed before ready", "connection");
    if (!signal) return readyPromise;
    if (signal.aborted) throw new PubSubError("ready aborted", "connection");

    return new Promise<void>((resolve, reject) => {
      const onAbort = () => reject(new PubSubError("ready aborted", "connection"));
      signal.addEventListener("abort", onAbort, { once: true });
      readyPromise.then(
        () => {
          signal.removeEventListener("abort", onAbort);
          resolve();
        },
        (error) => {
          signal.removeEventListener("abort", onAbort);
          reject(error);
        }
      );
    });
  }

  async function publish<P>(
    type: string,
    payload: P,
    publishOptions: PublishOptions = {}
  ): Promise<number | undefined> {
    if (closed) throw new PubSubError("not connected", "connection");
    const { attachments, idempotencyKey } = publishOptions;

    const result = await callChannel<{ id?: number }>("publish", pid, type, payload, {
      ref: undefined,
      senderMetadata: undefined,
      attachments: attachments ? toStoredAttachments(attachments) : undefined,
      idempotencyKey,
    });
    return result?.id;
  }

  async function updateMetadata(
    newMetadata: Partial<T>,
    updateOptions: UpdateMetadataOptions = {}
  ): Promise<void> {
    await callChannel("updateMetadata", pid, newMetadata);
  }

  async function setTyping(active: boolean): Promise<void> {
    await callChannel("setTypingState", pid, active);
  }

  async function updateChannelConfig(config: Partial<ChannelConfig>): Promise<ChannelConfig> {
    const newConfig = await callChannel<ChannelConfig>("updateConfig", config);
    serverChannelConfig = newConfig;
    return newConfig;
  }

  async function sendMessage(
    content: string,
    sendOptions?: {
      replyTo?: string;
      attachments?: AttachmentInput[];
      contentType?: string;
      mentions?: string[];
      /** Explicit direction: only the selected participants should respond. */
      to?: Array<{ kind: "all" | "role" | "participant"; role?: string; participantId?: string }>;
      metadata?: Record<string, unknown>;
      idempotencyKey?: string;
      /** Salience tier stamped onto the message; absent ⇒ "primary". */
      tier?: MessageTier;
    }
  ): Promise<{ messageId: string; pubsubId: number | undefined }> {
    const id = crypto.randomUUID();
    const event: AgenticEvent = {
      kind: "message.completed",
      actor: {
        kind: "user",
        id: pid,
        displayName:
          typeof subscribeMetadata["name"] === "string" ? subscribeMetadata["name"] : pid,
        metadata: subscribeMetadata,
      },
      causality: { messageId: id as never },
      payload: {
        protocol: "agentic.trajectory.v1",
        role: "user",
        blocks: [
          { blockId: `${id}:block:0` as never, type: "text", content },
          ...(sendOptions?.attachments?.map((attachment, index) => ({
            blockId: `${id}:block:${index + 1}` as never,
            type: "attachment" as const,
            metadata: {
              mimeType: attachment.mimeType,
              filename: "filename" in attachment ? attachment.filename : undefined,
            },
          })) ?? []),
        ],
        outcome: "completed",
        mentions: sendOptions?.mentions,
        replyTo: sendOptions?.replyTo as never,
        to: sendOptions?.to,
        ...(sendOptions?.tier ? { tier: sendOptions.tier } : {}),
        // Send intent (e.g. deliverAfterTurn) rides on payload.metadata; the
        // agent loop lifts it into its queue entries via metadataFromPayload.
        ...(sendOptions?.metadata ? { metadata: sendOptions.metadata } : {}),
      },
      createdAt: new Date().toISOString(),
    };
    const pubsubId = await publish(AGENTIC_EVENT_PAYLOAD_KIND, event, {
      attachments: sendOptions?.attachments,
      idempotencyKey: sendOptions?.idempotencyKey,
    });
    return { messageId: id, pubsubId };
  }

  /** The author's participant ref — actor and `payload.by` for mutations. */
  function selfActor(): AgenticEvent["actor"] {
    return {
      kind: "user",
      id: pid,
      displayName: typeof subscribeMetadata["name"] === "string" ? subscribeMetadata["name"] : pid,
      metadata: subscribeMetadata,
    };
  }

  /** Revise an unread message's blocks (publishes `message.edited`). The
   *  channel reducer enforces the author guard and the read-wins cutoff. */
  async function editMessage(
    messageId: string,
    blocks: MessageBlockInput[],
    options?: { idempotencyKey?: string; revision?: number }
  ): Promise<{ pubsubId: number | undefined }> {
    const by = selfActor();
    const event: AgenticEvent = {
      kind: "message.edited",
      actor: by,
      causality: { messageId: messageId as never },
      payload: { protocol: "agentic.trajectory.v1", by, blocks },
      createdAt: new Date().toISOString(),
    };
    const pubsubId = await publish(AGENTIC_EVENT_PAYLOAD_KIND, event, {
      idempotencyKey: options?.idempotencyKey ?? `edit:${messageId}:${options?.revision ?? 0}`,
    });
    return { pubsubId };
  }

  /** Cancel an unread message (publishes `message.retracted`). No-op after a
   *  recipient has read it. */
  async function retractMessage(
    messageId: string,
    options?: { reason?: string; idempotencyKey?: string }
  ): Promise<{ pubsubId: number | undefined }> {
    const by = selfActor();
    const event: AgenticEvent = {
      kind: "message.retracted",
      actor: by,
      causality: { messageId: messageId as never },
      payload: {
        protocol: "agentic.trajectory.v1",
        by,
        ...(options?.reason ? { reason: options.reason } : {}),
      },
      createdAt: new Date().toISOString(),
    };
    const pubsubId = await publish(AGENTIC_EVENT_PAYLOAD_KIND, event, {
      idempotencyKey: options?.idempotencyKey ?? `retract:${messageId}`,
    });
    return { pubsubId };
  }

  async function errorMessage(
    id: string,
    errorMsg: string,
    code?: string
  ): Promise<number | undefined> {
    const payload: Record<string, unknown> = { id, error: errorMsg };
    if (code) payload["code"] = code;
    return await publish("error", payload);
  }

  function callMethod(
    providerId: string,
    methodName: string,
    args?: unknown,
    callOptions?: {
      signal?: AbortSignal;
      invocationId?: string;
      transportCallId?: string;
      turnId?: string;
      timeoutMs?: number;
    }
  ): MethodCallHandle {
    const transportCallId = callOptions?.transportCallId ?? crypto.randomUUID();
    const invocationId = callOptions?.invocationId ?? transportCallId;
    const callId = transportCallId;

    let resolveResult!: (value: MethodResultValue) => void;
    let rejectResult!: (error: Error) => void;
    const result = new Promise<MethodResultValue>((res, rej) => {
      resolveResult = res;
      rejectResult = rej;
    });

    const stream = createFanout<MethodResultChunk>();
    const state: MethodCallState = {
      callId,
      invocationId,
      transportCallId,
      stream,
      resolve: resolveResult,
      reject: rejectResult,
      complete: false,
      isError: false,
    };
    methodCallStates.set(callId, state);

    const cancelCall = (notifyProvider: boolean, waitForProvider: boolean): Promise<void> => {
      if (state.complete) return Promise.resolve();
      state.complete = true;
      state.isError = true;
      stream.close();
      rejectResult(new AgenticError("cancelled", "cancelled"));
      methodCallStates.delete(callId);
      if (!notifyProvider) {
        return Promise.resolve();
      }
      const cancelPromise = callChannel("cancelMethodCall", transportCallId).then(() => undefined);
      if (waitForProvider) return cancelPromise;
      void cancelPromise.catch((err) => {
        console.warn(
          `[PubSubClient] Failed to notify provider about cancellation for ${transportCallId}:`,
          err
        );
      });
      return Promise.resolve();
    };

    if (callOptions?.signal) {
      if (callOptions.signal.aborted) {
        void cancelCall(false, false);
      } else {
        const abort = () => {
          void cancelCall(true, false);
        };
        callOptions.signal.addEventListener("abort", abort, { once: true });
        result.then(
          () => callOptions.signal?.removeEventListener("abort", abort),
          () => callOptions.signal?.removeEventListener("abort", abort)
        );
      }
    }

    if (!state.complete) {
      // Publish an invocation start via the channel DO.
      void callChannel("callMethod", pid, providerId, transportCallId, methodName, args ?? {}, {
        invocationId,
        transportCallId,
        ...(callOptions?.timeoutMs ? { timeoutMs: callOptions.timeoutMs } : {}),
        ...(callOptions?.turnId ? { turnId: callOptions.turnId } : {}),
      }).catch((e: unknown) => {
        if (state.complete) return;
        const err = e instanceof Error ? e : new Error(String(e));
        state.complete = true;
        state.isError = true;
        stream.close(err);
        rejectResult(new AgenticError(err.message, "connection-error", err));
        methodCallStates.delete(callId);
      });
    }

    return {
      callId,
      invocationId,
      transportCallId,
      result,
      stream: stream.subscribe(),
      cancel: async () => {
        await cancelCall(true, true);
      },
      get complete() {
        return state.complete;
      },
      get isError() {
        return state.isError;
      },
    };
  }

  async function cancelMethodCall(callId: string): Promise<void> {
    await callChannel("cancelMethodCall", callId);
  }

  // Abort a method THIS client is executing, synchronously and in-process.
  // The executing method (e.g. an eval running in this panel) was handed
  // `ctx.signal` from the controller stored in `executingMethods` keyed by the
  // inbound transport call id (see handleMethodCallExec). Firing it here stops
  // the local execution immediately; the method's abort path submits a
  // terminal invocation result, which settles the caller's pending result.
  function abortExecutingMethod(callId: string): boolean {
    const executing = executingMethods.get(callId);
    if (!executing) return false;
    executing.controller.abort();
    executingMethods.delete(callId);
    return true;
  }

  function events(evtOptions?: EventStreamOptions): AsyncIterableIterator<EventStreamItem> {
    const source = eventsFanout.subscribe();
    const includeReplay = evtOptions?.includeReplay ?? false;
    const includeSignals = evtOptions?.includeSignals ?? false;

    return (async function* () {
      if (includeReplay && replayMode !== "skip") {
        if (!replayComplete) {
          try {
            await readyPromise;
          } catch {
            // ready() failures are surfaced through close/error handling below.
          }
        }
        for (const item of replayEvents) {
          if (!includeSignals && item.delivery === "signal") continue;
          yield item;
        }
      }

      for await (const event of source) {
        if (!includeSignals && event.delivery === "signal") continue;
        if (!includeReplay && event.phase === "replay") continue;
        yield event;
      }
    })();
  }

  function close(): void {
    closed = true;
    unregisterColdRecover?.();
    rejectReady(new PubSubError("connection closed before ready", "connection"));
    clearInterval(touchInterval);
    eventsFanout.close();
    removeEventListener();
    // Reject all pending method calls so callers don't hang
    for (const [callId, state] of methodCallStates) {
      if (!state.complete) {
        state.complete = true;
        state.isError = true;
        state.stream.close();
        state.reject(new Error("Channel closed"));
      }
      methodCallStates.delete(callId);
    }
    // Abort all executing methods so handlers see signal.aborted
    for (const [, executing] of executingMethods) {
      executing.controller.abort();
    }
    executingMethods.clear();
    for (const handler of disconnectHandlers) handler();
    callChannel("unsubscribe", pid).catch((err) => {
      console.warn(`[PubSubClient] Failed to unsubscribe session ${pid} during close:`, err);
    });
  }

  async function sendRaw(_message: Record<string, unknown>): Promise<void> {
    // No-op for RPC transport
  }

  function localActor() {
    return {
      kind:
        opts.type === "agent" ||
        opts.type === "system" ||
        opts.type === "panel" ||
        opts.type === "external"
          ? opts.type
          : "user",
      id: pid,
      displayName: opts.name ?? pid,
      metadata: subscribeMetadata,
    } as const;
  }

  async function getMessageTypes(): Promise<MessageTypeDefinition[]> {
    return callChannel<MessageTypeDefinition[]>("getMessageTypes");
  }

  async function getMessageType(typeId: string): Promise<MessageTypeDefinition | null> {
    return callChannel<MessageTypeDefinition | null>("getMessageType", typeId);
  }

  async function registerMessageType(
    input: RegisterMessageTypeInput,
    options?: { idempotencyKey?: string }
  ): Promise<number | undefined> {
    const event: AgenticEvent<"messageType.registered"> = {
      kind: "messageType.registered",
      actor: localActor(),
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        typeId: input.typeId,
        displayMode: input.displayMode,
        source: input.source,
        registeredBy: localActor(),
      },
      createdAt: new Date().toISOString(),
    };
    if (input.imports !== undefined) event.payload.imports = input.imports;
    if (input.stateSchema !== undefined) event.payload.stateSchema = input.stateSchema;
    if (input.updateSchema !== undefined) event.payload.updateSchema = input.updateSchema;
    return publish(
      AGENTIC_EVENT_PAYLOAD_KIND,
      event,
      options?.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : undefined
    );
  }

  async function clearMessageType(
    typeId: string,
    options?: { idempotencyKey?: string }
  ): Promise<number | undefined> {
    const event: AgenticEvent<"messageType.cleared"> = {
      kind: "messageType.cleared",
      actor: localActor(),
      payload: { protocol: AGENTIC_PROTOCOL_VERSION, typeId },
      createdAt: new Date().toISOString(),
    };
    return publish(
      AGENTIC_EVENT_PAYLOAD_KIND,
      event,
      options?.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : undefined
    );
  }

  async function publishCustomMessage(
    input: { typeId: string; initialState?: unknown; displayMode?: "inline" | "row" },
    options?: { idempotencyKey?: string }
  ): Promise<{ messageId: string; pubsubId: number | undefined }> {
    const messageId = crypto.randomUUID();
    const event: AgenticEvent<"custom.started"> = {
      kind: "custom.started",
      actor: localActor(),
      causality: { messageId: messageId as MessageId },
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        messageId: messageId as MessageId,
        typeId: input.typeId,
        by: localActor(),
      },
      createdAt: new Date().toISOString(),
    };
    if (input.displayMode !== undefined) event.payload.displayMode = input.displayMode;
    if (input.initialState !== undefined) event.payload.initialState = input.initialState;
    const pubsubId = await publish(AGENTIC_EVENT_PAYLOAD_KIND, event, {
      idempotencyKey: options?.idempotencyKey ?? `custom:start:${messageId}`,
    });
    return { messageId, pubsubId };
  }

  async function updateCustomMessage(
    messageId: string,
    update: unknown,
    options?: {
      idempotencyKey?: string;
      status?: "failed";
      error?: { message: string; details?: unknown };
    }
  ): Promise<number | undefined> {
    const event: AgenticEvent<"custom.updated"> = {
      kind: "custom.updated",
      actor: localActor(),
      causality: { messageId: messageId as MessageId },
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        messageId: messageId as MessageId,
        update,
      },
      createdAt: new Date().toISOString(),
    };
    if (options?.status !== undefined) event.payload.status = options.status;
    if (options?.error !== undefined) event.payload.error = options.error;
    return publish(AGENTIC_EVENT_PAYLOAD_KIND, event, {
      idempotencyKey:
        options?.idempotencyKey ?? `custom:update:${messageId}:${crypto.randomUUID()}`,
    });
  }

  return {
    publish,
    updateMetadata,
    setTyping,
    ready,
    close,
    sendRaw,
    events,
    send: sendMessage,
    editMessage,
    retractMessage,
    error: errorMessage,
    callMethod,
    cancelMethodCall,
    abortExecutingMethod,
    getMessageTypes,
    getMessageType,
    registerMessageType,
    clearMessageType,
    publishCustomMessage,
    updateCustomMessage,
    get clientId() {
      return pid;
    },
    get channelId() {
      return channel;
    },
    get connected() {
      return !closed && replayComplete;
    },
    get reconnecting() {
      return false;
    },
    get contextId() {
      return serverContextId;
    },
    get channelConfig() {
      return serverChannelConfig;
    },
    onError: (handler: (error: Error) => void) => {
      errorHandlers.add(handler);
      return () => errorHandlers.delete(handler);
    },
    onDisconnect: (handler: () => void) => {
      disconnectHandlers.add(handler);
      return () => disconnectHandlers.delete(handler);
    },
    onReconnect: (handler: () => void) => {
      reconnectHandlers.add(handler);
      return () => reconnectHandlers.delete(handler);
    },
    onReady: (handler: () => void) => {
      readyHandlers.add(handler);
      return () => readyHandlers.delete(handler);
    },
    onRoster: (handler: (roster: RosterUpdate<T>) => void) => {
      rosterHandlers.add(handler);
      if (Object.keys(currentRoster).length > 0) {
        handler({ participants: { ...currentRoster }, ts: Date.now() });
      }
      return () => rosterHandlers.delete(handler);
    },
    updateChannelConfig,
    onConfigChange: (handler: (config: ChannelConfig) => void) => {
      configChangeHandlers.add(handler);
      if (serverChannelConfig) handler(serverChannelConfig);
      return () => configChangeHandlers.delete(handler);
    },
    get roster() {
      return { ...currentRoster };
    },
    get totalMessageCount() {
      return serverTotalCount;
    },
    get envelopeCount() {
      return serverEnvelopeCount;
    },
    get firstEnvelopeSeq() {
      return serverFirstEnvelopeSeq;
    },
    get hasMoreBefore() {
      return serverHasMoreBefore;
    },
    async getReplayBefore(beforeSeq: number, limit = 100) {
      return callChannel<ChannelReplayEnvelope>("getReplayBefore", beforeSeq, limit);
    },
    async getReplayAfter(sinceId: number) {
      return callChannel<ChannelReplayEnvelope>("getReplayAfter", sinceId);
    },
  };
}
