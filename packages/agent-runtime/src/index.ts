/**
 * @natstack/agent-runtime
 *
 * Agent base class, state management, and storage types.
 * Agents extend `Agent<S>` and run in-process in the main server.
 */

// Agent base class and types
export { Agent, deepMerge } from "./agent.js";
export type {
  AgentState,
  AgentContext,
  AgentLogger,
  AgentConnectOptions,
  AgentRuntimeInjection,
} from "./agent.js";

// State management
export { createStateStore } from "./state.js";
export type {
  StateStore,
  StateStoreOptions,
  StateMetadata,
  StateChangeEvent,
  StateChangeListener,
  StateMigration,
} from "./state.js";

// Storage API
export type { StorageApi, RunResult } from "./abstractions/storage.js";

// Event filtering
export { shouldYieldEvent, isAgentDebugEvent } from "./abstractions/event-filter.js";
export type { EventFilterContext } from "./abstractions/event-filter.js";
