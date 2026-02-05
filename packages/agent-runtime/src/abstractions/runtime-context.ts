/**
 * Runtime Context Abstraction
 *
 * Provides a unified context object that agents receive regardless of
 * runtime environment (Electron or Durable Objects).
 *
 * The RuntimeContext encapsulates:
 * - Storage (database access)
 * - EventBus (outgoing messaging)
 * - AiProvider (AI model access)
 * - Identity (agentId, channel, handle)
 * - Configuration
 * - Logging
 *
 * This abstraction allows agents to be written once and run in either:
 * - Electron's utilityProcess (WebSocket-based, RPC to host)
 * - Cloudflare Durable Objects (HTTP-based, direct API calls)
 */

import type { StorageApi } from "./storage.js";
import type { EventBus } from "./event-bus.js";
import type { AiProvider } from "./ai-provider.js";
import type { AgentLogger } from "../agent.js";
import type { AgenticParticipantMetadata } from "@natstack/agentic-messaging";

/**
 * Runtime mode indicator.
 *
 * Agents can check this to handle runtime-specific behavior if needed,
 * but ideally should be written to work identically in both modes.
 */
export type RuntimeMode = "electron" | "durable-object";

/**
 * Unified runtime context for agents.
 *
 * Provides access to all runtime services through a consistent interface.
 * Agents receive this context during initialization and use it throughout
 * their lifecycle.
 *
 * @template M - Participant metadata type
 *
 * @example
 * ```typescript
 * class MyAgent extends Agent<MyState> {
 *   // Runtime context is injected automatically
 *
 *   async onEvent(event: EventStreamItem) {
 *     // Access storage
 *     const rows = await this.storage.query<MyRow>('SELECT * FROM my_table');
 *
 *     // Access event bus (outgoing)
 *     await this.client.send('Hello!');
 *
 *     // Access AI
 *     const stream = this.ai.streamText({
 *       role: 'smart',
 *       messages: [{ role: 'user', content: event.content }],
 *     });
 *
 *     // Log
 *     this.log.info('Processing event');
 *   }
 * }
 * ```
 */
export interface RuntimeContext<M extends AgenticParticipantMetadata = AgenticParticipantMetadata> {
  // ==========================================================================
  // Services
  // ==========================================================================

  /**
   * Storage API for database operations.
   *
   * - Electron: RPC-based SQLite via better-sqlite3
   * - DO: Synchronous ctx.storage.sql
   */
  readonly storage: StorageApi;

  /**
   * Event bus for outgoing messaging operations.
   *
   * - Electron: WebSocket-based AgenticClient
   * - DO: HTTP-based messaging
   *
   * NOTE: This is for OUTGOING operations only. Event reception
   * is handled internally by the runtime (agents implement onEvent).
   */
  readonly eventBus: EventBus<M>;

  /**
   * AI provider for model access.
   *
   * - Electron: RPC-based calls to host AIHandler
   * - DO: Direct HTTP to Anthropic API
   */
  readonly ai: AiProvider;

  /**
   * Logger for agent output.
   *
   * - Electron: Forwards to host process
   * - DO: Console output (captured by DO runtime)
   */
  readonly log: AgentLogger;

  // ==========================================================================
  // Identity
  // ==========================================================================

  /** Agent type ID (from manifest) */
  readonly agentId: string;

  /** Channel this agent is bound to */
  readonly channel: string;

  /** Agent handle in the channel (for @-mentions) */
  readonly handle: string;

  /** Agent configuration passed at spawn time */
  readonly config: Record<string, unknown>;

  // ==========================================================================
  // Runtime Info
  // ==========================================================================

  /**
   * Runtime mode indicator.
   *
   * Check this if you need runtime-specific behavior, but prefer
   * writing runtime-agnostic code when possible.
   */
  readonly mode: RuntimeMode;

  // ==========================================================================
  // Checkpoint (Read-Only)
  // ==========================================================================

  /**
   * Current checkpoint (highest persisted event ID seen).
   *
   * This is READ-ONLY for agents. The runtime automatically advances
   * the checkpoint after delivering events to onEvent().
   *
   * Use this value in getConnectOptions() for replay recovery:
   * ```typescript
   * getConnectOptions() {
   *   return { replaySinceId: this.lastCheckpoint };
   * }
   * ```
   */
  readonly checkpoint: number | undefined;

  // ==========================================================================
  // Internal (Runtime Use Only)
  // ==========================================================================

  /**
   * @internal
   * Advance the checkpoint. Called by runtime after event delivery.
   * NOT for agent use - checkpointing is automatic.
   */
  _advanceCheckpoint(pubsubId: number): void;
}

/**
 * Configuration for creating a runtime context.
 */
export interface RuntimeContextConfig<M extends AgenticParticipantMetadata = AgenticParticipantMetadata> {
  /** Agent type ID */
  agentId: string;

  /** Channel name */
  channel: string;

  /** Agent handle */
  handle: string;

  /** Agent configuration */
  config: Record<string, unknown>;

  /** Storage implementation */
  storage: StorageApi;

  /** Event bus implementation */
  eventBus: EventBus<M>;

  /** AI provider implementation */
  ai: AiProvider;

  /** Logger implementation */
  log: AgentLogger;

  /** Runtime mode */
  mode: RuntimeMode;

  /** Initial checkpoint value */
  initialCheckpoint?: number;

  /** Callback when checkpoint advances */
  onCheckpointAdvance?: (pubsubId: number) => void;
}

/**
 * Create a runtime context from configuration.
 *
 * This is typically called by runtime-specific code (electron/createRuntime
 * or do/createRuntime) to construct the context that gets injected into agents.
 *
 * @param config - Runtime context configuration
 * @returns Configured runtime context
 */
export function createRuntimeContext<M extends AgenticParticipantMetadata = AgenticParticipantMetadata>(
  config: RuntimeContextConfig<M>
): RuntimeContext<M> {
  let checkpoint = config.initialCheckpoint;

  return {
    // Services
    storage: config.storage,
    eventBus: config.eventBus,
    ai: config.ai,
    log: config.log,

    // Identity
    agentId: config.agentId,
    channel: config.channel,
    handle: config.handle,
    config: config.config,

    // Runtime info
    mode: config.mode,

    // Checkpoint
    get checkpoint() {
      return checkpoint;
    },

    _advanceCheckpoint(pubsubId: number) {
      if (checkpoint === undefined || pubsubId > checkpoint) {
        checkpoint = pubsubId;
        config.onCheckpointAdvance?.(pubsubId);
      }
    },
  };
}
