/**
 * Electron Runtime Context Factory
 *
 * Creates a RuntimeContext configured for Electron's utilityProcess environment.
 * This factory is called by the main runAgent() function to set up the
 * runtime context before initializing the agent.
 */

import type { DatabaseInterface } from "@natstack/types";
import type { AgenticClient, AgenticParticipantMetadata } from "@workspace/agentic-messaging";
import type { RuntimeContext, RuntimeContextConfig } from "../abstractions/runtime-context.js";
import { createRuntimeContext } from "../abstractions/runtime-context.js";
import type { AgentLogger } from "../agent.js";
import { createElectronStorage } from "./electron-storage.js";
import { createWsEventBus } from "./ws-event-bus.js";
import { createRpcAiProvider } from "./rpc-ai-provider.js";

/**
 * Configuration for creating an Electron runtime context.
 */
export interface ElectronRuntimeConfig<M extends AgenticParticipantMetadata = AgenticParticipantMetadata> {
  /** Agent type ID */
  agentId: string;

  /** Channel name */
  channel: string;

  /** Agent handle */
  handle: string;

  /** Agent configuration */
  config: Record<string, unknown>;

  /** Database interface (from createDbClient().open()) */
  db: DatabaseInterface;

  /** Connected AgenticClient */
  client: AgenticClient<M>;

  /** Logger */
  log: AgentLogger;

  /** Initial checkpoint value (from loaded state) */
  initialCheckpoint?: number;

  /** Callback when checkpoint advances */
  onCheckpointAdvance?: (pubsubId: number) => void;
}

/**
 * Create a RuntimeContext for Electron environment.
 *
 * This sets up all the adapters for Electron's utilityProcess:
 * - Storage: RPC-based SQLite via better-sqlite3
 * - EventBus: WebSocket-based AgenticClient wrapper
 * - AI: RPC-based calls to host AIHandler
 *
 * @param config - Electron runtime configuration
 * @returns Configured RuntimeContext
 *
 * @example
 * ```typescript
 * // In runAgent():
 * const runtime = createElectronRuntime({
 *   agentId,
 *   channel,
 *   handle,
 *   config: agentConfig,
 *   db,
 *   client,
 *   log,
 *   initialCheckpoint: stateStore.getMetadata().lastPubsubId,
 *   onCheckpointAdvance: (pubsubId) => stateStore.setCheckpoint(pubsubId),
 * });
 *
 * // Inject into agent
 * agent._runtime = runtime;
 * ```
 */
export function createElectronRuntime<M extends AgenticParticipantMetadata = AgenticParticipantMetadata>(
  config: ElectronRuntimeConfig<M>
): RuntimeContext<M> {
  const {
    agentId,
    channel,
    handle,
    config: agentConfig,
    db,
    client,
    log,
    initialCheckpoint,
    onCheckpointAdvance,
  } = config;

  // Create adapters
  const storage = createElectronStorage(db);
  const eventBus = createWsEventBus(client);
  const ai = createRpcAiProvider();

  // Create and return the runtime context
  const runtimeConfig: RuntimeContextConfig<M> = {
    agentId,
    channel,
    handle,
    config: agentConfig,
    storage,
    eventBus,
    ai,
    log,
    mode: "electron",
    initialCheckpoint,
    onCheckpointAdvance,
  };

  return createRuntimeContext(runtimeConfig);
}
