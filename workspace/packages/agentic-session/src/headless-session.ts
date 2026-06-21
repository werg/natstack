/**
 * HeadlessSession — Channel-message-driven headless agentic session wrapper.
 *
 * Provides a programmatic interface for spawning agent chats from skill
 * code, system tests, etc. Pi runs in-process inside the worker DO; this
 * wrapper subscribes a PubSubClient to the channel and reads persisted
 * channel messages (text, thinking, action, image, inline_ui) to expose
 * chat state.
 * Panel-local action bars are not channel messages, so headless sessions do
 * not expose them.
 *
 * Public API:
 *   - `HeadlessSession.create()` — wire up a session, no agent yet
 *   - `HeadlessSession.createWithAgent()` — full setup: connect client + subscribe DO
 *   - `send(text, opts)` — publish a user message
 *   - `waitForAgentMessage()` / `waitForIdle()` / `sendAndWait()` — test helpers
 *   - `messages`, `participants`, `connected`, `status` — getters
 *   - `snapshot()` — diagnostic snapshot
 *   - `dispose()` / `close()` — teardown
 */

import {
  ConnectionManager,
  chatMessagesFromChannelView,
  type ConnectionConfig,
  type AgentSubscriptionConfig,
  type ChatParticipantMetadata,
  type ChatMessage,
  type DirtyRepoDetails,
  unwrapChatMethodResult,
  type ChatMethodResult,
} from "@workspace/agentic-core";
import type {
  PubSubClient,
  Participant,
  ChannelConfig,
  MethodDefinition,
  AttachmentInput,
  AgentDebugPayload,
  IncomingEvent,
} from "@workspace/pubsub";
import {
  AGENTIC_EVENT_PAYLOAD_KIND,
  createInitialChannelViewState,
  reduceChannelView,
  type AgenticEvent,
  type ChannelEnvelope,
  type ChannelViewState,
} from "@workspace/agentic-protocol";
import { z } from "zod";
import {
  getRecommendedChannelConfig,
  retireHeadlessAgent,
  subscribeHeadlessAgent,
  unsubscribeHeadlessAgent,
} from "./channel.js";

// ===========================================================================
// Types
// ===========================================================================

export interface SessionSnapshot {
  messages: readonly ChatMessage[];
  invocations: Array<{
    id: string;
    name: string;
    status: string;
    args?: unknown;
    result?: unknown;
    consoleOutput?: string;
    error?: string;
  }>;
  debugEvents: readonly (AgentDebugPayload & { ts: number })[];
  cleanupErrors: readonly SessionCleanupError[];
  participants: Record<string, { name: string; type: string; handle: string; connected: boolean }>;
  localMethodNames: readonly string[];
  connected: boolean;
  duration: number;
  /** The report title set via the agent's `set_title` tool (null until set). */
  title: string | null;
}

export interface HeadlessSessionConfig {
  config: ConnectionConfig;
  metadata?: ChatParticipantMetadata;
}

export interface HeadlessWithAgentConfig extends HeadlessSessionConfig {
  rpcCall: (target: string, method: string, args: unknown[]) => Promise<unknown>;
  source: string;
  className: string;
  objectKey?: string;
  contextId: string;
  channelId?: string;
  channelConfig?: ChannelConfig;
  methods?: Record<string, MethodDefinition>;
  /**
   * Pi-native pass-through subscription config. Common keys: `model`,
   * `thinkingLevel`, `approvalLevel`, `systemPrompt`, and
   * `systemPromptMode`.
   */
  extraConfig?: AgentSubscriptionConfig;
}

// ===========================================================================
// HeadlessSession
// ===========================================================================

const DEFAULT_METADATA: ChatParticipantMetadata = {
  name: "Headless Client",
  type: "headless",
  handle: "headless",
};

interface SessionCleanupError {
  phase: string;
  message: string;
  at: number;
}

interface MessageListener {
  (msg: ChatMessage): void;
}

function agentFailureMessageReason(msg: ChatMessage, clientId: string): string | null {
  if (msg.senderId === clientId || !msg.complete || msg.pending) return null;
  const error = (msg as { error?: unknown }).error;
  if (typeof error !== "string" || error.trim().length === 0) return null;
  if (
    msg.contentType === "invocation" ||
    msg.contentType === "thinking" ||
    msg.contentType === "typing"
  ) {
    return null;
  }
  return error.trim();
}

export class HeadlessSession {
  private _connection: ConnectionManager;
  private _client: PubSubClient<ChatParticipantMetadata> | null = null;
  private _channelId: string | null = null;
  private _clientId: string;
  private _createdAt = Date.now();
  private _config: HeadlessSessionConfig;
  private _agentEntityId: string | null = null;
  private _agentTargetId: string | null = null;
  private _agentRpcCall: HeadlessWithAgentConfig["rpcCall"] | null = null;

  // Channel message state (derived from persisted + live channel messages)
  private _chatMessages = new Map<string, ChatMessage>();
  private _chatMessageOrder: string[] = [];
  private _channelView: ChannelViewState = createInitialChannelViewState();
  private _hasIncomplete = false;
  private _participants: Record<string, Participant<ChatParticipantMetadata>> = {};
  private _debugEvents: Array<AgentDebugPayload & { ts: number }> = [];
  private _cleanupErrors: SessionCleanupError[] = [];
  private _dirtyRepoWarnings = new Map<string, DirtyRepoDetails>();
  private _registeredMethodNames: string[] = [];
  private _disposed = false;
  private _consumeAbort: AbortController | null = null;
  /**
   * The session/report title set by the agent's `set_title` tool. A headless
   * session has no chat panel, so the title lives HERE (on the report wrapper),
   * not on the channel config — the channel's `updateConfig` is panel/server-only
   * and a headless client is a `do` caller, so routing `set_title` through the
   * channel would fail the caller-kind gate. Surfaced via `title` + `snapshot()`.
   */
  private _title: string | null = null;

  // Listeners
  private _messageListeners = new Set<MessageListener>();

  private constructor(config: HeadlessSessionConfig) {
    this._config = config;
    this._clientId = config.config.clientId;

    this._connection = new ConnectionManager({
      config: config.config,
      metadata: config.metadata ?? DEFAULT_METADATA,
      callbacks: {
        onEvent: (event) => this.handleEvent(event),
      },
    });
  }

  private pubsubAgenticEventToEnvelope(wire: {
    pubsubId?: number;
    senderId?: string;
    senderMetadata?: { name?: string; type?: string; handle?: string };
    ts?: number;
    payload: AgenticEvent;
  }): ChannelEnvelope<AgenticEvent> {
    const participantId = wire.senderId ?? wire.payload.actor.id;
    const metadata = wire.senderMetadata;
    return {
      envelopeId: `pubsub:${wire.pubsubId ?? crypto.randomUUID()}` as never,
      channelId: (this._channelId ?? "headless") as never,
      seq: wire.pubsubId ?? 0,
      from: {
        kind: this.participantKind(metadata?.type),
        id: participantId,
        displayName: metadata?.name,
        participantId,
        metadata,
      },
      payload: wire.payload,
      payloadKind: AGENTIC_EVENT_PAYLOAD_KIND,
      publishedAt: new Date(wire.ts ?? Date.now()).toISOString(),
    };
  }

  private participantKind(type: string | undefined): "user" | "agent" | "panel" | "external" {
    if (type === "agent" || type === "headless") return "agent";
    if (type === "panel" || type === "client") return "panel";
    return "external";
  }

  /** Create a HeadlessSession with the given config (no agent yet). */
  static create(config: HeadlessSessionConfig): HeadlessSession {
    return new HeadlessSession(config);
  }

  /**
   * Convenience: create a channel, subscribe a DO agent, connect, all in one.
   */
  static async createWithAgent(config: HeadlessWithAgentConfig): Promise<HeadlessSession> {
    const channelId = config.channelId ?? `headless-${crypto.randomUUID()}`;
    const objectKey = config.objectKey ?? `headless-${crypto.randomUUID()}`;
    const session = new HeadlessSession(config);

    const defaultMethods = session.buildDefaultMethods();
    const methods: Record<string, MethodDefinition> = {
      ...defaultMethods,
      ...config.methods,
    };

    const channelConfig: ChannelConfig = {
      ...getRecommendedChannelConfig(),
      ...config.channelConfig,
    } as ChannelConfig;

    await session.connect(channelId, {
      channelConfig,
      contextId: config.contextId,
      methods,
    });

    try {
      const subscription = await subscribeHeadlessAgent({
        rpcCall: config.rpcCall,
        source: config.source,
        className: config.className,
        objectKey,
        channelId,
        contextId: config.contextId,
        extraConfig: config.extraConfig,
      });
      session._agentEntityId = subscription.entityId;
      session._agentTargetId = subscription.targetId;
      session._agentRpcCall = config.rpcCall;
    } catch (err) {
      session.disconnect();
      throw err;
    }

    return session;
  }

  // ===========================================================================
  // Default headless methods
  // ===========================================================================

  private buildDefaultMethods(): Record<string, MethodDefinition> {
    const methods: Record<string, MethodDefinition> = {};

    methods["set_title"] = {
      description: "Set the conversation title",
      parameters: z.object({ title: z.string().describe("The new title") }),
      execute: async (args: unknown) => {
        const { title } = args as { title: string };
        if (!title) return { ok: false, error: "Missing title" };
        // Headless context: there is no chat panel. Store the title on the
        // session/report itself (the `do`-permitted path) instead of routing it
        // through the channel's `updateConfig`, which is panel/server-only — a
        // headless client is a `do` caller and would hit the caller-kind gate
        // (`updateConfig: caller kind "do" is not permitted (allowed: panel,
        // server)`). The channel title stays untouched.
        this._title = title;
        const warnings: string[] = [];
        // Best-effort: also publish the title as this client's server-side
        // entity display title. `runtime.setTitle` admits `do` callers (unlike
        // `updateConfig`), so this surfaces in approval/registry UIs without
        // touching channel config. A failure is non-fatal — the report title is
        // already recorded above.
        try {
          await this._config.config.rpc.call("main", "runtime.setTitle", [
            title,
            { explicit: true },
          ]);
        } catch (err) {
          warnings.push(err instanceof Error ? err.message : String(err));
          console.warn("[HeadlessSession] runtime.setTitle failed:", err);
        }
        return warnings.length > 0 ? { ok: true, warnings } : { ok: true };
      },
    };

    return methods;
  }

  // ===========================================================================
  // Event tracking (debug events)
  // ===========================================================================

  private handleEvent(event: IncomingEvent): void {
    if (event.type === "agent-debug") {
      const payload = (event as IncomingEvent & { payload: AgentDebugPayload }).payload;
      const ts = (event as IncomingEvent & { ts: number }).ts ?? Date.now();
      this._debugEvents.push({ ...payload, ts });

      // Dirty repo warnings
      if (payload.debugType === "lifecycle" && payload.event === "warning" && payload.reason === "dirty-repo") {
        const details = payload.details as DirtyRepoDetails | undefined;
        if (details) {
          this._dirtyRepoWarnings.set(payload.handle, details);
        }
      }
    }
  }

  // ===========================================================================
  // Connection lifecycle
  // ===========================================================================

  async connect(
    channelId: string,
    options?: { channelConfig?: ChannelConfig; contextId?: string; methods?: Record<string, MethodDefinition> },
  ): Promise<void> {
    const methods = options?.methods ?? this.buildDefaultMethods();
    this._registeredMethodNames = Object.keys(methods).sort();

    this._client = await this._connection.connect({
      channelId,
      methods,
      ...(options?.channelConfig ? { channelConfig: options.channelConfig } : {}),
      ...(options?.contextId ? { contextId: options.contextId } : {}),
    });
    this._channelId = channelId;

    // Roster subscription
    this._client.onRoster?.((update) => {
      this._participants = { ...update.participants };
    });

    // Message stream → snapshot derivation
    this._consumeAbort = new AbortController();
    void this.consumeChannelMessages(this._consumeAbort.signal);
  }

  private async consumeChannelMessages(signal: AbortSignal): Promise<void> {
    if (!this._client) return;
    try {
      for await (const event of this._client.events({ includeReplay: true, includeSignals: false })) {
        if (signal.aborted) break;

        const wire = event as unknown as {
          type?: string;
          pubsubId?: number;
          senderId?: string;
          senderMetadata?: { name?: string; type?: string; handle?: string };
          ts?: number;
          payload?: AgenticEvent;
        };

        if (wire.type === AGENTIC_EVENT_PAYLOAD_KIND && wire.payload) {
          this._channelView = reduceChannelView(this._channelView, this.pubsubAgenticEventToEnvelope({
            pubsubId: wire.pubsubId,
            senderId: wire.senderId,
            senderMetadata: wire.senderMetadata,
            ts: wire.ts,
            payload: wire.payload,
          }));
          this._chatMessages.clear();
          this._chatMessageOrder = [];
          for (const msg of chatMessagesFromChannelView(this._channelView)) {
            this._chatMessages.set(msg.id, msg);
            this._chatMessageOrder.push(msg.id);
          }
          this.recomputeHasIncomplete();
          this.notifyListeners();
        }
      }
    } catch (err) {
      if (!signal.aborted) console.error("[HeadlessSession] message consumer error:", err);
    }
  }

  /** Scan all messages to determine if any are still incomplete (streaming). */
  private recomputeHasIncomplete(): void {
    for (const msg of this._chatMessages.values()) {
      if (!msg.complete) {
        this._hasIncomplete = true;
        return;
      }
    }
    this._hasIncomplete = false;
  }

  private notifyListeners(): void {
    const msgs = this.messages;
    if (msgs.length === 0) return;
    const latest = msgs[msgs.length - 1]!;
    for (const listener of this._messageListeners) {
      try {
        listener(latest);
      } catch (err) {
        console.error("[HeadlessSession] message listener threw:", err);
      }
    }
  }

  /**
   * Subscribe to message-state updates. Fires on every channel update,
   * including streaming deltas (so a renderer can show partial agent output).
   * Returns an unsubscribe function. Used by non-React renderers (e.g. the Ink
   * terminal chat) the same way the React hooks consume the message stream.
   */
  onMessage(listener: (msg: ChatMessage) => void): () => void {
    this._messageListeners.add(listener);
    return () => {
      this._messageListeners.delete(listener);
    };
  }

  async send(text: string, options?: { attachments?: AttachmentInput[]; idempotencyKey?: string }): Promise<string> {
    if (!this._client) throw new Error("Not connected");
    const result = await this._client.send(text, options);
    return result.messageId;
  }

  async interrupt(agentId: string): Promise<void> {
    if (!this._client) return;
    try {
      this._client.callMethod(agentId, "pause", {});
    } catch (err) {
      console.warn("[HeadlessSession] interrupt failed:", err);
    }
  }

  async callMethod(participantId: string, method: string, args: unknown): Promise<unknown> {
    if (!this._client) throw new Error("Not connected");
    const handle = this._client.callMethod(participantId, method, args);
    const result = await (handle as { result: Promise<ChatMethodResult> }).result;
    return unwrapChatMethodResult(result);
  }

  async callMethodResult(participantId: string, method: string, args: unknown): Promise<ChatMethodResult> {
    if (!this._client) throw new Error("Not connected");
    const handle = this._client.callMethod(participantId, method, args);
    return (handle as { result: Promise<ChatMethodResult> }).result;
  }

  async loadEarlierMessages(): Promise<void> {
    /* no-op: channel replay delivers full persisted history */
  }

  disconnect(): void {
    if (this._consumeAbort) {
      this._consumeAbort.abort();
      this._consumeAbort = null;
    }
    try {
      this._connection.disconnect();
    } catch (err) {
      this.recordCleanupError("disconnect", err);
    }
    this._client = null;
    this._channelId = null;
  }

  private recordCleanupError(phase: string, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[HeadlessSession] ${phase} failed:`, error);
    this._cleanupErrors.push({ phase, message, at: Date.now() });
  }

  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;
    this.disconnect();
    this._messageListeners.clear();
  }

  async close(): Promise<void> {
    const entityId = this._agentEntityId;
    const targetId = this._agentTargetId;
    const channelId = this._channelId;
    const rpcCall = this._agentRpcCall;
    this._agentEntityId = null;
    this._agentTargetId = null;
    this._agentRpcCall = null;
    if (targetId && channelId && rpcCall) {
      await unsubscribeHeadlessAgent({ rpcCall, targetId, channelId }).catch((err) => {
        this.recordCleanupError("unsubscribeHeadlessAgent", err);
      });
    }
    this.dispose();
    if (entityId && rpcCall) {
      await retireHeadlessAgent({ rpcCall, entityId }).catch((err) => {
        this.recordCleanupError("retireHeadlessAgent", err);
      });
    }
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }

  // ===========================================================================
  // State getters
  // ===========================================================================

  get messages(): readonly ChatMessage[] {
    return this._chatMessageOrder.map((id) => this._chatMessages.get(id)!);
  }

  get participants(): Readonly<Record<string, Participant<ChatParticipantMetadata>>> {
    return this._participants;
  }

  get allParticipants(): Readonly<Record<string, Participant<ChatParticipantMetadata>>> {
    return this._participants;
  }

  get connected(): boolean {
    return this._connection.connected;
  }

  get status(): string {
    return this._connection.status;
  }

  get channelId(): string | null {
    return this._channelId;
  }

  /** The report title set via the agent's `set_title` tool (null until set). */
  get title(): string | null {
    return this._title;
  }

  get debugEvents(): readonly (AgentDebugPayload & { ts: number })[] {
    return this._debugEvents;
  }

  get isStreaming(): boolean {
    return this._hasIncomplete;
  }

  get client(): PubSubClient<ChatParticipantMetadata> | null {
    return this._client;
  }

  // ===========================================================================
  // Snapshot
  // ===========================================================================

  snapshot(): SessionSnapshot {
    const now = Date.now();
    const participants: SessionSnapshot["participants"] = {};
    for (const [id, p] of Object.entries(this._participants)) {
      participants[id] = {
        name: p.metadata.name,
        type: p.metadata.type,
        handle: p.metadata.handle,
        connected: true,
      };
    }
    const invocations = this.messages
      .filter((message) => message.invocation)
      .map((message) => ({
        id: message.invocation!.id,
        name: message.invocation!.name,
        status: message.invocation!.execution.status,
        args: message.invocation!.arguments,
        result: message.invocation!.execution.result,
        consoleOutput: message.invocation!.execution.consoleOutput,
        error: message.invocation!.execution.isError
          ? String(message.invocation!.execution.result ?? message.invocation!.execution.description ?? "Invocation failed")
          : undefined,
      }));
    return {
      messages: this.messages,
      invocations,
      debugEvents: this._debugEvents,
      cleanupErrors: [...this._cleanupErrors],
      participants,
      localMethodNames: this._registeredMethodNames,
      connected: this._connection.connected,
      duration: now - this._createdAt,
      title: this._title,
    };
  }

  // ===========================================================================
  // Headless-specific
  // ===========================================================================

  getRecommendedChannelConfig() {
    return getRecommendedChannelConfig();
  }

  /**
   * Wait for a message from an agent (any non-self participant).
   */
  waitForAgentMessage(opts?: { timeoutMs?: number; signal?: AbortSignal }): Promise<ChatMessage> {
    const isAgentMessage = (msg: ChatMessage): boolean =>
      msg.senderId !== this._clientId &&
      msg.kind === "message" &&
      !!msg.complete &&
      !msg.pending &&
      msg.contentType !== "thinking" &&
      msg.contentType !== "typing" &&
      msg.contentType !== "invocation";

    const baselineMessages = this.messages;
    const alreadyPresent = [...baselineMessages].reverse().find(isAgentMessage);
    const baselineCount = baselineMessages.length;

    return new Promise<ChatMessage>((resolve, reject) => {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const cleanup = () => {
        if (timeout !== undefined) clearTimeout(timeout);
        opts?.signal?.removeEventListener("abort", onAbort);
        this._messageListeners.delete(listener);
      };
      const onAbort = () => {
        cleanup();
        reject(new Error("waitForAgentMessage aborted"));
      };
      if (opts?.signal?.aborted) {
        onAbort();
        return;
      }
      opts?.signal?.addEventListener("abort", onAbort, { once: true });
      if (opts?.timeoutMs !== undefined) {
        timeout = setTimeout(() => {
          cleanup();
          reject(new Error(`Timed out waiting for agent message after ${opts.timeoutMs}ms`));
        }, opts.timeoutMs);
      }

      const listener: MessageListener = () => {
        const current = this.messages;
        if (current.length <= baselineCount) return;
        for (let i = current.length - 1; i >= baselineCount; i--) {
          const msg = current[i]!;
          const failureReason = agentFailureMessageReason(msg, this._clientId);
          if (failureReason) {
            cleanup();
            reject(new Error(`Agent failed: ${failureReason}`));
            return;
          }
          if (isAgentMessage(msg) && msg !== alreadyPresent) {
            cleanup();
            resolve(msg);
            return;
          }
        }
      };
      this._messageListeners.add(listener);
    });
  }

  /**
   * Wait for the agent to become idle (no new messages for `debounce` ms).
   */
  waitForIdle(opts?: { debounce?: number; timeoutMs?: number; signal?: AbortSignal }): Promise<ChatMessage> {
    const debounceMs = opts?.debounce ?? 3_000;

    const isAgentMessage = (msg: ChatMessage): boolean =>
      msg.senderId !== this._clientId &&
      msg.kind === "message" &&
      !!msg.complete &&
      !msg.pending &&
      msg.contentType !== "thinking" &&
      msg.contentType !== "typing" &&
      msg.contentType !== "invocation";

    const baselineMessages = this.messages;
    const alreadyPresent = [...baselineMessages].reverse().find(isAgentMessage);
    const baselineCount = baselineMessages.length;

    return new Promise<ChatMessage>((resolve, reject) => {
      let lastMatch: ChatMessage | undefined;
      let debounceTimer: ReturnType<typeof setTimeout> | undefined;
      let timeout: ReturnType<typeof setTimeout> | undefined;

      const cleanup = () => {
        if (debounceTimer !== undefined) clearTimeout(debounceTimer);
        if (timeout !== undefined) clearTimeout(timeout);
        opts?.signal?.removeEventListener("abort", onAbort);
        this._messageListeners.delete(listener);
      };
      const onAbort = () => {
        cleanup();
        reject(new Error("waitForIdle aborted"));
      };
      if (opts?.signal?.aborted) {
        onAbort();
        return;
      }
      opts?.signal?.addEventListener("abort", onAbort, { once: true });
      if (opts?.timeoutMs !== undefined) {
        timeout = setTimeout(() => {
          cleanup();
          reject(new Error(`Timed out waiting for idle after ${opts.timeoutMs}ms`));
        }, opts.timeoutMs);
      }

      const scheduleResolve = () => {
        if (!lastMatch) return;
        if (debounceTimer !== undefined) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          // Don't resolve while there are incomplete (streaming) messages
          if (this._hasIncomplete || this.hasOpenAgentTurn()) {
            scheduleResolve();
            return;
          }
          cleanup();
          resolve(lastMatch!);
        }, debounceMs);
      };

      const listener: MessageListener = () => {
        const current = this.messages;
        if (current.length <= baselineCount) return;
        for (let i = current.length - 1; i >= baselineCount; i--) {
          const msg = current[i]!;
          const failureReason = agentFailureMessageReason(msg, this._clientId);
          if (failureReason) {
            cleanup();
            reject(new Error(`Agent failed: ${failureReason}`));
            return;
          }
          if (isAgentMessage(msg) && msg !== alreadyPresent) {
            lastMatch = msg;
            scheduleResolve();
            return;
          }
        }
      };
      this._messageListeners.add(listener);
    });
  }

  private hasOpenAgentTurn(): boolean {
    return Object.values(this._channelView.turns).some(
      (turn) => turn.status === "open" && turn.actor.kind === "agent"
    );
  }

  async sendAndWait(text: string, opts?: { debounce?: number; timeoutMs?: number; signal?: AbortSignal }): Promise<ChatMessage> {
    const wait = this.waitForIdle(opts);
    await this.send(text);
    return wait;
  }
}
