/**
 * PubSub WebSocket client implementation.
 *
 * Provides an async/generator-friendly API for pub/sub messaging.
 */

import { PubSubError } from "./types.js";
import type {
  Message,
  PubSubMessage,
  PublishOptions,
  UpdateMetadataOptions,
  ConnectOptions,
  ReconnectConfig,
  RosterUpdate,
  ParticipantMetadata,
  Participant,
  Attachment,
  ChannelConfig,
  AgentManifest,
  AgentInstanceSummary,
  InviteAgentOptions,
  InviteAgentResult,
  RemoveAgentResult,
  AgentBuildError,
} from "./types.js";

/**
 * Server message envelope.
 */
interface ServerMessage {
  kind: "replay" | "persisted" | "ephemeral" | "ready" | "error" | "config-update" | "messages-before"
    | "list-agents-response" | "invite-agent-response" | "channel-agents-response" | "remove-agent-response";
  id?: number;
  type?: string;
  payload?: unknown;
  senderId?: string;
  ts?: number;
  ref?: number;
  error?: string;
  /** Binary attachments (parsed from binary frame) */
  attachments?: Attachment[];
  senderMetadata?: Record<string, unknown>;
  /** Context ID for the channel (sent in ready message) */
  contextId?: string;
  /** Channel config (sent in ready message or config-update) */
  channelConfig?: ChannelConfig;
  /** Total message count for pagination (sent in ready message) */
  totalCount?: number;
  /** Count of type="message" events only, for accurate chat pagination */
  chatMessageCount?: number;
  /** ID of the first chat message in the channel (for pagination boundary) */
  firstChatMessageId?: number;
  /** Messages returned for get-messages-before (sent in messages-before response) */
  messages?: Array<{
    id: number;
    type: string;
    payload: unknown;
    senderId: string;
    ts: number;
    senderMetadata?: Record<string, unknown>;
  }>;
  /** Whether there are more messages before these (sent in messages-before response) */
  hasMore?: boolean;
  /** Trailing updates for boundary messages (messages-before response) */
  trailingUpdates?: Array<{
    id: number;
    type: string;
    payload: unknown;
    senderId: string;
    ts: number;
    senderMetadata?: Record<string, unknown>;
  }>;
  /** Agent manifests (list-agents-response) */
  agents?: AgentManifest[] | AgentInstanceSummary[];
  /** Whether operation succeeded (invite/remove-agent responses) */
  success?: boolean;
  /** Instance ID of spawned agent (invite-agent-response) */
  instanceId?: string;
  /** Structured build error with full diagnostics (invite-agent-response on failure) */
  buildError?: AgentBuildError;
}

type PresenceAction = "join" | "leave" | "update";

interface PresencePayload {
  action?: PresenceAction;
  metadata?: Record<string, unknown>;
  /** Reason for leave (only present when action === "leave") */
  leaveReason?: "graceful" | "disconnect";
}

/**
 * PubSub client interface.
 */
export interface PubSubClient<T extends ParticipantMetadata = ParticipantMetadata> {
  /** Async iterator for incoming messages */
  messages(): AsyncIterableIterator<Message>;

  /** Publish a message to the channel. Returns the message ID for persisted messages. */
  publish<P>(type: string, payload: P, options?: PublishOptions): Promise<number | undefined>;

  /** Update this client's participant metadata (triggers roster broadcast). */
  updateMetadata(metadata: T, options?: UpdateMetadataOptions): Promise<void>;

  /** Wait for the ready signal (replay complete). Throws if timeout exceeded. */
  ready(timeoutMs?: number): Promise<void>;

  /** Close the connection */
  close(): void;

  /** Send a raw message to the server (for protocol-level messages like "close") */
  sendRaw(message: Record<string, unknown>): Promise<void>;

  /** Whether currently connected */
  readonly connected: boolean;

  /** Whether currently attempting to reconnect */
  readonly reconnecting: boolean;

  /** Context ID for the channel (from server ready message) */
  readonly contextId: string | undefined;

  /** Channel config (from server ready message) */
  readonly channelConfig: ChannelConfig | undefined;

  /** Register error handler. Returns unsubscribe function. */
  onError(handler: (error: Error) => void): () => void;

  /** Register disconnect handler. Returns unsubscribe function. */
  onDisconnect(handler: () => void): () => void;

  /** Register reconnect handler (called after successful reconnection). Returns unsubscribe function. */
  onReconnect(handler: () => void): () => void;

  /** Register ready handler (called on every ready message, including reconnects). Returns unsubscribe function. */
  onReady(handler: () => void): () => void;

  /** Register roster update handler. Returns unsubscribe function. */
  onRoster(handler: (roster: RosterUpdate<T>) => void): () => void;

  /** Update the channel config (merges with existing config). */
  updateChannelConfig(config: Partial<ChannelConfig>): Promise<ChannelConfig>;

  /** Register channel config change handler. Returns unsubscribe function. */
  onConfigChange(handler: (config: ChannelConfig) => void): () => void;

  /** Get the current roster participants (may be empty if no roster update received yet) */
  readonly roster: Record<string, Participant<T>>;

  /** Total message count (from server ready message, for pagination) */
  readonly totalMessageCount: number | undefined;

  /** Count of type="message" events only (excludes protocol chatter), for accurate chat pagination */
  readonly chatMessageCount: number | undefined;

  /** ID of the first chat message in the channel (for pagination boundary) */
  readonly firstChatMessageId: number | undefined;

  /** Get older messages before a given ID (for pagination UI) */
  getMessagesBefore(beforeId: number, limit?: number): Promise<{
    messages: Array<{
      id: number;
      type: string;
      payload: unknown;
      senderId: string;
      ts: number;
      senderMetadata?: Record<string, unknown>;
      attachments?: Attachment[];
    }>;
    trailingUpdates?: Array<{
      id: number;
      type: string;
      payload: unknown;
      senderId: string;
      ts: number;
      senderMetadata?: Record<string, unknown>;
      attachments?: Attachment[];
    }>;
    hasMore: boolean;
  }>;

  // ===========================================================================
  // Agent API
  // ===========================================================================

  /**
   * List all available agents in the workspace.
   */
  listAgents(timeoutMs?: number): Promise<AgentManifest[]>;

  /**
   * Invite an agent to join this channel.
   */
  inviteAgent(agentId: string, options?: InviteAgentOptions): Promise<InviteAgentResult>;

  /**
   * List agents currently on this channel.
   */
  channelAgents(timeoutMs?: number): Promise<AgentInstanceSummary[]>;

  /**
   * Remove an agent from this channel.
   */
  removeAgent(instanceId: string, timeoutMs?: number): Promise<RemoveAgentResult>;
}

/** Default reconnection configuration */
const DEFAULT_RECONNECT_CONFIG: Required<ReconnectConfig> = {
  delayMs: 1000,
  maxDelayMs: 30000,
  maxAttempts: 0, // infinite
};

/**
 * Connect to a PubSub channel.
 *
 * @param serverUrl - WebSocket server URL (e.g., "ws://127.0.0.1:49452")
 * @param token - Authentication token
 * @param options - Connection options including channel and optional sinceId
 * @returns A PubSubClient instance
 */
export function connect<T extends ParticipantMetadata = ParticipantMetadata>(
  serverUrl: string,
  token: string,
  options: ConnectOptions<T>
): PubSubClient<T> {
  const { channel, contextId, channelConfig, sinceId: initialSinceId, reconnect, metadata, clientId, skipOwnMessages } = options;

  // Parse reconnection config
  const reconnectEnabled = reconnect !== undefined && reconnect !== false;
  const reconnectConfig: Required<ReconnectConfig> = reconnectEnabled
    ? { ...DEFAULT_RECONNECT_CONFIG, ...(typeof reconnect === "object" ? reconnect : {}) }
    : DEFAULT_RECONNECT_CONFIG;

  // Shared state
  let ws: WebSocket;
  let lastSeenId: number | undefined = initialSinceId;
  let closed = false;
  let isReconnecting = false;
  let reconnectAttempt = 0;
  let reconnectTimeoutId: ReturnType<typeof setTimeout> | null = null;
  let refCounter = 0;
  let serverContextId: string | undefined;
  let serverChannelConfig: ChannelConfig | undefined;
  let serverTotalCount: number | undefined;
  let serverChatMessageCount: number | undefined;
  let serverFirstChatMessageId: number | undefined;

  // Message queue for the async iterator
  const messageQueue: Message[] = [];
  let messageResolve: ((msg: Message | null) => void) | null = null;

  // Pending publish tracking
  const pendingPublishes = new Map<
    number,
    { resolve: (id?: number) => void; reject: (err: Error) => void; timeoutId: ReturnType<typeof setTimeout> }
  >();

  const pendingMetadataUpdates = new Map<
    number,
    { resolve: () => void; reject: (err: Error) => void; timeoutId: ReturnType<typeof setTimeout> }
  >();

  // Event handlers
  const errorHandlers = new Set<(error: Error) => void>();
  const disconnectHandlers = new Set<() => void>();
  const reconnectHandlers = new Set<() => void>();
  const readyHandlers = new Set<() => void>();
  const rosterHandlers = new Set<(roster: RosterUpdate<T>) => void>();
  const configChangeHandlers = new Set<(config: ChannelConfig) => void>();

  // Pending config update tracking
  const pendingConfigUpdates = new Map<
    number,
    { resolve: (config: ChannelConfig) => void; reject: (err: Error) => void; timeoutId: ReturnType<typeof setTimeout> }
  >();

  // Pending get-messages-before tracking
  type MessagesBeforeResult = {
    messages: Array<{
      id: number;
      type: string;
      payload: unknown;
      senderId: string;
      ts: number;
      senderMetadata?: Record<string, unknown>;
      attachments?: Attachment[];
    }>;
    trailingUpdates?: Array<{
      id: number;
      type: string;
      payload: unknown;
      senderId: string;
      ts: number;
      senderMetadata?: Record<string, unknown>;
      attachments?: Attachment[];
    }>;
    hasMore: boolean;
  };
  const pendingMessagesBeforeRequests = new Map<
    number,
    { resolve: (result: MessagesBeforeResult) => void; reject: (err: Error) => void; timeoutId: ReturnType<typeof setTimeout> }
  >();

  // Pending agent request maps
  const pendingListAgents = new Map<
    number,
    { resolve: (agents: AgentManifest[]) => void; reject: (err: Error) => void; timeoutId: ReturnType<typeof setTimeout> }
  >();

  const pendingInviteAgent = new Map<
    number,
    { resolve: (result: InviteAgentResult) => void; reject: (err: Error) => void; timeoutId: ReturnType<typeof setTimeout> }
  >();

  const pendingChannelAgents = new Map<
    number,
    { resolve: (agents: AgentInstanceSummary[]) => void; reject: (err: Error) => void; timeoutId: ReturnType<typeof setTimeout> }
  >();

  const pendingRemoveAgent = new Map<
    number,
    { resolve: (result: RemoveAgentResult) => void; reject: (err: Error) => void; timeoutId: ReturnType<typeof setTimeout> }
  >();

  // Current roster state
  let currentRoster: Record<string, Participant<T>> = {};
  const rosterOpIds = new Set<number>();
  const MAX_ROSTER_OP_IDS = 1000; // Limit to prevent unbounded growth

  // Ready promise management
  let readyResolve: (() => void) | null = null;
  let readyReject: ((err: Error) => void) | null = null;
  let readyPromise: Promise<void>;

  function resetReadyPromise(): void {
    readyPromise = new Promise<void>((resolve, reject) => {
      readyResolve = resolve;
      readyReject = reject;
    });
  }

  function buildWsUrl(withSinceId?: number): string {
    const url = new URL(serverUrl);
    url.searchParams.set("token", token);
    url.searchParams.set("channel", channel);
    if (contextId) {
      url.searchParams.set("contextId", contextId);
    }
    if (channelConfig !== undefined) {
      url.searchParams.set("channelConfig", JSON.stringify(channelConfig));
    }
    if (withSinceId !== undefined) {
      url.searchParams.set("sinceId", String(withSinceId));
    }
    // Note: metadata is always sent via updateMetadata after connection.
    // This avoids URL length limits (~2KB-8KB depending on browser/server).
    // WebSocket connections must use HTTP GET for the upgrade handshake (RFC 6455),
    // so POST is not an option. The extra round-trip is acceptable since
    // participants without metadata can still receive messages during this window.
    return url.toString();
  }

  function handleError(error: PubSubError): void {
    for (const handler of errorHandlers) {
      handler(error);
    }
  }

  function enqueueMessage(message: Message): void {
    if (messageResolve) {
      messageResolve(message);
      messageResolve = null;
    } else {
      messageQueue.push(message);
    }
  }

  function handleMessage(event: MessageEvent | { data: ArrayBuffer }): void {
    let msg: ServerMessage;

    // Handle binary messages (messages with attachments)
    if (event.data instanceof ArrayBuffer) {
      const buffer = event.data;
      if (buffer.byteLength < 5) {
        handleError(new PubSubError("invalid binary message format", "validation"));
        return;
      }

      const view = new DataView(buffer);
      // Byte 0 is a binary marker (0)
      const metadataLen = view.getUint32(1, true);

      if (buffer.byteLength < 5 + metadataLen) {
        handleError(new PubSubError("binary message truncated", "validation"));
        return;
      }

      // Parse metadata (contains kind, type, payload, senderId, ts, attachmentMeta, etc.)
      const metadataBytes = new Uint8Array(buffer, 5, metadataLen);
      const metadataStr = new TextDecoder().decode(metadataBytes);
      let metadata: Record<string, unknown> = {};
      try {
        metadata = JSON.parse(metadataStr);
      } catch {
        handleError(new PubSubError("invalid metadata in binary message", "validation"));
        return;
      }

      // Extract attachments from binary data based on attachmentMeta sizes
      const attachmentMeta = metadata["attachmentMeta"] as Array<{ id: string; mimeType: string; name?: string; size: number }> | undefined;
      const attachmentStart = 5 + metadataLen;
      let attachments: Attachment[] | undefined;

      if (attachmentMeta && attachmentMeta.length > 0) {
        attachments = [];
        let offset = attachmentStart;
        for (const meta of attachmentMeta) {
          const data = new Uint8Array(buffer.slice(offset, offset + meta.size));
          attachments.push({
            id: meta.id,
            data,
            mimeType: meta.mimeType,
            name: meta.name,
          });
          offset += meta.size;
        }
        // Remove attachmentMeta from the message object (it's internal wire format)
        delete metadata["attachmentMeta"];
      }

      msg = {
        ...metadata,
        attachments,
      } as ServerMessage;
    } else {
      // Handle text messages (JSON)
      msg = JSON.parse(event.data as string) as ServerMessage;
    }


    switch (msg.kind) {
      case "ready":
        // Capture contextId, channelConfig, and totalCount from server ready message
        if (typeof msg.contextId === "string") {
          serverContextId = msg.contextId;
        }
        if (msg.channelConfig) {
          serverChannelConfig = msg.channelConfig;
        }
        if (typeof msg.totalCount === "number") {
          serverTotalCount = msg.totalCount;
        }
        if (typeof msg.chatMessageCount === "number") {
          serverChatMessageCount = msg.chatMessageCount;
        }
        if (typeof msg.firstChatMessageId === "number") {
          serverFirstChatMessageId = msg.firstChatMessageId;
        } else {
          serverFirstChatMessageId = undefined;
        }
        readyResolve?.();
        readyResolve = null;
        readyReject = null;
        enqueueMessage({ kind: "ready", totalCount: serverTotalCount, chatMessageCount: serverChatMessageCount, firstChatMessageId: serverFirstChatMessageId });
        for (const handler of readyHandlers) handler();
        break;

      case "messages-before": {
        // Handle messages-before response
        if (msg.ref !== undefined) {
          const pending = pendingMessagesBeforeRequests.get(msg.ref);
          if (pending) {
            clearTimeout(pending.timeoutId);
            pending.resolve({
              messages: msg.messages ?? [],
              trailingUpdates: msg.trailingUpdates,
              hasMore: msg.hasMore ?? false,
            });
            pendingMessagesBeforeRequests.delete(msg.ref);
          }
        }
        break;
      }

      case "config-update": {
        // Update local channel config
        if (msg.channelConfig) {
          serverChannelConfig = msg.channelConfig;

          // Resolve pending config update if this is our request
          if (msg.ref !== undefined) {
            const pending = pendingConfigUpdates.get(msg.ref);
            if (pending) {
              clearTimeout(pending.timeoutId);
              pending.resolve(msg.channelConfig);
              pendingConfigUpdates.delete(msg.ref);
            }
          }

          // Notify all config change handlers
          for (const handler of configChangeHandlers) {
            handler(msg.channelConfig);
          }
        }
        break;
      }

      // Agent protocol response handlers
      case "list-agents-response": {
        if (msg.ref !== undefined) {
          const pending = pendingListAgents.get(msg.ref);
          if (pending) {
            clearTimeout(pending.timeoutId);
            pending.resolve((msg.agents as AgentManifest[]) ?? []);
            pendingListAgents.delete(msg.ref);
          }
        }
        break;
      }

      case "invite-agent-response": {
        if (msg.ref !== undefined) {
          const pending = pendingInviteAgent.get(msg.ref);
          if (pending) {
            clearTimeout(pending.timeoutId);
            pending.resolve({
              success: msg.success ?? false,
              instanceId: msg.instanceId,
              error: msg.error,
              buildError: msg.buildError,
            });
            pendingInviteAgent.delete(msg.ref);
          }
        }
        break;
      }

      case "channel-agents-response": {
        if (msg.ref !== undefined) {
          const pending = pendingChannelAgents.get(msg.ref);
          if (pending) {
            clearTimeout(pending.timeoutId);
            pending.resolve((msg.agents as AgentInstanceSummary[]) ?? []);
            pendingChannelAgents.delete(msg.ref);
          }
        }
        break;
      }

      case "remove-agent-response": {
        if (msg.ref !== undefined) {
          const pending = pendingRemoveAgent.get(msg.ref);
          if (pending) {
            clearTimeout(pending.timeoutId);
            pending.resolve({
              success: msg.success ?? false,
              error: msg.error,
            });
            pendingRemoveAgent.delete(msg.ref);
          }
        }
        break;
      }

      case "error": {
        const errorMsg = msg.error || "unknown server error";
        let code: "validation" | "server" = "server";
        if (errorMsg.includes("not serializable") || errorMsg.includes("invalid")) {
          code = "validation";
        }
        const error = new PubSubError(errorMsg, code);

        if (msg.ref !== undefined) {
          const pendingPublish = pendingPublishes.get(msg.ref);
          if (pendingPublish) {
            clearTimeout(pendingPublish.timeoutId);
            pendingPublish.reject(error);
            pendingPublishes.delete(msg.ref);
          }
          const pendingMetadata = pendingMetadataUpdates.get(msg.ref);
          if (pendingMetadata) {
            clearTimeout(pendingMetadata.timeoutId);
            pendingMetadata.reject(error);
            pendingMetadataUpdates.delete(msg.ref);
          }
          const pendingConfig = pendingConfigUpdates.get(msg.ref);
          if (pendingConfig) {
            clearTimeout(pendingConfig.timeoutId);
            pendingConfig.reject(error);
            pendingConfigUpdates.delete(msg.ref);
          }
          // Agent pending requests
          const pendingList = pendingListAgents.get(msg.ref);
          if (pendingList) {
            clearTimeout(pendingList.timeoutId);
            pendingList.reject(error);
            pendingListAgents.delete(msg.ref);
          }
          const pendingInvite = pendingInviteAgent.get(msg.ref);
          if (pendingInvite) {
            clearTimeout(pendingInvite.timeoutId);
            pendingInvite.reject(error);
            pendingInviteAgent.delete(msg.ref);
          }
          const pendingChannel = pendingChannelAgents.get(msg.ref);
          if (pendingChannel) {
            clearTimeout(pendingChannel.timeoutId);
            pendingChannel.reject(error);
            pendingChannelAgents.delete(msg.ref);
          }
          const pendingRemove = pendingRemoveAgent.get(msg.ref);
          if (pendingRemove) {
            clearTimeout(pendingRemove.timeoutId);
            pendingRemove.reject(error);
            pendingRemoveAgent.delete(msg.ref);
          }
        }

        handleError(error);
        break;
      }

      case "replay":
      case "persisted":
      case "ephemeral": {
        // Track last seen ID for reconnection
        if (msg.id !== undefined) {
          lastSeenId = msg.id;
        }

        const isPresence = msg.type === "presence";
        let presenceAction: PresenceAction | undefined;

        if (isPresence) {
          const payload = msg.payload as PresencePayload;
          presenceAction = payload?.action;

          if (msg.id !== undefined) {
            if (rosterOpIds.has(msg.id)) {
              return;
            }
            rosterOpIds.add(msg.id);

            // Simple cleanup to prevent unbounded growth
            if (rosterOpIds.size > MAX_ROSTER_OP_IDS) {
              // Remove oldest entries to bring the set back to ~800
              const toRemove = rosterOpIds.size - (MAX_ROSTER_OP_IDS - 200);
              const iter = rosterOpIds.values();
              for (let i = 0; i < toRemove; i++) {
                const { value } = iter.next();
                if (value !== undefined) rosterOpIds.delete(value);
              }
            }
          }

          if (presenceAction === "join" || presenceAction === "update") {
            if (payload?.metadata) {
              currentRoster = {
                ...currentRoster,
                [msg.senderId!]: {
                  id: msg.senderId!,
                  metadata: payload.metadata as T,
                },
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
              ...(presenceAction === "leave" && msg.senderId && {
                leaves: {
                  [msg.senderId]: {
                    leaveReason: (msg.payload as PresencePayload)?.leaveReason,
                  },
                },
              }),
            };
            for (const handler of rosterHandlers) {
              handler(rosterUpdate);
            }
          }

          if (msg.ref !== undefined && presenceAction === "update") {
            const pending = pendingMetadataUpdates.get(msg.ref);
            if (pending) {
              clearTimeout(pending.timeoutId);
              pending.resolve();
              pendingMetadataUpdates.delete(msg.ref);
            }
          }
        }

        // Resolve pending publish if this is our own message
        if (msg.ref !== undefined) {
          const pending = pendingPublishes.get(msg.ref);
          if (pending) {
            clearTimeout(pending.timeoutId);
            pending.resolve(msg.id);
            pendingPublishes.delete(msg.ref);
          }
        }

        // Skip own messages if configured (but never skip roster ops)
        if (skipOwnMessages && clientId && msg.senderId === clientId && !isPresence) {
          break;
        }

        // Don't leak presence events into the consumer message stream — they're
        // fully handled by the roster handlers above. Enqueueing them is redundant
        // and forces consumers to filter/re-parse events already processed here.
        if (isPresence) {
          break;
        }

        const message: PubSubMessage = {
          kind: msg.kind,
          id: msg.id,
          type: msg.type!,
          payload: msg.payload,
          senderId: msg.senderId!,
          ts: msg.ts!,
          attachments: msg.attachments,
          senderMetadata: msg.senderMetadata,
        };

        enqueueMessage(message);
        break;
      }
    }
  }

  function handleWsError(): void {
    const error = new PubSubError("WebSocket error", "connection");
    handleError(error);
    readyReject?.(error);
    readyResolve = null;
    readyReject = null;
  }

  function handleWsClose(event?: CloseEvent): void {
    // Build error message with close code and reason if available
    const closeReason = event?.reason || "unknown";
    const closeCode = event?.code ?? 1000;
    const errorMessage = closeCode >= 4000
      ? `connection closed by server: ${closeReason} (code ${closeCode})`
      : "connection closed";

    // Notify disconnect handlers
    for (const handler of disconnectHandlers) {
      handler();
    }

    if (closed) {
      // Intentional close - terminate everything
      if (messageResolve) {
        messageResolve(null);
        messageResolve = null;
      }
      rejectPendingPublishes(new PubSubError(errorMessage, "connection"));
      rejectPendingMetadataUpdates(new PubSubError(errorMessage, "connection"));
      rejectPendingConfigUpdates(new PubSubError(errorMessage, "connection"));
      rejectPendingMessagesBeforeRequests(new PubSubError(errorMessage, "connection"));
      rejectPendingAgentRequests(new PubSubError(errorMessage, "connection"));
      readyReject?.(new PubSubError(errorMessage, "connection"));
      readyResolve = null;
      readyReject = null;
      return;
    }

    if (reconnectEnabled) {
      // Attempt reconnection
      scheduleReconnect();
    } else {
      // No reconnection - close everything
      closed = true;
      if (messageResolve) {
        messageResolve(null);
        messageResolve = null;
      }
      rejectPendingPublishes(new PubSubError(errorMessage, "connection"));
      rejectPendingMetadataUpdates(new PubSubError(errorMessage, "connection"));
      rejectPendingConfigUpdates(new PubSubError(errorMessage, "connection"));
      rejectPendingMessagesBeforeRequests(new PubSubError(errorMessage, "connection"));
      rejectPendingAgentRequests(new PubSubError(errorMessage, "connection"));
      readyReject?.(new PubSubError(errorMessage, "connection"));
      readyResolve = null;
      readyReject = null;
    }
  }

  function rejectPendingPublishes(error: PubSubError): void {
    for (const [, pending] of pendingPublishes) {
      clearTimeout(pending.timeoutId);
      pending.reject(error);
    }
    pendingPublishes.clear();
  }

  function rejectPendingMetadataUpdates(error: PubSubError): void {
    for (const [, pending] of pendingMetadataUpdates) {
      clearTimeout(pending.timeoutId);
      pending.reject(error);
    }
    pendingMetadataUpdates.clear();
  }

  function rejectPendingConfigUpdates(error: PubSubError): void {
    for (const [, pending] of pendingConfigUpdates) {
      clearTimeout(pending.timeoutId);
      pending.reject(error);
    }
    pendingConfigUpdates.clear();
  }

  function rejectPendingMessagesBeforeRequests(error: PubSubError): void {
    for (const [, pending] of pendingMessagesBeforeRequests) {
      clearTimeout(pending.timeoutId);
      pending.reject(error);
    }
    pendingMessagesBeforeRequests.clear();
  }

  function rejectPendingAgentRequests(error: PubSubError): void {
    for (const [, pending] of pendingListAgents) {
      clearTimeout(pending.timeoutId);
      pending.reject(error);
    }
    pendingListAgents.clear();

    for (const [, pending] of pendingInviteAgent) {
      clearTimeout(pending.timeoutId);
      pending.reject(error);
    }
    pendingInviteAgent.clear();

    for (const [, pending] of pendingChannelAgents) {
      clearTimeout(pending.timeoutId);
      pending.reject(error);
    }
    pendingChannelAgents.clear();

    for (const [, pending] of pendingRemoveAgent) {
      clearTimeout(pending.timeoutId);
      pending.reject(error);
    }
    pendingRemoveAgent.clear();
  }

  function scheduleReconnect(): void {
    if (closed) return;

    isReconnecting = true;
    reconnectAttempt++;

    // Check max attempts
    if (reconnectConfig.maxAttempts > 0 && reconnectAttempt > reconnectConfig.maxAttempts) {
      closed = true;
      isReconnecting = false;
      const error = new PubSubError("max reconnection attempts exceeded", "connection");
      handleError(error);
      if (messageResolve) {
        messageResolve(null);
        messageResolve = null;
      }
      rejectPendingPublishes(error);
      rejectPendingMetadataUpdates(error);
      rejectPendingConfigUpdates(error);
      rejectPendingMessagesBeforeRequests(error);
      rejectPendingAgentRequests(error);
      return;
    }

    // Calculate delay with exponential backoff
    const delay = Math.min(
      reconnectConfig.delayMs * Math.pow(2, reconnectAttempt - 1),
      reconnectConfig.maxDelayMs
    );

    reconnectTimeoutId = setTimeout(() => {
      reconnectTimeoutId = null;
      attemptReconnect();
    }, delay);
  }

  function attemptReconnect(): void {
    if (closed) return;

    // Reset ready promise for new connection
    resetReadyPromise();

    // Clear roster state so it's rebuilt cleanly from the server's full
    // presence replay. Without this, stale entries accumulate and the
    // rosterOpIds dedup set can mask events that should be reprocessed.
    currentRoster = {};
    rosterOpIds.clear();

    // Create new WebSocket with lastSeenId for replay
    ws = new WebSocket(buildWsUrl(lastSeenId));
    wireUpWebSocket();
  }

  function wireUpWebSocket(): void {
    // Receive binary data as ArrayBuffer (default is Blob which breaks our parsing)
    ws.binaryType = "arraybuffer";
    ws.onmessage = handleMessage;
    ws.onerror = handleWsError;
    ws.onclose = handleWsClose;
    ws.onopen = () => {
      if (isReconnecting) {
        // Successful reconnection
        isReconnecting = false;
        reconnectAttempt = 0;
        for (const handler of reconnectHandlers) {
          handler();
        }
      }
      // Always send metadata after connection (avoids URL length limits)
      if (metadata !== undefined) {
        void updateMetadata(metadata).catch((err) => {
          const error = err instanceof PubSubError ? err : new PubSubError(String(err), "connection");
          handleError(error);
        });
      }
    };
  }

  // Initial connection
  resetReadyPromise();
  ws = new WebSocket(buildWsUrl(initialSinceId));
  wireUpWebSocket();

  async function* messages(): AsyncIterableIterator<Message> {
    while (!closed) {
      if (messageQueue.length > 0) {
        const msg = messageQueue.shift()!;
        yield msg;
      } else {
        const msg = await new Promise<Message | null>((resolve) => {
          if (closed && !isReconnecting) {
            resolve(null);
            return;
          }
          messageResolve = resolve;
        });
        if (msg === null) {
          break;
        }
        yield msg;
      }
    }
  }

  async function ready(timeoutMs = 30000): Promise<void> {
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new PubSubError("ready timeout", "timeout")), timeoutMs);
    });
    return Promise.race([readyPromise, timeoutPromise]);
  }

  async function publish<P>(
    type: string,
    payload: P,
    publishOptions: PublishOptions = {}
  ): Promise<number | undefined> {
    const ref = ++refCounter;
    const { persist = true, timeoutMs = 30000, attachments } = publishOptions;

    return new Promise((resolve, reject) => {
      if (ws.readyState !== WebSocket.OPEN) {
        reject(new PubSubError("not connected", "connection"));
        return;
      }

      const timeoutId = setTimeout(() => {
        const pending = pendingPublishes.get(ref);
        if (pending) {
          pendingPublishes.delete(ref);
          pending.reject(new PubSubError("publish timeout", "timeout"));
        }
      }, timeoutMs);

      pendingPublishes.set(ref, {
        resolve: (id) => {
          clearTimeout(timeoutId);
          resolve(id);
        },
        reject: (err) => {
          clearTimeout(timeoutId);
          reject(err);
        },
        timeoutId,
      });

      if (attachments && attachments.length > 0) {
        // Send as binary frame: metadata JSON + concatenated attachments
        // Wire format: [0x00][4-byte JSON len][JSON with attachmentMeta][attachment bytes...]
        // Note: No 'id' field - server assigns IDs
        const attachmentMeta = attachments.map((a) => ({
          mimeType: a.mimeType,
          name: a.name,
          size: a.data.length,
        }));
        const totalAttachmentSize = attachments.reduce((sum, a) => sum + a.data.length, 0);

        const metadata = JSON.stringify({
          action: "publish",
          type,
          payload,
          persist,
          ref,
          attachmentMeta,
        });
        const metadataBytes = new TextEncoder().encode(metadata);
        const metadataLen = metadataBytes.length;

        // Create buffer: 1 byte marker (0) + 4 bytes length + metadata + all attachments
        const buffer = new ArrayBuffer(1 + 4 + metadataLen + totalAttachmentSize);
        const view = new DataView(buffer);
        view.setUint8(0, 0); // Binary frame marker
        view.setUint32(1, metadataLen, true); // Metadata length (little-endian)

        // Copy metadata
        new Uint8Array(buffer, 5, metadataLen).set(metadataBytes);

        // Copy attachments sequentially
        let offset = 5 + metadataLen;
        for (const attachment of attachments) {
          new Uint8Array(buffer, offset, attachment.data.length).set(attachment.data);
          offset += attachment.data.length;
        }

        ws.send(buffer);
      } else {
        // Send as JSON text frame
        ws.send(
          JSON.stringify({
            action: "publish",
            type,
            payload,
            persist,
            ref,
          })
        );
      }
    });
  }

  async function updateMetadata(
    newMetadata: T,
    updateOptions: UpdateMetadataOptions = {}
  ): Promise<void> {
    const ref = ++refCounter;
    const { timeoutMs = 30000 } = updateOptions;

    return new Promise((resolve, reject) => {
      if (ws.readyState !== WebSocket.OPEN) {
        reject(new PubSubError("not connected", "connection"));
        return;
      }

      const timeoutId = setTimeout(() => {
        const pending = pendingMetadataUpdates.get(ref);
        if (pending) {
          pendingMetadataUpdates.delete(ref);
          pending.reject(new PubSubError("metadata update timeout", "timeout"));
        }
      }, timeoutMs);

      pendingMetadataUpdates.set(ref, {
        resolve: () => {
          clearTimeout(timeoutId);
          resolve();
        },
        reject: (err) => {
          clearTimeout(timeoutId);
          reject(err);
        },
        timeoutId,
      });

      ws.send(
        JSON.stringify({
          action: "update-metadata",
          payload: newMetadata,
          ref,
        })
      );
    });
  }

  async function updateChannelConfig(
    config: Partial<ChannelConfig>,
    timeoutMs = 30000
  ): Promise<ChannelConfig> {
    const ref = ++refCounter;

    return new Promise((resolve, reject) => {
      if (ws.readyState !== WebSocket.OPEN) {
        reject(new PubSubError("not connected", "connection"));
        return;
      }

      const timeoutId = setTimeout(() => {
        const pending = pendingConfigUpdates.get(ref);
        if (pending) {
          pendingConfigUpdates.delete(ref);
          pending.reject(new PubSubError("config update timeout", "timeout"));
        }
      }, timeoutMs);

      pendingConfigUpdates.set(ref, {
        resolve: (newConfig) => {
          clearTimeout(timeoutId);
          resolve(newConfig);
        },
        reject: (err) => {
          clearTimeout(timeoutId);
          reject(err);
        },
        timeoutId,
      });

      ws.send(
        JSON.stringify({
          action: "update-config",
          config,
          ref,
        })
      );
    });
  }

  function close(): void {
    closed = true;
    isReconnecting = false;
    if (reconnectTimeoutId) {
      clearTimeout(reconnectTimeoutId);
      reconnectTimeoutId = null;
    }
    // Send a graceful close action before closing the WebSocket. TCP ordering
    // guarantees the server processes this before the close frame, so it can
    // record a "graceful" leave reason instead of "disconnect". Fire-and-forget:
    // we don't need the ack since we're closing immediately after.
    if (ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify({ action: "close" }));
      } catch {
        // Best effort — connection may already be degraded
      }
    }
    ws.close();
  }

  async function sendRaw(message: Record<string, unknown>): Promise<void> {
    const ref = ++refCounter;
    const timeoutMs = 5000; // Short timeout for protocol messages

    return new Promise((resolve, reject) => {
      if (ws.readyState !== WebSocket.OPEN) {
        reject(new PubSubError("not connected", "connection"));
        return;
      }

      const timeoutId = setTimeout(() => {
        const pending = pendingPublishes.get(ref);
        if (pending) {
          pendingPublishes.delete(ref);
          pending.reject(new PubSubError("sendRaw timeout", "timeout"));
        }
      }, timeoutMs);

      pendingPublishes.set(ref, {
        resolve: () => {
          clearTimeout(timeoutId);
          resolve();
        },
        reject: (err) => {
          clearTimeout(timeoutId);
          reject(err);
        },
        timeoutId,
      });

      ws.send(JSON.stringify({ ...message, ref }));
    });
  }

  return {
    messages,
    publish,
    updateMetadata,
    ready,
    close,
    sendRaw,
    get connected() {
      return ws.readyState === WebSocket.OPEN;
    },
    get reconnecting() {
      return isReconnecting;
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
      // Immediately call handler with current roster if it's not empty
      // This ensures handlers registered after replay still get the roster state
      if (Object.keys(currentRoster).length > 0) {
        handler({ participants: { ...currentRoster }, ts: Date.now() });
      }
      return () => rosterHandlers.delete(handler);
    },
    updateChannelConfig,
    onConfigChange: (handler: (config: ChannelConfig) => void) => {
      configChangeHandlers.add(handler);
      // Immediately call handler with current config if available
      if (serverChannelConfig) {
        handler(serverChannelConfig);
      }
      return () => configChangeHandlers.delete(handler);
    },
    get roster() {
      return { ...currentRoster };
    },
    get totalMessageCount() {
      return serverTotalCount;
    },
    get chatMessageCount() {
      return serverChatMessageCount;
    },
    get firstChatMessageId() {
      return serverFirstChatMessageId;
    },
    async getMessagesBefore(beforeId: number, limit = 100) {
      const ref = ++refCounter;
      const timeoutMs = 30000;

      return new Promise<MessagesBeforeResult>((resolve, reject) => {
        const timeoutId = setTimeout(() => {
          pendingMessagesBeforeRequests.delete(ref);
          reject(new PubSubError("get-messages-before timeout", "timeout"));
        }, timeoutMs);

        pendingMessagesBeforeRequests.set(ref, { resolve, reject, timeoutId });

        try {
          ws.send(JSON.stringify({
            action: "get-messages-before",
            beforeId,
            limit,
            ref,
          }));
        } catch (err) {
          clearTimeout(timeoutId);
          pendingMessagesBeforeRequests.delete(ref);
          reject(new PubSubError(`send failed: ${err}`, "connection"));
        }
      });
    },

    // =========================================================================
    // Agent API
    // =========================================================================

    async listAgents(timeoutMs = 30000): Promise<AgentManifest[]> {
      const ref = ++refCounter;

      return new Promise((resolve, reject) => {
        if (ws.readyState !== WebSocket.OPEN) {
          reject(new PubSubError("not connected", "connection"));
          return;
        }

        const timeoutId = setTimeout(() => {
          pendingListAgents.delete(ref);
          reject(new PubSubError("list-agents timeout", "timeout"));
        }, timeoutMs);

        pendingListAgents.set(ref, { resolve, reject, timeoutId });

        ws.send(JSON.stringify({ action: "list-agents", ref }));
      });
    },

    async inviteAgent(
      agentId: string,
      options: InviteAgentOptions = {}
    ): Promise<InviteAgentResult> {
      const ref = ++refCounter;
      const { handle, config, timeoutMs = 30000 } = options;

      return new Promise((resolve, reject) => {
        if (ws.readyState !== WebSocket.OPEN) {
          reject(new PubSubError("not connected", "connection"));
          return;
        }

        const timeoutId = setTimeout(() => {
          pendingInviteAgent.delete(ref);
          reject(new PubSubError("invite-agent timeout", "timeout"));
        }, timeoutMs);

        pendingInviteAgent.set(ref, { resolve, reject, timeoutId });

        ws.send(JSON.stringify({
          action: "invite-agent",
          ref,
          agentId,
          handle,
          config,
        }));
      });
    },

    async channelAgents(timeoutMs = 30000): Promise<AgentInstanceSummary[]> {
      const ref = ++refCounter;

      return new Promise((resolve, reject) => {
        if (ws.readyState !== WebSocket.OPEN) {
          reject(new PubSubError("not connected", "connection"));
          return;
        }

        const timeoutId = setTimeout(() => {
          pendingChannelAgents.delete(ref);
          reject(new PubSubError("channel-agents timeout", "timeout"));
        }, timeoutMs);

        pendingChannelAgents.set(ref, { resolve, reject, timeoutId });

        ws.send(JSON.stringify({ action: "channel-agents", ref }));
      });
    },

    async removeAgent(
      instanceId: string,
      timeoutMs = 30000
    ): Promise<RemoveAgentResult> {
      const ref = ++refCounter;

      return new Promise((resolve, reject) => {
        if (ws.readyState !== WebSocket.OPEN) {
          reject(new PubSubError("not connected", "connection"));
          return;
        }

        const timeoutId = setTimeout(() => {
          pendingRemoveAgent.delete(ref);
          reject(new PubSubError("remove-agent timeout", "timeout"));
        }, timeoutMs);

        pendingRemoveAgent.set(ref, { resolve, reject, timeoutId });

        ws.send(JSON.stringify({
          action: "remove-agent",
          ref,
          instanceId,
        }));
      });
    },
  };
}
