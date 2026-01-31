/**
 * @natstack/core - Core types shared between runtime and agent-runtime.
 *
 * This package is a leaf dependency with no @natstack/* dependencies.
 * It provides foundational types for:
 * - Agent manifests and instances
 * - IPC protocol for host ↔ agent communication
 * - Form schema (data-driven UI)
 * - PubSub configuration
 * - Database interface
 */

// Agent types
export type {
  MethodAdvertisement,
  RequiredMethodSpec,
  AgentManifest,
  AgentState,
  AgentInstanceInfo,
} from "./agent-types.js";

// IPC protocol
export type {
  HostToAgentMessage,
  AgentToHostMessage,
  AgentInitConfig,
} from "./ipc-protocol.js";
export { isHostToAgentMessage, isAgentToHostMessage } from "./ipc-protocol.js";

// Form schema (full FieldDefinition system)
export type {
  PrimitiveFieldValue,
  FieldValue,
  FieldType,
  ConditionOperator,
  FieldCondition,
  FieldOption,
  SliderNotch,
  FieldWarning,
  FieldDefinition,
  FormSchema,
} from "./form-schema.js";
export {
  evaluateCondition,
  isFieldVisible,
  isFieldEnabled,
  getFieldWarning,
  groupFields,
  getFieldDefaults,
} from "./form-schema.js";

// Config types
export type { PubSubConfig } from "./config-types.js";

// Database
export type { DbRunResult, DatabaseInterface, DatabaseOpener, RpcCaller, DbClient } from "./database.js";
export { createDbClient } from "./database.js";

// Base64 utilities
export { encodeBase64, decodeBase64 } from "./base64.js";
