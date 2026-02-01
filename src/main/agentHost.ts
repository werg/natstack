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
import type { AgentInitConfig, AgentInstanceInfo } from "@natstack/core";
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

const log = createDevLogger("AgentHost");

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
}

interface SpawnOptions {
  channel: string;
  handle: string;
  config: Record<string, unknown>;
}

interface AgentHostOptions {
  workspaceRoot: string;
  pubsubUrl: string;
  createToken: (instanceId: string) => string;
  revokeToken: (instanceId: string) => boolean;
}

// ===========================================================================
// Constants
// ===========================================================================

const STARTUP_TIMEOUT_MS = 30_000; // 30s to become ready
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

export class AgentHost {
  private instances = new Map<string, AgentInstance>();
  private channelActivity = new Map<string, number>();
  private activityCheckInterval: NodeJS.Timeout | null = null;
  private isShuttingDown = false;

  constructor(private options: AgentHostOptions) {}

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

    const startupTimeout = setTimeout(() => {
      readyReject(new Error("Agent startup timeout"));
    }, STARTUP_TIMEOUT_MS);

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
    this.setupDbHandlers(rpcBridge, instanceId);
    this.setupAiHandlers(rpcBridge);

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

    // Handle process exit
    proc.on("exit", (code) => {
      log.verbose(`Agent ${agentId} (${instanceId}) exited with code ${code}`);
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
   */
  async kill(instanceId: string): Promise<boolean> {
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
   * Set up AI RPC handlers (stub - returns clear errors until AI support is implemented).
   */
  private setupAiHandlers(bridge: RpcBridge): void {
    const notImplemented = (method: string) => () => {
      throw new Error(`AI RPC method "${method}" is not yet implemented. AI support will be added in a future phase.`);
    };

    bridge.exposeMethod("ai.chat", notImplemented("ai.chat"));
    bridge.exposeMethod("ai.stream", notImplemented("ai.stream"));
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
        log.verbose(`Channel ${channel} inactive for 5 minutes, killing agents`);

        for (const instance of this.instances.values()) {
          if (instance.channel === channel) {
            void this.kill(instance.id);
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
