/**
 * Agent Base Class
 *
 * Abstract base class that all agents must extend. Provides:
 * - State management (automatically persisted on sleep)
 * - Context injection (client, logger, config)
 * - Lifecycle hooks (onWake, onEvent, onSleep)
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
 * - Override `onWake()` to perform initialization
 * - Override `onSleep()` to perform cleanup before shutdown
 * - Override `getConnectOptions()` to customize pubsub connection
 * - Override `getEventsOptions()` to filter the event stream
 *
 * @example
 * ```typescript
 * interface MyState extends AgentState {
 *   messageCount: number;
 * }
 *
 * class MyAgent extends Agent<MyState> {
 *   state: MyState = { messageCount: 0 };
 *
 *   async onEvent(event: EventStreamItem) {
 *     if (event.type === 'message' && event.kind !== 'replay') {
 *       this.state.messageCount++;
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
   * NOTE: The runtime does NOT automatically persist state. Agents are responsible
   * for their own state management. Use `createStateStore()` from the runtime if
   * you need SQLite-backed persistence, or implement your own storage strategy.
   *
   * If using createStateStore:
   * - Call `store.load()` in `onWake()` to restore state
   * - Call `store.flush()` in `onSleep()` to ensure state is saved
   * - Use `store.setCheckpoint(pubsubId)` to track replay position
   *
   * IMPORTANT: State MUST be JSON-serializable if using createStateStore:
   * - No functions
   * - No class instances (use plain objects)
   * - No circular references
   * - No undefined values (use null instead)
   * - No BigInt (convert to string or number)
   * - No Symbol
   */
  abstract state: S;

  /**
   * Agent context - set by runtime before onWake().
   * Contains identity, config, pubsub client, and logger.
   *
   * @protected Available to subclasses
   */
  protected ctx!: AgentContext;

  /**
   * Called once when agent instance is created or restored from sleep.
   * Use this for initialization that requires the context to be available.
   *
   * The pubsub client is connected and ready when onWake() is called.
   * State has been loaded from persistence (if available).
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
