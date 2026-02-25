/**
 * Event Bus Abstraction
 *
 * Provides a unified interface for OUTGOING messaging operations that works across:
 * - Electron: WebSocket-based pubsub client (AgenticClient wrapper)
 * - Durable Objects: HTTP-based messaging to pubsub server
 *
 * NOTE: This interface handles OUTGOING operations only. Event RECEPTION is an
 * internal runtime detail:
 * - Electron: WebSocket callbacks → agent.onEvent()
 * - DO: HTTP POST from pubsub → agent.onEvent()
 *
 * Agents implement onEvent() and don't care how events are sourced.
 */

import type {
  AgenticParticipantMetadata,
  AttachmentInput,
  Attachment,
  DiscoveredMethod,
  MethodDefinition,
  MethodCallHandle,
  SendResult,
  ChannelConfig,
  AgentManifest,
  AgentInstanceSummary,
  InviteAgentOptions,
  InviteAgentResult,
  RemoveAgentResult,
} from "@workspace/agentic-messaging";
import type { Participant, RosterUpdate } from "@workspace/pubsub";
import type { z } from "zod";

/**
 * Unified event bus interface for outgoing messaging operations.
 *
 * This interface is designed to be compatible with AgenticClient while
 * abstracting the underlying transport (WebSocket vs HTTP).
 *
 * @template M - Participant metadata type
 */
export interface EventBus<M extends AgenticParticipantMetadata = AgenticParticipantMetadata> {
  // ==========================================================================
  // Identity (read-only)
  // ==========================================================================

  /** This participant's handle (for @-mentions) */
  readonly handle: string;

  /** This participant's client ID (server-assigned) */
  readonly clientId: string | null;

  /** Channel name */
  readonly channel: string;

  // ==========================================================================
  // Messaging (Outgoing)
  // ==========================================================================

  /**
   * Send a new message to the channel.
   *
   * @param content - Message content (string or content blocks)
   * @param options - Send options
   * @returns Message ID and optional pubsub ID
   */
  send(
    content: string,
    options?: {
      replyTo?: string;
      persist?: boolean;
      attachments?: AttachmentInput[];
      contentType?: string;
      at?: string[];
      resolveHandles?: boolean;
      metadata?: Record<string, unknown>;
    }
  ): Promise<SendResult>;

  /**
   * Update an existing message (for streaming).
   *
   * @param id - Message ID to update
   * @param content - New content to append
   * @param options - Update options
   * @returns Pubsub ID if persisted
   */
  update(
    id: string,
    content: string,
    options?: {
      complete?: boolean;
      persist?: boolean;
      attachments?: AttachmentInput[];
      contentType?: string;
    }
  ): Promise<number | undefined>;

  /**
   * Mark a message as complete.
   *
   * @param id - Message ID to complete
   * @returns Pubsub ID if persisted
   */
  complete(id: string): Promise<number | undefined>;

  /**
   * Mark a message as errored.
   *
   * @param id - Message ID that errored
   * @param error - Error message
   * @param code - Optional error code
   * @returns Pubsub ID if persisted
   */
  error(id: string, error: string, code?: string): Promise<number | undefined>;

  /**
   * Publish a custom event to the channel.
   *
   * @param eventType - Event type string
   * @param payload - Event payload (JSON-serializable)
   * @param options - Publish options
   */
  publish(
    eventType: string,
    payload: unknown,
    options?: { persist?: boolean }
  ): Promise<void>;

  // ==========================================================================
  // Methods (RPC)
  // ==========================================================================

  /**
   * Call a method on another participant.
   *
   * @param providerId - Target participant ID
   * @param methodName - Method to call
   * @param args - Method arguments
   * @param options - Call options
   * @returns Handle for tracking call progress and result
   */
  callMethod(
    providerId: string,
    methodName: string,
    args: unknown,
    options?: {
      signal?: AbortSignal;
      validateArgs?: z.ZodTypeAny;
      timeoutMs?: number;
    }
  ): MethodCallHandle;

  /**
   * Discover all methods advertised by participants in the channel.
   */
  discoverMethodDefs(): DiscoveredMethod[];

  /**
   * Discover methods advertised by a specific participant.
   *
   * @param providerId - Participant ID to query
   */
  discoverMethodDefsFrom(providerId: string): DiscoveredMethod[];

  /**
   * Send a method result (for method providers).
   *
   * @param callId - Call ID to respond to
   * @param content - Result content
   * @param options - Result options
   */
  sendMethodResult(
    callId: string,
    content: unknown,
    options?: {
      complete?: boolean;
      isError?: boolean;
      progress?: number;
      attachments?: AttachmentInput[];
      contentType?: string;
    }
  ): Promise<void>;

  // ==========================================================================
  // Roster & Participants
  // ==========================================================================

  /** Current roster of participants (read-only) */
  readonly roster: Record<string, Participant<M>>;

  /**
   * Subscribe to roster changes.
   *
   * @param handler - Called when roster changes
   * @returns Unsubscribe function
   */
  onRoster(handler: (roster: RosterUpdate<M>) => void): () => void;

  /**
   * Resolve @handle mentions to participant IDs.
   *
   * @param handles - Array of handles (with or without @ prefix)
   * @returns Array of resolved participant IDs
   */
  resolveHandles(handles: string[]): string[];

  /**
   * Get participant ID by handle.
   *
   * @param handle - Handle to look up (with or without @ prefix)
   * @returns Participant ID or undefined if not found
   */
  getParticipantByHandle(handle: string): string | undefined;

  /**
   * Update this participant's metadata.
   *
   * @param metadata - New metadata (merged with existing)
   */
  updateMetadata(metadata: M): Promise<void>;

  // ==========================================================================
  // Settings (Session Storage)
  // ==========================================================================

  /**
   * Get settings from pubsub session storage.
   *
   * @returns Stored settings or null if none
   */
  getSettings<T = Record<string, unknown>>(): Promise<T | null>;

  /**
   * Update settings in pubsub session storage.
   *
   * @param settings - Settings to store (merged with existing)
   */
  updateSettings(settings: Record<string, unknown>): Promise<void>;

  /** Whether session persistence is enabled */
  readonly sessionEnabled: boolean;

  /** Session key (if session enabled) */
  readonly sessionKey: string | undefined;

  // ==========================================================================
  // Channel Management
  // ==========================================================================

  /** Context ID for this channel (from server) */
  readonly contextId: string | undefined;

  /** Channel config (from server) */
  readonly channelConfig: ChannelConfig | undefined;

  /**
   * Set the channel title.
   *
   * @param title - New title
   */
  setChannelTitle(title: string): Promise<void>;

  /**
   * Subscribe to title changes.
   *
   * @param handler - Called when title changes
   * @returns Unsubscribe function
   */
  onTitleChange(handler: (title: string) => void): () => void;

  // ==========================================================================
  // Agent Management
  // ==========================================================================

  /**
   * List all available agents in the workspace.
   *
   * @param timeoutMs - Optional timeout
   */
  listAgents(timeoutMs?: number): Promise<AgentManifest[]>;

  /**
   * Invite an agent to join this channel.
   *
   * @param agentId - Agent ID to invite
   * @param options - Invite options
   */
  inviteAgent(agentId: string, options?: InviteAgentOptions): Promise<InviteAgentResult>;

  /**
   * List agents currently on this channel.
   *
   * @param timeoutMs - Optional timeout
   */
  channelAgents(timeoutMs?: number): Promise<AgentInstanceSummary[]>;

  /**
   * Remove an agent from this channel.
   *
   * @param instanceId - Agent instance ID to remove
   * @param timeoutMs - Optional timeout
   */
  removeAgent(instanceId: string, timeoutMs?: number): Promise<RemoveAgentResult>;

  // ==========================================================================
  // Lifecycle
  // ==========================================================================

  /** Whether currently connected */
  readonly connected: boolean;

  /** Whether reconnection is in progress */
  readonly reconnecting: boolean;

  /**
   * Close the connection.
   */
  close(): Promise<void>;

  /**
   * Subscribe to disconnect events.
   *
   * @param handler - Called when disconnected
   * @returns Unsubscribe function
   */
  onDisconnect(handler: () => void): () => void;

  /**
   * Subscribe to reconnect events.
   *
   * @param handler - Called when reconnected
   * @returns Unsubscribe function
   */
  onReconnect(handler: () => void): () => void;

  /**
   * Subscribe to error events.
   *
   * @param handler - Called when an error occurs
   * @returns Unsubscribe function
   */
  onError(handler: (error: Error) => void): () => void;
}
