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

// No top-level Electron import — detection happens at runtime in hasElectronUtilityProcess()
import * as path from "path";
import { randomUUID } from "crypto";
import { EventEmitter } from "events";
import type { AgentInitConfig, AgentInstanceInfo } from "@natstack/types";
import type { MessageStore } from "./pubsubServer.js";
import {
  createRpcBridge,
  type RpcBridge,
  type RpcTransport,
  type RpcMessage,
  isParentPortEnvelope,
  type ParentPortEnvelope,
} from "@natstack/rpc";
import { getAgentDiscovery } from "./agentDiscovery.js";
import { getDatabaseManager } from "./db/databaseManager.js";
import { createDevLogger } from "./devLog.js";
import type { AIHandler, StreamTarget } from "./ai/aiHandler.js";
import type { StreamTextOptions, StreamTextEvent } from "../shared/types.js";
import type { ToolExecutionResult } from "./ai/claudeCodeToolProxy.js";
import {
  type ProcessAdapter,
  hasElectronUtilityProcess,
  createNodeProcessAdapter,
} from "./processAdapter.js";
import type { ContextFolderManager } from "./contextFolderManager.js";

const log = createDevLogger("AgentHost");

// Module-level AI handler reference (set via setAgentHostAiHandler)
let _aiHandler: AIHandler | null = null;

/**
 * Custom error class for agent spawn failures with full build diagnostics.
 * Includes build log, type errors, and dirty repo state when available.
 */
export class AgentSpawnError extends Error {
  constructor(
    message: string,
    public readonly buildLog?: string,
    public readonly typeErrors?: Array<{ file: string; line: number; column: number; message: string }>,
    public readonly dirtyRepo?: { modified: string[]; untracked: string[]; staged: string[] }
  ) {
    super(message);
    this.name = "AgentSpawnError";
  }
}

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
  process: ProcessAdapter;
  rpcBridge: RpcBridge;
  /** Set when stop event has been emitted, prevents duplicate events from exit handler */
  stopEventEmitted?: boolean;
}

interface SpawnOptions {
  channel: string;
  handle: string;
  config: Record<string, unknown>;
  contextFolderPath: string;
}

/** Result from V2 build service for agents */
interface AgentBuildResult {
  bundlePath: string;
  dir: string;
  metadata: { kind: string; name: string };
}

interface AgentHostOptions {
  workspaceRoot: string;
  pubsubUrl: string;
  messageStore: MessageStore;
  createToken: (instanceId: string) => string;
  revokeToken: (instanceId: string) => boolean;
  /** Build an agent via V2 build service */
  getBuild: (unitPath: string) => Promise<AgentBuildResult>;
  contextFolderManager: ContextFolderManager;
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
  reason?: "timeout" | "explicit" | "crash" | "idle" | "dirty-repo";
  /** Additional details for warning events */
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
  contextId: string;
}

// ===========================================================================
// Constants
// ===========================================================================

const SHUTDOWN_TIMEOUT_MS = 5_000; // 5s for graceful shutdown
const INACTIVITY_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const ACTIVITY_CHECK_INTERVAL_MS = 60_000; // Check every minute

// ===========================================================================
// Process Adapter — uses shared processAdapter.ts module
// ===========================================================================

/**
 * Spawn an agent process. Detection is separated from fork so that
 * real fork failures (bad bundle path, permissions) propagate to the caller
 * instead of being silently swallowed by a fallback.
 */
function createAgentProcess(
  bundlePath: string,
  opts: { serviceName: string; env: Record<string, string | undefined> }
): ProcessAdapter {
  if (hasElectronUtilityProcess()) {
    // Electron path — fork errors propagate (not caught)
    const { utilityProcess: up } = require("electron");
    const proc = up.fork(bundlePath, [], {
      serviceName: opts.serviceName,
      stdio: "pipe",
      env: opts.env,
    });
    return proc as unknown as ProcessAdapter;
  }

  // Node.js path
  return createNodeProcessAdapter(bundlePath, opts.env);
}

// ===========================================================================
// Host Transport Implementation
// ===========================================================================

/**
 * Create an RPC transport for a utilityProcess.
 * This bridges the gap between the main process and the agent process.
 */
function createHostTransport(
  proc: ProcessAdapter,
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
  /** Tracks consecutive wake failures per (channel, agentId) to implement exponential backoff. */
  private wakeFailures = new Map<string, { count: number; backoffUntil: number }>();

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
    log.verbose(`[spawn] Starting spawn for agent=${agentId}, channel=${options.channel}, handle=${options.handle}`);

    // 1. Validate agent exists
    const discovery = getAgentDiscovery();
    if (!discovery) {
      log.verbose(`[spawn] Error: AgentDiscovery not initialized`);
      throw new Error("AgentDiscovery not initialized");
    }
    const agent = discovery.get(agentId);
    if (!agent) {
      log.verbose(`[spawn] Error: Agent not found: ${agentId}`);
      throw new Error(`Agent not found: ${agentId}`);
    }
    if (!agent.valid) {
      log.verbose(`[spawn] Error: Agent manifest invalid: ${agent.error}`);
      throw new Error(`Agent manifest invalid: ${agent.error}`);
    }

    log.verbose(`[spawn] Agent manifest valid: ${agent.manifest.name}`);

    // 2. Check for existing instance on this channel
    const existing = this.getInstance(options.channel, agentId);
    if (existing) {
      log.verbose(`Agent ${agentId} already running on ${options.channel}`);
      return existing;
    }

    // 3. Build agent via V2 build service
    log.verbose(`[spawn] Building agent ${agentId}...`);
    let buildResult: AgentBuildResult;
    try {
      buildResult = await this.options.getBuild(`agents/${agentId}`);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      log.verbose(`[spawn] Build failed: ${errorMsg}`);
      throw new AgentSpawnError(errorMsg);
    }

    log.verbose(`[spawn] Build successful: ${buildResult.bundlePath}`);

    // 4. Generate instance ID and token
    const instanceId = randomUUID();
    const token = this.options.createToken(instanceId);

    log.verbose(`[spawn] Forking utilityProcess for ${agentId} (instanceId=${instanceId.slice(0, 8)})`);

    // 5. Fork agent process (Electron utilityProcess or Node.js child_process)
    const proc = createAgentProcess(buildResult.bundlePath, {
      serviceName: `agent-${agentId}-${instanceId.slice(0, 8)}`,
      env: {
        ...process.env,
        NODE_ENV: process.env["NODE_ENV"],
        // Set NODE_PATH to build dir for native addon resolution
        NODE_PATH: path.join(buildResult.dir, "node_modules"),
      },
    });

    // Emit spawning lifecycle event immediately so UI can show pending state
    this.emit("agentLifecycle", {
      channel: options.channel,
      handle: options.handle,
      agentId,
      event: "spawning",
      timestamp: Date.now(),
    } satisfies AgentLifecycleEvent);

    // 6. Set up lifecycle promise and RPC bridge BEFORE creating instance
    // This avoids the deferred assignment code smell
    let readyResolve: () => void;
    let readyReject: (err: Error) => void;
    const readyPromise = new Promise<void>((resolve, reject) => {
      readyResolve = resolve;
      readyReject = reject;
    });

    // Track whether agent is ready (for logging level decisions)
    let agentReady = false;

    const onLifecycleMessage = (msg: LifecycleMessage) => {
      log.verbose(`[spawn] Lifecycle message from ${agentId}: ${msg.type}`);
      if (msg.type === "ready") {
        log.verbose(`[spawn] Agent ${agentId} sent ready signal`);
        agentReady = true;
        readyResolve();
      } else if (msg.type === "error") {
        const errorMsg = (msg["error"] as string) || "Agent initialization error";
        // Log at both verbose and error level so it's visible without verbose mode
        log.verbose(`[spawn] Agent ${agentId} sent error: ${errorMsg}`);
        console.error(`[AgentHost] Agent ${agentId} initialization error: ${errorMsg}`);
        if (msg["stack"]) {
          log.verbose(`[spawn] Stack: ${msg["stack"]}`);
          console.error(`[AgentHost] Stack:\n${msg["stack"]}`);
        }
        readyReject(new Error(errorMsg));
      } else if (msg.type === "log") {
        // Forward structured log messages to pubsub channel
        const level = (msg["level"] as "debug" | "info" | "warn" | "error") || "info";
        const message = (msg["message"] as string) || "";
        const stack = msg["stack"] as string | undefined;
        this.emit("agentLog", {
          channel: options.channel,
          handle: options.handle,
          agentId,
          level,
          message,
          stack,
          timestamp: Date.now(),
        } satisfies AgentLogEvent);
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

    // Capture stdout/stderr for debug events AND terminal logging
    proc.stdout?.on("data", (data: Buffer) => {
      const content = data.toString().trimEnd();
      // Log at info level during startup to help debug issues, verbose after ready
      if (agentReady) {
        log.verbose(`[Agent:${agentId}:stdout] ${content}`);
      } else {
        console.log(`[Agent:${agentId}:stdout] ${content}`);
      }
      this.emit("agentOutput", {
        channel: options.channel,
        handle: options.handle,
        agentId,
        stream: "stdout",
        content,
        timestamp: Date.now(),
      } satisfies AgentOutputEvent);
    });

    proc.stderr?.on("data", (data: Buffer) => {
      const content = data.toString().trimEnd();
      // Log at error level during startup to help debug issues, verbose after ready
      if (agentReady) {
        log.verbose(`[Agent:${agentId}:stderr] ${content}`);
      } else {
        console.error(`[Agent:${agentId}:stderr] ${content}`);
      }
      this.emit("agentOutput", {
        channel: options.channel,
        handle: options.handle,
        agentId,
        stream: "stderr",
        content,
        timestamp: Date.now(),
      } satisfies AgentOutputEvent);
    });

    // Handle process exit - emit lifecycle event only if not already emitted
    // Also reject readyPromise if process exits before sending ready signal
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
      // Reject readyPromise if we haven't received ready yet (process crashed during init)
      readyReject(new Error(`Agent process exited with code ${code} before sending ready signal`));
    });

    // 8. Wait for spawn event before sending init config
    // utilityProcess emits 'spawn' when the process is ready to receive messages
    await new Promise<void>((resolve, reject) => {
      const onSpawn = () => {
        proc.removeListener("spawn", onSpawn);
        proc.removeListener("exit", onExit);
        resolve();
      };
      const onExit = (code: number | null) => {
        proc.removeListener("spawn", onSpawn);
        proc.removeListener("exit", onExit);
        reject(new Error(`Agent process exited with code ${code} before spawning`));
      };
      proc.on("spawn", onSpawn);
      proc.on("exit", onExit);
    });
    log.verbose(`[spawn] Process spawned for ${agentId}`);

    // 9. Send init config
    const initConfig: AgentInitConfig = {
      agentId,
      channel: options.channel,
      handle: options.handle,
      config: options.config,
      pubsubUrl: this.options.pubsubUrl,
      pubsubToken: token,
      contextFolderPath: options.contextFolderPath,
    };

    log.verbose(`[spawn] Sending init config to ${agentId}: channel=${options.channel}, pubsubUrl=${this.options.pubsubUrl}`);
    proc.postMessage({ type: "init", config: initConfig });

    // 10. Await ready
    log.verbose(`[spawn] Waiting for ready signal from ${agentId}...`);
    try {
      await readyPromise;
      log.verbose(`[spawn] Agent ${agentId} ready on channel ${options.channel}`);

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
      const errorMsg = err instanceof Error ? err.message : String(err);
      log.verbose(`[spawn] Failed to start agent ${agentId}: ${errorMsg}`);
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

    const now = Date.now();

    for (const registration of registeredAgents) {
      // Skip if already running - check specific (channel, agentId, handle) to allow multiple handles
      const existing = this.getInstanceByHandle(channel, registration.agentId, registration.handle);
      if (existing) {
        continue;
      }

      // Skip if in backoff period from a previous failed wake attempt
      const backoffKey = `${channel}:${registration.agentId}`;
      const failure = this.wakeFailures.get(backoffKey);
      if (failure && now < failure.backoffUntil) {
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

      // Resolve context folder path at wake time
      if (!spawnConfig.contextId) {
        log.warn(`No contextId in stored config for agent ${registration.agentId} on ${channel}, skipping wake`);
        continue;
      }

      let contextFolderPath: string;
      try {
        contextFolderPath = await this.options.contextFolderManager.ensureContextFolder(spawnConfig.contextId);
      } catch (err) {
        log.error(`Failed to resolve context folder for ${registration.agentId}: ${err}`);
        continue;
      }

      log.verbose(`Waking agent ${registration.agentId} (@${registration.handle}) on channel ${channel}`);

      try {
        // Use authoritative channel/handle from DB record, config from stored JSON
        await this.spawn(registration.agentId, {
          channel: registration.channel,
          handle: registration.handle,
          config: spawnConfig.config,
          contextFolderPath,
        });

        // Success — clear any previous failure tracking
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
