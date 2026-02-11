/**
 * Agent Runtime Entry Point
 *
 * The main runAgent() function that bootstraps and runs an agent in
 * Electron's utilityProcess. Handles:
 * - IPC setup with host process
 * - RPC bridge initialization
 * - Database client injection
 * - Pubsub connection
 * - Automatic state management
 * - Lifecycle management
 * - Graceful shutdown
 */

import { createRpcBridge } from "@natstack/rpc";
import {
  isHostToAgentMessage,
  createDbClient,
  type AgentInitConfig,
  type AgentToHostMessage,
  type AgentState,
} from "@natstack/core";
import { connect, setDbOpen } from "@natstack/agentic-messaging";
import type { AgenticClient, EventStreamItem, AgenticParticipantMetadata } from "@natstack/agentic-messaging";
import { setRpc } from "@natstack/ai";

import { Agent, deepMerge, type AgentContext, type AgentLogger, type AgentRuntimeInjection } from "./agent.js";
import { getAgentIpcChannel, type AgentIpcChannel } from "./ipc-channel.js";
import { createIpcTransport } from "./ipc-transport.js";
import { createLifecycleManager } from "./lifecycle.js";
import { createStateStore, type StateStore } from "./state.js";
import { createElectronStorage } from "./electron/electron-storage.js";
import { isAgentDebugEvent } from "./abstractions/event-filter.js";

// Shutdown timeouts
const SHUTDOWN_TIMEOUT_MS = 5000;
const SLEEP_TIMEOUT_MS = 3000;

// State persistence debounce
const STATE_PERSIST_DEBOUNCE_MS = 100;

/**
 * Send a message to the host process.
 */
function createHostMessenger(ipc: AgentIpcChannel) {
  return (message: AgentToHostMessage) => {
    ipc.postMessage(message);
  };
}

/**
 * Create a logger that forwards to the host and also logs locally.
 * All log levels are forwarded to the host as structured log messages.
 */
function createAgentLogger(
  agentId: string,
  sendToHost: (msg: AgentToHostMessage) => void
): AgentLogger {
  const prefix = `[Agent:${agentId}]`;

  const formatMessage = (args: unknown[]): { message: string; stack?: string } => {
    const message = args.map((a) => (a instanceof Error ? a.message : String(a))).join(" ");
    const stack = args.find((a) => a instanceof Error)?.stack;
    return { message, stack };
  };

  return {
    debug: (...args: unknown[]) => {
      console.debug(prefix, ...args);
      const { message } = formatMessage(args);
      sendToHost({ type: "log", level: "debug", message });
    },
    info: (...args: unknown[]) => {
      console.info(prefix, ...args);
      const { message } = formatMessage(args);
      sendToHost({ type: "log", level: "info", message });
    },
    warn: (...args: unknown[]) => {
      console.warn(prefix, ...args);
      const { message, stack } = formatMessage(args);
      sendToHost({ type: "log", level: "warn", message, stack });
    },
    error: (...args: unknown[]) => {
      console.error(prefix, ...args);
      const { message, stack } = formatMessage(args);
      sendToHost({ type: "log", level: "error", message, stack });
      // Also send legacy error message for backward compatibility during spawn
      sendToHost({ type: "error", error: message, stack });
    },
  };
}

/**
 * Wait for an init message from the host.
 */
function waitForInit(ipc: AgentIpcChannel): Promise<AgentInitConfig> {
  console.log("[agent-runtime] waitForInit: registering message handler");
  return new Promise((resolve) => {
    const handler = (msg: unknown) => {
      // No {data:...} unwrapping — handled by AgentIpcChannel
      console.log("[agent-runtime] waitForInit: received message:", JSON.stringify(msg).slice(0, 200));
      if (isHostToAgentMessage(msg) && msg.type === "init") {
        console.log("[agent-runtime] waitForInit: got init message, resolving");
        ipc.removeListener("message", handler);
        resolve(msg.config);
      } else {
        console.log("[agent-runtime] waitForInit: not an init message, isHostToAgentMessage:", isHostToAgentMessage(msg));
      }
    };
    ipc.on("message", handler);
    console.log("[agent-runtime] waitForInit: message handler registered");
  });
}

/**
 * Run an agent in utilityProcess.
 *
 * This is the main entry point for agents. It:
 * 1. Validates we're running in utilityProcess
 * 2. Waits for init config from host (or uses provided config)
 * 3. Sets up RPC bridge and DB client
 * 4. Loads persisted state (so getConnectOptions can use lastCheckpoint)
 * 5. Connects to pubsub
 * 6. Initializes the agent (init, onWake)
 * 7. Enters the message loop
 * 8. Handles graceful shutdown with state flush
 *
 * @param AgentClass - The agent class to instantiate
 * @param config - Optional init config (if not provided, waits for host message)
 *
 * @example
 * ```typescript
 * // agent-entry.ts
 * import { Agent, runAgent } from '@natstack/agent-runtime';
 *
 * class MyAgent extends Agent<{ count: number }> {
 *   state = { count: 0 };
 *   readonly stateVersion = 1;
 *
 *   async onEvent(event) {
 *     if (event.type === 'message' && event.kind !== 'replay') {
 *       this.setState({ count: this.state.count + 1 });
 *       await this.ctx.client.send(`Message #${this.state.count}`);
 *     }
 *   }
 * }
 *
 * runAgent(MyAgent);
 * ```
 */
export async function runAgent<S extends AgentState>(
  AgentClass: new () => Agent<S>,
  config?: AgentInitConfig
): Promise<void> {
  // DEBUG: Trace agent startup
  console.log("[agent-runtime] runAgent called");

  // Step 1: Acquire IPC channel (Electron parentPort or Node.js fork)
  let ipc: AgentIpcChannel;
  try {
    ipc = getAgentIpcChannel();
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
  console.log("[agent-runtime] IPC channel acquired");

  // Keep process alive while setting up
  ipc.ref?.();
  console.log("[agent-runtime] ipc.ref() called, waiting for init...");

  const sendToHost = createHostMessenger(ipc);

  // Step 2: Resolve init config
  const initConfig = config ?? (await waitForInit(ipc));
  console.log("[agent-runtime] received init config:", initConfig?.agentId);
  const { agentId, channel, handle, config: agentConfig, pubsubUrl, pubsubToken } = initConfig;

  // Create logger
  const log = createAgentLogger(agentId, sendToHost);
  log.info("Agent starting...");

  // Step 3: Instantiate agent with default state
  const agent = new AgentClass();
  const defaultState = { ...agent.state }; // Capture default state for merging

  // Step 4: Initialize RPC + DB client
  const selfId = `agent:${agentId}:${handle}`;
  const transport = createIpcTransport(ipc, selfId);
  const rpc = createRpcBridge({ selfId, transport });

  // Create DB client and inject for shared packages
  const dbClient = createDbClient(rpc);
  setDbOpen(dbClient.open);  // For agentic-messaging session persistence
  setRpc(rpc);               // For @natstack/ai streaming and tool execution

  // Step 5: Set up state management BEFORE pubsub connect
  // This allows getConnectOptions() to use lastCheckpoint for replay recovery
  const db = await dbClient.open("agent-state.db");
  const storage = createElectronStorage(db);

  // Access protected/internal agent properties via the injection interface
  // This provides type-safe access to methods the runtime needs to call/inject
  type AgentInternal = AgentRuntimeInjection<S, AgenticParticipantMetadata>;
  const agentInternal = agent as unknown as AgentInternal;

  const stateStore: StateStore<S> = createStateStore({
    storage,
    key: { agentId, channel, handle },
    initial: defaultState,
    version: agent.stateVersion,
    migrate: agentInternal.migrateState?.bind(agent),
    autoSaveDelayMs: STATE_PERSIST_DEBOUNCE_MS,
  });

  // Load persisted state and merge with defaults
  const persistedState = await stateStore.load();

  // Deep merge persisted state with defaults
  agent.state = deepMerge(defaultState, persistedState);

  // IMPORTANT: Sync the merged state back to stateStore so it's consistent
  stateStore.set(agent.state);

  const checkpoint = stateStore.getMetadata().lastPubsubId;
  log.debug(`State loaded: checkpoint=${checkpoint ?? "none"}`);

  // Inject setState helper (via the internal interface)
  agentInternal.setState = (partial: Partial<S>) => {
    agent.state = deepMerge(agent.state, partial);
    stateStore.set(agent.state);
  };

  // Inject lastCheckpoint getter
  Object.defineProperty(agent, "lastCheckpoint", {
    get: () => stateStore.getMetadata().lastPubsubId,
    configurable: true,
  });

  // Step 5b: Inject context BEFORE getConnectOptions (Issue #1 fix)
  // This allows agents to use this.ctx consistently in all lifecycle methods.
  // The client property starts as null and is populated after pubsub connects.
  const ctx: AgentContext<AgenticParticipantMetadata> = {
    agentId,
    channel,
    handle,
    config: agentConfig,
    log,
    client: null, // Populated after pubsub connects
    pubsubUrl,
    pubsubToken,
  };

  // Inject ctx first (unified context model) via the internal interface
  agentInternal.ctx = ctx;

  // Also inject initInfo for backward compatibility (deprecated, same values as ctx)
  agentInternal.initInfo = {
    agentId,
    channel,
    handle,
    config: agentConfig,
  };

  // Step 6: Connect to pubsub (NOW getConnectOptions can use lastCheckpoint AND ctx)
  log.debug(`Connecting to pubsub at ${pubsubUrl}...`);
  let client: AgenticClient;
  try {
    const customOptions = agent.getConnectOptions?.() ?? {};

    client = await connect({
      // Agent-customizable options
      ...customOptions,
      // Runtime-controlled options (cannot be overridden)
      serverUrl: pubsubUrl,
      token: pubsubToken,
      channel,
      handle,
      // Merge name/type with defaults
      name: customOptions.name ?? AgentClass.name,
      type: customOptions.type ?? "agent",
      extraMetadata: {
        agentId,
        ...(customOptions.extraMetadata ?? {}),
      },
    });
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    log.error("Failed to connect to pubsub:", error.message);
    sendToHost({
      type: "error",
      error: error.message,
      stack: error.stack,
    });
    process.exit(1);
  }

  log.info(`Connected to pubsub channel: ${channel}`);

  // Step 7: Populate client in existing context (Issue #1 fix - unified context)
  // ctx was created earlier with client: null, now we populate it
  ctx.client = client;

  // Call optional init hook (after state loading, after client connection)
  agentInternal.init?.();

  // Step 8: Set up lifecycle management
  let isShuttingDown = false;
  const inflight = new Set<Promise<void>>();

  const lifecycle = createLifecycleManager({
    onIdle: () => {
      log.debug("Agent idle, allowing process to exit");
      ipc.unref?.();
    },
    eluThreshold: 0.01,
    idleDebounceMs: 1000,
  });

  // Shutdown handler
  const shutdown = async (reason: string) => {
    if (isShuttingDown) return;
    isShuttingDown = true;

    log.info(`Shutdown requested: ${reason}`);

    // Set up force exit timeout
    const forceExitTimeout = setTimeout(() => {
      log.error("Shutdown timeout, forcing exit");
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);

    try {
      // Stop idle monitoring
      lifecycle.stopIdleMonitoring();

      // Wait for in-flight event handlers to finish
      if (inflight.size > 0) {
        log.debug(`Draining ${inflight.size} in-flight event handler(s)...`);
        await Promise.allSettled([...inflight]);
      }

      // Run onSleep with timeout
      try {
        await Promise.race([
          agent.onSleep(),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("onSleep timeout")), SLEEP_TIMEOUT_MS)
          ),
        ]);
      } catch (err) {
        log.warn("onSleep error/timeout:", err);
      }

      // Sync current state to store and flush to DB
      stateStore.set(agent.state);
      await stateStore.flush();
      log.debug("State flushed");

      // Close pubsub connection first so the disconnect handler sees closing=true
      // and skips markInterrupted() — avoids "Database connection is closed" race
      try {
        await client.close();
      } catch (err) {
        log.warn("Error closing pubsub:", err);
      }

      // Close database after pubsub is torn down
      try {
        await db.close();
      } catch (err) {
        log.warn("Error closing database:", err);
      }

      // Notify host
      sendToHost({ type: "shutdown-complete" });
    } finally {
      clearTimeout(forceExitTimeout);
      process.exit(0);
    }
  };

  // Listen for host shutdown message
  ipc.on("message", async (msg) => {
    // No {data:...} unwrapping — handled by AgentIpcChannel
    if (isHostToAgentMessage(msg) && msg.type === "shutdown") {
      await shutdown("host requested shutdown");
    }
  });

  // Handle natural exit (event loop empty)
  process.on("beforeExit", () => {
    void shutdown("beforeExit (event loop empty)");
  });

  // Handle uncaught errors
  process.on("uncaughtException", (err) => {
    log.error("Uncaught exception:", err);
    void shutdown("uncaught exception");
  });

  process.on("unhandledRejection", (reason) => {
    log.error("Unhandled rejection:", reason);
    // Don't shutdown on unhandled rejection, just log
  });

  // Step 9: Set up reconnection handlers
  client.onDisconnect(() => {
    log.warn("Pubsub disconnected");
  });

  client.onReconnect(() => {
    log.info("Pubsub reconnected");
    lifecycle.markActive();
  });

  client.onError((err) => {
    log.error("Pubsub error:", err.message);
  });

  // Step 10: Load settings and call agent.onWake()
  try {
    // Load settings before onWake (Issue #6 fix)
    // Access loadSettings via type cast since it's protected
    log.debug("Loading settings...");
    const agentWithSettings = agent as unknown as { loadSettings: () => Promise<void> };
    await agentWithSettings.loadSettings();
    log.debug("Settings loaded");

    log.debug("Calling onWake...");
    await agent.onWake();
    log.debug("onWake completed");
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    log.error("onWake failed:", error.message);
    if (error.stack) {
      log.error("Stack trace:", error.stack);
    }
    sendToHost({
      type: "error",
      error: error.message,
      stack: error.stack,
    });
    process.exit(1);
  }

  // Step 11: Send ready to host
  sendToHost({ type: "ready" });
  log.info("Agent ready");

  // Step 12: Start idle monitoring
  lifecycle.startIdleMonitoring();

  // Step 13: Enter message loop (fire-and-forget pattern)
  // Auto-checkpoint: Runtime advances checkpoint after delivering each persisted event.
  // This means "highest event ID we've seen" - agents don't manage checkpoints directly.
  //
  // IMPORTANT: We also checkpoint events filtered by client.events() (e.g., targetedOnly)
  // via the onFiltered callback. Without this, filtered events would replay forever.
  const baseEventsOptions = agent.getEventsOptions?.() ?? {};
  const eventsOptions = {
    ...baseEventsOptions,
    onFiltered: (event: { pubsubId?: number }) => {
      // Checkpoint filtered events so they don't replay forever
      // Same semantics as delivered events: "I've seen it"
      if (event.pubsubId !== undefined) {
        stateStore.setCheckpoint(event.pubsubId);
      }
    },
  };

  try {
    for await (const event of client.events(eventsOptions)) {
      // Skip agent-debug events - they're UI-only and not for agent processing
      if (isAgentDebugEvent(event)) {
        continue;
      }

      lifecycle.markActive();
      ipc.ref?.(); // Re-ref IPC while processing

      // Fire and forget - let agent control queueing/serialization
      const p = Promise.resolve(agent.onEvent(event)).catch((err) => {
        const error = err instanceof Error ? err : new Error(String(err));
        log.error("Error in onEvent:", error.message);
      }).finally(() => inflight.delete(p));
      inflight.add(p);

      // Auto-checkpoint: advance for all events we've received
      // Semantics: "I've seen this event" (at-most-once delivery)
      // Checkpoint both persisted and replay events - the distinction is informational only
      if (event.pubsubId !== undefined) {
        stateStore.setCheckpoint(event.pubsubId);
      }
    }
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    log.error("Event loop error:", error.message);
  }

  // Events iterator ended (connection closed)
  await shutdown("events iterator ended");
}
