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
  Message,
  PubSubMessage,
  LeaveReason,
  ReplayEnvelope,
  ServerLogEvent,
  BootstrapSnapshot,
} from "./types.js";
import type { RpcChannelMessage } from "./protocol-wire.js";
import { PubSubError } from "./types.js";
import type {
  IncomingEvent,
  IncomingNewMessage,
  IncomingUpdateMessage,
  IncomingErrorMessage,
  IncomingMethodCallEvent,
  IncomingMethodResultEvent,
  IncomingPresenceEventWithType,
  IncomingExecutionPauseEvent,
  IncomingAgentDebugEvent,
  AggregatedEvent,
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
import { AgenticError } from "./protocol-types.js";
import {
  NewMessageSchema,
  UpdateMessageSchema,
  ErrorMessageSchema,
  MethodCallSchema,
  MethodResultSchema,
  ExecutionPauseSchema,
} from "./protocol.js";
import { aggregateReplayEvents } from "./aggregation.js";
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
  chatMessageCount?: number;
  firstChatMessageId?: number;
}

interface SubscribeResult {
  ok?: boolean;
  channelConfig?: ChannelConfig;
  envelope?: ReplayEnvelope;
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
    data: typeof att.data === "string" ? base64ToUint8Array(att.data) : att.data as unknown as Uint8Array,
    mimeType: att.mimeType,
    name: att.filename ?? att.name,
    size: att.size,
  }));
}

function eventToClientIngress(event: ServerLogEvent, phase: "replay" | "live"): ClientIngressMessage {
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
    onEvent(event: string, listener: (fromId: string, payload: unknown) => void): () => void;
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
  clientId?: string;
  name?: string;
  type?: string;
  handle?: string;
  replayMode?: "collect" | "stream" | "skip";
  methods?: Record<string, MethodDefinition>;
  recoveryCoordinator?: Pick<RecoveryCoordinator, "registerColdRecoverHandler">;
}

export function connectViaRpc<T extends ParticipantMetadata = ParticipantMetadata>(
  opts: RpcConnectOptions<T>,
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

  // Convert MethodDefinitions to MethodAdvertisements
  function toMethodAdvertisements(methods: Record<string, MethodDefinition>): MethodAdvertisement[] {
    return Object.entries(methods).filter(([, def]) => !def.internal).map(([methodName, def]) => {
      const parameters = def.parameters && typeof def.parameters === "object" && !("_def" in def.parameters)
        ? (def.parameters as JsonSchema)
        : convertZodToJsonSchema(def.parameters as z.ZodTypeAny, { target: "openApi3" }) as JsonSchema;
      const returns = def.returns
        ? (def.returns && typeof def.returns === "object" && !("_def" in def.returns)
          ? (def.returns as JsonSchema)
          : convertZodToJsonSchema(def.returns as z.ZodTypeAny, { target: "openApi3" }) as JsonSchema)
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

  const methodAdvertisements = providedMethods && Object.keys(providedMethods).length > 0
    ? toMethodAdvertisements(providedMethods)
    : undefined;

  // State
  let closed = false;
  let lastSeenId: number | undefined = opts.sinceId;
  let serverContextId: string | undefined;
  let serverChannelConfig: ChannelConfig | undefined;
  let serverTotalCount: number | undefined;
  let serverChatMessageCount: number | undefined;
  let serverFirstChatMessageId: number | undefined;
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
  readyPromise.catch(() => {});

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

  // Message queue for messages() iterator
  const messageQueue: Message[] = [];
  let messageResolve: ((msg: Message | null) => void) | null = null;

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
  let pendingReplay: IncomingEvent[] = [];
  let aggregatedReplay: AggregatedEvent[] = [];
  let replayComplete = false;
  const streamReplayEvents: IncomingEvent[] = [];
  const replayMessageKeys = new Set<string>();
  const MAX_REPLAY_MESSAGE_KEYS = 2000;

  // Roster dedup
  const rosterOpIds = new Set<number>();
  const MAX_ROSTER_OP_IDS = 1000;

  // Method auto-execution
  const registeredMethods: Record<string, MethodDefinition> = { ...(providedMethods ?? {}) };

  // Track AbortControllers for methods we're executing, keyed by callId.
  // When a caller cancels, we abort the controller so the handler sees signal.aborted.
  const executingMethods = new Map<string, AbortController>();

  // Method call tracking
  interface MethodCallState {
    readonly callId: string;
    readonly stream: ReturnType<typeof createFanout<MethodResultChunk>>;
    readonly resolve: (value: MethodResultValue) => void;
    readonly reject: (error: Error) => void;
    complete: boolean;
    isError: boolean;
  }
  const methodCallStates = new Map<string, MethodCallState>();

  // Stable for the lifetime of this client instance. Re-subscribe attempts
  // reuse it; a panel reload creates a new one.
  const participantSessionId = crypto.randomUUID();

  function handleError(error: PubSubError): void {
    for (const handler of errorHandlers) handler(error);
  }

  function enqueueMessage(message: Message): void {
    if (messageResolve) {
      messageResolve(message);
      messageResolve = null;
    } else {
      messageQueue.push(message);
    }
  }

  function normalizeSenderMetadata(
    meta: Record<string, unknown> | undefined,
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

    if (msgType === "message") {
      const parsed = NewMessageSchema.safeParse(payload);
      if (!parsed.success) return null;
      return {
        type: "message",
        delivery, phase, senderId, ts,
        attachments: msgAttachments,
        pubsubId,
        senderMetadata: normalizedSender,
        id: parsed.data.id,
        content: parsed.data.content,
        replyTo: parsed.data.replyTo,
        contentType: parsed.data.contentType,
        at: parsed.data.at,
        metadata: parsed.data.metadata,
      } as IncomingNewMessage;
    }

    if (msgType === "update-message") {
      const parsed = UpdateMessageSchema.safeParse(payload);
      if (!parsed.success) return null;
      return {
        type: "update-message",
        delivery, phase, senderId, ts,
        attachments: msgAttachments,
        pubsubId,
        senderMetadata: normalizedSender,
        id: parsed.data.id,
        content: parsed.data.content,
        complete: parsed.data.complete,
        contentType: parsed.data.contentType,
        append: parsed.data.append,
      } as IncomingUpdateMessage;
    }

    if (msgType === "error") {
      const parsed = ErrorMessageSchema.safeParse(payload);
      if (!parsed.success) return null;
      return {
        type: "error",
        delivery, phase, senderId, ts,
        attachments: msgAttachments,
        pubsubId,
        senderMetadata: normalizedSender,
        id: parsed.data.id,
        error: parsed.data.error,
        code: parsed.data.code,
      } as IncomingErrorMessage;
    }

    if (msgType === "method-call") {
      const parsed = MethodCallSchema.safeParse(payload);
      if (!parsed.success) return null;
      return {
        type: "method-call",
        delivery, phase, senderId, ts,
        pubsubId,
        senderMetadata: normalizedSender,
        callId: parsed.data.callId,
        methodName: parsed.data.methodName,
        providerId: parsed.data.providerId,
        args: parsed.data.args,
      } as IncomingMethodCallEvent;
    }

    if (msgType === "method-result") {
      const parsed = MethodResultSchema.safeParse(payload);
      if (!parsed.success) return null;
      return {
        type: "method-result",
        delivery, phase, senderId, ts,
        pubsubId,
        senderMetadata: normalizedSender,
        callId: parsed.data.callId,
        content: parsed.data.content,
        contentType: parsed.data.contentType,
        complete: parsed.data.complete ?? false,
        isError: parsed.data.isError ?? false,
        progress: parsed.data.progress,
        attachments: msgAttachments,
      } as IncomingMethodResultEvent;
    }

    if (msgType === "execution-pause") {
      const parsed = ExecutionPauseSchema.safeParse(payload);
      if (!parsed.success) return null;
      return {
        type: "execution-pause",
        delivery, phase, senderId, ts,
        pubsubId,
        senderMetadata: normalizedSender,
        messageId: parsed.data.messageId,
        status: parsed.data.status,
        reason: parsed.data.reason,
      } as IncomingExecutionPauseEvent;
    }

    if (msgType === "presence") {
      const presencePayload = payload as { action?: string; metadata?: Record<string, unknown>; leaveReason?: string };
      if (!presencePayload.action || !presencePayload.metadata) return null;
      return {
        type: "presence",
        delivery, phase, senderId, ts,
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
        delivery, phase, senderId, ts,
        pubsubId,
        senderMetadata: normalizedSender,
        payload,
      } as unknown as IncomingAgentDebugEvent;
    }

    return null;
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
        if (typeof msg.chatMessageCount === "number") serverChatMessageCount = msg.chatMessageCount;
        if (typeof msg.firstChatMessageId === "number") {
          serverFirstChatMessageId = msg.firstChatMessageId;
        } else {
          serverFirstChatMessageId = undefined;
        }

        if (replayComplete) {
          break;
        }

        // Aggregate replay
        if (replayMode !== "skip") {
          const aggregated = aggregateReplayEvents(pendingReplay);
          if (!replayComplete) {
            aggregatedReplay = aggregated;
          } else if (aggregated.length > 0) {
            aggregatedReplay = [...aggregatedReplay, ...aggregated];
          }
        }
        bufferingReplay = false;
        pendingReplay = [];
        replayComplete = true;

        resolveReady();
        enqueueMessage({
          kind: "ready",
          totalCount: serverTotalCount,
          chatMessageCount: serverChatMessageCount,
          firstChatMessageId: serverFirstChatMessageId,
        });
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
                ...(presenceAction === "leave" && payload?.leaveReason && { leaveReason: payload.leaveReason }),
              },
              ...(presenceAction === "leave" && msg.senderId && {
                leaves: {
                  [msg.senderId]: { leaveReason: payload?.leaveReason },
                },
              }),
            };
            for (const handler of rosterHandlers) handler(rosterUpdate);
          }
        }

        // Handle method-cancel before normal event parsing (not a recognized event type)
        if (msg.type === "method-cancel" && msg.phase !== "replay") {
          const cancelPayload = msg.payload as { callId?: string } | undefined;
          if (cancelPayload?.callId) {
            const controller = executingMethods.get(cancelPayload.callId);
            if (controller) {
              controller.abort();
              executingMethods.delete(cancelPayload.callId);
            }
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
          // Auto-execute method calls targeting this client
          if (event.type === "method-call" && event.phase !== "replay") {
            handleMethodCallExec(event as IncomingMethodCallEvent)
              .catch((err) => console.error(`[RpcPubSubClient] Method execution failed:`, err));
          }

          // Buffer replay events until the initial ready boundary. If ready was
          // resolved from the subscribe acknowledgment because the ready event
          // was not delivered, late replay events are surfaced directly instead
          // of being stranded in a replay buffer with no future ready boundary.
          if (event.phase === "replay") {
            if (replayComplete) {
              if (replayMode === "stream") streamReplayEvents.push(event);
              eventsFanout.emit(event);
            } else if (replayMode !== "skip") {
              if (!bufferingReplay) {
                bufferingReplay = true;
                pendingReplay = [];
              }
              pendingReplay.push(event);
              if (replayMode === "stream") streamReplayEvents.push(event);
            }
          } else {
            // Emit live events
            eventsFanout.emit(event);
          }
        }

        // Don't leak presence events into messages() iterator
        if (!isPresence) {
          enqueueMessage(pubsubMsg);
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

  function ingestReplayEnvelope(envelope: ReplayEnvelope, _source: "stream" | "ack"): void {
    if (replayComplete) return;
    if (replayMode !== "skip") {
      for (const event of envelope.logEvents) {
        handleServerMessage(eventToClientIngress(event, "replay"));
      }
      for (const snapshot of envelope.snapshots) {
        applyRosterSnapshot(snapshot);
      }
    }
    handleServerMessage({
      stream: "control",
      controlType: "ready",
      contextId: envelope.ready.contextId,
      channelConfig: envelope.ready.channelConfig,
      totalCount: envelope.ready.totalCount,
      chatMessageCount: envelope.ready.rootMessageCount,
      firstChatMessageId: envelope.ready.firstRootMessageId,
    });
    streamedReplayLogEvents = [];
    streamedReplaySnapshots = [];
  }

  function applySubscribeAckFallback(result: SubscribeResult | undefined): void {
    if (!result?.envelope || replayComplete) return;
    ingestReplayEnvelope(result.envelope, "ack");
  }

  async function handleMethodCallExec(event: IncomingMethodCallEvent): Promise<void> {
    if (!pid || event.providerId !== pid) return;

    const methodDef = registeredMethods[event.methodName];
    if (!methodDef) {
      try {
        await callChannel("publish", pid, "method-result", {
          callId: event.callId,
          content: { error: `Method "${event.methodName}" not registered on this client` },
          complete: true,
          isError: true,
        }, {});
      } catch { /* best effort */ }
      return;
    }

    const abortController = new AbortController();
    executingMethods.set(event.callId, abortController);
    const ctx: MethodExecutionContext = {
      callId: event.callId,
      callerId: event.senderId,
      signal: abortController.signal,
      stream: async (content: unknown) => {
        await callChannel("publish", pid, "method-result", {
          callId: event.callId,
          content,
          complete: false,
          isError: false,
        }, {});
      },
      streamWithAttachments: async (content: unknown, attachments: AttachmentInput[], streamOpts?: { contentType?: string }) => {
        await callChannel("publish", pid, "method-result", {
          callId: event.callId,
          content,
          contentType: streamOpts?.contentType,
          complete: false,
          isError: false,
        }, { attachments: toStoredAttachments(attachments) });
      },
      resultWithAttachments: <R>(content: R, attachments: AttachmentInput[], resultOpts?: { contentType?: string }) => ({
        content,
        attachments,
        contentType: resultOpts?.contentType,
      }),
      progress: async (percent: number) => {
        await callChannel("publish", pid, "method-result", {
          callId: event.callId,
          complete: false,
          isError: false,
          progress: percent,
        }, {});
      },
    };

    try {
      let args = event.args;
      if (methodDef.parameters && "_def" in methodDef.parameters) {
        args = (methodDef.parameters as z.ZodTypeAny).parse(args);
      }

      const result = await methodDef.execute(args, ctx);

      if (result && typeof result === "object" && "attachments" in (result as Record<string, unknown>) && "content" in (result as Record<string, unknown>)) {
        const withAttachments = result as { content: unknown; attachments: AttachmentInput[]; contentType?: string };
        await callChannel("publish", pid, "method-result", {
          callId: event.callId,
          content: withAttachments.content,
          contentType: withAttachments.contentType,
          complete: true,
          isError: false,
        }, { attachments: toStoredAttachments(withAttachments.attachments) });
      } else {
        await callChannel("publish", pid, "method-result", {
          callId: event.callId,
          content: result,
          complete: true,
          isError: false,
        }, {});
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      await callChannel("publish", pid, "method-result", {
        callId: event.callId,
        content: { error: errorMsg },
        complete: true,
        isError: true,
      }, {}).catch(e => console.error("[PubSub] Failed to publish auto-execution error:", e));
    } finally {
      executingMethods.delete(event.callId);
    }
  }

  function toStoredAttachments(attachments: AttachmentInput[]): Array<{ id: string; data: string; mimeType: string; name?: string; size: number }> {
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
  const removeEventListener = rpc.onEvent("channel:message", (_fromId: string, payload: unknown) => {
    if (closed) return;
    const data = payload as { channelId?: string; message?: RpcChannelMessage };
    if (data.channelId !== channel) return;
    if (data.message) {
      const raw = data.message;
      if (raw.kind === "control" && raw.type === "ready" && raw.ready) {
        if (!replayComplete) {
          ingestReplayEnvelope({
            mode: opts.sinceId && opts.sinceId > 0 ? "after" : "initial",
            logEvents: streamedReplayLogEvents,
            snapshots: streamedReplaySnapshots,
            ready: raw.ready,
          }, "stream");
        } else {
          handleServerMessage({
            stream: "control",
            controlType: "ready",
            contextId: raw.ready.contextId,
            channelConfig: raw.ready.channelConfig,
            totalCount: raw.ready.totalCount,
            chatMessageCount: raw.ready.rootMessageCount,
            firstChatMessageId: raw.ready.firstRootMessageId,
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
        if (replayMode === "skip") return;
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
            callChannel<ReplayEnvelope>("getReplayAfter", lastSeenSeq).then(envelope => {
              for (const evt of envelope.logEvents) {
                if (evt.id !== undefined && lastSeenSeq !== undefined && evt.id <= lastSeenSeq) continue;
                handleServerMessage(eventToClientIngress(evt, "live"));
              }
            }).catch(err => {
              console.warn("[RpcPubSubClient] Gap repair failed:", err);
            }).finally(() => {
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
    replayMessageLimit: opts.replayMessageLimit ?? 200,
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
    if (closed) { reconnecting = false; return; }
    try {
      // Best-effort unsubscribe old session
      await callChannel("unsubscribe", pid).catch(() => {});
      // Reset local roster and presence dedup state so replayed presence events are accepted
      currentRoster = {};
      rosterOpIds.clear();
      replayMessageKeys.clear();
      pendingReplay = [];
      bufferingReplay = replayMode !== "skip";
      replayComplete = false;
      // Re-subscribe with sinceId for catch-up replay
      const resubMeta = { ...subscribeMetadata, sinceId: lastSeenSeq, replay: true };
      const result = await callChannel<SubscribeResult | undefined>("subscribe", pid, resubMeta);
      applySubscribeAckFallback(result);
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
    attemptResubscription,
  );

  const touchInterval = setInterval(() => {
    if (closed) return;
    callChannel("touch", pid).then(() => {
      consecutiveTouchFailures = 0;
    }).catch(err => {
      consecutiveTouchFailures++;
      if (consecutiveTouchFailures >= 3) {
        console.error(`[PubSub] Heartbeat failed ${consecutiveTouchFailures} times:`, err);
        handleError(new PubSubError("Channel heartbeat failing — connection may be lost", "connection"));
        // Phase 3A: Auto-resubscribe
        void attemptResubscription();
      }
    });
  }, TOUCH_INTERVAL_MS);

  // Fire subscribe. Replay normally arrives through ordered channel events; the
  // result also carries the same ordered initial replay as a fallback so losing
  // the ready event does not let ready resolve ahead of replay delivery.
  callChannel<SubscribeResult | undefined>("subscribe", pid, subscribeMetadata).then((result) => {
    applySubscribeAckFallback(result);
  }).catch((err: unknown) => {
    const error = err instanceof Error ? err : new Error(String(err));
    clearInterval(touchInterval);
    const pubsubError = new PubSubError(error.message, "connection");
    rejectReady(pubsubError);
    handleError(pubsubError);
  });

  // Subscribe to events fanout for method-result tracking
  const methodResultSource = eventsFanout.subscribe();
  void (async () => {
    try {
      for await (const event of methodResultSource) {
        if (event.type !== "method-result") continue;
        const result = event as IncomingMethodResultEvent;
        const state = methodCallStates.get(result.callId);
        if (!state) continue;

        const chunk: MethodResultChunk = {
          content: result.content,
          attachments: result.attachments,
          contentType: result.contentType,
          complete: result.complete,
          isError: result.isError,
          progress: result.progress,
        };

        state.stream.emit(chunk);

        if (chunk.complete) {
          state.complete = true;
          state.isError = chunk.isError;
          state.stream.close();

          if (chunk.isError) {
            const content = chunk.content;
            let errorMsg = "method execution failed";
            if (content && typeof content === "object" && typeof (content as Record<string, unknown>)["error"] === "string") {
              errorMsg = (content as Record<string, unknown>)["error"] as string;
            }
            state.reject(new AgenticError(errorMsg, "execution-error", content));
          } else {
            state.resolve({
              content: chunk.content,
              attachments: chunk.attachments,
              contentType: chunk.contentType,
            });
          }
          methodCallStates.delete(result.callId);
        }
      }
    } catch {
      // Stream closed
    }
  })();

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
        },
      );
    });
  }

  async function publish<P>(
    type: string,
    payload: P,
    publishOptions: PublishOptions = {},
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
    updateOptions: UpdateMetadataOptions = {},
  ): Promise<void> {
    await callChannel("updateMetadata", pid, newMetadata);
  }

  async function setTyping(active: boolean): Promise<void> {
    await callChannel("setTypingState", pid, active);
  }

  async function updateChannelConfig(
    config: Partial<ChannelConfig>,
  ): Promise<ChannelConfig> {
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
      at?: string[];
      metadata?: Record<string, unknown>;
      idempotencyKey?: string;
    },
  ): Promise<{ messageId: string; pubsubId: number | undefined }> {
    const id = crypto.randomUUID();
    const messagePayload: Record<string, unknown> = { id, content };
    if (sendOptions?.replyTo) messagePayload["replyTo"] = sendOptions.replyTo;
    if (sendOptions?.contentType) messagePayload["contentType"] = sendOptions.contentType;
    if (sendOptions?.at) messagePayload["at"] = sendOptions.at;
    if (sendOptions?.metadata) messagePayload["metadata"] = sendOptions.metadata;

    const pubsubId = await publish("message", messagePayload, {
      attachments: sendOptions?.attachments,
      idempotencyKey: sendOptions?.idempotencyKey,
    });
    return { messageId: id, pubsubId };
  }

  async function updateMessage(
    id: string,
    content: string,
    updateOptions?: { complete?: boolean; attachments?: AttachmentInput[]; contentType?: string },
  ): Promise<number | undefined> {
    const payload: Record<string, unknown> = { id, content };
    if (updateOptions?.complete !== undefined) payload["complete"] = updateOptions.complete;
    if (updateOptions?.contentType) payload["contentType"] = updateOptions.contentType;
    return await publish("update-message", payload, {
      attachments: updateOptions?.attachments,
    });
  }

  async function completeMessage(id: string, options?: { idempotencyKey?: string }): Promise<number | undefined> {
    return await publish("update-message", { id, complete: true }, { idempotencyKey: options?.idempotencyKey });
  }

  async function errorMessage(id: string, errorMsg: string, code?: string): Promise<number | undefined> {
    const payload: Record<string, unknown> = { id, error: errorMsg };
    if (code) payload["code"] = code;
    return await publish("error", payload);
  }

  function callMethod(
    providerId: string,
    methodName: string,
    args?: unknown,
    callOptions?: { signal?: AbortSignal },
  ): MethodCallHandle {
    const callId = crypto.randomUUID();

    let resolveResult!: (value: MethodResultValue) => void;
    let rejectResult!: (error: Error) => void;
    const result = new Promise<MethodResultValue>((res, rej) => {
      resolveResult = res;
      rejectResult = rej;
    });

    const stream = createFanout<MethodResultChunk>();
    const state: MethodCallState = {
      callId,
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
      const cancelPromise = callChannel("cancelMethodCall", callId).then(() => undefined);
      if (waitForProvider) return cancelPromise;
      void cancelPromise.catch(() => {});
      return Promise.resolve();
    };

    if (callOptions?.signal) {
      if (callOptions.signal.aborted) {
        void cancelCall(false, false);
      } else {
        const abort = () => { void cancelCall(true, false); };
        callOptions.signal.addEventListener("abort", abort, { once: true });
        result.then(
          () => callOptions.signal?.removeEventListener("abort", abort),
          () => callOptions.signal?.removeEventListener("abort", abort),
        );
      }
    }

    if (!state.complete) {
      // Publish method-call via DO.
      void callChannel("callMethod", pid, providerId, callId, methodName, args ?? {}).catch((e: unknown) => {
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
      result,
      stream: stream.subscribe(),
      cancel: async () => {
        await cancelCall(true, true);
      },
      get complete() { return state.complete; },
      get isError() { return state.isError; },
    };
  }

  async function* messages(): AsyncIterableIterator<Message> {
    while (!closed) {
      if (messageQueue.length > 0) {
        yield messageQueue.shift()!;
      } else {
        const msg = await new Promise<Message | null>((resolve) => {
          if (closed) { resolve(null); return; }
          messageResolve = resolve;
        });
        if (msg === null) break;
        yield msg;
      }
    }
  }

  function events(evtOptions?: EventStreamOptions): AsyncIterableIterator<EventStreamItem> {
    const source = eventsFanout.subscribe();
    const includeReplay = evtOptions?.includeReplay ?? false;
    const includeSignals = evtOptions?.includeSignals ?? false;

    function isIncomingEvent(event: EventStreamItem): event is IncomingEvent {
      return !("aggregated" in event);
    }

    return (async function* () {
      if (includeReplay && replayMode !== "skip") {
        const replaySeed: EventStreamItem[] =
          replayMode === "stream" ? streamReplayEvents : aggregatedReplay;
        for (const item of replaySeed) {
          if (isIncomingEvent(item)) {
            if (!includeSignals && item.delivery === "signal") continue;
          }
          yield item;
        }
      }

      for await (const event of source) {
        if (!includeSignals && event.delivery === "signal") continue;
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
    if (messageResolve) {
      messageResolve(null);
      messageResolve = null;
    }
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
    for (const [, controller] of executingMethods) {
      controller.abort();
    }
    executingMethods.clear();
    for (const handler of disconnectHandlers) handler();
    callChannel("unsubscribe", pid).catch(() => {});
  }

  async function sendRaw(_message: Record<string, unknown>): Promise<void> {
    // No-op for RPC transport
  }

  return {
    messages,
    publish,
    updateMetadata,
    setTyping,
    ready,
    close,
    sendRaw,
    events,
    send: sendMessage,
    update: updateMessage,
    complete: completeMessage,
    error: errorMessage,
    callMethod,
    get clientId() { return pid; },
    get connected() { return !closed && replayComplete; },
    get reconnecting() { return false; },
    get contextId() { return serverContextId; },
    get channelConfig() { return serverChannelConfig; },
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
    get roster() { return { ...currentRoster }; },
    get totalMessageCount() { return serverTotalCount; },
    get chatMessageCount() { return serverChatMessageCount; },
    get firstChatMessageId() { return serverFirstChatMessageId; },
    async getChatReplayBefore(beforeRootId: number, rootLimit = 100) {
      return callChannel<ReplayEnvelope>("getChatReplayBefore", beforeRootId, rootLimit);
    },
    async getReplayAfter(sinceId: number) {
      return callChannel<ReplayEnvelope>("getReplayAfter", sinceId);
    },
  };
}
