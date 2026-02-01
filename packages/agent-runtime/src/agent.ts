/**
 * Agent Base Class
 *
 * Abstract base class that all agents must extend. Provides:
 * - Automatic state management (loaded before onWake, flushed after onSleep)
 * - Context injection (client, logger, config)
 * - Lifecycle hooks (init, onWake, onEvent, onSleep)
 * - Checkpoint tracking for replay recovery
 */

import type { AgentState } from "@natstack/core";
import type {
  AgenticClient,
  EventStreamItem,
  EventStreamOptions,
  ConnectOptions,
} from "@natstack/agentic-messaging";

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
 * Context provided to agents by the runtime.
 * Contains identity info, configuration, pubsub client, and logging.
 */
export interface AgentContext {
  /** Agent type ID (from manifest) */
  agentId: string;
  /** Channel this agent is bound to */
  channel: string;
  /** Agent handle in the channel */
  handle: string;
  /** Agent configuration passed at spawn */
  config: Record<string, unknown>;
  /** Pubsub client for messaging */
  client: AgenticClient;
  /** Logger with levels */
  log: AgentLogger;
}

/**
 * Options returned by getConnectOptions() that agents can customize.
 * Some fields are always overridden by the runtime (serverUrl, token, channel, handle).
 */
export type AgentConnectOptions = Omit<
  Partial<ConnectOptions>,
  "serverUrl" | "token" | "channel" | "handle"
>;

/**
 * Abstract base class for agents.
 *
 * Agents must:
 * 1. Extend this class
 * 2. Define an initial `state` property (must be JSON-serializable)
 * 3. Implement `onEvent()` to handle incoming pubsub events
 *
 * Optionally, agents can:
 * - Override `init()` for custom initialization after context is set
 * - Override `onWake()` to perform initialization (after state is loaded)
 * - Override `onSleep()` to perform cleanup before shutdown
 * - Override `migrateState()` to handle state version migrations
 * - Override `getConnectOptions()` to customize pubsub connection
 * - Override `getEventsOptions()` to filter the event stream
 *
 * The runtime automatically:
 * 1. Loads persisted state before onWake()
 * 2. Deep-merges with declared defaults
 * 3. Flushes state after onSleep() completes
 * 4. Tracks lastCheckpoint for replay recovery
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
 *       await this.ctx.client.send(`Received message #${this.state.messageCount}`);
 *     }
 *   }
 * }
 * ```
 */
export abstract class Agent<S extends AgentState = AgentState> {
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
   * Agent context - set by runtime before init() and onWake().
   * Contains identity, config, pubsub client, and logger.
   *
   * @protected Available to subclasses
   */
  protected ctx!: AgentContext;

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
   * Use this with getConnectOptions().replaySinceId for replay recovery.
   * The runtime injects this getter during bootstrap.
   *
   * @returns The last persisted pubsub ID, or undefined if none
   */
  protected get lastCheckpoint(): number | undefined {
    // Injected by runtime - returns undefined before injection
    return undefined;
  }

  /**
   * Commit a checkpoint after successfully processing an event.
   * Call this after you've finished processing an event to mark it as handled.
   * On restart, replay will resume from the last committed checkpoint.
   *
   * IMPORTANT: Only call this after the event is fully processed.
   * For queued processing, call after the queue drains, not when enqueuing.
   *
   * @param pubsubId - The pubsub ID of the processed event
   *
   * @example
   * ```typescript
   * private async handleEvent(event: EventStreamItem) {
   *   await this.processMessage(event);
   *
   *   // Commit checkpoint after successful processing
   *   if (event.pubsubId !== undefined) {
   *     this.commitCheckpoint(event.pubsubId);
   *   }
   * }
   * ```
   */
  protected commitCheckpoint(_pubsubId: number): void {
    // Injected by runtime - throws if called before injection
    throw new Error("commitCheckpoint called before runtime initialization");
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
   *     replaySinceId: this.state.lastPubsubId || undefined,
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
