/**
 * @natstack/agent-runtime
 *
 * Minimal runtime package for agents running in Electron's utilityProcess.
 * Provides the Agent base class, state management, lifecycle handling,
 * and the runAgent() entry point.
 *
 * ## Architecture
 *
 * The runtime is designed to be portable between deployment targets:
 * - **Electron**: Uses RPC-based adapters (current implementation)
 * - **Cloudflare DOs**: Uses direct HTTP/SQLite adapters (future)
 *
 * ## Key Features
 *
 * 1. **Unified Context** - `this.ctx` is available from getConnectOptions() onward.
 *    Identity properties (agentId, channel, handle, config, log) are always available;
 *    `client` becomes available after pubsub connects.
 *
 * 2. **Type-Safe Accessors** - Use `this.client`, `this.log`, `this.config` instead
 *    of reaching into ctx. These throw helpful errors if accessed too early.
 *
 * 3. **Auto-Checkpoint** - Runtime automatically advances checkpoint for all
 *    persisted events delivered to onEvent(). No manual checkpoint management needed.
 *
 * 4. **First-Class Settings** - Override `defaultSettings` getter and use
 *    `this.settings` and `this.updateSettings()` for user preferences.
 *
 * 5. **Tracker Helpers** - Use `this.createTrackers(replyTo)` for UI indicators.
 *
 * @example
 * ```typescript
 * import { Agent, runAgent } from '@natstack/agent-runtime';
 * import type { EventStreamItem } from '@natstack/agentic-messaging';
 *
 * interface MyState {
 *   messageCount: number;
 * }
 *
 * class MyAgent extends Agent<MyState> {
 *   state: MyState = { messageCount: 0 };
 *
 *   // Settings with defaults (auto-loaded from pubsub session)
 *   protected get defaultSettings() {
 *     return { temperature: 0.7 };
 *   }
 *
 *   async onWake() {
 *     this.log.info('Agent starting with state:', this.state);
 *     this.log.info('Settings:', this.settings);
 *   }
 *
 *   async onEvent(event: EventStreamItem) {
 *     if (event.type === 'message' && event.kind !== 'replay') {
 *       // Auto-checkpoint handles replay recovery - just update state
 *       this.setState({ messageCount: this.state.messageCount + 1 });
 *       await this.client.send(`Echo #${this.state.messageCount}`);
 *     }
 *   }
 *
 *   async onSleep() {
 *     this.log.info('Agent shutting down');
 *   }
 * }
 *
 * runAgent(MyAgent);
 * ```
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

// Runtime entry point
export { runAgent } from "./runtime.js";

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

// Lifecycle management (exported for testing/advanced use)
export { createLifecycleManager } from "./lifecycle.js";
export type { LifecycleManager, LifecycleManagerOptions } from "./lifecycle.js";

// IPC Channel abstraction (Electron parentPort / Node.js fork)
export { getAgentIpcChannel } from "./ipc-channel.js";
export type { AgentIpcChannel } from "./ipc-channel.js";

// IPC Transport (RPC over AgentIpcChannel)
export { createIpcTransport } from "./ipc-transport.js";

// Transport envelope types (shared between agent and host)
export { isParentPortEnvelope } from "./transport.js";
export type { ParentPortEnvelope } from "./transport.js";

// Re-export database client from core for convenience
export { createDbClient } from "@natstack/core";
export type { DbClient, DatabaseInterface, RpcCaller } from "@natstack/core";

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

// Event filtering - shared between Electron and DO
export { shouldYieldEvent, isAgentDebugEvent } from "./abstractions/event-filter.js";
export type { EventFilterContext } from "./abstractions/event-filter.js";

// ============================================================================
// Electron Runtime Adapters
// ============================================================================

export { createElectronStorage } from "./electron/electron-storage.js";
export { createWsEventBus } from "./electron/ws-event-bus.js";
export { createRpcAiProvider } from "./electron/rpc-ai-provider.js";
export { createElectronRuntime } from "./electron/create-runtime.js";
export type { ElectronRuntimeConfig } from "./electron/create-runtime.js";

