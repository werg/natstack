/**
 * HeadlessSession — Channel-message-driven headless agentic session wrapper.
 *
 * Provides a programmatic interface for spawning agent chats from skill
 * code, system tests, etc. Pi runs in-process inside the worker DO; this
 * wrapper subscribes a PubSubClient to the channel and reads persisted
 * channel messages (text, thinking, action, image, inline_ui) to expose
 * chat state.
 *
 * Public API mirrors the legacy SessionManager-based wrapper:
 *   - `HeadlessSession.create()` — wire up a session, no agent yet
 *   - `HeadlessSession.createWithAgent()` — full setup: subscribe DO + connect
 *   - `send(text, opts)` — publish a user message
 *   - `waitForAgentMessage()` / `waitForIdle()` / `sendAndWait()` — test helpers
 *   - `messages`, `methodEntries`, `participants`, `connected`, `status` — getters
 *   - `snapshot()` — diagnostic snapshot
 *   - `dispose()` / `close()` — teardown
 */

import {
  ConnectionManager,
  buildEvalTool,
  isAgentParticipantType,
  type ConnectionConfig,
  type ChatParticipantMetadata,
  type ChatMessage,
  type MethodHistoryEntry,
  type SandboxConfig,
  type DirtyRepoDetails,
} from "@workspace/agentic-core";
import type {
  PubSubClient,
  Participant,
  ChannelConfig,
  MethodDefinition,
  AttachmentInput,
  AgentDebugPayload,
  Attachment,
  IncomingEvent,
  IncomingMethodResultEvent,
} from "@natstack/pubsub";
import { z } from "zod";
import { ScopeManager, DbScopePersistence } from "@workspace/eval";
import {
  getRecommendedChannelConfig,
  subscribeHeadlessAgent,
} from "./channel.js";

// ===========================================================================
// Types
// ===========================================================================

export interface SessionSnapshot {
  messages: readonly ChatMessage[];
  methodHistory: Array<{
    callId: string;
    method: string;
    status: string;
    args?: unknown;
    result?: unknown;
    consoleOutput?: string;
    error?: string;
    duration?: number;
    providerId?: string;
    callerId?: string;
  }>;
  debugEvents: readonly (AgentDebugPayload & { ts: number })[];
  participants: Record<string, { name: string; type: string; handle: string; connected: boolean }>;
  connected: boolean;
  duration: number;
}

export class HeadlessTimeoutError extends Error {
  constructor(message: string, public readonly snapshot: SessionSnapshot) {
    super(message);
    this.name = "HeadlessTimeoutError";
  }
}

export interface HeadlessSessionConfig {
  config: ConnectionConfig;
  metadata?: ChatParticipantMetadata;
  /** Optional sandbox config for eval support */
  sandbox?: SandboxConfig;
  /** Optional pre-built ScopeManager */
  scopeManager?: ScopeManager;
}

export interface HeadlessWithAgentConfig extends HeadlessSessionConfig {
  rpcCall: (target: string, method: string, ...args: unknown[]) => Promise<unknown>;
  source: string;
  className: string;
  objectKey?: string;
  contextId: string;
  channelId?: string;
  channelConfig?: ChannelConfig;
  methods?: Record<string, MethodDefinition>;
  /**
   * Pi-native pass-through subscription config. Allowed keys: `model`,
   * `thinkingLevel`, `approvalLevel`. Per-test prompt overrides should
   * live in `<contextFolder>/.pi/AGENTS.md`.
   */
  extraConfig?: Record<string, unknown>;
}

// ===========================================================================
// HeadlessSession
// ===========================================================================

const DEFAULT_METADATA: ChatParticipantMetadata = {
  name: "Headless Client",
  type: "headless",
  handle: "headless",
};

interface MessageListener {
  (msg: ChatMessage): void;
}

export class HeadlessSession {
  private _connection: ConnectionManager;
  private _client: PubSubClient<ChatParticipantMetadata> | null = null;
  private _channelId: string | null = null;
  private _sandbox: SandboxConfig | null;
  private _scopeManager: ScopeManager | null;
  private _clientId: string;
  private _createdAt = Date.now();
  private _config: HeadlessSessionConfig;

  // Channel message state (derived from persisted + live channel messages)
  private _chatMessages = new Map<string, ChatMessage>();
  private _chatMessageOrder: string[] = [];
  private _hasIncomplete = false;
  private _participants: Record<string, Participant<ChatParticipantMetadata>> = {};
  private _methodHistory = new Map<string, MethodHistoryEntry>();
  private _debugEvents: Array<AgentDebugPayload & { ts: number }> = [];
  private _dirtyRepoWarnings = new Map<string, DirtyRepoDetails>();
  private _disposed = false;
  private _consumeAbort: AbortController | null = null;

  // Listeners
  private _messageListeners = new Set<MessageListener>();
  private _methodHistoryListeners = new Set<() => void>();

  private constructor(config: HeadlessSessionConfig, channelId?: string) {
    this._config = config;
    this._sandbox = config.sandbox ?? null;
    this._clientId = config.config.clientId;

    if (config.scopeManager) {
      this._scopeManager = config.scopeManager;
    } else if (config.sandbox && channelId) {
      this._scopeManager = new ScopeManager({
        channelId,
        panelId: config.config.clientId,
        persistence: new DbScopePersistence(() => config.sandbox!.db.open("repl-scopes")),
      });
    } else {
      this._scopeManager = null;
    }

    this._connection = new ConnectionManager({
      config: config.config,
      metadata: config.metadata ?? DEFAULT_METADATA,
      callbacks: {
        onEvent: (event) => this.handleEvent(event),
      },
    });
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
    const session = new HeadlessSession(config, channelId);

    await subscribeHeadlessAgent({
      rpcCall: config.rpcCall,
      source: config.source,
      className: config.className,
      objectKey,
      channelId,
      contextId: config.contextId,
      extraConfig: config.extraConfig,
    });

    if (session._scopeManager) {
      await session._scopeManager.hydrate();
    }

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
        if (this._client) {
          await this._client.updateChannelConfig({ title });
        }
        return { ok: true };
      },
    };

    if (this._sandbox) {
      methods["eval"] = buildEvalTool({
        sandbox: this._sandbox,
        rpc: this._sandbox.rpc,
        runtimeTarget: "workerRuntime",
        scopeManager: this._scopeManager,
        getChatSandboxValue: () => this.buildChatSandboxValue(),
        getScope: () => this._scopeManager?.current ?? {},
      });
    }

    return methods;
  }

  private buildChatSandboxValue() {
    return {
      publish: async (eventType: string, payload: unknown, options?: { persist?: boolean }) => {
        if (!this._client) throw new Error("Not connected");
        return this._client.publish(eventType, payload, options);
      },
      callMethod: async (participantId: string, method: string, args: unknown) => {
        if (!this._client) throw new Error("Not connected");
        const handle = this._client.callMethod(participantId, method, args);
        const result = await (handle as { result?: Promise<unknown> }).result;
        return result;
      },
      contextId: "",
      channelId: this._channelId,
      rpc: this._sandbox?.rpc ?? { call: async () => undefined as unknown },
    };
  }

  // ===========================================================================
  // Event tracking (method history + debug events)
  // ===========================================================================

  private handleEvent(event: IncomingEvent): void {
    if (event.type === "method-call") {
      const e = event as IncomingEvent & {
        callId: string; methodName: string; senderId: string;
        providerId?: string; args?: unknown; ts: number;
      };
      if (!this._methodHistory.has(e.callId)) {
        this._methodHistory.set(e.callId, {
          callId: e.callId,
          methodName: e.methodName,
          args: e.args,
          status: "pending",
          startedAt: e.ts ?? Date.now(),
          providerId: e.providerId,
          callerId: e.senderId,
        });
        this.notifyMethodHistoryListeners();
      }
    }

    if (event.type === "method-result") {
      const e = event as IncomingMethodResultEvent;
      const existing = this._methodHistory.get(e.callId);
      if (existing) {
        if (e.complete) {
          if (e.isError) {
            const errorMessage = typeof e.content === "string"
              ? e.content
              : Array.isArray(e.content)
                ? (e.content as Array<{ text?: string }>).map((c) => c.text ?? "").join("")
                : String(e.content ?? "Unknown error");
            this._methodHistory.set(e.callId, {
              ...existing, status: "error", error: errorMessage, completedAt: Date.now(),
            });
          } else {
            this._methodHistory.set(e.callId, {
              ...existing, status: "success", result: e.content, completedAt: Date.now(),
            });
          }
        } else if ((e as { progress?: number }).progress !== undefined) {
          this._methodHistory.set(e.callId, {
            ...existing, progress: (e as { progress?: number }).progress,
          });
        }
        // Capture streamed console output
        if (e.contentType === "application/json" && !e.complete) {
          try {
            const parsed = typeof e.content === "string" ? JSON.parse(e.content) : e.content;
            if (parsed && typeof parsed === "object" && (parsed as { type?: string }).type === "console") {
              const prev = existing.consoleOutput ?? "";
              this._methodHistory.set(e.callId, {
                ...this._methodHistory.get(e.callId)!,
                consoleOutput: prev + ((parsed as { content?: string }).content ?? ""),
              });
            }
          } catch { /* not JSON, ignore */ }
        }
        this.notifyMethodHistoryListeners();
      }
    }

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

  private notifyMethodHistoryListeners(): void {
    for (const listener of this._methodHistoryListeners) {
      try { listener(); } catch { /* best-effort */ }
    }
  }

  // ===========================================================================
  // Connection lifecycle
  // ===========================================================================

  async connect(
    channelId: string,
    options?: { channelConfig?: ChannelConfig; contextId?: string; methods?: Record<string, MethodDefinition> },
  ): Promise<void> {
    if (!this._scopeManager && this._sandbox) {
      this._scopeManager = new ScopeManager({
        channelId,
        panelId: this._clientId,
        persistence: new DbScopePersistence(() => this._sandbox!.db.open("repl-scopes")),
      });
      await this._scopeManager.hydrate();
    }

    const methods = options?.methods ?? this.buildDefaultMethods();

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
      for await (const event of this._client.events({ includeReplay: true, includeEphemeral: false })) {
        if (signal.aborted) break;

        const wire = event as unknown as {
          type?: string;
          kind?: string;
          id?: string;
          senderId?: string;
          content?: string;
          contentType?: string;
          complete?: boolean;
          attachments?: Attachment[];
          senderMetadata?: { name?: string; type?: string; handle?: string };
        };

        if (wire.type === "message" && wire.id) {
          const isReplay = wire.kind === "replay";
          const isFromClient = wire.senderMetadata?.type === "panel" || wire.senderMetadata?.type === "headless";
          const msg: ChatMessage = {
            id: wire.id,
            senderId: wire.senderId ?? "unknown",
            content: wire.content ?? "",
            contentType: wire.contentType,
            kind: "message",
            complete: isReplay || isFromClient,
            attachments: wire.attachments,
            senderMetadata: wire.senderMetadata,
          };
          if (!this._chatMessages.has(wire.id)) {
            this._chatMessageOrder.push(wire.id);
          }
          this._chatMessages.set(wire.id, msg);
          this.recomputeHasIncomplete();
          this.notifyListeners();
        } else if (wire.type === "update-message" && wire.id) {
          const existing = this._chatMessages.get(wire.id);
          if (existing) {
            const updated = { ...existing };
            if (wire.content !== undefined) {
              if (!existing.contentType) {
                updated.content = (existing.content ?? "") + wire.content;
              } else {
                updated.content = wire.content;
              }
            }
            if (wire.complete !== undefined) updated.complete = wire.complete;
            if (wire.attachments) updated.attachments = wire.attachments;
            this._chatMessages.set(wire.id, updated);
            this.recomputeHasIncomplete();
            this.notifyListeners();
          }
        } else if (wire.type === "error" && wire.id) {
          const existing = this._chatMessages.get(wire.id);
          if (existing) {
            this._chatMessages.set(wire.id, { ...existing, complete: true, error: (wire as { error?: string }).error ?? "Unknown error" });
            this.recomputeHasIncomplete();
            this.notifyListeners();
          }
        } else if (wire.type === "execution-pause") {
          const targetId = (wire as { messageId?: string }).messageId ?? wire.id;
          if (targetId) {
            const existing = this._chatMessages.get(targetId);
            if (existing && !existing.complete) {
              this._chatMessages.set(targetId, { ...existing, complete: true });
              this.recomputeHasIncomplete();
              this.notifyListeners();
            }
          } else {
            for (let i = this._chatMessageOrder.length - 1; i >= 0; i--) {
              const msg = this._chatMessages.get(this._chatMessageOrder[i]!);
              if (msg && !msg.complete) {
                this._chatMessages.set(this._chatMessageOrder[i]!, { ...msg, complete: true });
                this.recomputeHasIncomplete();
                this.notifyListeners();
                break;
              }
            }
          }
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
    return (handle as { result?: Promise<unknown> }).result;
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
    } catch {
      // best-effort
    }
    this._client = null;
    this._channelId = null;
  }

  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;
    this.disconnect();
    this._messageListeners.clear();
    this._methodHistoryListeners.clear();
  }

  async close(): Promise<void> {
    this.dispose();
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

  get methodEntries(): ReadonlyMap<string, MethodHistoryEntry> {
    return this._methodHistory;
  }

  get methodHistory(): ReadonlyMap<string, MethodHistoryEntry> {
    return this._methodHistory;
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

  get scope(): Record<string, unknown> {
    return this._scopeManager?.current ?? {};
  }

  get scopeManager(): ScopeManager | null {
    return this._scopeManager;
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
    const methodHistory = [...this._methodHistory.values()].map((e) => ({
      callId: e.callId,
      method: e.methodName,
      status: e.status,
      args: e.args,
      result: e.result,
      consoleOutput: e.consoleOutput,
      error: e.error,
      duration: e.completedAt ? e.completedAt - e.startedAt : undefined,
      providerId: e.providerId,
      callerId: e.callerId,
    }));
    return {
      messages: this.messages,
      methodHistory,
      debugEvents: this._debugEvents,
      participants,
      connected: this._connection.connected,
      duration: now - this._createdAt,
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
  waitForAgentMessage(opts?: { timeout?: number }): Promise<ChatMessage> {
    const timeout = opts?.timeout ?? 0;

    const isAgentMessage = (msg: ChatMessage): boolean =>
      msg.senderId !== this._clientId &&
      msg.kind === "message" &&
      !!msg.complete &&
      !msg.pending &&
      msg.contentType !== "thinking" &&
      msg.contentType !== "typing" &&
      msg.contentType !== "action";

    const knownAgentHandles = new Set<string>();
    for (const p of Object.values(this._participants)) {
      if (isAgentParticipantType(p.metadata.type)) {
        knownAgentHandles.add(p.metadata.handle);
      }
    }

    const baselineMessages = this.messages;
    const alreadyPresent = [...baselineMessages].reverse().find(isAgentMessage);
    const baselineCount = baselineMessages.length;

    return new Promise<ChatMessage>((resolve, reject) => {
      const timer = timeout > 0 ? setTimeout(() => {
        cleanup();
        reject(new HeadlessTimeoutError(
          `Timed out waiting for agent message after ${timeout}ms`,
          this.snapshot(),
        ));
      }, timeout) : null;

      const cleanup = () => {
        if (timer) clearTimeout(timer);
        this._messageListeners.delete(listener);
      };

      const listener: MessageListener = () => {
        const current = this.messages;
        if (current.length <= baselineCount) return;
        for (let i = current.length - 1; i >= baselineCount; i--) {
          const msg = current[i]!;
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
  waitForIdle(opts?: { timeout?: number; debounce?: number }): Promise<ChatMessage> {
    const timeout = opts?.timeout ?? 0;
    const debounceMs = opts?.debounce ?? 3_000;

    const isAgentMessage = (msg: ChatMessage): boolean =>
      msg.senderId !== this._clientId &&
      msg.kind === "message" &&
      !!msg.complete &&
      !msg.pending &&
      msg.contentType !== "thinking" &&
      msg.contentType !== "typing" &&
      msg.contentType !== "action";

    const baselineMessages = this.messages;
    const alreadyPresent = [...baselineMessages].reverse().find(isAgentMessage);
    const baselineCount = baselineMessages.length;

    return new Promise<ChatMessage>((resolve, reject) => {
      let lastMatch: ChatMessage | undefined;
      let debounceTimer: ReturnType<typeof setTimeout> | undefined;

      const overallTimer = timeout > 0 ? setTimeout(() => {
        cleanup();
        if (lastMatch) {
          resolve(lastMatch);
        } else {
          reject(new HeadlessTimeoutError(
            `Timed out waiting for idle after ${timeout}ms`,
            this.snapshot(),
          ));
        }
      }, timeout) : null;

      const cleanup = () => {
        if (overallTimer) clearTimeout(overallTimer);
        if (debounceTimer !== undefined) clearTimeout(debounceTimer);
        this._messageListeners.delete(listener);
      };

      const scheduleResolve = () => {
        if (!lastMatch) return;
        if (debounceTimer !== undefined) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          // Don't resolve while there are incomplete (streaming) messages
          if (this._hasIncomplete) {
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

  async sendAndWait(text: string, opts?: { timeout?: number }): Promise<ChatMessage> {
    await this.send(text);
    return this.waitForIdle(opts);
  }
}
