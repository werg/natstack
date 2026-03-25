/**
 * @natstack/pubsub - WebSocket pub/sub client for NatStack
 *
 * Provides real-time messaging between panels and workers via a persistent
 * WebSocket connection with SQLite-backed message history.
 *
 * @example Basic usage
 * ```typescript
 * import { connect } from "@natstack/pubsub";
 * import { pubsubConfig } from "@workspace/runtime/panel";
 *
 * // Connect to a channel
 * const client = connect(pubsubConfig.serverUrl, pubsubConfig.token, {
 *   channel: "chat",
 *   sinceId: lastKnownId, // Optional: resume from where you left off
 * });
 *
 * // Wait for ready (replay complete)
 * await client.ready();
 *
 * // Process messages
 * for await (const msg of client.messages()) {
 *   console.log(msg.type, msg.payload);
 * }
 * ```
 *
 * @example With auto-reconnection
 * ```typescript
 * const client = connect(serverUrl, token, {
 *   channel: "chat",
 *   reconnect: true, // Use defaults: 1s initial delay, 30s max, infinite attempts
 * });
 *
 * // Or with custom config
 * const client = connect(serverUrl, token, {
 *   channel: "chat",
 *   reconnect: { delayMs: 500, maxDelayMs: 10000, maxAttempts: 5 },
 * });
 *
 * client.onDisconnect(() => console.log("Disconnected, reconnecting..."));
 * client.onReconnect(() => console.log("Reconnected!"));
 * ```
 *
 * @example Presence / roster tracking with metadata
 * ```typescript
 * // Define your metadata type
 * interface UserMetadata {
 *   name: string;
 *   status: "online" | "away";
 * }
 *
 * // Connect with typed metadata
 * const client = connect<UserMetadata>(serverUrl, token, {
 *   channel: "chat",
 *   metadata: { name: "Alice", status: "online" },
 * });
 *
 * // Get notified when roster changes (idempotent - receives full state)
 * client.onRoster((roster) => {
 *   for (const [id, participant] of Object.entries(roster.participants)) {
 *     console.log(`${participant.metadata.name} is ${participant.metadata.status}`);
 *   }
 * });
 *
 * // Access current roster at any time
 * console.log("Currently online:", Object.keys(client.roster));
 * ```
 */

export * from "./types.js";
export { connect } from "./client.js";
export type { PubSubClient } from "./client.js";
export { connectViaRpc } from "./rpc-client.js";
export type { RpcConnectOptions } from "./rpc-client.js";

// Content type constants
export * from "./content-types.js";

// Protocol types (agentic messaging types, events, aggregation)
export * from "./protocol-types.js";

// Event stream types (re-exports from protocol-types for discoverability)
export * from "./event-types.js";

// Tracker types and interfaces
export * from "./tracker-types.js";

// Tracker factory functions
export { createThinkingTracker, createActionTracker, createTypingTracker } from "./tracker-factories.js";

// Tool name utilities
export * from "./tool-name-utils.js";

// Tool schemas and validation
export * from "./tool-types.js";

// Tool approval logic
export * from "./tool-approval.js";

// Context window usage types
export * from "./context-tracker.js";

// Missed context formatting
export {
  formatMissedContext,
  DEFAULT_MISSED_CONTEXT_MAX_CHARS,
  DEFAULT_METHOD_RESULT_MAX_CHARS,
} from "./missed-context.js";

// Replay event aggregation
export { aggregateReplayEvents } from "./aggregation.js";

// Action descriptions
export { getDetailedActionDescription } from "./action-descriptions.js";

// TODO list types and code generation
export { type TodoItem, getTodoListCode, getCachedTodoListCode } from "./todo-types.js";

// Protocol message schemas (Zod)
export * from "./protocol.js";

// Protocol schemas (feedback UI, field definitions)
export {
  FieldDefinitionSchema,
  FeedbackFormArgsSchema,
  FeedbackCustomArgsSchema,
  RequiredMethodSpecSchema,
  MethodAdvertisementSchema,
  AgentTypeAdvertisementSchema,
  type FeedbackFormArgs,
  type FeedbackCustomArgs,
} from "./protocol-schemas.js";

// JSON Schema to Zod conversion
export { jsonSchemaToZod, jsonSchemaToZodRawShape, isRecord } from "./json-schema-to-zod.js";

// Image processing utilities
export {
  SUPPORTED_IMAGE_TYPES,
  MAX_IMAGE_BYTES,
  MAX_TOTAL_BYTES,
  isImageMimeType,
  validateAttachment,
  validateAttachments,
  uint8ArrayToBase64,
  base64ToUint8Array,
  buildClaudeContentBlocks,
  buildOpenAIContents,
  filterImageAttachments,
  formatBytes,
  type SupportedImageType,
  type AttachmentValidationResult,
  type ClaudeImageBlock,
  type ClaudeTextBlock,
  type ClaudeContentBlock,
  type OpenAIImageContent,
  type OpenAITextContent,
  type OpenAIContent,
} from "./image-utils.js";

// Async utilities
export { AsyncQueue, createFanout } from "./async-queue.js";

// Approval schema builder
export {
  createApprovalSchema,
  type CreateApprovalSchemaParams,
} from "./approval-schema.js";

// Re-export for convenience when used with runtime
import { connect as connectRaw, type PubSubClient } from "./client.js";
import { PubSubError, type ConnectOptions, type ParticipantMetadata } from "./types.js";

/**
 * Connect using runtime-injected config.
 * For use in panels/workers where pubsubConfig is available.
 *
 * @example
 * ```typescript
 * import { connectWithConfig } from "@natstack/pubsub";
 * import { pubsubConfig } from "@workspace/runtime/panel";
 *
 * const client = connectWithConfig(pubsubConfig, { channel: "notifications" });
 * await client.ready();
 * ```
 */
export function connectWithConfig<T extends ParticipantMetadata = ParticipantMetadata>(
  config: { serverUrl: string; token: string } | null,
  options: ConnectOptions<T>
): PubSubClient<T> {
  if (!config) {
    throw new PubSubError(
      "PubSub config not available. Ensure pubsubConfig is provided by the runtime.",
      "connection"
    );
  }
  return connectRaw(config.serverUrl, config.token, options);
}
