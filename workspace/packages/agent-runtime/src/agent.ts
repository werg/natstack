/**
 * Agent Base Class
 *
 * Abstract base class that all agents must extend. Provides:
 * - Automatic state management (loaded before onWake, flushed after onSleep)
 * - Unified context with consistent access patterns
 * - First-class settings support with automatic persistence
 * - Lifecycle hooks (onWake, onEvent, onSleep)
 * - Automatic checkpoint tracking for replay recovery
 *
 * ## Auto-Checkpoint
 *
 * The runtime automatically advances checkpoints after delivering events
 * to onEvent(), whether the agent processed them or filtered them.
 * Agents don't need to manage checkpoints - it's handled by the runtime.
 *
 * ## Context Availability
 *
 * The agent has a single unified context (`this.ctx`) that is populated in stages:
 *
 * | Lifecycle Phase      | Available Properties                                    |
 * |----------------------|---------------------------------------------------------|
 * | constructor          | None (don't use ctx)                                    |
 * | getConnectOptions()  | agentId, channel, handle, config, log                   |
 * | onWake()             | All of above + client                                   |
 * | onEvent()            | All (full context)                                      |
 * | onSleep()            | All (full context)                                      |
 *
 * The `client` property is null in getConnectOptions() and populated after connect.
 * Use the type-safe accessor `this.client` which throws if accessed too early.
 *
 * ## Portability
 *
 * Agents written using this base class are portable between:
 * - Electron's utilityProcess (current deployment)
 * - Cloudflare Durable Objects (future deployment)
 *
 * The runtime abstractions (storage, event bus, AI) ensure agents work
 * identically regardless of deployment target.
 */

import type { AgentState } from "@natstack/types";
import type {
  AgenticClient,
  AgenticParticipantMetadata,
  EventStreamItem,
  EventStreamOptions,
  ConnectOptions,
} from "@workspace/agentic-messaging";

// Re-export AgentState for convenience
export type { AgentState };

/**
 * Deep merge utility for combining state objects.
 * Handles nested objects while preserving arrays and primitives.
 *
 * @param defaults - The default state with all fields
 * @param persisted - The persisted state (may be partial)
 * @returns Merged state with defaults filled in
 */
export function deepMerge<T extends Record<string, unknown>>(
  defaults: T,
  persisted: Partial<T>
): T {
  const result = { ...defaults };

  for (const key of Object.keys(persisted) as Array<keyof T>) {
    const value = persisted[key];

    if (value !== undefined) {
      // Deep merge objects (but not arrays)
      if (
        value !== null &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        defaults[key] !== null &&
        typeof defaults[key] === "object" &&
        !Array.isArray(defaults[key])
      ) {
        result[key] = deepMerge(
          defaults[key] as Record<string, unknown>,
          value as Record<string, unknown>
        ) as T[keyof T];
      } else {
        result[key] = value as T[keyof T];
      }
    }
  }

  return result;
}

/**
 * Logger interface for agents.
 * Provides leveled logging that gets forwarded to the host.
 */
export interface AgentLogger {
  debug: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

/**
 * Unified agent context.
 *
 * All identity properties (agentId, channel, handle, config, log) are available
 * from getConnectOptions() onward. The `client` property becomes available
 * after pubsub connects (in onWake and later).
 *
 * Use the type-safe `this.client` accessor instead of `this.ctx.client` to get
 * proper typing and early-access detection.
 *
 * @template M - Participant metadata type (defaults to AgenticParticipantMetadata)
 */
export interface AgentContext<M extends AgenticParticipantMetadata = AgenticParticipantMetadata> {
  /** Agent type ID (from manifest) */
  readonly agentId: string;
  /** Channel this agent is bound to */
  readonly channel: string;
  /** Agent handle in the channel */
  readonly handle: string;
  /** Agent configuration passed at spawn */
  readonly config: Record<string, unknown>;
  /** Logger with levels - always available */
  readonly log: AgentLogger;
  /**
   * Pubsub client for messaging.
   * NULL in getConnectOptions(), populated after pubsub connects.
   * Use `this.client` accessor for type-safe access.
   */
  client: AgenticClient<M> | null;
  /**
   * Pubsub server URL for subagent connections.
   * Use this when creating SubagentManager.
   */
  readonly pubsubUrl: string;
  /**
   * Pubsub authentication token for subagent connections.
   * Use this when creating SubagentManager.
   */
  readonly pubsubToken: string;
}

/**
 * Options returned by getConnectOptions() that agents can customize.
 *
 * ## Runtime-controlled fields (cannot be overridden):
 * - `serverUrl` - Set by runtime from pubsub config
 * - `token` - Set by runtime from pubsub config
 * - `channel` - Set by runtime from spawn config
 * - `handle` - Set by runtime from spawn config (Issue #2 fix)
 *
 * ## Agent-customizable fields:
 * - `name` - Display name in roster (default: class name)
 * - `type` - Participant type (default: "agent")
 * - `contextId` - For session persistence
 * - `extraMetadata` - Additional participant metadata
 * - `methods` - RPC methods to register
 * - `reconnect` - Auto-reconnect on disconnect
 * - `replaySinceId` - Checkpoint for replay recovery (use `this.lastCheckpoint`)
 */
export type AgentConnectOptions = Omit<
  Partial<ConnectOptions>,
  "serverUrl" | "token" | "channel" | "handle"
>;

/**
 * @deprecated Use `this.ctx` instead. initInfo is kept for backward compatibility
 * but ctx now provides the same information consistently.
 */
export interface AgentInitInfo {
  /** Agent type ID (from manifest) */
  agentId: string;
  /** Channel this agent is bound to */
  channel: string;
  /** Agent handle in the channel */
  handle: string;
  /** Agent configuration passed at spawn */
  config: Record<string, unknown>;
}

/**
 * Internal interface for runtime-injected agent properties.
 * Used by the runtime to inject functionality that requires runtime context.
 * NOT part of the public API - agents should use the public accessors.
 *
 * @internal
 */
export interface AgentRuntimeInjection<S extends AgentState, M extends AgenticParticipantMetadata> {
  /** Injected by runtime - updates state and triggers persistence */
  setState: (partial: Partial<S>) => void;
  /** Injected by runtime - unified agent context */
  ctx: AgentContext<M>;
  /** Injected by runtime - deprecated init info */
  initInfo: AgentInitInfo;
  /** Optional migration function for state upgrades */
  migrateState?: (oldState: AgentState, oldVersion: number) => S;
  /** Optional initialization hook */
  init?: () => void;
  /** Settings loader (called by runtime before onWake) */
  loadSettings: () => Promise<void>;
}

/**
 * Abstract base class for agents.
 *
 * Agents must:
 * 1. Extend this class
 * 2. Define an initial `state` property (must be JSON-serializable)
 * 3. Implement `onEvent()` to handle incoming pubsub events
 *
 * Optionally, agents can:
 * - Override `onWake()` to perform initialization (after state is loaded)
 * - Override `onSleep()` to perform cleanup before shutdown
 * - Override `migrateState()` to handle state version migrations
 * - Override `getConnectOptions()` to customize pubsub connection
 * - Override `getEventsOptions()` to filter the event stream
 *
 * ## Access Patterns (Issue #3 fix)
 *
 * Use these canonical accessors instead of reaching into ctx:
 * - `this.client` - Type-safe client accessor (throws if called before connect)
 * - `this.log` - Logger accessor (always available after getConnectOptions)
 * - `this.config` - Config accessor (always available after getConnectOptions)
 * - `this.agentId` - Agent type ID
 * - `this.channel` - Channel name
 * - `this.handle` - Agent handle
 *
 * The runtime automatically:
 * 1. Loads persisted state before onWake()
 * 2. Deep-merges with declared defaults
 * 3. Flushes state after onSleep() completes
 * 4. Auto-advances checkpoint after each persisted event delivery
 *
 * @example
 * ```typescript
 * interface MyState extends AgentState {
 *   messageCount: number;
 * }
 *
 * class MyAgent extends Agent<MyState> {
 *   state: MyState = { messageCount: 0 };
 *   readonly stateVersion = 1;
 *
 *   async onEvent(event: EventStreamItem) {
 *     if (event.type === 'message' && event.kind !== 'replay') {
 *       this.setState({ messageCount: this.state.messageCount + 1 });
 *       await this.client.send(`Received message #${this.state.messageCount}`);
 *     }
 *     // No need to call commitCheckpoint() - runtime handles it automatically
 *   }
 * }
 * ```
 */
export abstract class Agent<
  S extends AgentState = AgentState,
  M extends AgenticParticipantMetadata = AgenticParticipantMetadata
> {
  /**
   * Agent state property.
   *
   * The runtime automatically manages state persistence:
   * - State is loaded from DB before onWake()
   * - State is deep-merged with declared defaults
   * - State is flushed after onSleep() completes
   *
   * Use setState() for nested property updates to ensure persistence is triggered.
   *
   * IMPORTANT: State MUST be JSON-serializable:
   * - No functions
   * - No class instances (use plain objects)
   * - No circular references
   * - No undefined values (use null instead)
   * - No BigInt (convert to string or number)
   * - No Symbol
   */
  abstract state: S;

  /**
   * State version for migrations.
   * Bump this when the state shape changes.
   * Override `migrateState()` to handle upgrades from older versions.
   *
   * @default 1
   */
  readonly stateVersion: number = 1;

  /**
   * @deprecated Use `this.ctx` directly - it's now available from getConnectOptions() onward.
   * Kept for backward compatibility. Both initInfo and ctx.{agentId,channel,handle,config}
   * will have the same values.
   */
  protected initInfo!: AgentInitInfo;

  /**
   * Unified agent context - available from getConnectOptions() onward.
   *
   * Identity properties (agentId, channel, handle, config, log) are set before
   * getConnectOptions(). The `client` property is set after pubsub connects.
   *
   * Prefer using the type-safe accessors (`this.client`, `this.log`, etc.)
   * instead of accessing ctx properties directly.
   *
   * @protected Available to subclasses
   */
  protected ctx!: AgentContext<M>;

  // =========================================================================
  // Canonical Accessors (Issue #3 fix)
  // =========================================================================

  /**
   * Type-safe client accessor.
   * Throws if accessed before pubsub connects (i.e., in getConnectOptions).
   *
   * @throws Error if called before onWake()
   */
  protected get client(): AgenticClient<M> {
    if (!this.ctx?.client) {
      throw new Error(
        "client accessed before pubsub connect. " +
        "Use this.client in onWake() or later, not in getConnectOptions()."
      );
    }
    return this.ctx.client;
  }

  /**
   * Logger accessor. Available from getConnectOptions() onward.
   * @throws Error if accessed before context injection (in constructor)
   */
  protected get log(): AgentLogger {
    if (!this.ctx?.log) {
      throw new Error(
        "log accessed before context injection. " +
        "Use this.log in getConnectOptions() or later, not in constructor."
      );
    }
    return this.ctx.log;
  }

  /**
   * Config accessor. Available from getConnectOptions() onward.
   * @throws Error if accessed before context injection (in constructor)
   */
  protected get config(): Record<string, unknown> {
    if (!this.ctx) {
      throw new Error(
        "config accessed before context injection. " +
        "Use this.config in getConnectOptions() or later, not in constructor."
      );
    }
    return this.ctx.config;
  }

  /**
   * Agent type ID. Available from getConnectOptions() onward.
   * @throws Error if accessed before context injection (in constructor)
   */
  protected get agentId(): string {
    if (!this.ctx) {
      throw new Error(
        "agentId accessed before context injection. " +
        "Use this.agentId in getConnectOptions() or later, not in constructor."
      );
    }
    return this.ctx.agentId;
  }

  /**
   * Channel name. Available from getConnectOptions() onward.
   * @throws Error if accessed before context injection (in constructor)
   */
  protected get channel(): string {
    if (!this.ctx) {
      throw new Error(
        "channel accessed before context injection. " +
        "Use this.channel in getConnectOptions() or later, not in constructor."
      );
    }
    return this.ctx.channel;
  }

  /**
   * Agent handle. Available from getConnectOptions() onward.
   * @throws Error if accessed before context injection (in constructor)
   */
  protected get handle(): string {
    if (!this.ctx) {
      throw new Error(
        "handle accessed before context injection. " +
        "Use this.handle in getConnectOptions() or later, not in constructor."
      );
    }
    return this.ctx.handle;
  }

  // =========================================================================
  // State Management (Issue #4 fix - clearer ceremony)
  // =========================================================================

  /**
   * Update state with partial values.
   * Use this for nested property updates to ensure persistence is triggered.
   * The runtime injects this method during bootstrap.
   *
   * @param partial - Partial state to merge into current state
   *
   * @example
   * ```typescript
   * // Instead of: this.state.nested.value = 'foo';
   * this.setState({ nested: { ...this.state.nested, value: 'foo' } });
   * ```
   */
  protected setState(_partial: Partial<S>): void {
    // Injected by runtime - throws if called before injection
    throw new Error("setState called before runtime initialization");
  }

  /**
   * Get the last processed checkpoint (pubsub ID).
   *
   * This is READ-ONLY. The runtime automatically advances the checkpoint
   * after delivering each persisted event to onEvent(), whether the agent
   * processed it or filtered it.
   *
   * Use this in getConnectOptions().replaySinceId for replay recovery:
   * ```typescript
   * getConnectOptions() {
   *   return { replaySinceId: this.lastCheckpoint };
   * }
   * ```
   *
   * @returns The last persisted pubsub ID, or undefined if none
   */
  protected get lastCheckpoint(): number | undefined {
    // Injected by runtime - returns undefined before injection
    return undefined;
  }

  // =========================================================================
  // Settings Management (Issue #6 fix - first-class settings)
  // =========================================================================

  /**
   * Default settings for this agent. Override this getter to provide defaults.
   * Settings are loaded from pubsub session storage and merged with defaults.
   *
   * Unlike state (which is agent-local and persists across restarts),
   * settings are user preferences stored via pubsub session (shared context).
   *
   * @example
   * ```typescript
   * protected get defaultSettings() {
   *   return {
   *     modelRole: 'fast',
   *     temperature: 0.7,
   *     maxTokens: 1024,
   *   };
   * }
   * ```
   */
  protected get defaultSettings(): Record<string, unknown> {
    return {};
  }

  /**
   * Current settings. Populated after onWake() by loading from pubsub session
   * and merging with defaultSettings and config.
   *
   * Access pattern: `this.settings.modelRole`
   *
   * @protected Injected by runtime
   */
  protected settings: Record<string, unknown> = {};

  /**
   * Update settings and persist to pubsub session.
   * Deep merges with current settings.
   *
   * @param partial - Partial settings to merge
   *
   * @example
   * ```typescript
   * await this.updateSettings({ temperature: 0.9 });
   * ```
   */
  protected async updateSettings(partial: Record<string, unknown>): Promise<void> {
    // Deep merge
    this.settings = deepMerge(this.settings, partial);

    // Persist to pubsub session if available
    if (this.ctx?.client?.sessionKey) {
      await this.client.updateSettings(this.settings);
    }
  }

  /**
   * Load settings from pubsub session.
   * Called automatically by runtime during onWake().
   * Can be called manually to reload settings.
   *
   * Merge order: defaultSettings → saved settings → config
   */
  protected async loadSettings(): Promise<void> {
    // Start with defaults
    let merged = { ...this.defaultSettings };

    // Apply saved settings from pubsub session
    if (this.ctx?.client?.sessionKey) {
      try {
        const saved = await this.client.getSettings<Record<string, unknown>>();
        if (saved) {
          merged = deepMerge(merged, saved);
        }
      } catch {
        // Ignore errors, use defaults
      }
    }

    // Apply config (highest priority) - filter to keys that exist in defaults
    const configKeys = Object.keys(this.defaultSettings);
    const configOverrides: Record<string, unknown> = {};
    for (const key of configKeys) {
      if (this.config[key] !== undefined) {
        configOverrides[key] = this.config[key];
      }
    }
    if (Object.keys(configOverrides).length > 0) {
      merged = deepMerge(merged, configOverrides);
    }

    this.settings = merged;
  }

  // =========================================================================
  // Tracker Helpers (Issue #5 fix - reduce duplication)
  // =========================================================================

  /** @internal Flag to prevent repeated warnings about missing tracker implementation */
  private _trackerWarningShown = false;

  /**
   * Create a tracker manager for handling a message.
   * Provides unified access to typing, thinking, and action trackers
   * with automatic cleanup.
   *
   * Import createTrackerManager from @workspace/agent-patterns for the
   * actual implementation - this is a convenience wrapper.
   *
   * @param replyTo - Message ID to use as replyTo for tracker messages
   * @returns Object with typing, thinking, action trackers and cleanupAll()
   *
   * @example
   * ```typescript
   * async handleMessage(event: IncomingNewMessage) {
   *   const trackers = this.createTrackers(event.id);
   *
   *   try {
   *     await trackers.typing.startTyping('thinking...');
   *     // ... process message ...
   *     await trackers.typing.stopTyping();
   *   } catch (err) {
   *     await trackers.cleanupAll();
   *     throw err;
   *   }
   * }
   * ```
   */
  protected createTrackers(replyTo?: string): {
    typing: { startTyping: (text?: string) => Promise<void>; stopTyping: () => Promise<void>; isTyping: () => boolean; cleanup: () => Promise<boolean> };
    thinking: { startThinking: (itemId?: string) => Promise<void>; updateThinking: (delta: string) => Promise<void>; endThinking: () => Promise<void>; isThinking: () => boolean; isThinkingItem: (id: string) => boolean; setTextMode: () => void; cleanup: () => Promise<boolean>; state: { currentContentType: string | null } };
    action: { startAction: (data: { type: string; description?: string; toolUseId?: string }) => Promise<void>; completeAction: () => Promise<void>; cleanup: () => Promise<boolean> };
    cleanupAll: () => Promise<boolean>;
  } {
    // This is a stub that should be overridden by agents using @workspace/agent-patterns
    // The default implementation provides no-op trackers
    const noopTracker = {
      startTyping: async () => {},
      stopTyping: async () => {},
      isTyping: () => false,
      cleanup: async () => true,
    };
    const noopThinking = {
      startThinking: async () => {},
      updateThinking: async () => {},
      endThinking: async () => {},
      isThinking: () => false,
      isThinkingItem: () => false,
      setTextMode: () => {},
      cleanup: async () => true,
      state: { currentContentType: null as string | null },
    };
    const noopAction = {
      startAction: async () => {},
      completeAction: async () => {},
      cleanup: async () => true,
    };

    // Log warning once if createTrackerManager hasn't been imported
    if (replyTo && !this._trackerWarningShown) {
      this._trackerWarningShown = true;
      this.log.warn?.(
        "createTrackers() called but no tracker implementation available. " +
        "Import createTrackerManager from @workspace/agent-patterns and override this method."
      );
    }

    return {
      typing: noopTracker,
      thinking: noopThinking,
      action: noopAction,
      cleanupAll: async () => true,
    };
  }

  /**
   * Optional: Override for custom initialization after context and state are ready.
   * Called after context injection and state loading, but before onWake().
   * Use this for setup that can use both context and persisted state.
   *
   * @example
   * ```typescript
   * protected init() {
   *   // Set up event handlers, initialize trackers, etc.
   *   this.queue = createMessageQueue({ onProcess: (e) => this.process(e) });
   * }
   * ```
   */
  protected init?(): void;

  /**
   * Optional: Override to migrate state from older versions.
   * Called when loaded state has a different version than stateVersion.
   *
   * @param oldState - The persisted state (may have old shape)
   * @param oldVersion - The version of the persisted state
   * @returns The migrated state matching current schema
   *
   * @example
   * ```typescript
   * protected migrateState(oldState: AgentState, oldVersion: number): MyState {
   *   if (oldVersion < 2) {
   *     return { ...oldState, newField: 'default' } as MyState;
   *   }
   *   return oldState as MyState;
   * }
   * ```
   */
  protected migrateState?(oldState: AgentState, oldVersion: number): S;

  /**
   * Called once when agent instance is created or restored from sleep.
   * Use this for initialization that requires the context to be available.
   *
   * The pubsub client is connected and ready when onWake() is called.
   * State has been loaded from persistence (if available) and merged with defaults.
   *
   * @example
   * ```typescript
   * async onWake() {
   *   this.ctx.log.info('Agent starting with state:', this.state);
   *   // Start background processing, initialize resources, etc.
   * }
   * ```
   */
  async onWake(): Promise<void> {
    // Default: no-op
  }

  /**
   * Called for each incoming pubsub event.
   *
   * Events include:
   * - `message` - New message in channel
   * - `update-message` - Message content updated (streaming)
   * - `error` - Error marker for a message
   * - `method-call` - Remote method invocation
   * - `method-result` - Result from a method call
   * - `presence` - Participant join/leave/update
   * - `execution-pause` - Pause/resume/cancel events
   * - `tool-role-*` - Tool role negotiation events
   *
   * Check `event.kind` to distinguish:
   * - `replay` - Historical events from before connection
   * - `persisted` - New events that are stored
   * - `ephemeral` - Transient events not stored
   *
   * IMPORTANT: onEvent should return quickly to avoid blocking the event loop.
   * For long-running operations, enqueue work and process asynchronously.
   *
   * @param event The incoming event
   *
   * @example
   * ```typescript
   * async onEvent(event: EventStreamItem) {
   *   // Skip replay events
   *   if ('kind' in event && event.kind === 'replay') return;
   *
   *   // Handle messages
   *   if (event.type === 'message') {
   *     this.queue.push(event);
   *     this.processQueue(); // async, fire-and-forget
   *   }
   * }
   * ```
   */
  abstract onEvent(event: EventStreamItem): Promise<void>;

  /**
   * Called when agent is about to sleep (process exit).
   * Use this for cleanup: close connections, flush buffers, etc.
   *
   * State is automatically saved after onSleep() completes.
   * The runtime enforces a timeout (default 3s) on onSleep().
   *
   * @example
   * ```typescript
   * async onSleep() {
   *   this.ctx.log.info('Agent shutting down');
   *   await this.flushPendingWork();
   * }
   * ```
   */
  async onSleep(): Promise<void> {
    // Default: no-op
  }

  /**
   * Optional: override to customize pubsub connection options.
   *
   * Runtime will merge these with init config. The following fields
   * are always overridden by runtime and cannot be customized:
   * - serverUrl
   * - token
   * - channel
   * - handle
   *
   * Useful for:
   * - Setting replayMode ("collect", "stream", or "skip")
   * - Setting replaySinceId for checkpoint-based recovery
   * - Registering methods
   * - Setting reconnect options
   * - Adding extra metadata
   *
   * @example
   * ```typescript
   * // Basic example: skip replay
   * getConnectOptions() {
   *   return {
   *     name: 'My Custom Agent',
   *     type: 'assistant',
   *     replayMode: 'skip', // Don't process historical events
   *   };
   * }
   *
   * // Checkpoint-based recovery: resume from last processed message
   * getConnectOptions() {
   *   return {
   *     replayMode: 'collect',
   *     // Resume from persisted checkpoint (avoids full replay on restart)
   *     replaySinceId: this.lastCheckpoint,
   *   };
   * }
   * ```
   */
  getConnectOptions?(): AgentConnectOptions;

  /**
   * Optional: override to customize event stream filtering.
   *
   * @example
   * ```typescript
   * getEventsOptions() {
   *   return {
   *     targetedOnly: true, // Only receive @-mentioned messages
   *     respondWhenSolo: true, // Also respond when we're the only agent
   *     includeReplay: false, // Skip replayed events
   *   };
   * }
   * ```
   */
  getEventsOptions?(): EventStreamOptions;
}
