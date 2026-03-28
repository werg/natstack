/**
 * HeadlessSession — Thin wrapper over SessionManager with headless defaults.
 *
 * Provides convenience for creating headless agentic sessions where:
 * - No interactive UI is available (no inline_ui, feedback_form, etc.)
 * - Full-auto approval is desired
 * - The session creates and owns its own channel
 */

import {
  SessionManager,
  type SessionManagerConfig,
  type ConnectOptions,
  type SendOptions,
  type ChatMessage,
  type ChatParticipantMetadata,
  type MethodHistoryEntry,
  type SandboxConfig,
  type ConnectionConfig,
} from "@workspace/agentic-core";
import type { Participant, ChannelConfig, MethodDefinition, AgentDebugPayload } from "@natstack/pubsub";
import { z } from "zod";
import {
  ScopeManager,
  DbScopePersistence,
  executeSandbox,
  type SandboxOptions,
  type SandboxResult,
  type ScopesApi,
} from "@workspace/eval";
import {
  getRecommendedHarnessConfig,
  getRecommendedChannelConfig,
  subscribeHeadlessAgent,
  type SubscribeHeadlessAgentOptions,
} from "./channel.js";

// =============================================================================
// Types
// =============================================================================

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
  /** Optional sandbox config for eval support. When provided, a ScopeManager
   *  is created automatically for persistent scope across eval calls. */
  sandbox?: SandboxConfig;
  /** Optional pre-built ScopeManager (overrides automatic creation) */
  scopeManager?: ScopeManager;
  /** Override the headless system prompt */
  systemPrompt?: string;
}

export interface HeadlessWithAgentConfig extends HeadlessSessionConfig {
  /** RPC call function for reaching the platform */
  rpcCall: (target: string, method: string, ...args: unknown[]) => Promise<unknown>;
  /** Worker source (e.g., "workers/agent-worker") */
  source: string;
  /** DO class name (e.g., "AiChatWorker") */
  className: string;
  /** DO object key — auto-generated if not provided */
  objectKey?: string;
  /** Context ID for authorization */
  contextId: string;
  /** Channel ID — auto-generated if not provided */
  channelId?: string;
  /** Channel config overrides */
  channelConfig?: ChannelConfig;
  /** Additional methods to register on the client (merged with default eval/set_title) */
  methods?: Record<string, MethodDefinition>;
  /** Additional subscription config */
  extraConfig?: Record<string, unknown>;
  /**
   * When true, skip the restrictive headless prompt and tool allowlist.
   * The agent gets the default NatStack chat prompt with all tools.
   * Use when the session runs in a panel context where all capabilities
   * (inline_ui, browser panels, feedback, etc.) are actually available.
   */
  useDefaultPrompt?: boolean;
}

// =============================================================================
// HeadlessSession
// =============================================================================

export class HeadlessSession {
  private _manager: SessionManager;
  private _systemPrompt: string | undefined;
  private _sandbox: SandboxConfig | null;
  private _scopeManager: ScopeManager | null;
  private _clientId: string;
  private _createdAt = Date.now();

  private constructor(config: HeadlessSessionConfig, channelId?: string) {
    this._systemPrompt = config.systemPrompt;
    this._sandbox = config.sandbox ?? null;
    this._clientId = config.config.clientId;

    // Create ScopeManager if sandbox is provided (for eval-backed scope persistence)
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

    const managerConfig: SessionManagerConfig = {
      config: config.config,
      metadata: config.metadata ?? {
        name: "Headless Client",
        type: "panel",
        handle: "headless",
      },
      sandbox: config.sandbox,
      scopeManager: this._scopeManager ?? undefined,
    };

    this._manager = new SessionManager(managerConfig);
  }

  /** Create a HeadlessSession with the given config. */
  static create(config: HeadlessSessionConfig): HeadlessSession {
    return new HeadlessSession(config);
  }

  /**
   * Convenience: create a channel, subscribe a DO agent, connect, all in one.
   *
   * This is the primary entry point for headless consumers that want a
   * fully configured session ready to send messages.
   */
  static async createWithAgent(config: HeadlessWithAgentConfig): Promise<HeadlessSession> {
    const channelId = config.channelId ?? `headless-${crypto.randomUUID()}`;
    const objectKey = config.objectKey ?? `headless-${crypto.randomUUID()}`;
    const session = new HeadlessSession(config, channelId);

    // Subscribe the DO agent to the channel with headless defaults
    const hasEval = !!config.sandbox;
    await subscribeHeadlessAgent({
      rpcCall: config.rpcCall,
      source: config.source,
      className: config.className,
      objectKey,
      channelId,
      contextId: config.contextId,
      systemPrompt: config.systemPrompt,
      hasEval,
      useDefaultPrompt: config.useDefaultPrompt,
      extraConfig: config.extraConfig,
    });

    // Hydrate scope if available
    if (session._scopeManager) {
      await session._scopeManager.hydrate();
    }

    // Build default headless methods (eval + set_title) + user-provided methods
    const defaultMethods = session.buildDefaultMethods();
    const methods: Record<string, MethodDefinition> = {
      ...defaultMethods,
      ...config.methods,  // User methods override defaults
    };

    // Connect the session to the channel
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
  // Default headless method definitions
  // ===========================================================================

  /**
   * Build eval + set_title method definitions for headless sessions.
   * These are the methods the agent calls via PubSub.
   */
  private buildDefaultMethods(): Record<string, MethodDefinition> {
    const methods: Record<string, MethodDefinition> = {};

    // set_title — always available
    methods["set_title"] = {
      description: "Set the conversation title",
      parameters: z.object({ title: z.string().describe("The new title") }),
      execute: async (args: unknown) => {
        const { title } = args as { title: string };
        if (!title) return { ok: false, error: "Missing title" };
        const client = this._manager.client;
        if (client) {
          try { await client.updateChannelConfig({ title }); } catch { /* best-effort */ }
        }
        return { ok: true };
      },
    };

    // eval — only available when sandbox is configured
    if (this._sandbox) {
      const sandbox = this._sandbox;
      const scopeManager = this._scopeManager;

      methods["eval"] = {
        description: "Execute TypeScript/JavaScript code in the headless sandbox.",
        parameters: z.object({
          code: z.string().describe("The code to execute"),
          syntax: z.enum(["tsx", "jsx", "typescript"]).optional().describe("Source syntax"),
          timeout: z.number().optional().describe("Execution timeout in ms"),
          imports: z.record(z.string()).optional().describe("Dynamic imports: { specifier: version }. E.g. { \"lodash\": \"npm:4\" }"),
        }),
        execute: async (args: unknown) => {
          const { code, syntax, timeout, imports: dynamicImports } = args as { code: string; syntax?: string; timeout?: number; imports?: Record<string, string> };
          if (!code) return { ok: false, error: "Missing code" };

          scopeManager?.enterEval();
          try {
            const result: SandboxResult = await executeSandbox(code, {
              syntax: syntax as SandboxOptions["syntax"],
              timeout,
              imports: dynamicImports,
              loadImport: sandbox.loadImport,
              bindings: {
                contextId: this._manager.contextId ?? "",
                chat: this._manager.buildChatSandboxValue(),
                scope: scopeManager?.current ?? {},
                scopes: scopeManager?.api ?? {},
              },
            });

            return {
              ok: !result.error,
              result: result.returnValue,
              consoleOutput: result.consoleOutput,
              error: result.error,
            };
          } finally {
            await scopeManager?.exitEval();
          }
        },
      };
    }

    return methods;
  }

  // ===========================================================================
  // Delegates to SessionManager
  // ===========================================================================

  get manager(): SessionManager {
    return this._manager;
  }

  /**
   * Connect to a channel. When using the two-step API (create + connect),
   * this automatically builds default methods (eval/set_title) and creates
   * a ScopeManager if sandbox was provided but no channelId was available
   * at construction time.
   */
  async connect(channelId: string, options?: Omit<ConnectOptions, "channelId">): Promise<void> {
    // Lazy ScopeManager creation for the two-step path (create() didn't have channelId)
    if (!this._scopeManager && this._sandbox) {
      this._scopeManager = new ScopeManager({
        channelId,
        panelId: this._clientId,
        persistence: new DbScopePersistence(() => this._sandbox!.db.open("repl-scopes")),
      });
      this._manager.setScopeManager(this._scopeManager);
      await this._scopeManager.hydrate();
    }

    // Build default methods if caller didn't provide any
    const methods = options?.methods ?? this.buildDefaultMethods();

    return this._manager.connect(channelId, { ...options, methods });
  }

  async send(text: string, options?: SendOptions): Promise<string> {
    return this._manager.send(text, options);
  }

  async interrupt(agentId: string): Promise<void> {
    return this._manager.interrupt(agentId);
  }

  async callMethod(participantId: string, method: string, args: unknown): Promise<unknown> {
    return this._manager.callMethod(participantId, method, args);
  }

  async loadEarlierMessages(): Promise<void> {
    return this._manager.loadEarlierMessages();
  }

  disconnect(): void {
    this._manager.disconnect();
  }

  /** Synchronous best-effort teardown (same as SessionManager.dispose) */
  dispose(): void {
    this._manager.dispose();
  }

  /** Awaitable teardown — preferred for headless use */
  async close(): Promise<void> {
    return this._manager.close();
  }

  /** Symbol.asyncDispose for `await using session = ...` */
  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }

  // ===========================================================================
  // State getters
  // ===========================================================================

  get messages(): readonly ChatMessage[] {
    return this._manager.messages;
  }

  get participants(): Readonly<Record<string, Participant<ChatParticipantMetadata>>> {
    return this._manager.participants;
  }

  get allParticipants(): Readonly<Record<string, Participant<ChatParticipantMetadata>>> {
    return this._manager.allParticipants;
  }

  get methodEntries(): ReadonlyMap<string, MethodHistoryEntry> {
    return this._manager.methodHistory;
  }

  get connected(): boolean {
    return this._manager.connected;
  }

  get status(): string {
    return this._manager.status;
  }

  get channelId(): string | null {
    return this._manager.channelId;
  }

  get scope(): Record<string, unknown> {
    return this._manager.scope;
  }

  get scopeManager(): ScopeManager | null {
    return this._scopeManager;
  }

  get debugEvents(): readonly (AgentDebugPayload & { ts: number })[] {
    return this._manager.debugEvents;
  }

  // ===========================================================================
  // Event subscription (delegates to SessionManager)
  // ===========================================================================

  on: SessionManager["on"] = (...args: Parameters<SessionManager["on"]>) => {
    return this._manager.on(...args);
  };

  once: SessionManager["once"] = (...args: Parameters<SessionManager["once"]>) => {
    return this._manager.once(...args);
  };

  // ===========================================================================
  // Snapshot
  // ===========================================================================

  /** Capture a diagnostic snapshot of the current session state. */
  snapshot(): SessionSnapshot {
    const now = Date.now();
    const participants: SessionSnapshot["participants"] = {};
    const currentParticipants = new Set(Object.keys(this._manager.participants));
    for (const [id, p] of Object.entries(this._manager.allParticipants)) {
      participants[id] = {
        name: p.metadata.name,
        type: p.metadata.type,
        handle: p.metadata.handle,
        connected: currentParticipants.has(id),
      };
    }
    const methodHistory = [...this._manager.methodHistory.values()].map(e => ({
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
      messages: this._manager.messages,
      methodHistory,
      debugEvents: this._manager.debugEvents,
      participants,
      connected: this._manager.connected,
      duration: now - this._createdAt,
    };
  }

  // ===========================================================================
  // Headless-specific
  // ===========================================================================

  getRecommendedHarnessConfig() {
    return getRecommendedHarnessConfig({ systemPrompt: this._systemPrompt, hasEval: !!this._sandbox });
  }

  getRecommendedChannelConfig() {
    return getRecommendedChannelConfig();
  }

  /**
   * Wait for a message from an agent (any non-self participant).
   *
   * Useful for headless send-and-wait patterns:
   * ```ts
   * await session.send("What is 2+2?");
   * const response = await session.waitForAgentMessage();
   * ```
   *
   * Rejects immediately with HeadlessTimeoutError if the agent disconnects,
   * and on timeout provides a full session snapshot for diagnostics.
   */
  waitForAgentMessage(opts?: { timeout?: number }): Promise<ChatMessage> {
    const timeout = opts?.timeout ?? 0;  // 0 = no timeout (wait indefinitely)
    const selfId = this._manager.client?.clientId;

    const isAgentMessage = (msg: ChatMessage): boolean =>
      msg.senderId !== selfId &&
      msg.kind === "message" &&
      !!msg.complete &&
      !msg.pending &&
      msg.contentType !== "thinking";

    // Collect non-panel agent handles we know about
    const knownAgentHandles = new Set<string>();
    for (const p of Object.values(this._manager.allParticipants)) {
      if (p.metadata.type !== "panel") {
        knownAgentHandles.add(p.metadata.handle);
      }
    }

    // Check existing messages first to avoid race with send()
    const existing = this._manager.messages;
    const alreadyPresent = [...existing].reverse().find(isAgentMessage);
    const baselineCount = existing.length;

    return new Promise<ChatMessage>((resolve, reject) => {
      const timer = timeout > 0 ? setTimeout(() => {
        unsub();
        reject(new HeadlessTimeoutError(
          `Timed out waiting for agent message after ${timeout}ms`,
          this.snapshot(),
        ));
      }, timeout) : null;

      const cleanup = (fn: () => void) => {
        if (timer) clearTimeout(timer);
        unsub();
        fn();
      };

      const unsub = this._manager.on("messagesChanged", (messages) => {
        // Only consider messages added after we started waiting
        if (messages.length <= baselineCount) return;
        for (let i = messages.length - 1; i >= baselineCount; i--) {
          const msg = messages[i]!;

          // Disconnect detection: system message with disconnectedAgent
          if (msg.kind === "system" && msg.disconnectedAgent) {
            const handle = msg.disconnectedAgent.handle;
            if (knownAgentHandles.has(handle)) {
              knownAgentHandles.delete(handle);
              // If no non-panel agents remain, reject
              if (knownAgentHandles.size === 0) {
                cleanup(() => reject(new HeadlessTimeoutError(
                  `Agent disconnected: ${msg.disconnectedAgent!.name}`,
                  this.snapshot(),
                )));
                return;
              }
            }
          }

          if (isAgentMessage(msg) && msg !== alreadyPresent) {
            cleanup(() => resolve(msg));
            return;
          }
        }
      });
    });
  }

  /**
   * Wait for the agent to become idle (no new messages for `debounce` ms).
   *
   * Resolves with the last agent message once the conversation settles.
   * Uses the same disconnect detection as waitForAgentMessage.
   */
  waitForIdle(opts?: { timeout?: number; debounce?: number }): Promise<ChatMessage> {
    const timeout = opts?.timeout ?? 0;  // 0 = no timeout (wait indefinitely)
    const debounceMs = opts?.debounce ?? 3_000;
    const selfId = this._manager.client?.clientId;

    const isAgentMessage = (msg: ChatMessage): boolean =>
      msg.senderId !== selfId &&
      msg.kind === "message" &&
      !!msg.complete &&
      !msg.pending &&
      msg.contentType !== "thinking";

    // Collect non-panel agent handles we know about
    const knownAgentHandles = new Set<string>();
    for (const p of Object.values(this._manager.allParticipants)) {
      if (p.metadata.type !== "panel") {
        knownAgentHandles.add(p.metadata.handle);
      }
    }

    const existing = this._manager.messages;
    const alreadyPresent = [...existing].reverse().find(isAgentMessage);
    const baselineCount = existing.length;

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
        unsub();
      };

      const unsub = this._manager.on("messagesChanged", (messages) => {
        if (messages.length <= baselineCount) return;
        for (let i = messages.length - 1; i >= baselineCount; i--) {
          const msg = messages[i]!;

          // Disconnect detection
          if (msg.kind === "system" && msg.disconnectedAgent) {
            const handle = msg.disconnectedAgent.handle;
            if (knownAgentHandles.has(handle)) {
              knownAgentHandles.delete(handle);
              if (knownAgentHandles.size === 0) {
                cleanup();
                if (lastMatch) {
                  resolve(lastMatch);
                } else {
                  reject(new HeadlessTimeoutError(
                    `Agent disconnected: ${msg.disconnectedAgent!.name}`,
                    this.snapshot(),
                  ));
                }
                return;
              }
            }
          }

          if (isAgentMessage(msg) && msg !== alreadyPresent) {
            lastMatch = msg;
            // Reset debounce timer on each new matching message
            if (debounceTimer !== undefined) clearTimeout(debounceTimer);
            debounceTimer = setTimeout(() => {
              cleanup();
              resolve(lastMatch!);
            }, debounceMs);
            return; // Only need the latest match
          }
        }
      });
    });
  }

  /**
   * Send a message and wait for the agent to finish responding (idle).
   *
   * Convenience wrapper over send() + waitForIdle().
   */
  async sendAndWait(text: string, opts?: { timeout?: number }): Promise<ChatMessage> {
    await this.send(text);
    return this.waitForIdle(opts);
  }
}
