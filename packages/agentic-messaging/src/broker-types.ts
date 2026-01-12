/**
 * @natstack/agentic-messaging broker types
 *
 * Types for agent broker discovery and invitation protocol.
 */

import type { AgenticParticipantMetadata, MethodAdvertisement } from "./types.js";
import type { FieldDefinition } from "@natstack/runtime";

/**
 * Specification for a method that an agent requires.
 * Can match by exact name or pattern.
 */
export interface RequiredMethodSpec {
  /** Method name (exact match) */
  name?: string;
  /** Method name pattern (regex) */
  pattern?: string;
  /** Description of why this method is needed */
  description?: string;
  /** Whether this method is required (true) or optional (false) */
  required: boolean;
}

/**
 * Describes an agent type that a broker can spawn.
 * This is what brokers advertise about their capabilities.
 */
export interface AgentTypeAdvertisement {
  /** Unique identifier for this agent type within the broker */
  id: string;
  /** Human-readable name */
  name: string;
  /**
   * Proposed handle for @-mentions when this agent is spawned.
   * Can be overridden by the invite's handleOverride field.
   * Must be unique within the target channel.
   */
  proposedHandle: string;
  /** Free-form description for LLM interpretation */
  description: string;
  /** Methods the spawned agent will provide */
  providesMethods: MethodAdvertisement[];
  /** Methods the spawned agent requires from other participants */
  requiresMethods: RequiredMethodSpec[];
  /** Configurable parameters for this agent type */
  parameters?: FieldDefinition[];
  /** Optional tags for filtering/categorization */
  tags?: string[];
  /** Optional version string */
  version?: string;
}

/**
 * Broker participant metadata.
 * Extends AgenticParticipantMetadata with agent type advertisements.
 */
export interface BrokerMetadata extends AgenticParticipantMetadata {
  /** Marker to identify this participant as a broker */
  isBroker: true;
  /** Agent types this broker can spawn */
  agentTypes: AgentTypeAdvertisement[];
  /** Broker version for compatibility checking */
  brokerVersion?: string;
}

/**
 * Invite payload sent from client to broker.
 */
export interface Invite {
  /** Unique invite ID for correlation */
  inviteId: string;
  /** Target channel where the spawned agent should connect */
  targetChannel: string;
  /** Which agent type to spawn (must match an advertised AgentTypeAdvertisement.id) */
  agentTypeId: string;
  /** Optional configuration for the spawned agent (opaque to protocol) */
  config?: Record<string, unknown>;
  /** Optional context/instructions for the agent */
  context?: string;
  /**
   * Override the agent's handle for @-mentions.
   * If not provided, the agent uses its AgentTypeAdvertisement.proposedHandle.
   */
  handleOverride?: string;
  /** Timestamp when invite was sent */
  ts: number;
}

/**
 * Decline codes for invite responses.
 */
export type InviteDeclineCode =
  | "unknown-agent-type"
  | "capacity-exceeded"
  | "invalid-config"
  | "target-unreachable"
  | "internal-error"
  | "declined-by-policy"
  | "timeout";

/**
 * Response to an invite from broker to client.
 */
export interface InviteResponse {
  /** Invite ID being responded to */
  inviteId: string;
  /** Whether the invite was accepted */
  accepted: boolean;
  /** Reason for decline (if not accepted) */
  declineReason?: string;
  /** Error code for decline (if not accepted) */
  declineCode?: InviteDeclineCode;
  /** Agent ID on the target channel (if accepted and agent connected) */
  agentId?: string;
  /** Timestamp of response */
  ts: number;
}

/**
 * Error codes for broker operations.
 */
export type BrokerErrorCode =
  | InviteDeclineCode
  | "broker-not-found"
  | "broker-offline"
  | "invite-timeout";

/**
 * Error class for broker operations.
 */
export class BrokerError extends Error {
  constructor(
    message: string,
    public readonly code: BrokerErrorCode,
    public readonly cause?: unknown
  ) {
    super(message);
    this.name = "BrokerError";
  }
}

/**
 * A discovered broker from the availability channel roster.
 */
export interface DiscoveredBroker {
  /** Broker's client ID */
  brokerId: string;
  /** Broker's display name */
  name: string;
  /** Agent types this broker offers */
  agentTypes: AgentTypeAdvertisement[];
  /** Full broker metadata */
  metadata: BrokerMetadata;
}

/**
 * Result of an invite operation.
 */
export interface InviteResult {
  /** The invite that was sent */
  invite: Invite;
  /** Promise that resolves with the response */
  response: Promise<InviteResponse>;
  /** Cancel the invite (if not yet responded) */
  cancel(): void;
}

/**
 * Result from an invite handler.
 */
export interface InviteHandlerResult {
  /** Whether to accept the invite */
  accept: boolean;
  /** Reason for decline (if not accepting) */
  declineReason?: string;
  /** Decline code (if not accepting) */
  declineCode?: InviteDeclineCode;
  /**
   * If accept is true and this is provided, the handler has already
   * connected an agent - include its ID. If not provided, broker will
   * auto-connect using the spawn callback.
   */
  agentId?: string;
}

/**
 * Callback signature for handling incoming invites.
 */
export type InviteHandler = (invite: Invite, senderId: string) => Promise<InviteHandlerResult>;

/**
 * Callback to spawn an agent on a target channel.
 * Called when an invite is accepted and broker should auto-connect.
 */
export type SpawnAgentCallback = (
  invite: Invite,
  agentType: AgentTypeAdvertisement
) => Promise<{ agentId: string }>;

/**
 * Options for connecting as a broker.
 */
export interface BrokerConnectOptions {
  /** The availability channel to advertise on */
  availabilityChannel: string;
  /** Broker display name */
  name: string;
  /** Unique handle for @-mentions (e.g., "broker", "agent-manager") */
  handle: string;
  /** Agent types to advertise */
  agentTypes: AgentTypeAdvertisement[];
  /**
   * Invite handler. Return accept: true to accept invites.
   * If not provided, all invites are declined.
   */
  onInvite?: InviteHandler;
  /**
   * Spawn callback. Called when invite is accepted and handler
   * did not provide an agentId. Should connect agent to target channel
   * and return the agent's client ID.
   */
  onSpawn?: SpawnAgentCallback;
  /** Auto-reconnect configuration */
  reconnect?: boolean | { delayMs?: number; maxDelayMs?: number; maxAttempts?: number };
  /** Optional custom metadata fields */
  customMetadata?: Record<string, unknown>;
}

/**
 * Options for discovering and inviting brokers.
 */
export interface BrokerClientOptions {
  /** The availability channel to connect to */
  availabilityChannel: string;
  /** Client display name */
  name: string;
  /** Unique handle for @-mentions */
  handle: string;
  /** Client type identifier */
  type: string;
  /** Default timeout for invite operations in ms */
  inviteTimeoutMs?: number;
  /** Auto-reconnect configuration */
  reconnect?: boolean | { delayMs?: number; maxDelayMs?: number; maxAttempts?: number };
}

/**
 * Query for filtering brokers by capability.
 */
export interface BrokerQuery {
  /** Filter by agent type tags (OR matching) */
  tags?: string[];
  /** Filter by methods the agent provides (by name) */
  providesMethods?: string[];
  /** Filter by methods the agent requires (by name) */
  requiresMethods?: string[];
  /** Free-text search in descriptions */
  descriptionContains?: string;
}
