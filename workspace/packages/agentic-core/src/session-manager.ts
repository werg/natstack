/**
 * SessionManager — Core agentic session orchestrator.
 *
 * Owns connection lifecycle, message state, method history, event dispatch,
 * and optional scope management. Both React adapters and headless consumers
 * use this class to run agentic sessions.
 *
 * State changes are exposed via a typed event emitter so adapters can
 * subscribe and pipe into their own state management (React useState,
 * plain callbacks, etc.).
 */

import type {
  PubSubClient,
  Participant,
  RosterUpdate,
  IncomingEvent,
  IncomingMethodResult,
  AggregatedEvent,
  AggregatedMessage,
  MethodDefinition,
  ChannelConfig,
  AttachmentInput,
  AgentDebugPayload,
  TypingData,
} from "@natstack/pubsub";
import { CONTENT_TYPE_TYPING } from "@natstack/pubsub";
import type { ScopeManager, ScopesApi } from "@workspace/eval";

import { TypedEmitter } from "./emitter.js";
import { ConnectionManager, type ConnectionStatus } from "./connection.js";
import { MessageState } from "./message-state.js";
import { MethodHistoryTracker } from "./method-history.js";
import {
  dispatchAgenticEvent,
  aggregatedToChatMessage,
  type AgentEventHandlers,
  type EventMiddleware,
  type DirtyRepoDetails,
} from "./event-dispatch.js";
import type {
  ChatMessage,
  ChatParticipantMetadata,
  ConnectionConfig,
  ChatSandboxValue,
  SandboxConfig,
  MethodHistoryEntry,
  PendingAgent,
  DisconnectedAgentInfo,
} from "./types.js";

// =============================================================================
// Types
// =============================================================================

export interface SessionManagerConfig {
  config: ConnectionConfig;
  metadata?: ChatParticipantMetadata;
  eventMiddleware?: EventMiddleware[];
  /** Optional scope manager for eval support */
  scopeManager?: ScopeManager;
  /** Optional sandbox config for eval support */
  sandbox?: SandboxConfig;
}

export interface ConnectOptions {
  channelId: string;
  methods?: Record<string, MethodDefinition>;
  channelConfig?: ChannelConfig;
  contextId?: string;
}

export interface SendOptions {
  attachments?: AttachmentInput[];
  idempotencyKey?: string;
}

export interface SessionManagerEvents {
  messagesChanged: (messages: readonly ChatMessage[]) => void;
  participantsChanged: (participants: Readonly<Record<string, Participant<ChatParticipantMetadata>>>) => void;
  allParticipantsChanged: (participants: Readonly<Record<string, Participant<ChatParticipantMetadata>>>) => void;
  methodHistoryChanged: (entries: ReadonlyMap<string, MethodHistoryEntry>) => void;
  connectionChanged: (connected: boolean, status: string) => void;
  scopeDirty: () => void;
  debugEvent: (event: AgentDebugPayload & { ts: number }) => void;
  dirtyRepoWarning: (handle: string, details: DirtyRepoDetails) => void;
  pendingAgentsChanged: (agents: ReadonlyMap<string, PendingAgent>) => void;
  error: (error: Error) => void;
}

const DEFAULT_METADATA: ChatParticipantMetadata = {
  name: "Headless Client",
  type: "panel",
  handle: "headless",
};

const PENDING_TIMEOUT_MS = 45_000;

// =============================================================================
// SessionManager
// =============================================================================

export class SessionManager extends TypedEmitter<SessionManagerEvents> {
  private connectionManager: ConnectionManager;
  private messageState: MessageState;
  private _methodHistory: MethodHistoryTracker;
  private _participants: Record<string, Participant<ChatParticipantMetadata>> = {};
  private _allParticipants: Record<string, Participant<ChatParticipantMetadata>> = {};
  private _historicalParticipants: Record<string, Participant<ChatParticipantMetadata>> = {};
  private _channelId: string | null = null;
  private _contextId: string | undefined;
  private _selfId: string | null = null;
  private _debugEvents: Array<AgentDebugPayload & { ts: number }> = [];
  private _dirtyRepoWarnings = new Map<string, DirtyRepoDetails>();
  private _pendingAgents = new Map<string, PendingAgent>();
  private expectedStops = new Set<string>();
  private eventMiddleware?: EventMiddleware[];
  private _scopeManager: ScopeManager | null;
  private _sandbox: SandboxConfig | null;
  private _config: ConnectionConfig;
  private _metadata: ChatParticipantMetadata;
  private _disposed = false;
  private _loadingMore = false;
  private _firstChatMessageId: number | undefined;
  private _scopeChangeUnsub: (() => void) | null = null;

  // Roster tracking state
  private suppressDisconnect = true;

  // Pending agent timeouts
  private pendingTimeouts = new Map<string, ReturnType<typeof setTimeout>>();

  // Typing state
  private typingMessageId: string | null = null;
  private typingTimeout: ReturnType<typeof setTimeout> | null = null;
  private readonly TYPING_DEBOUNCE_MS = 2000;

  constructor(managerConfig: SessionManagerConfig) {
    super();
    this._config = managerConfig.config;
    this._metadata = managerConfig.metadata ?? DEFAULT_METADATA;
    this.eventMiddleware = managerConfig.eventMiddleware;
    this._scopeManager = managerConfig.scopeManager ?? null;
    this._sandbox = managerConfig.sandbox ?? null;

    // Wire up scopeDirty event
    if (this._scopeManager) {
      this._scopeChangeUnsub = this._scopeManager.onChange(() => {
        if (this._scopeManager?.isDirty) {
          this.emit("scopeDirty");
        }
      });
    }

    // Wire up message state
    this.messageState = new MessageState((msgs) => {
      this.emit("messagesChanged", msgs);
    });

    // Wire up method history
    this._methodHistory = new MethodHistoryTracker({
      clientId: this._config.clientId,
      setMessages: (updater) => this.messageState.setMessages(updater),
      onChange: (entries) => this.emit("methodHistoryChanged", entries),
    });

    // Wire up connection manager
    this.connectionManager = new ConnectionManager({
      config: this._config,
      metadata: this._metadata,
      callbacks: {
        onEvent: (event) => this.handleEvent(event),
        onAggregatedEvent: (event) => this.handleAggregatedEvent(event),
        onRoster: (roster) => this.handleRoster(roster),
        onError: (error) => this.emit("error", error),
        onReconnect: () => this.handleReconnect(),
        onStatusChange: (status) => {
          this.emit("connectionChanged", status === "connected", status);
        },
      },
    });
  }

  // ===========================================================================
  // Lifecycle
  // ===========================================================================

  async connect(channelId: string, options?: Omit<ConnectOptions, "channelId">): Promise<void> {
    this._channelId = channelId;
    this._contextId = options?.contextId;
    const client = await this.connectionManager.connect({
      channelId,
      methods: options?.methods ?? {},
      channelConfig: options?.channelConfig,
      contextId: options?.contextId,
    });
    this._selfId = client.clientId ?? this._config.clientId;
    this._firstChatMessageId = client.firstChatMessageId;
  }

  disconnect(): void {
    this.stopTypingSync();
    this.connectionManager.disconnect();
    this._channelId = null;
  }

  /** Synchronous best-effort teardown — fire-and-forget scope persist, then cleanup. */
  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;
    this.stopTypingSync();
    this.clearPendingTimeouts();
    this._scopeChangeUnsub?.();
    if (this._scopeManager?.isDirty) {
      this._scopeManager.persist().catch((err) =>
        console.warn("[SessionManager] Scope persist on dispose failed:", err)
      );
    }
    this._scopeManager?.dispose();
    this.connectionManager.disconnect();
    this.removeAllListeners();
  }

  /** Awaitable teardown — flush scope to DB, disconnect, cleanup. */
  async close(): Promise<void> {
    if (this._disposed) return;
    this._disposed = true;
    await this.stopTyping();
    this.clearPendingTimeouts();
    this._scopeChangeUnsub?.();
    if (this._scopeManager?.isDirty) {
      try {
        await this._scopeManager.persist();
      } catch (err) {
        console.warn("[SessionManager] Scope persist on close failed:", err);
      }
    }
    this._scopeManager?.dispose();
    this.connectionManager.disconnect();
    this.removeAllListeners();
  }

  /** Symbol.asyncDispose for `await using session = ...` */
  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }

  // ===========================================================================
  // Communication
  // ===========================================================================

  async send(text: string, options?: SendOptions): Promise<string> {
    const client = this.connectionManager.client;
    if (!client?.connected) throw new Error("Not connected");

    await this.stopTyping();
    const idempotencyKey = options?.idempotencyKey ?? crypto.randomUUID();

    const { messageId } = await client.send(text, {
      attachments: options?.attachments,
      idempotencyKey,
    });

    // Optimistic local message
    const selfId = client.clientId ?? this._config.clientId;
    this.messageState.setMessages((prev) => {
      if (prev.some((m) => m.id === messageId)) return prev;
      return [...prev, { id: messageId, senderId: selfId, content: text, complete: true, pending: true, kind: "message" }];
    });

    return messageId;
  }

  async interrupt(agentId: string): Promise<void> {
    const client = this.connectionManager.client;
    if (!client) return;

    const roster = this._allParticipants;
    let targetId = agentId;
    if (!roster[agentId]) {
      const byHandle = Object.values(roster).find(
        (p) => p.metadata.handle === agentId && p.metadata.type !== "panel"
      );
      if (byHandle) targetId = byHandle.id;
      else {
        console.warn(`Cannot interrupt: agent ${agentId} not in roster`);
        return;
      }
    }
    try {
      await client.callMethod(targetId, "pause", { reason: "User interrupted execution" }).result;
    } catch (error) {
      console.error("Failed to interrupt agent:", error);
    }
  }

  async callMethod(participantId: string, method: string, args: unknown): Promise<unknown> {
    const client = this.connectionManager.client;
    if (!client) throw new Error("Not connected");
    return client.callMethod(participantId, method, args).result;
  }

  async loadEarlierMessages(): Promise<void> {
    const client = this.connectionManager.client;
    const oldestLoadedId = this.messageState.oldestLoadedId;
    if (!client || !oldestLoadedId || this._loadingMore || !this.hasMoreHistory) return;
    this._loadingMore = true;

    try {
    let currentBeforeId = oldestLoadedId;
    let olderMessages: ChatMessage[] = [];
    let hasMore = true;

    while (hasMore && olderMessages.length === 0) {
      const result = await client.getMessagesBefore(currentBeforeId, 50);
      olderMessages = result.messages
        .filter((msg) => msg.type === "message")
        .map((msg) => {
          const payload = typeof msg.payload === "string" ? JSON.parse(msg.payload as string) : msg.payload;
          const p = payload as Record<string, unknown> | null;
          const meta = msg.senderMetadata as Record<string, unknown> | undefined;
          const aggregated = {
            kind: "replay" as const,
            aggregated: true as const,
            type: "message" as const,
            id: (p?.["id"] as string) ?? String(msg.id),
            pubsubId: msg.id,
            content: (p?.["content"] as string) ?? "",
            complete: (p?.["complete"] as boolean) ?? true,
            incomplete: false,
            replyTo: p?.["replyTo"] as string | undefined,
            contentType: p?.["contentType"] as string | undefined,
            metadata: p?.["metadata"] as Record<string, unknown> | undefined,
            error: p?.["error"] as string | undefined,
            senderId: msg.senderId,
            senderName: meta?.["name"] as string | undefined,
            senderType: meta?.["type"] as string | undefined,
            senderHandle: meta?.["handle"] as string | undefined,
            ts: msg.ts,
          } as AggregatedMessage;
          return aggregatedToChatMessage(aggregated);
        });
      hasMore = result.hasMore;

      if (result.messages.length > 0) {
        currentBeforeId = result.messages[0]!.id;
      } else {
        hasMore = false;
        break;
      }
    }

    this.messageState.prepend(olderMessages, currentBeforeId, !hasMore);
    } finally {
      this._loadingMore = false;
    }
  }

  // ===========================================================================
  // Typing indicators
  // ===========================================================================

  async startTyping(): Promise<void> {
    const client = this.connectionManager.client;
    if (!client?.connected) return;
    if (this.typingTimeout) clearTimeout(this.typingTimeout);
    if (!this.typingMessageId) {
      const typingData: TypingData = {
        senderId: client.clientId ?? this._config.clientId,
        senderName: this._metadata.name,
        senderType: this._metadata.type,
      };
      const { messageId } = await client.send(JSON.stringify(typingData), {
        contentType: CONTENT_TYPE_TYPING,
        persist: false,
      });
      this.typingMessageId = messageId;
    }
    this.typingTimeout = setTimeout(() => {
      void this.stopTyping().catch((err) =>
        console.error("[SessionManager] Stop typing timeout error:", err)
      );
    }, this.TYPING_DEBOUNCE_MS);
  }

  async stopTyping(): Promise<void> {
    if (this.typingTimeout) {
      clearTimeout(this.typingTimeout);
      this.typingTimeout = null;
    }
    if (this.typingMessageId && this.connectionManager.client?.connected) {
      await this.connectionManager.client.update(this.typingMessageId, "", {
        complete: true,
        persist: false,
      });
      this.typingMessageId = null;
    }
  }

  private stopTypingSync(): void {
    if (this.typingTimeout) {
      clearTimeout(this.typingTimeout);
      this.typingTimeout = null;
    }
    this.typingMessageId = null;
  }

  // ===========================================================================
  // State getters (read-only snapshots)
  // ===========================================================================

  get messages(): readonly ChatMessage[] {
    return this.messageState.messages;
  }

  get participants(): Readonly<Record<string, Participant<ChatParticipantMetadata>>> {
    return this._participants;
  }

  get allParticipants(): Readonly<Record<string, Participant<ChatParticipantMetadata>>> {
    return this._allParticipants;
  }

  get methodHistory(): ReadonlyMap<string, MethodHistoryEntry> {
    return this._methodHistory.current;
  }

  get connected(): boolean {
    return this.connectionManager.connected;
  }

  get status(): string {
    return this.connectionManager.status;
  }

  get channelId(): string | null {
    return this._channelId;
  }

  get hasMoreHistory(): boolean {
    if (this.messageState.paginationExhausted) return false;
    if (this.messageState.oldestLoadedId === null) return false;
    if (this._firstChatMessageId === undefined) return false;
    return this.messageState.oldestLoadedId > this._firstChatMessageId;
  }

  get loadingMore(): boolean {
    return this._loadingMore;
  }

  get contextId(): string | undefined {
    return this._contextId;
  }

  /** Pagination state: oldest loaded message ID */
  get oldestLoadedId(): number | null {
    return this.messageState.oldestLoadedId;
  }

  /** Pagination state: whether all history has been loaded */
  get paginationExhausted(): boolean {
    return this.messageState.paginationExhausted;
  }

  // ===========================================================================
  // Public mutation API (for adapter layers like React hooks)
  // ===========================================================================

  /** Update messages via an updater function (same semantics as React setState) */
  updateMessages(updater: (prev: ChatMessage[]) => ChatMessage[]): void {
    this.messageState.setMessages(updater);
  }

  /** Dispatch a raw message window action (prepend, replace) */
  dispatchMessageAction(action: import("./message-reducer.js").MessageWindowAction): void {
    this.messageState.dispatch(action);
  }

  /** Add a method history entry */
  addMethodHistoryEntry(entry: MethodHistoryEntry): void {
    this._methodHistory.addEntry(entry);
  }

  /** Update a method history entry */
  updateMethodHistoryEntry(callId: string, updates: Partial<MethodHistoryEntry>): void {
    this._methodHistory.updateEntry(callId, updates);
  }

  /** Handle a method result (success, error, console chunk, progress) */
  handleMethodResult(result: IncomingMethodResult): void {
    this._methodHistory.handleMethodResult(result);
  }

  /** Clear all method history */
  clearMethodHistory(): void {
    this._methodHistory.clear();
  }

  /** Dismiss a dirty repo warning by agent handle */
  dismissDirtyRepoWarning(agentHandle: string): void {
    if (!this._dirtyRepoWarnings.has(agentHandle)) return;
    this._dirtyRepoWarnings = new Map(this._dirtyRepoWarnings);
    this._dirtyRepoWarnings.delete(agentHandle);
  }

  /** Add a pending agent (for launcher tracking before debug events arrive) */
  addPendingAgent(handle: string, agentId: string): void {
    if (this._pendingAgents.has(handle)) return;
    this._pendingAgents = new Map(this._pendingAgents);
    this._pendingAgents.set(handle, { agentId, status: "starting" });
    this.schedulePendingTimeouts();
    this.emit("pendingAgentsChanged", this._pendingAgents);
  }

  get scope(): Record<string, unknown> {
    return this._scopeManager?.current ?? {};
  }

  get scopeManager(): ScopeManager | null {
    return this._scopeManager;
  }

  /** Set the scope manager (for deferred initialization, e.g., when channelId isn't known at construction) */
  setScopeManager(mgr: ScopeManager): void {
    if (this._scopeChangeUnsub) this._scopeChangeUnsub();
    this._scopeManager = mgr;
    this._scopeChangeUnsub = mgr.onChange(() => {
      if (mgr.isDirty) this.emit("scopeDirty");
    });
  }

  get scopesApi(): ScopesApi | null {
    return this._scopeManager?.api ?? null;
  }

  get client(): PubSubClient<ChatParticipantMetadata> | null {
    return this.connectionManager.client;
  }

  get debugEvents(): readonly (AgentDebugPayload & { ts: number })[] {
    return this._debugEvents;
  }

  get dirtyRepoWarnings(): ReadonlyMap<string, DirtyRepoDetails> {
    return this._dirtyRepoWarnings;
  }

  get pendingAgents(): ReadonlyMap<string, PendingAgent> {
    return this._pendingAgents;
  }

  /** Build a ChatSandboxValue for tool providers. Calls defer to current client at invocation time. */
  buildChatSandboxValue(): ChatSandboxValue {
    return {
      publish: (eventType, payload, opts) => {
        const client = this.connectionManager.client;
        if (!client) return Promise.reject(new Error("Not connected"));
        if (eventType === "message" && typeof payload === "object" && payload !== null && !("id" in payload)) {
          (payload as Record<string, unknown>)["id"] = crypto.randomUUID();
        }
        return client.publish(eventType, payload, {
          ...opts,
          idempotencyKey: (opts as { idempotencyKey?: string } | undefined)?.idempotencyKey ?? crypto.randomUUID(),
        }) as Promise<unknown>;
      },
      callMethod: async (pid, method, callArgs) => {
        const client = this.connectionManager.client;
        if (!client) throw new Error("Not connected");
        const handle = client.callMethod(pid, method, callArgs);
        return (handle as { result: Promise<unknown> }).result;
      },
      contextId: this._contextId ?? "",
      channelId: this._channelId,
      rpc: this._sandbox?.rpc ?? { call: () => Promise.reject(new Error("No RPC configured")) },
    };
  }

  // ===========================================================================
  // Internal event handling
  // ===========================================================================

  private handleEvent(event: IncomingEvent): void {
    try {
      const selfId = this._selfId ?? this._config.clientId;
      const handlers: AgentEventHandlers = {
        setMessages: (updater) => this.messageState.setMessages(updater),
        addMethodHistoryEntry: (entry) => this._methodHistory.addEntry(entry),
        handleMethodResult: (result) => this._methodHistory.handleMethodResult(result),
        setDebugEvents: (updater) => {
          this._debugEvents = updater(this._debugEvents);
          // Emit for last event added
          const last = this._debugEvents[this._debugEvents.length - 1];
          if (last) this.emit("debugEvent", last);
        },
        setDirtyRepoWarnings: (updater) => {
          const prev = this._dirtyRepoWarnings;
          this._dirtyRepoWarnings = updater(prev);
          // Emit only for new or changed warnings
          for (const [handle, details] of this._dirtyRepoWarnings) {
            if (!prev.has(handle)) {
              this.emit("dirtyRepoWarning", handle, details);
            }
          }
        },
        setPendingAgents: (updater) => {
          this._pendingAgents = updater(this._pendingAgents);
          this.schedulePendingTimeouts();
          this.emit("pendingAgentsChanged", this._pendingAgents);
        },
        expectedStops: this.expectedStops,
      };

      dispatchAgenticEvent(event, handlers, selfId, this._allParticipants, this.eventMiddleware);
    } catch (err) {
      console.error("[SessionManager] Event dispatch error:", err);
    }
  }

  private handleAggregatedEvent(event: AggregatedEvent): void {
    switch (event.type) {
      case "message": {
        const chatMsg = aggregatedToChatMessage(event as AggregatedMessage);
        this.messageState.setMessages((prev) => {
          if (chatMsg.pubsubId && prev.some((m) => m.pubsubId === chatMsg.pubsubId)) return prev;
          const existingIdx = prev.findIndex((m) => m.id === chatMsg.id);
          if (existingIdx >= 0) {
            const existing = prev[existingIdx]!;
            if (chatMsg.pubsubId && !existing.pubsubId) {
              const updated = [...prev];
              updated[existingIdx] = { ...existing, pubsubId: chatMsg.pubsubId, pending: false };
              return updated;
            }
            return prev;
          }
          return [...prev, chatMsg];
        });
        break;
      }
      case "method-call": {
        const mc = event as AggregatedEvent & { callId: string; methodName: string; args: unknown; providerId?: string; senderId: string; ts: number };
        this._methodHistory.addEntry({
          callId: mc.callId,
          methodName: mc.methodName,
          description: undefined,
          args: mc.args,
          status: "pending",
          startedAt: mc.ts,
          providerId: mc.providerId,
          callerId: mc.senderId,
          handledLocally: false,
        });
        break;
      }
      case "method-result": {
        const mr = event as AggregatedEvent & { callId: string; content: unknown; status: string; senderId: string; ts: number; pubsubId?: number; senderName?: string; senderType?: string; senderHandle?: string };
        const isError = mr.status === "error";
        this._methodHistory.handleMethodResult({
          kind: "replay",
          senderId: mr.senderId,
          ts: mr.ts,
          callId: mr.callId,
          content: mr.content,
          complete: mr.status !== "incomplete",
          isError,
          pubsubId: mr.pubsubId,
          senderMetadata: {
            name: mr.senderName,
            type: mr.senderType,
            handle: mr.senderHandle,
          },
        } as IncomingMethodResult);
        break;
      }
    }
  }

  private handleRoster(roster: RosterUpdate<ChatParticipantMetadata>): void {
    const prev = this._participants;
    const newParticipants = roster.participants;
    this._participants = newParticipants;

    // Unsuppress disconnect detection once we see ourselves in the roster
    if (this.suppressDisconnect && this._config.clientId in newParticipants) {
      this.suppressDisconnect = false;
    }

    // Track historical participants (for method description lookup)
    this._historicalParticipants = { ...this._historicalParticipants };
    for (const [id, p] of Object.entries(newParticipants)) {
      if (!(id in this._historicalParticipants)) {
        this._historicalParticipants[id] = p;
      }
    }
    for (const [id, p] of Object.entries(prev)) {
      if (!(id in newParticipants)) {
        this._historicalParticipants[id] = p;
      }
    }
    this._allParticipants = { ...this._historicalParticipants, ...newParticipants };

    // --- Disconnect detection ---
    const prevIds = new Set(Object.keys(prev));
    const newIds = new Set(Object.keys(newParticipants));
    const disconnectedIds: string[] = [];

    if (!this.suppressDisconnect) {
      const changeIsGraceful =
        roster.change?.type === "leave" && roster.change.leaveReason === "graceful";

      for (const prevId of prevIds) {
        if (!newIds.has(prevId)) {
          disconnectedIds.push(prevId);
          if (changeIsGraceful && roster.change?.participantId === prevId) {
            continue;
          }
          const disconnected = prev[prevId];
          const meta = disconnected?.metadata;
          if (meta && meta.type !== "panel") {
            const isExpectedStop =
              this.expectedStops.has(meta.handle) || changeIsGraceful;
            this.expectedStops.delete(meta.handle);

            if (!isExpectedStop) {
              const agentInfo: DisconnectedAgentInfo = {
                name: meta.name,
                handle: meta.handle,
                panelId: meta.panelId,
                agentTypeId: meta.agentTypeId,
                type: meta.type,
              };
              this.messageState.setMessages((msgs) => [
                ...msgs,
                {
                  id: `system-disconnect-${prevId}-${Date.now()}`,
                  senderId: "system",
                  content: "",
                  kind: "system",
                  complete: true,
                  disconnectedAgent: agentInfo,
                },
              ]);
            }
          }
        }
      }
    }

    // Clear typing indicators for disconnected agents
    if (disconnectedIds.length > 0) {
      const disconnectedSet = new Set(disconnectedIds);
      this.messageState.setMessages((msgs) => {
        let changed = false;
        const next = msgs.map((msg) => {
          if (
            msg.contentType === "typing" &&
            !msg.complete &&
            disconnectedSet.has(msg.senderId)
          ) {
            changed = true;
            return { ...msg, complete: true };
          }
          return msg;
        });
        return changed ? next : msgs;
      });
    }

    // Handle reconnecting agents — clear stale typing from old client IDs
    const reconnectingHandles = new Set<string>();
    for (const newId of newIds) {
      if (
        !prevIds.has(newId) &&
        newParticipants[newId]?.metadata?.type !== "panel"
      ) {
        reconnectingHandles.add(newParticipants[newId]!.metadata.handle);
      }
    }

    if (reconnectingHandles.size > 0) {
      const staleSenderIds = new Set<string>();
      for (const [id, p] of Object.entries(prev)) {
        if (reconnectingHandles.has(p.metadata.handle) && !newIds.has(id)) {
          staleSenderIds.add(id);
        }
      }
      if (staleSenderIds.size > 0) {
        this.messageState.setMessages((msgs) => {
          let changed = false;
          const next = msgs.map((msg) => {
            if (
              msg.contentType === "typing" &&
              !msg.complete &&
              staleSenderIds.has(msg.senderId)
            ) {
              changed = true;
              return { ...msg, complete: true };
            }
            return msg;
          });
          return changed ? next : msgs;
        });
      }
    }

    // Remove stale disconnect messages when an agent with the same handle reconnects
    const agentHandles = new Set(
      Object.values(newParticipants)
        .filter((p) => p.metadata.type !== "panel")
        .map((p) => p.metadata.handle),
    );
    this.messageState.setMessages((msgs) => {
      const filtered = msgs.filter((msg) => {
        if (msg.kind !== "system" || !msg.disconnectedAgent) return true;
        return !agentHandles.has(msg.disconnectedAgent.handle);
      });
      return filtered.length === msgs.length ? msgs : filtered;
    });

    // Clear pending agents that joined
    if (this._pendingAgents.size > 0) {
      let changed = false;
      const next = new Map(this._pendingAgents);
      for (const p of Object.values(newParticipants)) {
        if (next.has(p.metadata.handle)) {
          next.delete(p.metadata.handle);
          changed = true;
        }
      }
      if (changed) {
        this._pendingAgents = next;
        this.schedulePendingTimeouts();
        this.emit("pendingAgentsChanged", this._pendingAgents);
      }
    }

    this.emit("participantsChanged", this._participants);
    this.emit("allParticipantsChanged", this._allParticipants);
  }

  private handleReconnect(): void {
    this._historicalParticipants = {};
    this.suppressDisconnect = true;
    // Remove all disconnect system messages
    this.messageState.setMessages((msgs) => {
      const filtered = msgs.filter(
        (msg) => msg.kind !== "system" || !msg.disconnectedAgent,
      );
      return filtered.length === msgs.length ? msgs : filtered;
    });
  }

  // ===========================================================================
  // Pending agent timeouts
  // ===========================================================================

  private schedulePendingTimeouts(): void {
    // Schedule timeouts for new "starting" agents
    for (const [handle, agent] of this._pendingAgents) {
      if (agent.status === "starting" && !this.pendingTimeouts.has(handle)) {
        const timeout = setTimeout(() => {
          this.pendingTimeouts.delete(handle);
          const existing = this._pendingAgents.get(handle);
          if (existing?.status === "starting") {
            const next = new Map(this._pendingAgents);
            next.set(handle, {
              ...existing,
              status: "error",
              error: { message: "Agent failed to start (timeout)" },
            });
            this._pendingAgents = next;
            this.emit("pendingAgentsChanged", this._pendingAgents);
          }
        }, PENDING_TIMEOUT_MS);
        this.pendingTimeouts.set(handle, timeout);
      }
    }
    // Clear timeouts for agents no longer in the pending map
    for (const [handle, timeout] of this.pendingTimeouts) {
      if (!this._pendingAgents.has(handle)) {
        clearTimeout(timeout);
        this.pendingTimeouts.delete(handle);
      }
    }
  }

  private clearPendingTimeouts(): void {
    for (const timeout of this.pendingTimeouts.values()) {
      clearTimeout(timeout);
    }
    this.pendingTimeouts.clear();
  }
}
