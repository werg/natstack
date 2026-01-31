/**
 * @natstack/agent-runtime
 *
 * Minimal runtime package for agents running in Electron's utilityProcess.
 * Provides the Agent base class, state management, lifecycle handling,
 * and the runAgent() entry point.
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
 *   async onWake() {
 *     this.ctx.log.info('Agent starting with state:', this.state);
 *   }
 *
 *   async onEvent(event: EventStreamItem) {
 *     if (event.type === 'message' && event.kind !== 'replay') {
 *       this.state.messageCount++;
 *       await this.ctx.client.send(`Echo #${this.state.messageCount}`);
 *     }
 *   }
 *
 *   async onSleep() {
 *     this.ctx.log.info('Agent shutting down');
 *   }
 * }
 *
 * runAgent(MyAgent);
 * ```
 */

// Agent base class and types
export { Agent } from "./agent.js";
export type {
  AgentState,
  AgentContext,
  AgentLogger,
  AgentConnectOptions,
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
