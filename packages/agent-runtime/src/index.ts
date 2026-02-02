/**
 * @natstack/agent-runtime
 *
 * Minimal runtime package for agents running in Electron's utilityProcess.
 * Provides the Agent base class, state management, lifecycle handling,
 * and the runAgent() entry point.
 *
 * ## Key Improvements (Phase 7 Refactoring)
 *
 * 1. **Unified Context** - `this.ctx` is available from getConnectOptions() onward.
 *    Identity properties (agentId, channel, handle, config, log) are always available;
 *    `client` becomes available after pubsub connects.
 *
 * 2. **Type-Safe Accessors** - Use `this.client`, `this.log`, `this.config` instead
 *    of reaching into ctx. These throw helpful errors if accessed too early.
 *
 * 3. **Clearer State Management** - Use `saveCheckpoint(state, pubsubId)` to
 *    combine state updates and checkpoint commits.
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
 *     // Use canonical accessors
 *     this.log.info('Agent starting with state:', this.state);
 *     this.log.info('Settings:', this.settings);
 *   }
 *
 *   async onEvent(event: EventStreamItem) {
 *     if (event.type === 'message' && event.kind !== 'replay') {
 *       // Use saveCheckpoint for combined state + checkpoint update
 *       this.saveCheckpoint(
 *         { messageCount: this.state.messageCount + 1 },
 *         event.pubsubId
 *       );
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

// Transport utilities (exported for testing/advanced use)
export { createParentPortTransport, isParentPortEnvelope } from "./transport.js";
export type { ParentPort, ParentPortEnvelope } from "./transport.js";

// Re-export database client from core for convenience
export { createDbClient } from "@natstack/core";
export type { DbClient, DatabaseInterface, RpcCaller } from "@natstack/core";
