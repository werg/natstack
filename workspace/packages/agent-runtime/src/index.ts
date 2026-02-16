/**
 * @workspace/agent-runtime
 *
 * Portable runtime package for agents.
 * Provides the Agent base class, state management, and runtime abstractions.
 *
 * ## Architecture
 *
 * The runtime is designed to be portable between deployment targets.
 * Concrete adapters (storage, event bus, AI provider) are injected via
 * RuntimeContext, keeping the core agent logic platform-agnostic.
 *
 * ## Key Features
 *
 * 1. **Unified Context** - `this.ctx` provides identity properties
 *    (agentId, channel, handle, config, log) and injected services.
 *
 * 2. **Type-Safe Accessors** - Use `this.client`, `this.log`, `this.config`
 *    instead of reaching into ctx. These throw helpful errors if accessed too early.
 *
 * 3. **Auto-Checkpoint** - Runtime automatically advances checkpoint for all
 *    persisted events delivered to onEvent(). No manual checkpoint management needed.
 *
 * 4. **First-Class Settings** - Override `defaultSettings` getter and use
 *    `this.settings` and `this.updateSettings()` for user preferences.
 *
 * 5. **Tracker Helpers** - Use `this.createTrackers(replyTo)` for UI indicators.
 */

// Agent base class and types
export { Agent, deepMerge } from "./agent.js";
export type {
  AgentState,
  AgentContext,
  AgentLogger,
  AgentConnectOptions,
  AgentInitInfo,
  AgentRuntimeInjection,
} from "./agent.js";

// State management (optional helper, exported for testing/advanced use)
export { createStateStore } from "./state.js";
export type {
  StateStore,
  StateStoreOptions,
  StateMetadata,
  StateChangeEvent,
  StateChangeListener,
  StateMigration,
} from "./state.js";

// Re-export database client from core for convenience
export { createDbClient } from "@workspace/core";
export type { DbClient, DatabaseInterface, RpcCaller } from "@natstack/types";

// ============================================================================
// Abstractions - Portable interfaces for runtime adapters
// ============================================================================

// Storage API - unified database interface
export type { StorageApi, RunResult } from "./abstractions/storage.js";

// Event Bus - outgoing messaging interface
export type { EventBus } from "./abstractions/event-bus.js";

// AI Provider - LLM streaming interface
export type {
  AiProvider,
  AIRoleRecord,
  StreamTextOptions,
  StreamEvent,
  StreamHandle,
  StreamResult,
  GenerateResult,
} from "./abstractions/ai-provider.js";

// Runtime Context - unified service container
export { createRuntimeContext } from "./abstractions/runtime-context.js";
export type {
  RuntimeContext,
  RuntimeContextConfig,
} from "./abstractions/runtime-context.js";

// Event filtering
export { shouldYieldEvent, isAgentDebugEvent } from "./abstractions/event-filter.js";
export type { EventFilterContext } from "./abstractions/event-filter.js";
