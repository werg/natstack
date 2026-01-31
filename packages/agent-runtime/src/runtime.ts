/**
 * Agent Runtime Entry Point
 *
 * The main runAgent() function that bootstraps and runs an agent in
 * Electron's utilityProcess. Handles:
 * - IPC setup with host process
 * - RPC bridge initialization
 * - Database client injection
 * - Pubsub connection
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
import type { AgenticClient } from "@natstack/agentic-messaging";
import { setRpc } from "@natstack/ai";

import { Agent, type AgentContext, type AgentLogger } from "./agent.js";
import { createParentPortTransport, type ParentPort } from "./transport.js";
import { createLifecycleManager } from "./lifecycle.js";

// Shutdown timeouts
const SHUTDOWN_TIMEOUT_MS = 5000;
const SLEEP_TIMEOUT_MS = 3000;

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
 * 4. Connects to pubsub
 * 5. Initializes the agent (onWake)
 * 6. Enters the message loop
 * 7. Handles graceful shutdown
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
 *
 *   async onEvent(event) {
 *     if (event.type === 'message') {
 *       this.state.count++;
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

  // Step 4: Initialize RPC + DB client
  const selfId = `agent:${agentId}:${handle}`;
  const transport = createParentPortTransport(parentPort, selfId);
  const rpc = createRpcBridge({ selfId, transport });

  // Create DB client and inject for shared packages
  const dbClient = createDbClient(rpc);
  setDbOpen(dbClient.open);  // For agentic-messaging session persistence
  setRpc(rpc);               // For @natstack/ai streaming and tool execution

  // Step 5: Connect to pubsub
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

  // Step 6: Create context and inject into agent
  const ctx: AgentContext = {
    agentId,
    channel,
    handle,
    config: agentConfig,
    client,
    log,
  };

  // Inject context (accessing protected property)
  (agent as unknown as { ctx: AgentContext }).ctx = ctx;

  // Step 7: Set up lifecycle management
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

  // Step 8: Set up reconnection handlers
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

  // Step 9: Call agent.onWake()
  try {
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

  // Step 10: Send ready to host
  sendToHost({ type: "ready" });
  log.info("Agent ready");

  // Step 11: Start idle monitoring
  lifecycle.startIdleMonitoring();

  // Step 12: Enter message loop (fire-and-forget pattern)
  const eventsOptions = agent.getEventsOptions?.() ?? {};

  try {
    for await (const event of client.events(eventsOptions)) {
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
