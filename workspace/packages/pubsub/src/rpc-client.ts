/**
 * RPC-based PubSub client.
 *
 * Implements PubSubClient<T> using RPC calls to the PubSubChannel DO
 * instead of a direct WebSocket connection. Used by panels that communicate
 * through the Electron RPC bridge.
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
} from "./types.js";
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

const CHANNEL_SOURCE = "workers/pubsub-channel";
const CHANNEL_CLASS = "PubSubChannel";
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

interface ServerMessage {
  kind: "replay" | "persisted" | "ephemeral" | "ready" | "error" | "config-update" | "messages-before";
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
  messages?: Array<{
    id: number;
    type: string;
    payload: unknown;
    senderId: string;
    ts: number;
    senderMetadata?: Record<string, unknown>;
    attachments?: WireAttachment[];
  }>;
  hasMore?: boolean;
  trailingUpdates?: Array<{
    id: number;
    type: string;
    payload: unknown;
    senderId: string;
    ts: number;
    senderMetadata?: Record<string, unknown>;
    attachments?: WireAttachment[];
  }>;
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

type PresenceAction = "join" | "leave" | "update";

interface PresencePayload {
  action?: PresenceAction;
  metadata?: Record<string, unknown>;
  leaveReason?: LeaveReason;
}

export interface RpcConnectOptions<T extends ParticipantMetadata = ParticipantMetadata> {
  rpc: {
    call<R = unknown>(targetId: string, method: string, ...args: unknown[]): Promise<R>;
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
  clientId?: string;
  name?: string;
  type?: string;
  handle?: string;
  replayMode?: "collect" | "stream" | "skip";
  methods?: Record<string, MethodDefinition>;
}

export function connectViaRpc<T extends ParticipantMetadata = ParticipantMetadata>(
  opts: RpcConnectOptions<T>,
): PubSubClient<T> {
  const { rpc, channel, replayMode = "stream", methods: providedMethods } = opts;
  const doTarget = `do:${CHANNEL_SOURCE}:${CHANNEL_CLASS}:${channel}`;
  const pid = opts.clientId ?? rpc.selfId;

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
        timeout: def.timeout,
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

  // Ready promise
  let readyResolve: (() => void) | null = null;
  let readyReject: ((err: Error) => void) | null = null;
  let readyPromise = new Promise<void>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });

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
  let initialReplayComplete = false;
  const streamReplayEvents: IncomingEvent[] = [];

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

  function randomId(): string {
    const cryptoObj = (globalThis as unknown as { crypto?: { randomUUID(): string } }).crypto;
    if (cryptoObj?.randomUUID) return cryptoObj.randomUUID();
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
    });
  }

  // Stable for the lifetime of this client instance. Re-subscribe attempts
  // reuse it; a panel reload creates a new one.
  const participantSessionId = randomId();

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
      kind,
      id: pubsubId,
      senderMetadata,
    } = pubsubMsg;
    const normalizedSender = normalizeSenderMetadata(senderMetadata);

    if (msgType === "message") {
      const parsed = NewMessageSchema.safeParse(payload);
      if (!parsed.success) return null;
      return {
        type: "message",
        kind, senderId, ts,
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
        kind, senderId, ts,
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
        kind, senderId, ts,
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
        kind, senderId, ts,
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
        kind, senderId, ts,
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
        kind, senderId, ts,
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
        kind, senderId, ts,
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
        kind, senderId, ts,
        pubsubId,
        senderMetadata: normalizedSender,
        payload,
      } as unknown as IncomingAgentDebugEvent;
    }

    return null;
  }

  function handleServerMessage(msg: ServerMessage): void {
    switch (msg.kind) {
      case "ready": {
        if (typeof msg.contextId === "string") serverContextId = msg.contextId;
        if (msg.channelConfig) serverChannelConfig = msg.channelConfig;
        if (typeof msg.totalCount === "number") serverTotalCount = msg.totalCount;
        if (typeof msg.chatMessageCount === "number") serverChatMessageCount = msg.chatMessageCount;
        if (typeof msg.firstChatMessageId === "number") {
          serverFirstChatMessageId = msg.firstChatMessageId;
        } else {
          serverFirstChatMessageId = undefined;
        }

        // Aggregate replay
        if (replayMode !== "skip") {
          const aggregated = aggregateReplayEvents(pendingReplay);
          if (!initialReplayComplete) {
            aggregatedReplay = aggregated;
          } else if (aggregated.length > 0) {
            aggregatedReplay = [...aggregatedReplay, ...aggregated];
          }
        }
        bufferingReplay = false;
        pendingReplay = [];
        initialReplayComplete = true;

        readyResolve?.();
        readyResolve = null;
        readyReject = null;
        enqueueMessage({
          kind: "ready",
          totalCount: serverTotalCount,
          chatMessageCount: serverChatMessageCount,
          firstChatMessageId: serverFirstChatMessageId,
        });
        for (const handler of readyHandlers) handler();
        break;
      }

      case "config-update": {
        if (msg.channelConfig) {
          serverChannelConfig = msg.channelConfig;
          for (const handler of configChangeHandlers) handler(msg.channelConfig);
        }
        break;
      }

      case "error": {
        const errorMsg = msg.error || "unknown server error";
        const error = new PubSubError(errorMsg, "server");
        handleError(error);
        break;
      }

      case "replay":
      case "persisted":
      case "ephemeral": {
        if (msg.id !== undefined) {
          lastSeenId = msg.id;
          if (msg.id > 0) lastSeenSeq = msg.id;
        }

        const isPresence = msg.type === "presence";

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
        if (msg.type === "method-cancel" && msg.kind !== "replay") {
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
          kind: msg.kind,
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
          if (event.type === "method-call" && event.kind !== "replay") {
            handleMethodCallExec(event as IncomingMethodCallEvent)
              .catch((err) => console.error(`[RpcPubSubClient] Method execution failed:`, err));
          }

          // Buffer replay events
          if (event.kind === "replay") {
            if (replayMode !== "skip") {
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

  async function handleMethodCallExec(event: IncomingMethodCallEvent): Promise<void> {
    if (!pid || event.providerId !== pid) return;

    const methodDef = registeredMethods[event.methodName];
    if (!methodDef) {
      try {
        await rpc.call(doTarget, "publish", pid, "method-result", {
          callId: event.callId,
          content: { error: `Method "${event.methodName}" not registered on this client` },
          complete: true,
          isError: true,
        }, { persist: true });
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
        await rpc.call(doTarget, "publish", pid, "method-result", {
          callId: event.callId,
          content,
          complete: false,
          isError: false,
        }, { persist: true });
      },
      streamWithAttachments: async (content: unknown, attachments: AttachmentInput[], streamOpts?: { contentType?: string }) => {
        await rpc.call(doTarget, "publish", pid, "method-result", {
          callId: event.callId,
          content,
          contentType: streamOpts?.contentType,
          complete: false,
          isError: false,
        }, { persist: true, attachments: toStoredAttachments(attachments) });
      },
      resultWithAttachments: <R>(content: R, attachments: AttachmentInput[], resultOpts?: { contentType?: string }) => ({
        content,
        attachments,
        contentType: resultOpts?.contentType,
      }),
      progress: async (percent: number) => {
        await rpc.call(doTarget, "publish", pid, "method-result", {
          callId: event.callId,
          complete: false,
          isError: false,
          progress: percent,
        }, { persist: false });
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
        await rpc.call(doTarget, "publish", pid, "method-result", {
          callId: event.callId,
          content: withAttachments.content,
          contentType: withAttachments.contentType,
          complete: true,
          isError: false,
        }, { persist: true, attachments: toStoredAttachments(withAttachments.attachments) });
      } else {
        await rpc.call(doTarget, "publish", pid, "method-result", {
          callId: event.callId,
          content: result,
          complete: true,
          isError: false,
        }, { persist: true });
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      await rpc.call(doTarget, "publish", pid, "method-result", {
        callId: event.callId,
        content: { error: errorMsg },
        complete: true,
        isError: true,
      }, { persist: true }).catch(e => console.error("[PubSub] Failed to publish auto-execution error:", e));
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
  const gapBuffer: ServerMessage[] = [];
  const MAX_GAP_SIZE = 500;

  // Register event listener for channel messages
  const removeEventListener = rpc.onEvent("channel:message", (_fromId: string, payload: unknown) => {
    if (closed) return;
    const data = payload as { channelId?: string; message?: ServerMessage };
    if (data.channelId !== channel) return;
    if (data.message) {
      const msg = data.message;

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
            rpc.call<Array<{ id: number; type: string; payload: unknown; senderId: string; ts: number; senderMetadata?: Record<string, unknown>; attachments?: unknown[] }>>(
              doTarget, "getEventRange", lastSeenSeq, msg.id - 1,
            ).then(events => {
              if (events && Array.isArray(events)) {
                for (const evt of events) {
                  if (evt.id !== undefined && lastSeenSeq !== undefined && evt.id <= lastSeenSeq) continue;
                  const replayMsg: ServerMessage = {
                    kind: "persisted",
                    id: evt.id,
                    type: evt.type,
                    payload: evt.payload,
                    senderId: evt.senderId,
                    ts: evt.ts,
                    senderMetadata: evt.senderMetadata,
                    attachments: evt.attachments as ServerMessage["attachments"],
                  };
                  handleServerMessage(replayMsg);
                }
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
    transport: "rpc",
    [PARTICIPANT_SESSION_METADATA_KEY]: participantSessionId,
    contextId: opts.contextId,
    channelConfig: opts.channelConfig ? opts.channelConfig : undefined,
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
    // Exponential backoff: 1s, 2s, 4s, 8s, 16s
    const backoffMs = Math.min(1000 * Math.pow(2, reconnectAttempts - 1), 16000);
    await new Promise(resolve => setTimeout(resolve, backoffMs));
    if (closed) { reconnecting = false; return; }
    try {
      // Best-effort unsubscribe old session
      await rpc.call(doTarget, "unsubscribe", pid).catch(() => {});
      // Reset local roster and presence dedup state so replayed presence events are accepted
      currentRoster = {};
      rosterOpIds.clear();
      // Re-subscribe with sinceId for catch-up replay
      const resubMeta = { ...subscribeMetadata, sinceId: lastSeenSeq, replay: true };
      await rpc.call(doTarget, "subscribe", pid, resubMeta);
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

  const touchInterval = setInterval(() => {
    if (closed) return;
    rpc.call(doTarget, "touch", pid).then(() => {
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

  // Fire subscribe (replay arrives via events, not return value)
  rpc.call(doTarget, "subscribe", pid, subscribeMetadata).catch((err: unknown) => {
    const error = err instanceof Error ? err : new Error(String(err));
    clearInterval(touchInterval);
    readyReject?.(new PubSubError(error.message, "connection"));
    readyResolve = null;
    readyReject = null;
    handleError(new PubSubError(error.message, "connection"));
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

  async function ready(timeoutMs = 30000): Promise<void> {
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new PubSubError("ready timeout", "timeout")), timeoutMs);
    });
    return Promise.race([readyPromise, timeoutPromise]);
  }

  async function publish<P>(
    type: string,
    payload: P,
    publishOptions: PublishOptions = {},
  ): Promise<number | undefined> {
    if (closed) throw new PubSubError("not connected", "connection");
    const { persist = true, attachments, idempotencyKey } = publishOptions;

    const result = await rpc.call<{ id?: number }>(doTarget, "publish", pid, type, payload, {
      persist,
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
    await rpc.call(doTarget, "updateMetadata", pid, newMetadata);
  }

  async function setTyping(active: boolean): Promise<void> {
    await rpc.call(doTarget, "setTypingState", pid, active);
  }

  async function updateChannelConfig(
    config: Partial<ChannelConfig>,
  ): Promise<ChannelConfig> {
    const newConfig = await rpc.call<ChannelConfig>(doTarget, "updateConfig", config);
    serverChannelConfig = newConfig;
    return newConfig;
  }

  async function sendMessage(
    content: string,
    sendOptions?: {
      replyTo?: string;
      persist?: boolean;
      attachments?: AttachmentInput[];
      contentType?: string;
      at?: string[];
      metadata?: Record<string, unknown>;
      idempotencyKey?: string;
    },
  ): Promise<{ messageId: string; pubsubId: number | undefined }> {
    const id = randomId();
    const messagePayload: Record<string, unknown> = { id, content };
    if (sendOptions?.replyTo) messagePayload["replyTo"] = sendOptions.replyTo;
    if (sendOptions?.contentType) messagePayload["contentType"] = sendOptions.contentType;
    if (sendOptions?.at) messagePayload["at"] = sendOptions.at;
    if (sendOptions?.metadata) messagePayload["metadata"] = sendOptions.metadata;

    const pubsubId = await publish("message", messagePayload, {
      persist: sendOptions?.persist ?? true,
      attachments: sendOptions?.attachments,
      idempotencyKey: sendOptions?.idempotencyKey,
    });
    return { messageId: id, pubsubId };
  }

  async function updateMessage(
    id: string,
    content: string,
    updateOptions?: { complete?: boolean; persist?: boolean; attachments?: AttachmentInput[]; contentType?: string },
  ): Promise<number | undefined> {
    const payload: Record<string, unknown> = { id, content };
    if (updateOptions?.complete !== undefined) payload["complete"] = updateOptions.complete;
    if (updateOptions?.contentType) payload["contentType"] = updateOptions.contentType;
    return await publish("update-message", payload, {
      persist: updateOptions?.persist ?? true,
      attachments: updateOptions?.attachments,
    });
  }

  async function completeMessage(id: string, options?: { idempotencyKey?: string }): Promise<number | undefined> {
    return await publish("update-message", { id, complete: true }, { persist: true, idempotencyKey: options?.idempotencyKey });
  }

  async function errorMessage(id: string, errorMsg: string, code?: string): Promise<number | undefined> {
    const payload: Record<string, unknown> = { id, error: errorMsg };
    if (code) payload["code"] = code;
    return await publish("error", payload, { persist: true });
  }

  function callMethod(
    providerId: string,
    methodName: string,
    args?: unknown,
    callOptions?: { timeoutMs?: number },
  ): MethodCallHandle {
    const callId = randomId();

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

    // Publish method-call via DO
    void rpc.call(doTarget, "callMethod", pid, providerId, callId, methodName, args ?? {}).catch((e: unknown) => {
      const err = e instanceof Error ? e : new Error(String(e));
      state.complete = true;
      state.isError = true;
      stream.close(err);
      rejectResult(new AgenticError(err.message, "connection-error", err));
      methodCallStates.delete(callId);
    });

    const timeoutMs = callOptions?.timeoutMs;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    if (timeoutMs && timeoutMs > 0) {
      timeoutId = setTimeout(() => {
        if (!state.complete) {
          state.complete = true;
          state.isError = true;
          stream.close();
          rejectResult(new AgenticError("method call timeout", "timeout"));
          methodCallStates.delete(callId);
          // Tell the DO to cancel so the provider can be notified
          rpc.call(doTarget, "cancelMethodCall", callId).catch(() => {});
        }
      }, timeoutMs);
    }

    void result.finally(() => {
      if (timeoutId) clearTimeout(timeoutId);
    });

    return {
      callId,
      result,
      stream: stream.subscribe(),
      cancel: async () => {
        if (state.complete) return;
        state.complete = true;
        state.isError = true;
        stream.close();
        rejectResult(new AgenticError("cancelled", "cancelled"));
        methodCallStates.delete(callId);
        await rpc.call(doTarget, "cancelMethodCall", callId).catch(e => console.warn("[PubSub] Failed to cancel method call:", e));
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
    const includeEphemeral = evtOptions?.includeEphemeral ?? false;

    function isIncomingEvent(event: EventStreamItem): event is IncomingEvent {
      return !("aggregated" in event);
    }

    return (async function* () {
      if (includeReplay && replayMode !== "skip") {
        const replaySeed: EventStreamItem[] =
          replayMode === "stream" ? streamReplayEvents : aggregatedReplay;
        for (const item of replaySeed) {
          if (isIncomingEvent(item)) {
            if (!includeEphemeral && item.kind === "ephemeral") continue;
          }
          yield item;
        }
      }

      for await (const event of source) {
        if (!includeEphemeral && event.kind === "ephemeral") continue;
        yield event;
      }
    })();
  }

  function close(): void {
    closed = true;
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
    rpc.call(doTarget, "unsubscribe", pid).catch(() => {});
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
    get connected() { return !closed && initialReplayComplete; },
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
    async getMessagesBefore(beforeId: number, limit = 100) {
      const result = await rpc.call<{
        messages: Array<{
          id: number;
          type: string;
          payload: unknown;
          senderId: string;
          ts: number;
          senderMetadata?: Record<string, unknown>;
          attachments?: WireAttachment[];
        }>;
        trailingUpdates?: Array<{
          id: number;
          type: string;
          payload: unknown;
          senderId: string;
          ts: number;
          senderMetadata?: Record<string, unknown>;
          attachments?: WireAttachment[];
        }>;
        hasMore: boolean;
      }>(doTarget, "getMessagesBefore", beforeId, limit);
      // Convert wire-format attachments (base64) to client format (Uint8Array)
      return {
        messages: result.messages.map(m => ({
          ...m,
          attachments: convertWireAttachments(m.attachments),
        })),
        trailingUpdates: result.trailingUpdates?.map(m => ({
          ...m,
          attachments: convertWireAttachments(m.attachments),
        })),
        hasMore: result.hasMore,
      };
    },
  };
}
