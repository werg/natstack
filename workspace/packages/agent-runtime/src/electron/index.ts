/**
 * Electron Runtime Adapters
 *
 * This module provides implementations of the runtime abstractions for
 * Electron's utilityProcess environment:
 *
 * - **ElectronStorage**: RPC-based SQLite via better-sqlite3
 * - **WsEventBus**: WebSocket-based messaging (AgenticClient wrapper)
 * - **RpcAiProvider**: RPC-based AI calls to host AIHandler
 * - **EventSource**: WebSocket event subscription → agent.onEvent()
 *
 * ## Usage
 *
 * The `createElectronRuntime()` factory is the main entry point. It creates
 * a RuntimeContext with all adapters configured for Electron.
 *
 * @example
 * ```typescript
 * import { createElectronRuntime } from './electron';
 *
 * const runtime = createElectronRuntime({
 *   agentId: 'my-agent',
 *   channel: 'chat:123',
 *   handle: 'assistant',
 *   config: {},
 *   db,
 *   client,
 *   aiClient,
 *   log,
 * });
 *
 * agent._runtime = runtime;
 * ```
 */

// Main factory
export { createElectronRuntime } from "./create-runtime.js";
export type { ElectronRuntimeConfig } from "./create-runtime.js";

// Individual adapters (for advanced use cases)
export { createElectronStorage } from "./electron-storage.js";
export { createWsEventBus } from "./ws-event-bus.js";
export { createRpcAiProvider } from "./rpc-ai-provider.js";

// Event source (internal event loop)
export { startEventSource, createEventSource } from "./event-source.js";
export type { EventSourceOptions } from "./event-source.js";
