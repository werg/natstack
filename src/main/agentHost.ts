/**
 * AgentHost - Manages agent lifecycle with in-process responders.
 *
 * Responsibilities:
 * 1. Instantiates agents in-process from the responder registry
 * 2. Provides state persistence via direct StorageApi
 * 3. Connects agents to pubsub via WebSocket
 * 4. Tracks running instances per channel
 * 5. Enforces 5-minute channel inactivity timeout
 * 6. Handles graceful shutdown
 *
 * Previously agents were spawned as separate processes (utilityProcess/fork)
 * with IPC/RPC bridges. Now they run in-process as trusted code.
 */

import { randomUUID } from "crypto";
import { EventEmitter } from "events";
import type { AgentInstanceInfo } from "@natstack/types";
import type { MessageStore } from "./pubsubServer.js";
import type { Agent, AgentState, AgentContext, AgentRuntimeInjection, AgentLogger } from "@workspace/agent-runtime";
import { createStateStore, deepMerge, type StateStore } from "@workspace/agent-runtime";
import type { AgenticClient, AgenticParticipantMetadata, EventStreamItem } from "@workspace/agentic-messaging";
import { connect } from "@workspace/agentic-messaging";
import { getDatabaseManager } from "./db/databaseManager.js";
import { createDirectStorageApi } from "./directStorageAdapter.js";
import { RESPONDER_REGISTRY } from "./responders/index.js";
import { createDevLogger } from "./devLog.js";

const log = createDevLogger("AgentHost");

// ===========================================================================
// Types
// ===========================================================================

/**
 * In-process agent instance.
 * Holds the agent object, its pubsub client, state store, and lifecycle control.
 */
interface AgentInstance extends AgentInstanceInfo {
  /** The agent object */
  agent: Agent<AgentState>;
  /** Pubsub client for this agent */
  client: AgenticClient<AgenticParticipantMetadata> | null;
  /** State store for persistence */
  stateStore: StateStore<AgentState>;
  /** Abort controller for the event loop */
  abortController: AbortController;
  /** Set when stop event has been emitted, prevents duplicate events */
  stopEventEmitted?: boolean;
  /** Event loop promise (for awaiting during shutdown) */
  eventLoopPromise?: Promise<void>;
}

interface SpawnOptions {
  channel: string;
  handle: string;
  config: Record<string, unknown>;
}

interface AgentHostOptions {
  workspaceRoot: string;
  pubsubUrl: string;
  messageStore: MessageStore;
  createToken: (instanceId: string) => string;
  revokeToken: (instanceId: string) => boolean;
}

/**
 * Agent output event emitted when stdout/stderr is captured.
 */
export interface AgentOutputEvent {
  channel: string;
  handle: string;
  agentId: string;
  stream: "stdout" | "stderr";
  content: string;
  timestamp: number;
}

/**
 * Agent lifecycle event emitted on state changes.
 */
export interface AgentLifecycleEvent {
  channel: string;
  handle: string;
  agentId: string;
  event: "spawning" | "started" | "stopped" | "woken" | "warning";
  reason?: "timeout" | "explicit" | "crash" | "idle";
  details?: unknown;
  timestamp: number;
}

/**
 * Agent log event emitted when agent sends structured log messages.
 */
export interface AgentLogEvent {
  channel: string;
  handle: string;
  agentId: string;
  level: "debug" | "info" | "warn" | "error";
  message: string;
  stack?: string;
  timestamp: number;
}

/**
 * Spawn configuration stored for auto-wake.
 */
export interface StoredSpawnConfig {
  channel: string;
  handle: string;
  config: Record<string, unknown>;
}

/**
 * Custom error class for agent spawn failures.
 */
export class AgentSpawnError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentSpawnError";
  }
}


// ===========================================================================
// Constants
// ===========================================================================

const INACTIVITY_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const ACTIVITY_CHECK_INTERVAL_MS = 60_000; // Check every minute
const SHUTDOWN_TIMEOUT_MS = 5_000; // 5s for graceful shutdown

// ===========================================================================
// AgentHost Class
// ===========================================================================

export class AgentHost extends EventEmitter {
  private instances = new Map<string, AgentInstance>();
  private channelActivity = new Map<string, number>();
  private activityCheckInterval: NodeJS.Timeout | null = null;
  private isShuttingDown = false;
  private messageStore: MessageStore;
  /** Tracks consecutive wake failures per (channel, agentId) to implement exponential backoff. */
  private wakeFailures = new Map<string, { count: number; backoffUntil: number }>();

  constructor(private options: AgentHostOptions) {
    super();
    this.messageStore = options.messageStore;
  }

  async initialize(): Promise<void> {
    this.startActivityMonitoring();
    log.verbose("AgentHost initialized (in-process mode)");
  }

  /**
   * Spawn an agent for a channel.
   * Returns existing instance if already running on the channel.
   */
  async spawn(
    agentId: string,
    options: SpawnOptions
  ): Promise<AgentInstanceInfo> {
    log.verbose(`[spawn] Starting spawn for agent=${agentId}, channel=${options.channel}, handle=${options.handle}`);

    // 1. Validate agent exists in registry
    const registered = RESPONDER_REGISTRY.get(agentId);
    if (!registered) {
      throw new AgentSpawnError(`Agent not found: ${agentId}`);
    }

    // 2. Check for existing instance on this channel
    const existing = this.getInstance(options.channel, agentId);
    if (existing) {
      log.verbose(`Agent ${agentId} already running on ${options.channel}`);
      return existing;
    }

    // Emit spawning lifecycle event
    this.emit("agentLifecycle", {
      channel: options.channel,
      handle: options.handle,
      agentId,
      event: "spawning",
      timestamp: Date.now(),
    } satisfies AgentLifecycleEvent);

    // 3. Generate instance ID and token
    const instanceId = randomUUID();
    const token = this.options.createToken(instanceId);

    // 4. Instantiate the agent in-process
    const { AgentClass } = registered;
    const agent = new AgentClass();

    // 5. Create logger that emits to AgentHost events
    const agentLogger: AgentLogger = {
      debug: (...args: unknown[]) => {
        log.verbose(`[Agent:${agentId}] ${args.map(String).join(" ")}`);
        this.emitLogEvent(options.channel, options.handle, agentId, "debug", args);
      },
      info: (...args: unknown[]) => {
        log.verbose(`[Agent:${agentId}] ${args.map(String).join(" ")}`);
        this.emitLogEvent(options.channel, options.handle, agentId, "info", args);
      },
      warn: (...args: unknown[]) => {
        log.warn(`[Agent:${agentId}] ${args.map(String).join(" ")}`);
        this.emitLogEvent(options.channel, options.handle, agentId, "warn", args);
      },
      error: (...args: unknown[]) => {
        log.error(`[Agent:${agentId}] ${args.map(String).join(" ")}`);
        this.emitLogEvent(options.channel, options.handle, agentId, "error", args);
      },
    };

    // 6. Create state store with direct StorageApi
    const ownerId = `agent:${agentId}:${options.handle}`;
    const storageApi = createDirectStorageApi(ownerId);
    const stateStore = createStateStore<AgentState>({
      storage: storageApi,
      key: {
        agentId,
        channel: options.channel,
        handle: options.handle,
      },
      initial: agent.state,
      version: agent.stateVersion,
      migrate: (agent as unknown as AgentRuntimeInjection<AgentState, AgenticParticipantMetadata>).migrateState?.bind(agent),
      autoSaveDelayMs: 100,
    });

    // Load persisted state and merge with defaults
    const persistedState = await stateStore.load();
    agent.state = deepMerge(agent.state, persistedState);

    // 7. Inject context (client=null initially)
    const ctx: AgentContext<AgenticParticipantMetadata> = {
      agentId,
      channel: options.channel,
      handle: options.handle,
      config: options.config,
      log: agentLogger,
      client: null,
      pubsubUrl: this.options.pubsubUrl,
      pubsubToken: token,
    };

    const agentInternal = agent as unknown as AgentRuntimeInjection<AgentState, AgenticParticipantMetadata>;
    agentInternal.ctx = ctx;

    // Inject setState
    agentInternal.setState = (partial: Partial<AgentState>) => {
      agent.state = deepMerge(agent.state, partial);
      stateStore.set(agent.state);
    };

    // Inject lastCheckpoint
    const stateMetadata = stateStore.getMetadata();
    Object.defineProperty(agent, "lastCheckpoint", {
      get: () => stateMetadata.lastPubsubId,
      configurable: true,
    });

    // 8. Connect to pubsub via WebSocket
    const customOptions = agent.getConnectOptions?.() ?? {};
    let client: AgenticClient<AgenticParticipantMetadata>;
    try {
      client = await connect({
        serverUrl: this.options.pubsubUrl,
        token,
        channel: options.channel,
        handle: options.handle,
        name: customOptions.name ?? registered.manifest.title ?? agentId,
        type: (customOptions as { type?: string }).type ?? "agent",
        ...customOptions,
      });
    } catch (err) {
      this.options.revokeToken(instanceId);
      stateStore.destroy();
      throw new AgentSpawnError(`Failed to connect agent ${agentId} to pubsub: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Populate client in context
    ctx.client = client;

    // 9. Load settings and call onWake
    const abortController = new AbortController();

    const instance: AgentInstance = {
      id: instanceId,
      agentId,
      channel: options.channel,
      handle: options.handle,
      startedAt: Date.now(),
      agent,
      client,
      stateStore,
      abortController,
    };
    this.instances.set(instanceId, instance);
    this.markChannelActivity(options.channel);

    try {
      // Load settings before onWake (same as runtime.ts does)
      await agentInternal.loadSettings();

      await agent.onWake();
    } catch (err) {
      log.error(`Agent ${agentId} failed during onWake: ${err}`);
      await this.cleanupInstance(instanceId);
      throw new AgentSpawnError(`Agent ${agentId} onWake failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    // 10. Start event loop in background
    const eventsOptions = agent.getEventsOptions?.();
    instance.eventLoopPromise = this.runEventLoop(instance, eventsOptions);

    // Emit started lifecycle event
    this.emit("agentLifecycle", {
      channel: options.channel,
      handle: options.handle,
      agentId,
      event: "started",
      timestamp: Date.now(),
    } satisfies AgentLifecycleEvent);

    log.verbose(`[spawn] Agent ${agentId} started on channel ${options.channel}`);

    return {
      id: instance.id,
      agentId: instance.agentId,
      channel: instance.channel,
      handle: instance.handle,
      startedAt: instance.startedAt,
    };
  }

  /**
   * Run the event loop for an in-process agent.
   * Processes pubsub events and auto-checkpoints.
   */
  private async runEventLoop(
    instance: AgentInstance,
    eventsOptions?: Parameters<AgenticClient<AgenticParticipantMetadata>["events"]>[0]
  ): Promise<void> {
    const { agent, client, stateStore, abortController } = instance;
    if (!client) return;

    try {
      for await (const event of client.events(eventsOptions)) {
        if (abortController.signal.aborted) break;

        try {
          await agent.onEvent(event as EventStreamItem);
        } catch (err) {
          log.error(`Agent ${instance.agentId} onEvent error:`, err);
        }

        // Auto-checkpoint
        const pubsubId = (event as { pubsubId?: number }).pubsubId;
        if (pubsubId !== undefined) {
          stateStore.setCheckpoint(pubsubId);
        }
      }
    } catch (err) {
      if (!abortController.signal.aborted) {
        log.error(`Agent ${instance.agentId} event loop error:`, err);
      }
    }
  }

  /**
   * Kill an agent instance gracefully.
   * Emits "stopped (explicit)" lifecycle event.
   */
  async kill(instanceId: string): Promise<boolean> {
    const instance = this.instances.get(instanceId);
    if (!instance) {
      return false;
    }

    // Mark that we've emitted the stop event to prevent duplicate
    instance.stopEventEmitted = true;

    // Emit explicit stop lifecycle event
    this.emit("agentLifecycle", {
      channel: instance.channel,
      handle: instance.handle,
      agentId: instance.agentId,
      event: "stopped",
      reason: "explicit",
      timestamp: Date.now(),
    } satisfies AgentLifecycleEvent);

    return this.killInternal(instanceId);
  }

  /**
   * Internal kill without lifecycle event (used by timeout handler).
   */
  private async killInternal(instanceId: string): Promise<boolean> {
    const instance = this.instances.get(instanceId);
    if (!instance) {
      return false;
    }

    // Abort the event loop
    instance.abortController.abort();

    // Graceful shutdown with timeout
    try {
      const shutdownPromise = (async () => {
        try {
          await instance.agent.onSleep();
        } catch (err) {
          log.warn(`Agent ${instance.agentId} onSleep error:`, err);
        }

        // Flush state
        instance.stateStore.set(instance.agent.state);
        await instance.stateStore.flush();
        instance.stateStore.destroy();

        // Close pubsub client
        if (instance.client) {
          try {
            await instance.client.close();
          } catch {
            // Ignore close errors
          }
        }
      })();

      await Promise.race([
        shutdownPromise,
        new Promise<void>((resolve) => setTimeout(resolve, SHUTDOWN_TIMEOUT_MS)),
      ]);
    } catch (err) {
      log.warn(`Error during agent ${instance.agentId} shutdown:`, err);
    }

    await this.cleanupInstance(instanceId);
    return true;
  }

  /**
   * Get an existing instance of a specific agent on a channel.
   */
  getInstance(channel: string, agentId: string): AgentInstanceInfo | null {
    for (const instance of this.instances.values()) {
      if (instance.channel === channel && instance.agentId === agentId) {
        return {
          id: instance.id,
          agentId: instance.agentId,
          channel: instance.channel,
          handle: instance.handle,
          startedAt: instance.startedAt,
        };
      }
    }
    return null;
  }

  /**
   * Get an existing instance by channel, agentId, AND handle.
   * Used for auto-wake to allow multiple handles of the same agent.
   */
  getInstanceByHandle(channel: string, agentId: string, handle: string): AgentInstanceInfo | null {
    for (const instance of this.instances.values()) {
      if (instance.channel === channel && instance.agentId === agentId && instance.handle === handle) {
        return {
          id: instance.id,
          agentId: instance.agentId,
          channel: instance.channel,
          handle: instance.handle,
          startedAt: instance.startedAt,
        };
      }
    }
    return null;
  }

  /**
   * Get all agents running on a channel.
   */
  getChannelAgents(channel: string): AgentInstanceInfo[] {
    const agents: AgentInstanceInfo[] = [];
    for (const instance of this.instances.values()) {
      if (instance.channel === channel) {
        agents.push({
          id: instance.id,
          agentId: instance.agentId,
          channel: instance.channel,
          handle: instance.handle,
          startedAt: instance.startedAt,
        });
      }
    }
    return agents;
  }

  /**
   * List all available agents from the registry.
   */
  listAvailableAgents() {
    return [...RESPONDER_REGISTRY.values()].map((r) => r.manifest);
  }

  /**
   * Mark channel activity (resets inactivity timer).
   */
  markChannelActivity(channel: string): void {
    this.channelActivity.set(channel, Date.now());
  }

  /**
   * Wake registered agents for a channel that aren't currently running.
   */
  async wakeChannelAgents(channel: string): Promise<void> {
    if (this.isShuttingDown) return;

    const registeredAgents = this.messageStore.getChannelAgents(channel);
    if (registeredAgents.length === 0) return;

    const now = Date.now();

    for (const registration of registeredAgents) {
      // Skip if already running
      const existing = this.getInstanceByHandle(channel, registration.agentId, registration.handle);
      if (existing) {
        continue;
      }

      // Skip if in backoff period
      const backoffKey = `${channel}:${registration.agentId}`;
      const failure = this.wakeFailures.get(backoffKey);
      if (failure && now < failure.backoffUntil) {
        continue;
      }

      // Parse stored spawn config
      let spawnConfig: StoredSpawnConfig;
      try {
        spawnConfig = JSON.parse(registration.config) as StoredSpawnConfig;
      } catch (err) {
        log.warn(`Failed to parse stored config for agent ${registration.agentId}: ${err}`);
        continue;
      }

      log.verbose(`Waking agent ${registration.agentId} (@${registration.handle}) on channel ${channel}`);

      try {
        await this.spawn(registration.agentId, {
          channel: registration.channel,
          handle: registration.handle,
          config: spawnConfig.config,
        });

        // Clear failure tracking on success
        this.wakeFailures.delete(backoffKey);

        // Emit woken lifecycle event
        this.emit("agentLifecycle", {
          channel: registration.channel,
          handle: registration.handle,
          agentId: registration.agentId,
          event: "woken",
          timestamp: Date.now(),
        } satisfies AgentLifecycleEvent);
      } catch (err) {
        // Exponential backoff: 5s, 10s, 20s, 40s, capped at 60s
        const count = (failure?.count ?? 0) + 1;
        const delayMs = Math.min(5_000 * Math.pow(2, count - 1), 60_000);
        this.wakeFailures.set(backoffKey, { count, backoffUntil: now + delayMs });
        log.error(`Failed to wake agent ${registration.agentId} (attempt ${count}, next retry in ${delayMs / 1000}s): ${err}`);
      }
    }
  }

  /**
   * Start the activity monitoring interval.
   */
  private startActivityMonitoring(): void {
    this.activityCheckInterval = setInterval(() => {
      if (this.isShuttingDown) return;

      const now = Date.now();
      const channelsToCleanup: string[] = [];

      for (const [channel, lastActivity] of this.channelActivity) {
        if (now - lastActivity > INACTIVITY_TIMEOUT_MS) {
          channelsToCleanup.push(channel);
        }
      }

      for (const channel of channelsToCleanup) {
        log.verbose(`Channel ${channel} inactive for 5 minutes, stopping agents (they can auto-wake)`);

        for (const instance of this.instances.values()) {
          if (instance.channel === channel) {
            instance.stopEventEmitted = true;

            this.emit("agentLifecycle", {
              channel: instance.channel,
              handle: instance.handle,
              agentId: instance.agentId,
              event: "stopped",
              reason: "timeout",
              timestamp: Date.now(),
            } satisfies AgentLifecycleEvent);
            void this.killInternal(instance.id);
          }
        }

        this.channelActivity.delete(channel);
      }
    }, ACTIVITY_CHECK_INTERVAL_MS);

    this.activityCheckInterval.unref();
  }

  /**
   * Emit a log event from an agent.
   */
  private emitLogEvent(
    channel: string,
    handle: string,
    agentId: string,
    level: "debug" | "info" | "warn" | "error",
    args: unknown[]
  ): void {
    const message = args.map((a) => {
      if (a instanceof Error) return a.stack ?? a.message;
      return String(a);
    }).join(" ");

    this.emit("agentLog", {
      channel,
      handle,
      agentId,
      level,
      message,
      timestamp: Date.now(),
    } satisfies AgentLogEvent);
  }

  /**
   * Clean up an instance.
   */
  private async cleanupInstance(instanceId: string): Promise<void> {
    const instance = this.instances.get(instanceId);
    if (instance) {
      getDatabaseManager().closeAllForOwner(`agent:${instance.agentId}:${instance.handle}`);
      this.options.revokeToken(instanceId);
      this.instances.delete(instanceId);
    }
  }

  /**
   * Shutdown the AgentHost and all running agents.
   */
  shutdown(): void {
    this.isShuttingDown = true;

    if (this.activityCheckInterval) {
      clearInterval(this.activityCheckInterval);
      this.activityCheckInterval = null;
    }

    // Kill all agents
    for (const instance of this.instances.values()) {
      instance.abortController.abort();
      instance.stateStore.set(instance.agent.state);
      void instance.stateStore.flush().catch(() => {});
      instance.stateStore.destroy();
      if (instance.client) {
        void instance.client.close().catch(() => {});
      }
      getDatabaseManager().closeAllForOwner(`agent:${instance.agentId}:${instance.handle}`);
      this.options.revokeToken(instance.id);
    }

    this.instances.clear();
    this.channelActivity.clear();
    this.wakeFailures.clear();

    log.verbose("AgentHost shutdown complete");
  }
}

// ===========================================================================
// Singleton Management
// ===========================================================================

let agentHostInstance: AgentHost | null = null;

/**
 * Get the AgentHost singleton (null if not initialized).
 */
export function getAgentHost(): AgentHost | null {
  return agentHostInstance;
}

/**
 * Initialize the AgentHost singleton.
 */
export function initAgentHost(options: AgentHostOptions): AgentHost {
  if (agentHostInstance) {
    agentHostInstance.shutdown();
  }
  agentHostInstance = new AgentHost(options);
  return agentHostInstance;
}

/**
 * Shutdown the AgentHost singleton.
 */
export function shutdownAgentHost(): void {
  if (agentHostInstance) {
    agentHostInstance.shutdown();
    agentHostInstance = null;
  }
}
