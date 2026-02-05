/**
 * Agent Runtime Abstractions
 *
 * This module provides unified interfaces that allow agents to run in
 * both Electron (utilityProcess) and Cloudflare Durable Objects.
 *
 * ## Architecture
 *
 * ```
 * ┌─────────────────────────────────────────────────────────────────┐
 * │                      Agent<S> Base Class                        │
 * │  - state, settings, lifecycle hooks (unchanged API)             │
 * │  - this.client (outgoing), this.storage, this.ai               │
 * │  - onEvent() called by runtime (event reception)                │
 * └────────────────────────────┬────────────────────────────────────┘
 *                              │
 *                              ▼
 * ┌─────────────────────────────────────────────────────────────────┐
 * │                     RuntimeContext                              │
 * │  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐              │
 * │  │ StorageApi  │  │EventBus     │  │ AiProvider  │              │
 * │  │             │  │(outgoing)   │  │             │              │
 * │  └─────────────┘  └─────────────┘  └─────────────┘              │
 * └────────┬─────────────────┬─────────────────┬────────────────────┘
 *          │                 │                 │
 *     ┌────┴────┐       ┌────┴────┐       ┌────┴────┐
 *     ▼         ▼       ▼         ▼       ▼         ▼
 * ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐
 * │Electron│ │  DO    │ │Electron│ │  DO    │ │Electron│ │  DO    │
 * │Storage │ │Storage │ │EventBus│ │EventBus│ │   AI   │ │   AI   │
 * │ (RPC)  │ │ (sync) │ │ (WS)   │ │ (HTTP) │ │ (RPC)  │ │(direct)│
 * └────────┘ └────────┘ └────────┘ └────────┘ └────────┘ └────────┘
 * ```
 *
 * ## Key Interfaces
 *
 * - **StorageApi** - Database operations (exec, run, get, query, flush)
 * - **EventBus** - Outgoing messaging (send, update, publish, callMethod, etc.)
 * - **AiProvider** - AI model access (streamText, generateText, listRoles)
 * - **RuntimeContext** - Unified context combining all services
 *
 * ## Event Reception
 *
 * Event reception is NOT part of EventBus. It's an internal runtime detail:
 * - Electron: WebSocket callbacks → agent.onEvent()
 * - DO: HTTP POST → agent.onEvent()
 *
 * Agents implement onEvent() and don't care how events are sourced.
 *
 * ## Auto-Checkpoint
 *
 * The runtime automatically advances checkpoints after delivering events
 * to onEvent(), whether the agent processed them or filtered them.
 * Agents no longer need to call commitCheckpoint() manually.
 */

// Storage abstraction
export type { StorageApi, RunResult } from "./storage.js";

// Event bus abstraction (outgoing operations only)
export type { EventBus } from "./event-bus.js";

// AI provider abstraction
export type {
  AiProvider,
  AIRoleRecord,
  StreamTextOptions,
  StreamEvent,
  StreamResult,
  GenerateResult,
  StreamHandle,
} from "./ai-provider.js";

// Runtime context (combines all abstractions)
export type {
  RuntimeContext,
  RuntimeContextConfig,
  RuntimeMode,
} from "./runtime-context.js";
export { createRuntimeContext } from "./runtime-context.js";

// Event filtering utility (shared logic)
export type {
  EventFilterContext,
  EventStreamFilterOptions,
} from "./event-filter.js";
export { shouldYieldEvent, createFilterContext, isAgentDebugEvent } from "./event-filter.js";
