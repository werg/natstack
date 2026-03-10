/**
 * Agent Adapter — in-process agent lifecycle management.
 *
 * Runs agents in-process with direct access to DatabaseManager, AIHandler,
 * and PubSub.
 *
 * The adapter:
 * 1. Injects setDbOpen() for agentic-messaging session persistence
 * 2. Creates a local WebSocket PubSub connection via AgenticClient
 * 3. Opens a state database via DatabaseManager directly
 * 4. Owns the event loop (for await over client.events())
 * 5. Dispatches events to the agent's handler
 * 6. Preserves checkpoint semantics (advances for both delivered AND filtered events)
 * 7. Wraps each dispatch in try/catch for error isolation
 */

import * as path from "path";
import type { DatabaseInterface } from "@natstack/types";
import type { AiClient } from "@natstack/ai";
import type { AgenticClient, AgenticParticipantMetadata, EventStreamItem } from "@natstack/agentic-protocol";
import { connect, setDbOpen } from "@natstack/agentic-messaging";
import type { DatabaseManager } from "../../shared/db/databaseManager.js";
import { createDirectAiClient } from "./directAi.js";
import type { AIHandler } from "../../shared/ai/aiHandler.js";

/**
 * Logger interface matching what agents expect.
 */
export interface AgentLogger {
  debug: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

/**
 * Simple key-value state store backed by a single SQLite table.
 * Agents use this to persist state (e.g., SDK session IDs) across restarts.
 */
export interface AgentStateStore {
  /** Get the full state object. Returns {} if no state is persisted. */
  get<T extends Record<string, unknown> = Record<string, unknown>>(): T;
  /** Merge a partial update into the persisted state. */
  set(patch: Record<string, unknown>): void;
}

/**
 * Full context provided to agent services on start().
 */
export interface AgentServiceContext {
  agentId: string;
  channel: string;
  handle: string;
  config: Record<string, unknown>;
  client: AgenticClient;
  db: DatabaseManager;
  ai: AiClient;
  pubsubUrl: string;
  pubsubToken: string;
  contextFolderPath: string;
  log: AgentLogger;
  /** Persistent state store — survives agent restarts. */
  state: AgentStateStore;
}

/**
 * Interface that agent implementations must satisfy.
 */
export interface AgentService {
  start(ctx: AgentServiceContext): Promise<void>;
  onEvent(event: EventStreamItem): Promise<void>;
  stop(): Promise<void>;
}

/**
 * Options for running an agent service in-process.
 */
export interface RunAgentOptions {
  agentId: string;
  channel: string;
  handle: string;
  config: Record<string, unknown>;
  pubsubUrl: string;
  pubsubToken: string;
  contextFolderPath: string;
  databaseManager: DatabaseManager;
  aiHandler: AIHandler;
  /** Called when the event loop crashes (not for per-event errors). */
  onError?: (error: Error) => void;
}

export interface RunningAgent {
  stop(): Promise<void>;
  readonly isRunning: boolean;
  readonly error: Error | null;
}

/**
 * Sanitize a database name for use as a filename.
 */
function sanitizeDbName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
}

/**
 * Create a DatabaseInterface wrapper around DatabaseManager for a specific owner.
 * This is injected via setDbOpen() so agentic-messaging's SessionDb can open databases.
 *
 * All databases are stored in the agent's context folder (.databases/ subdirectory),
 * mirroring the old per-process model where each agent had its own workspace.
 */
function createDbOpener(
  databaseManager: DatabaseManager,
  ownerId: string,
  contextDbDir: string,
): (name: string, readOnly?: boolean) => Promise<DatabaseInterface> {
  return async (name: string, readOnly?: boolean): Promise<DatabaseInterface> => {
    const dbPath = path.join(contextDbDir, sanitizeDbName(name) + ".db");
    const handle = databaseManager.openAtPath(ownerId, dbPath, readOnly);
    return {
      async exec(sql: string) {
        databaseManager.exec(handle, sql);
      },
      async run(sql: string, params?: unknown[]) {
        return databaseManager.run(handle, sql, params);
      },
      async get<T>(sql: string, params?: unknown[]) {
        return databaseManager.get<T>(handle, sql, params);
      },
      async query<T>(sql: string, params?: unknown[]) {
        return databaseManager.query<T>(handle, sql, params);
      },
      async close() {
        databaseManager.close(handle);
      },
    };
  };
}

/**
 * Create a simple SQLite-backed state store for an agent.
 * State is a single JSON blob stored in the agent's context folder.
 */
function createAgentStateStore(
  databaseManager: DatabaseManager,
  ownerId: string,
  dbPath: string,
): AgentStateStore {
  const handle = databaseManager.openAtPath(ownerId, dbPath);

  // Create table if needed
  databaseManager.exec(handle, `
    CREATE TABLE IF NOT EXISTS state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);

  const stateKey = "agent_state";

  // Load initial state
  let cached: Record<string, unknown>;
  const row = databaseManager.get<{ value: string }>(
    handle,
    "SELECT value FROM state WHERE key = ?",
    [stateKey],
  );
  cached = row ? JSON.parse(row.value) as Record<string, unknown> : {};

  return {
    get<T extends Record<string, unknown> = Record<string, unknown>>(): T {
      return cached as T;
    },
    set(patch: Record<string, unknown>): void {
      cached = { ...cached, ...patch };
      const json = JSON.stringify(cached);
      databaseManager.run(
        handle,
        "INSERT OR REPLACE INTO state (key, value) VALUES (?, ?)",
        [stateKey, json],
      );
    },
  };
}

function createAgentLogger(agentId: string): AgentLogger {
  const prefix = `[Agent:${agentId}]`;
  return {
    debug: (...args: unknown[]) => console.debug(prefix, ...args),
    info: (...args: unknown[]) => console.info(prefix, ...args),
    warn: (...args: unknown[]) => console.warn(prefix, ...args),
    error: (...args: unknown[]) => console.error(prefix, ...args),
  };
}

/**
 * Mutex for the setDbOpen() → connect() critical section.
 * setDbOpen() writes to a module-level global in agentic-messaging, and connect()
 * reads it lazily after an async gap (WebSocket handshake). Without serialization,
 * concurrent spawns could get each other's DB openers.
 */
let connectLock: Promise<void> = Promise.resolve();

/**
 * Run an agent service in-process.
 *
 * Returns a handle for stopping the agent and checking its status.
 */
export async function runAgentService(
  agent: AgentService,
  options: RunAgentOptions,
): Promise<RunningAgent> {
  const {
    agentId, channel, handle, config,
    pubsubUrl, pubsubToken, contextFolderPath,
    databaseManager, aiHandler,
  } = options;

  const log = createAgentLogger(agentId);
  let running = true;
  let agentError: Error | null = null;

  // 1. All agent databases live in a channel+handle-scoped subdirectory of the
  //    context folder. This isolates state when multiple channels share a context,
  //    or when the same handle exists on different channels.
  const ownerId = `agent:${agentId}:${handle}:${channel}`;
  const agentDbDir = path.join(contextFolderPath, ".databases", sanitizeDbName(channel), sanitizeDbName(handle));
  const stateDbPath = path.join(agentDbDir, "agent-state.db");
  const stateStore = createAgentStateStore(databaseManager, ownerId, stateDbPath);

  // 2. Create direct AI client (no RPC, no IPC)
  const ai = createDirectAiClient(aiHandler, agentId);

  // 3. Pre-inject minimal context for getConnectOptions/getEventsOptions.
  // These methods may eagerly read agentId, config, and log before start() is called.
  // The full context is provided via start() which overwrites these fields.
  const agentObj = agent as unknown as Record<string, unknown>;
  agentObj["ctx"] = { agentId, channel, handle, config } as unknown;
  agentObj["log"] = log;

  // 4. Get connect/events options from the agent (if it provides them)
  const connectOptions = (agent as { getConnectOptions?: () => Record<string, unknown> }).getConnectOptions?.() ?? {};
  const eventsOptions = (agent as { getEventsOptions?: () => Record<string, unknown> }).getEventsOptions?.() ?? {};

  // 5. Connect to PubSub via local WebSocket
  // setDbOpen() + connect() must be serialized: setDbOpen writes a module-level global
  // that connect() reads lazily after the WebSocket handshake completes.
  log.info(`Connecting to pubsub at ${pubsubUrl}...`);
  const persistedCheckpoint = stateStore.get<{ lastCheckpoint?: number }>().lastCheckpoint;

  const client = await new Promise<Awaited<ReturnType<typeof connect>>>((resolve, reject) => {
    const doConnect = async () => {
      setDbOpen(createDbOpener(databaseManager, ownerId, agentDbDir));
      return connect({
        ...connectOptions,
        serverUrl: pubsubUrl,
        token: pubsubToken,
        channel,
        handle,
        // Adapter is the authority for contextId — always pass from config
        // (agents may omit it from getConnectOptions(), e.g. pubsubChatResponder)
        contextId: config["contextId"] as string | undefined,
        name: (connectOptions as { name?: string }).name ?? agentId,
        type: (connectOptions as { type?: string }).type ?? "agent",
        // Adapter owns checkpoint — override agent's replaySinceId
        ...(persistedCheckpoint !== undefined && { replaySinceId: persistedCheckpoint }),
        extraMetadata: {
          agentId,
          ...((connectOptions as { extraMetadata?: Record<string, unknown> }).extraMetadata ?? {}),
        },
      });
    };
    const locked = connectLock.then(doConnect);
    connectLock = locked.then(() => {}, () => {});
    locked.then(resolve, reject);
  });

  log.info(`Connected to pubsub channel: ${channel}`);

  // 7. Build context and call agent.start()
  const ctx: AgentServiceContext = {
    agentId, channel, handle, config,
    client, db: databaseManager, ai,
    pubsubUrl, pubsubToken, contextFolderPath, log,
    state: stateStore,
  };

  await agent.start(ctx);
  log.info("Agent started");

  // 8. Checkpoint tracking — persisted to state store, loaded on restart
  let lastCheckpoint: number | undefined =
    stateStore.get<{ lastCheckpoint?: number }>().lastCheckpoint;
  let checkpointDirty = false;

  const advanceCheckpoint = (pubsubId: number | undefined) => {
    if (pubsubId !== undefined) {
      lastCheckpoint = pubsubId;
      checkpointDirty = true;
    }
  };

  // Debounced checkpoint flush (100ms, same as old StateStore)
  const checkpointTimer = setInterval(() => {
    if (checkpointDirty) {
      stateStore.set({ lastCheckpoint });
      checkpointDirty = false;
    }
  }, 100);

  // 9. Enter event loop (runs in background)
  const eventLoopPromise = (async () => {
    try {
      const opts = {
        ...eventsOptions,
        onFiltered: (event: { pubsubId?: number }) => {
          // Checkpoint filtered events so they don't replay forever
          advanceCheckpoint(event.pubsubId);
        },
      };

      for await (const event of client.events(opts)) {
        if (!running) break;

        // Dispatch to agent with error isolation
        try {
          await agent.onEvent(event as EventStreamItem);
        } catch (err) {
          log.error("Error in onEvent:", err instanceof Error ? err.message : err);
        }

        // Auto-checkpoint
        advanceCheckpoint((event as { pubsubId?: number }).pubsubId);
      }
    } catch (err) {
      if (running) {
        agentError = err instanceof Error ? err : new Error(String(err));
        log.error("Event loop error:", agentError.message);
        options.onError?.(agentError);
      }
    }
  })();

  // Extend agent with onEvent (it's called by the adapter's event loop)
  // The agent implements this in its class

  return {
    async stop() {
      if (!running) return;
      running = false;
      log.info("Stopping agent...");

      try {
        await agent.stop();
      } catch (err) {
        log.warn("Error in agent.stop():", err);
      }

      try {
        await client.close();
      } catch (err) {
        log.warn("Error closing pubsub:", err);
      }

      // Flush final checkpoint before closing DB
      clearInterval(checkpointTimer);
      if (checkpointDirty) {
        stateStore.set({ lastCheckpoint });
      }

      // Clean up DB handles
      databaseManager.closeAllForOwner(ownerId);

      // Wait for event loop to finish
      await eventLoopPromise.catch(() => {});

      log.info("Agent stopped");
    },

    get isRunning() {
      return running;
    },

    get error() {
      return agentError;
    },
  };
}
