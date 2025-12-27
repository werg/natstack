export * from "./types.js";
export * from "./protocol.js";
export { connect, createToolsForAgentSDK } from "./client.js";
export type { AgenticClient } from "./types.js";

// Re-export commonly needed types from pubsub so consumers don't need a direct dependency
export type { Participant, RosterUpdate, ParticipantMetadata } from "@natstack/pubsub";

// Broker exports
export * from "./broker-types.js";
export * from "./broker-protocol.js";
export { connectAsBroker, connectAsSelfBroker } from "./broker.js";
export { connectForDiscovery, inviteAgent } from "./broker-client.js";
export type { BrokerClient } from "./broker.js";
export type { BrokerDiscoveryClient } from "./broker-client.js";

// JSON Schema utilities
export { jsonSchemaToZod, jsonSchemaToZodRawShape, isRecord } from "./json-schema-to-zod.js";

// Responder utilities
export {
  type ChatParticipantMetadata,
  parseAgentConfig,
  createLogger,
  formatArgsForLog,
  isMessageTargetedAt,
} from "./responder-utils.js";

// Execution pause/resume utilities
export {
  createPauseToolDefinition,
} from "./execution.js";

// Interrupt handler for responders
export {
  createInterruptHandler,
  type InterruptHandlerOptions,
} from "./interrupt-handler.js";

// Missed ontext utilities
export {
  aggregateReplayEvents,
  formatMissedContext,
  DEFAULT_MISSED_CONTEXT_MAX_CHARS,
  DEFAULT_TOOL_RESULT_MAX_CHARS,
} from "./missed-context.js";
