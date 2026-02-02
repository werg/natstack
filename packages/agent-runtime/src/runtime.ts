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
import { createParentPortTransport, type ParentPort } from "./transport.js";
import { createLifecycleManager } from "./lifecycle.js";
import { createStateStore, type StateStore } from "./state.js";

// Shutdown timeouts
const SHUTDOWN_TIMEOUT_MS = 5000;
const SLEEP_TIMEOUT_MS = 3000;

// State persistence debounce
const STATE_PERSIST_DEBOUNCE_MS = 100;

/**
 * Send a message to the host process.
 */
function createHostMessenger(parentPort: ParentPort) {
  return (message: AgentToHostMessage) => {
    parentPort.postMessage(message);
  };
}

/**
 * Create a logger that forwards to the host and also logs locally.
 */
function createAgentLogger(
  agentId: string,
  sendToHost: (msg: AgentToHostMessage) => void
): AgentLogger {
  const prefix = `[Agent:${agentId}]`;

  return {
    debug: (...args: unknown[]) => {
      console.debug(prefix, ...args);
    },
    info: (...args: unknown[]) => {
      console.info(prefix, ...args);
    },
    warn: (...args: unknown[]) => {
      console.warn(prefix, ...args);
    },
    error: (...args: unknown[]) => {
      console.error(prefix, ...args);
      // Also send errors to host
      const message = args.map((a) => (a instanceof Error ? a.message : String(a))).join(" ");
      const stack = args.find((a) => a instanceof Error)?.stack;
      sendToHost({
        type: "error",
        error: message,
        stack,
      });
    },
  };
}

/**
 * Wait for an init message from the host.
 */
function waitForInit(parentPort: ParentPort): Promise<AgentInitConfig> {
  return new Promise((resolve) => {
    const handler = (msg: unknown) => {
      if (isHostToAgentMessage(msg) && msg.type === "init") {
        parentPort.removeListener("message", handler);
        resolve(msg.config);
      }
    };
    parentPort.on("message", handler);
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
  // Step 1: Validate parentPort
  const parentPort = (process as unknown as { parentPort?: ParentPort }).parentPort;
  if (!parentPort) {
    console.error("agent-runtime must run in utilityProcess (no parentPort available)");
    process.exit(1);
  }

  // Keep process alive while setting up
  parentPort.ref?.();

  const sendToHost = createHostMessenger(parentPort);

  // Step 2: Resolve init config
  const initConfig = config ?? (await waitForInit(parentPort));
  const { agentId, channel, handle, config: agentConfig, pubsubUrl, pubsubToken } = initConfig;

  // Create logger
  const log = createAgentLogger(agentId, sendToHost);
  log.info("Agent starting...");

  // Step 3: Instantiate agent with default state
  const agent = new AgentClass();
  const defaultState = { ...agent.state }; // Capture default state for merging

  // Step 4: Initialize RPC + DB client
  const selfId = `agent:${agentId}:${handle}`;
  const transport = createParentPortTransport(parentPort, selfId);
  const rpc = createRpcBridge({ selfId, transport });

  // Create DB client and inject for shared packages
  const dbClient = createDbClient(rpc);
  setDbOpen(dbClient.open);  // For agentic-messaging session persistence
  setRpc(rpc);               // For @natstack/ai streaming and tool execution

  // Step 5: Set up state management BEFORE pubsub connect
  // This allows getConnectOptions() to use lastCheckpoint for replay recovery
  const db = await dbClient.open("agent-state.db");

  // Access protected/internal agent properties via the injection interface
  // This provides type-safe access to methods the runtime needs to call/inject
  type AgentInternal = AgentRuntimeInjection<S, AgenticParticipantMetadata>;
  const agentInternal = agent as unknown as AgentInternal;

  const stateStore: StateStore<S> = createStateStore({
    db,
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

  // Inject commitCheckpoint method for explicit checkpoint management
  // Agents should call this when they've actually finished processing an event
  agentInternal.commitCheckpoint = (pubsubId: number) => {
    stateStore.setCheckpoint(pubsubId);
  };

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

  const lifecycle = createLifecycleManager({
    onIdle: () => {
      log.debug("Agent idle, allowing process to exit");
      parentPort.unref?.();
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

      // Close database
      try {
        await db.close();
      } catch (err) {
        log.warn("Error closing database:", err);
      }

      // Close pubsub connection
      try {
        await client.close();
      } catch (err) {
        log.warn("Error closing pubsub:", err);
      }

      // Notify host
      sendToHost({ type: "shutdown-complete" });
    } finally {
      clearTimeout(forceExitTimeout);
      process.exit(0);
    }
  };

  // Listen for host shutdown message
  parentPort.on("message", async (msg) => {
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
    const agentWithSettings = agent as unknown as { loadSettings: () => Promise<void> };
    await agentWithSettings.loadSettings();

    await agent.onWake();
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    log.error("onWake failed:", error.message);
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
  // NOTE: Checkpoints are NOT automatically updated. Agents should call
  // this.commitCheckpoint(event.pubsubId) when they've finished processing
  // an event (e.g., after queue.drain() in onSleep).
  const eventsOptions = agent.getEventsOptions?.() ?? {};

  try {
    for await (const event of client.events(eventsOptions)) {
      // Skip agent-debug events - they're UI-only and not for agent processing
      if ("type" in event && event.type === "agent-debug") {
        continue;
      }

      lifecycle.markActive();
      parentPort.ref?.(); // Re-ref IPC while processing

      // Fire and forget - let agent control queueing/serialization
      void Promise.resolve(agent.onEvent(event)).catch((err) => {
        const error = err instanceof Error ? err : new Error(String(err));
        log.error("Error in onEvent:", error.message);
      });
    }
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    log.error("Event loop error:", error.message);
  }

  // Events iterator ended (connection closed)
  await shutdown("events iterator ended");
}
