/**
 * AgentHost - Manages agent lifecycle using Electron's utilityProcess.
 *
 * Responsibilities:
 * 1. Spawns agents as utilityProcess child processes
 * 2. Sends initialization config via IPC
 * 3. Tracks running instances per channel
 * 4. Enforces 5-minute channel inactivity timeout
 * 5. Handles graceful and forced shutdown
 * 6. Provides RPC bridge for DB operations
 */

import { utilityProcess, type UtilityProcess } from "electron";
import { randomUUID } from "crypto";
import { EventEmitter } from "events";
import type { AgentInitConfig, AgentInstanceInfo } from "@natstack/core";
import type { MessageStore } from "./pubsubServer.js";
import {
  createRpcBridge,
  type RpcBridge,
  type RpcTransport,
  type RpcMessage,
} from "@natstack/rpc";
import {
  isParentPortEnvelope,
  type ParentPortEnvelope,
} from "@natstack/agent-runtime";
import { getAgentBuilder } from "./agentBuilder.js";
import { getAgentDiscovery } from "./agentDiscovery.js";
import { getDatabaseManager } from "./db/databaseManager.js";
import { createDevLogger } from "./devLog.js";
import type { AIHandler, StreamTarget } from "./ai/aiHandler.js";
import type { StreamTextOptions, StreamTextEvent } from "../shared/ipc/types.js";
import type { ToolExecutionResult } from "./ai/claudeCodeToolProxy.js";

const log = createDevLogger("AgentHost");

// Module-level AI handler reference (set via setAgentHostAiHandler)
let _aiHandler: AIHandler | null = null;

/**
 * Set the AI handler instance for agents (called during initialization).
 */
export function setAgentHostAiHandler(handler: AIHandler | null): void {
  _aiHandler = handler;
}

// ===========================================================================
// Types
// ===========================================================================

/**
 * Lifecycle message from agent to host.
 */
interface LifecycleMessage {
  type: string;
  error?: string;
  [key: string]: unknown;
}

interface AgentInstance extends AgentInstanceInfo {
  process: UtilityProcess;
  rpcBridge: RpcBridge;
  /** Set when stop event has been emitted, prevents duplicate events from exit handler */
  stopEventEmitted?: boolean;
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
  /**
   * Timeout in milliseconds for agent startup (waiting for 'ready' message).
   * Complex agents may need longer to initialize.
   * @default 30000 (30 seconds)
   */
  startupTimeoutMs?: number;
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
  event: "started" | "stopped" | "woken";
  reason?: "timeout" | "explicit" | "crash" | "idle";
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

// ===========================================================================
// Constants
// ===========================================================================

const DEFAULT_STARTUP_TIMEOUT_MS = 30_000; // 30s to become ready
const SHUTDOWN_TIMEOUT_MS = 5_000; // 5s for graceful shutdown
const INACTIVITY_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const ACTIVITY_CHECK_INTERVAL_MS = 60_000; // Check every minute

// ===========================================================================
// Host Transport Implementation
// ===========================================================================

/**
 * Create an RPC transport for a utilityProcess.
 * This bridges the gap between the main process and the agent process.
 */
function createHostTransport(
  proc: UtilityProcess,
  selfId: string,
  onLifecycleMessage: (msg: LifecycleMessage) => void
): RpcTransport {
  const anyMessageHandlers = new Set<
    (sourceId: string, message: RpcMessage) => void
  >();

  proc.on("message", (msg) => {
    // Check if it's an RPC message (has envelope structure)
    if (isParentPortEnvelope(msg)) {
      const envelope = msg;
      // Only handle messages targeted at us ("main")
      if (envelope.targetId !== selfId && envelope.targetId !== "main") return;

      const sourceId = envelope.sourceId ?? "agent";
      const message = envelope.message;

      for (const handler of anyMessageHandlers) {
        handler(sourceId, message);
      }
      return;
    }

    // Otherwise it's a lifecycle message (ready, shutdown-complete, error)
    const m = msg as { type?: string };
    if (m.type) {
      onLifecycleMessage(msg as LifecycleMessage);
    }
  });

  return {
    async send(targetId: string, message: RpcMessage): Promise<void> {
      const envelope: ParentPortEnvelope = {
        targetId,
        sourceId: selfId,
        message,
      };
      proc.postMessage(envelope);
    },

    onMessage(
      _sourceId: string,
      _handler: (message: RpcMessage) => void
    ): () => void {
      // Not used - we use onAnyMessage
      return () => {};
    },

    onAnyMessage(
      handler: (sourceId: string, message: RpcMessage) => void
    ): () => void {
      anyMessageHandlers.add(handler);
      return () => anyMessageHandlers.delete(handler);
    },
  };
}

// ===========================================================================
// AgentHost Class
// ===========================================================================

export class AgentHost extends EventEmitter {
  private instances = new Map<string, AgentInstance>();
  private channelActivity = new Map<string, number>();
  private activityCheckInterval: NodeJS.Timeout | null = null;
  private isShuttingDown = false;
  private messageStore: MessageStore;

  constructor(private options: AgentHostOptions) {
    super();
    this.messageStore = options.messageStore;
  }

  async initialize(): Promise<void> {
    this.startActivityMonitoring();
    log.verbose("AgentHost initialized");
  }

  /**
   * Spawn an agent for a channel.
   * Returns existing instance if already running on the channel.
   */
  async spawn(
    agentId: string,
    options: SpawnOptions
  ): Promise<AgentInstanceInfo> {
    // 1. Validate agent exists
    const discovery = getAgentDiscovery();
    if (!discovery) {
      throw new Error("AgentDiscovery not initialized");
    }
    const agent = discovery.get(agentId);
    if (!agent) {
      throw new Error(`Agent not found: ${agentId}`);
    }
    if (!agent.valid) {
      throw new Error(`Agent manifest invalid: ${agent.error}`);
    }

    // 2. Check for existing instance on this channel
    const existing = this.getInstance(options.channel, agentId);
    if (existing) {
      log.verbose(`Agent ${agentId} already running on ${options.channel}`);
      return existing;
    }

    // 3. Build agent
    const builder = getAgentBuilder();
    const buildResult = await builder.build({
      workspaceRoot: this.options.workspaceRoot,
      agentName: agentId,
    });

    if (!buildResult.success || !buildResult.bundlePath) {
      throw new Error(`Failed to build agent: ${buildResult.error}`);
    }

    // 4. Generate instance ID and token
    const instanceId = randomUUID();
    const token = this.options.createToken(instanceId);

    // 5. Fork utilityProcess
    const proc = utilityProcess.fork(buildResult.bundlePath, [], {
      serviceName: `agent-${agentId}-${instanceId.slice(0, 8)}`,
      env: {
        ...process.env,
        NODE_ENV: process.env["NODE_ENV"],
        // Set NODE_PATH for any future native addon needs
        NODE_PATH: buildResult.nodeModulesDir,
      },
    });

    // 6. Set up lifecycle promise and RPC bridge BEFORE creating instance
    // This avoids the deferred assignment code smell
    let readyResolve: () => void;
    let readyReject: (err: Error) => void;
    const readyPromise = new Promise<void>((resolve, reject) => {
      readyResolve = resolve;
      readyReject = reject;
    });

    const startupTimeoutMs = this.options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
    const startupTimeout = setTimeout(() => {
      readyReject(new Error(`Agent startup timeout after ${startupTimeoutMs}ms`));
    }, startupTimeoutMs);

    const onLifecycleMessage = (msg: LifecycleMessage) => {
      if (msg.type === "ready") {
        clearTimeout(startupTimeout);
        readyResolve();
      } else if (msg.type === "error") {
        clearTimeout(startupTimeout);
        readyReject(
          new Error((msg["error"] as string) || "Agent initialization error")
        );
      }
    };

    // Create transport and RPC bridge
    const transport = createHostTransport(proc, "main", onLifecycleMessage);
    const rpcBridge = createRpcBridge({ selfId: "main", transport });

    // Expose RPC methods to the agent
    // Agent's RPC selfId matches what agent-runtime uses: agent:${agentId}:${handle}
    const agentSelfId = `agent:${agentId}:${options.handle}`;
    this.setupDbHandlers(rpcBridge, instanceId);
    this.setupAiHandlers(rpcBridge, instanceId, agentSelfId);

    // 7. Create instance record with all fields initialized
    const instance: AgentInstance = {
      id: instanceId,
      agentId,
      channel: options.channel,
      handle: options.handle,
      startedAt: Date.now(),
      process: proc,
      rpcBridge,
    };

    this.instances.set(instanceId, instance);
    this.markChannelActivity(options.channel);

    // Capture stdout/stderr for debug events
    proc.stdout?.on("data", (data: Buffer) => {
      this.emit("agentOutput", {
        channel: options.channel,
        handle: options.handle,
        agentId,
        stream: "stdout",
        content: data.toString(),
        timestamp: Date.now(),
      } satisfies AgentOutputEvent);
    });

    proc.stderr?.on("data", (data: Buffer) => {
      this.emit("agentOutput", {
        channel: options.channel,
        handle: options.handle,
        agentId,
        stream: "stderr",
        content: data.toString(),
        timestamp: Date.now(),
      } satisfies AgentOutputEvent);
    });

    // Handle process exit - emit lifecycle event only if not already emitted
    proc.on("exit", (code) => {
      log.verbose(`Agent ${agentId} (${instanceId}) exited with code ${code}`);
      const instance = this.instances.get(instanceId);
      // Only emit if we haven't already emitted a stop event (e.g., from explicit kill or timeout)
      if (instance && !instance.stopEventEmitted) {
        const reason = code === 0 ? "idle" : "crash";
        this.emit("agentLifecycle", {
          channel: options.channel,
          handle: options.handle,
          agentId,
          event: "stopped",
          reason,
          timestamp: Date.now(),
        } satisfies AgentLifecycleEvent);
      }
      this.cleanupInstance(instanceId);
    });

    // 8. Send init config
    const initConfig: AgentInitConfig = {
      agentId,
      channel: options.channel,
      handle: options.handle,
      config: options.config,
      pubsubUrl: this.options.pubsubUrl,
      pubsubToken: token,
    };

    proc.postMessage({ type: "init", config: initConfig });

    // 9. Await ready
    try {
      await readyPromise;
      log.verbose(`Agent ${agentId} ready on channel ${options.channel}`);

      // Emit started lifecycle event
      this.emit("agentLifecycle", {
        channel: options.channel,
        handle: options.handle,
        agentId,
        event: "started",
        timestamp: Date.now(),
      } satisfies AgentLifecycleEvent);
    } catch (err) {
      // Cleanup on failure
      this.cleanupInstance(instanceId);
      proc.kill();
      throw err;
    }

    return {
      id: instance.id,
      agentId: instance.agentId,
      channel: instance.channel,
      handle: instance.handle,
      startedAt: instance.startedAt,
    };
  }

  /**
   * Kill an agent instance gracefully with fallback to force kill.
   * Emits "stopped (explicit)" lifecycle event.
   */
  async kill(instanceId: string): Promise<boolean> {
    const instance = this.instances.get(instanceId);
    if (!instance) {
      return false;
    }

    // Mark that we've emitted the stop event to prevent duplicate from exit handler
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

    return new Promise<boolean>((resolve) => {
      let resolved = false;

      const cleanup = () => {
        if (resolved) return;
        resolved = true;
        instance.process.off("message", handler);
        this.cleanupInstance(instanceId);
        resolve(true);
      };

      // Listen for graceful shutdown
      const handler = (msg: unknown) => {
        const m = msg as { type?: string };
        if (m.type === "shutdown-complete") {
          log.verbose(`Agent ${instance.agentId} shutdown gracefully`);
          cleanup();
        }
      };
      instance.process.on("message", handler);

      // Send shutdown signal
      instance.process.postMessage({ type: "shutdown" });

      // Force kill after timeout
      setTimeout(() => {
        if (!resolved) {
          log.verbose(`Force killing agent ${instance.agentId}`);
          instance.process.kill();
          cleanup();
        }
      }, SHUTDOWN_TIMEOUT_MS);
    });
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
   * List all available agents from discovery.
   */
  listAvailableAgents() {
    const discovery = getAgentDiscovery();
    return discovery?.listValid().map((a) => a.manifest) ?? [];
  }

  /**
   * Mark channel activity (resets inactivity timer).
   * Called by PubSubServer on every channel message.
   */
  markChannelActivity(channel: string): void {
    this.channelActivity.set(channel, Date.now());
  }

  /**
   * Wake registered agents for a channel that aren't currently running.
   * Called when there's activity on a channel with registered agents.
   */
  async wakeChannelAgents(channel: string): Promise<void> {
    if (this.isShuttingDown) return;

    const registeredAgents = this.messageStore.getChannelAgents(channel);
    if (registeredAgents.length === 0) return;

    for (const registration of registeredAgents) {
      // Skip if already running - check specific (channel, agentId, handle) to allow multiple handles
      const existing = this.getInstanceByHandle(channel, registration.agentId, registration.handle);
      if (existing) {
        continue;
      }

      // Parse the stored spawn config for the agent-specific config values
      let spawnConfig: StoredSpawnConfig;
      try {
        spawnConfig = JSON.parse(registration.config) as StoredSpawnConfig;
      } catch (err) {
        log.warn(`Failed to parse stored config for agent ${registration.agentId}: ${err}`);
        continue;
      }

      log.verbose(`Waking agent ${registration.agentId} (@${registration.handle}) on channel ${channel}`);

      try {
        // Use authoritative channel/handle from DB record, config from stored JSON
        await this.spawn(registration.agentId, {
          channel: registration.channel,
          handle: registration.handle,
          config: spawnConfig.config,
        });

        // Emit woken lifecycle event
        this.emit("agentLifecycle", {
          channel: registration.channel,
          handle: registration.handle,
          agentId: registration.agentId,
          event: "woken",
          timestamp: Date.now(),
        } satisfies AgentLifecycleEvent);
      } catch (err) {
        log.error(`Failed to wake agent ${registration.agentId}: ${err}`);
        // Don't throw - try to wake other agents
      }
    }
  }

  /**
   * Set up database RPC handlers for an agent.
   */
  private setupDbHandlers(bridge: RpcBridge, instanceId: string): void {
    const dbManager = getDatabaseManager();

    bridge.exposeMethod("db.open", (name: string, readOnly?: boolean) => {
      return dbManager.open(instanceId, name, readOnly);
    });

    bridge.exposeMethod("db.exec", (handle: string, sql: string) => {
      dbManager.exec(handle, sql);
    });

    bridge.exposeMethod("db.run", (handle: string, sql: string, params?: unknown[]) => {
      return dbManager.run(handle, sql, params);
    });

    bridge.exposeMethod("db.get", (handle: string, sql: string, params?: unknown[]) => {
      return dbManager.get(handle, sql, params);
    });

    bridge.exposeMethod("db.query", (handle: string, sql: string, params?: unknown[]) => {
      return dbManager.query(handle, sql, params);
    });

    bridge.exposeMethod("db.close", (handle: string) => {
      dbManager.close(handle);
    });
  }

  /**
   * Set up AI RPC handlers for agents.
   * Wires ai.listRoles, ai.streamTextStart, ai.streamCancel to the shared AIHandler.
   *
   * @param bridge - RPC bridge to the agent
   * @param instanceId - Agent instance ID
   * @param agentSelfId - Agent's RPC self ID (e.g., "agent:my-agent:handle")
   */
  private setupAiHandlers(bridge: RpcBridge, instanceId: string, agentSelfId: string): void {
    // ai.listRoles - returns available AI roles/models
    bridge.exposeMethod("ai.listRoles", () => {
      if (!_aiHandler) {
        throw new Error("AI handler not initialized");
      }
      return _aiHandler.getAvailableRoles();
    });

    // ai.streamCancel - cancel an active stream
    bridge.exposeMethod("ai.streamCancel", (streamId: string) => {
      if (!_aiHandler) {
        throw new Error("AI handler not initialized");
      }
      _aiHandler.cancelStream(streamId);
    });

    // ai.streamTextStart - start a streaming AI request
    bridge.exposeMethod(
      "ai.streamTextStart",
      (options: StreamTextOptions, streamId: string) => {
        if (!_aiHandler) {
          throw new Error("AI handler not initialized");
        }

        // Create an agent-specific StreamTarget that uses the RPC bridge
        const target: StreamTarget = {
          targetId: instanceId,

          isAvailable: () => {
            // Check if the agent instance is still running
            return this.instances.has(instanceId);
          },

          sendChunk: (event: StreamTextEvent) => {
            // Send stream chunk via RPC event to the agent's selfId
            void bridge.emit(agentSelfId, "ai:stream-text-chunk", { streamId, chunk: event });
          },

          sendEnd: () => {
            // Send stream end via RPC event to the agent's selfId
            void bridge.emit(agentSelfId, "ai:stream-text-end", { streamId });
          },

          executeTool: async (
            toolName: string,
            args: Record<string, unknown>
          ): Promise<ToolExecutionResult> => {
            // Call the agent's ai.executeTool method via RPC
            return bridge.call<ToolExecutionResult>(
              agentSelfId,
              "ai.executeTool",
              streamId,
              toolName,
              args
            );
          },

          onUnavailable: (listener: () => void) => {
            // Monitor for agent exit
            const instance = this.instances.get(instanceId);
            if (!instance) {
              // Already unavailable
              listener();
              return () => {};
            }

            // Watch for process exit
            const exitHandler = () => listener();
            instance.process.on("exit", exitHandler);
            return () => instance.process.off("exit", exitHandler);
          },
        };

        // Start streaming to the agent target
        _aiHandler.startTargetStream(target, options, streamId);
      }
    );
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
        log.verbose(`Channel ${channel} inactive for 5 minutes, killing agents (they can auto-wake)`);

        for (const instance of this.instances.values()) {
          if (instance.channel === channel) {
            // Mark that we've emitted the stop event to prevent duplicate from exit handler
            instance.stopEventEmitted = true;

            // Emit timeout lifecycle event before killing
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

    // Don't let the interval keep the process alive during shutdown
    this.activityCheckInterval.unref();
  }

  /**
   * Clean up an instance (revoke token, close DB connections, remove from tracking).
   */
  private cleanupInstance(instanceId: string): void {
    const instance = this.instances.get(instanceId);
    if (instance) {
      // Close all DB connections owned by this agent
      getDatabaseManager().closeAllForOwner(instanceId);
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

    // Clean up all agents (closes DB connections, revokes tokens)
    for (const instance of this.instances.values()) {
      instance.process.kill();
      getDatabaseManager().closeAllForOwner(instance.id);
      this.options.revokeToken(instance.id);
    }

    this.instances.clear();
    this.channelActivity.clear();

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
