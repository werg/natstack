/**
 * Agent Manager — in-process agent lifecycle management.
 *
 * Manages agent instances as ManagedService in ServiceContainer.
 * Handles spawning, killing, activity tracking, inactivity timeout (5 min),
 * and auto-wake on new channel messages.
 *
 * Channel-agent registrations are persisted to MessageStore's channel_agents
 * table so auto-wake survives server restarts.
 */

import type { DatabaseManager } from "../../shared/db/databaseManager.js";
import type { AIHandler } from "../../shared/ai/aiHandler.js";
import type { MessageStore } from "@natstack/pubsub-server";
import { AGENTS, listAgentTypes } from "./registry.js";
import { runAgentService, type RunningAgent, type AgentService } from "./agentAdapter.js";

/** How we resolve contextFolderPath from a channel name */
interface ContextFolderManagerLike {
  ensureContextFolder(contextId: string): Promise<string>;
}

/** Stored information about a running agent instance */
interface AgentInstance {
  instanceId: string;
  agentId: string;
  channel: string;
  handle: string;
  config: Record<string, unknown>;
  runner: RunningAgent;
  lastActivity: number;
}

/** Debounce timer entry for auto-wake */
interface WakeDebounce {
  timer: ReturnType<typeof setTimeout>;
  channel: string;
}

export interface AgentManagerOptions {
  pubsubUrl: string;
  databaseManager: DatabaseManager;
  aiHandler: AIHandler;
  messageStore: MessageStore;
  contextFolderManager: ContextFolderManagerLike;
  createToken: (instanceId: string) => string;
  revokeToken: (instanceId: string) => void;
}

const INACTIVITY_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const INACTIVITY_CHECK_INTERVAL_MS = 60 * 1000; // Check every minute
const AUTO_WAKE_DEBOUNCE_MS = 100;

export class AgentManager {
  private instances = new Map<string, AgentInstance>();
  private opts: AgentManagerOptions;
  private inactivityTimer: ReturnType<typeof setInterval> | null = null;
  private wakeDebounces = new Map<string, WakeDebounce>();
  /** Guards concurrent spawns for the same (agentId, channel, handle) tuple */
  private spawning = new Set<string>();

  constructor(opts: AgentManagerOptions) {
    this.opts = opts;
    this.startInactivityMonitor();
  }

  /**
   * Spawn an agent on a channel.
   */
  async spawn(
    agentId: string,
    channel: string,
    handle: string,
    config: Record<string, unknown> = {},
  ): Promise<string> {
    const entry = AGENTS[agentId];
    if (!entry) {
      throw new Error(`Unknown agent: ${agentId}`);
    }

    // Check if already running on this channel with this handle
    for (const inst of this.instances.values()) {
      if (inst.agentId === agentId && inst.channel === channel && inst.handle === handle) {
        return inst.instanceId; // Already running, return existing
      }
    }

    // Guard against concurrent spawns for the same (agentId, channel, handle)
    const spawnKey = `${agentId}:${channel}:${handle}`;
    if (this.spawning.has(spawnKey)) {
      throw new Error(`Agent ${agentId}:${handle} is already being spawned on ${channel}`);
    }
    this.spawning.add(spawnKey);

    let instanceId: string | undefined;
    try {
      instanceId = `${agentId}:${handle}:${crypto.randomUUID().slice(0, 8)}`;

      // Resolve contextFolderPath from channel's contextId
      const channelInfo = this.opts.messageStore.getChannel(channel);
      const contextId = channelInfo?.contextId ?? config["contextId"] as string;
      if (!contextId) {
        throw new Error(`No contextId for channel ${channel}`);
      }
      const contextFolderPath = await this.opts.contextFolderManager.ensureContextFolder(contextId);

      // Create auth token for PubSub connection
      const pubsubToken = this.opts.createToken(instanceId);

      // Create agent instance (async factory — lazy-loads SDK modules)
      const agent: AgentService = await entry.factory();

      const runner = await runAgentService(agent, {
        agentId,
        channel,
        handle,
        config: { ...config, contextId },
        pubsubUrl: this.opts.pubsubUrl,
        pubsubToken,
        contextFolderPath,
        databaseManager: this.opts.databaseManager,
        aiHandler: this.opts.aiHandler,
        onError: (error) => {
          console.error(`[AgentManager] Event loop crashed for ${instanceId}: ${error.message}`);
          // Clean up the dead instance so it can be auto-woken
          this.instances.delete(instanceId!);
          this.opts.revokeToken(instanceId!);
        },
      });

      this.instances.set(instanceId, {
        instanceId,
        agentId,
        channel,
        handle,
        config: { ...config, contextId },
        runner,
        lastActivity: Date.now(),
      });

      // Persist registration for auto-wake (survives server restarts)
      this.persistRegistration(channel, agentId, handle, { ...config, contextId });

      console.info(`[AgentManager] Spawned ${agentId} on ${channel} as ${instanceId}`);
      return instanceId;
    } catch (err) {
      // Revoke token if it was created but agent failed to start
      if (instanceId) {
        this.opts.revokeToken(instanceId);
      }
      throw err;
    } finally {
      this.spawning.delete(spawnKey);
    }
  }

  /**
   * Kill an agent instance. Channel-scoped: verifies the instance belongs to the channel.
   */
  async kill(instanceId: string, channel?: string): Promise<boolean> {
    const instance = this.instances.get(instanceId);
    if (!instance) return false;

    // Channel-scoped authorization
    if (channel && instance.channel !== channel) {
      throw new Error(`Instance ${instanceId} does not belong to channel ${channel}`);
    }

    await instance.runner.stop();
    this.instances.delete(instanceId);
    this.opts.revokeToken(instanceId);

    // Unregister from auto-wake so killed agents don't respawn
    this.removeRegistration(instance.channel, instance.agentId, instance.handle);

    console.info(`[AgentManager] Killed ${instanceId}`);
    return true;
  }

  /**
   * Kill an agent by channel and handle. Useful when the caller doesn't have the instanceId.
   * Also removes the auto-wake registration.
   */
  async killByHandle(channel: string, handle: string): Promise<boolean> {
    for (const [instanceId, inst] of this.instances) {
      if (inst.channel === channel && inst.handle === handle) {
        return this.kill(instanceId, channel);
      }
    }
    // Agent not running — remove any dormant registrations
    for (const agentId of Object.keys(AGENTS)) {
      this.removeRegistration(channel, agentId, handle);
    }
    return false;
  }

  /**
   * Stop an agent due to inactivity. Preserves auto-wake registration
   * so the agent respawns when the next message arrives.
   */
  private async stopForInactivity(instanceId: string): Promise<void> {
    const instance = this.instances.get(instanceId);
    if (!instance) return;

    await instance.runner.stop();
    this.instances.delete(instanceId);
    this.opts.revokeToken(instanceId);
    // NOTE: Do NOT unregister — agent should auto-wake on next message

    console.info(`[AgentManager] Stopped ${instanceId} (inactivity, auto-wake preserved)`);
  }

  /**
   * Kill all agents on a channel.
   */
  async killByChannel(channel: string): Promise<void> {
    const toKill = [...this.instances.entries()]
      .filter(([, inst]) => inst.channel === channel)
      .map(([id]) => id);

    await Promise.all(toKill.map(id => this.kill(id)));
  }

  /**
   * List all available agent types.
   */
  listAgents() {
    return listAgentTypes();
  }

  /**
   * Get running agent instances for a channel.
   */
  getChannelAgents(channel: string) {
    return [...this.instances.values()]
      .filter(inst => inst.channel === channel)
      .map(inst => ({
        instanceId: inst.instanceId,
        agentId: inst.agentId,
        handle: inst.handle,
        channel: inst.channel,
      }));
  }

  /**
   * Called by PubSub hook on any channel message (persisted or ephemeral).
   * Marks activity and triggers auto-wake for stopped agents.
   */
  onChannelMessage(channel: string, persisted: boolean): void {
    // Mark activity on all running instances for this channel
    for (const inst of this.instances.values()) {
      if (inst.channel === channel) {
        inst.lastActivity = Date.now();
      }
    }

    // Auto-wake: only for persisted messages on channels with registered agents
    if (!persisted) return;

    const registered = this.opts.messageStore.getChannelAgents(channel);
    if (registered.length === 0) return;

    // Check if any registered agents are not running (keyed by agentId:handle
    // to correctly handle multiple instances of the same agent type)
    const runningKeys = new Set(
      [...this.instances.values()]
        .filter(inst => inst.channel === channel)
        .map(inst => `${inst.agentId}:${inst.handle}`)
    );

    const needsWake = registered.some(r => !runningKeys.has(`${r.agentId}:${r.handle}`));
    if (!needsWake) return;

    // Debounce auto-wake
    const existing = this.wakeDebounces.get(channel);
    if (existing) {
      clearTimeout(existing.timer);
    }

    this.wakeDebounces.set(channel, {
      channel,
      timer: setTimeout(() => {
        this.wakeDebounces.delete(channel);
        void this.wakeChannelAgents(channel).catch(err => {
          console.error(`[AgentManager] Auto-wake failed for ${channel}:`, err);
        });
      }, AUTO_WAKE_DEBOUNCE_MS),
    });
  }

  /**
   * Shutdown all agents.
   */
  async shutdown(): Promise<void> {
    if (this.inactivityTimer) {
      clearInterval(this.inactivityTimer);
      this.inactivityTimer = null;
    }

    for (const debounce of this.wakeDebounces.values()) {
      clearTimeout(debounce.timer);
    }
    this.wakeDebounces.clear();

    const stopPromises = [...this.instances.values()].map(inst => inst.runner.stop());
    await Promise.allSettled(stopPromises);
    this.instances.clear();
  }

  // ── Private ──

  private persistRegistration(channel: string, agentId: string, handle: string, config: Record<string, unknown>) {
    try {
      this.opts.messageStore.registerChannelAgent(
        channel, agentId, handle, JSON.stringify(config), "agentManager",
      );
    } catch (err) {
      console.warn(`[AgentManager] Failed to persist agent registration:`, err);
    }
  }

  private removeRegistration(channel: string, agentId: string, handle: string) {
    try {
      this.opts.messageStore.unregisterChannelAgent(channel, agentId, handle);
    } catch (err) {
      console.warn(`[AgentManager] Failed to remove agent registration:`, err);
    }
  }

  private async wakeChannelAgents(channel: string): Promise<void> {
    const registered = this.opts.messageStore.getChannelAgents(channel);
    if (registered.length === 0) return;

    const runningKeys = new Set(
      [...this.instances.values()]
        .filter(inst => inst.channel === channel)
        .map(inst => `${inst.agentId}:${inst.handle}`)
    );

    for (const row of registered) {
      if (runningKeys.has(`${row.agentId}:${row.handle}`)) continue;

      // Skip agents that no longer exist in the registry
      if (!AGENTS[row.agentId]) {
        console.warn(`[AgentManager] Skipping auto-wake for unknown agent ${row.agentId}`);
        continue;
      }

      try {
        let config: Record<string, unknown> = {};
        try { config = JSON.parse(row.config) as Record<string, unknown>; } catch {}
        await this.spawn(row.agentId, channel, row.handle, config);
        console.info(`[AgentManager] Auto-woke ${row.agentId} on ${channel}`);
      } catch (err) {
        console.error(`[AgentManager] Failed to auto-wake ${row.agentId} on ${channel}:`, err);
      }
    }
  }

  private startInactivityMonitor() {
    this.inactivityTimer = setInterval(() => {
      const now = Date.now();
      for (const [instanceId, inst] of this.instances) {
        if (now - inst.lastActivity > INACTIVITY_TIMEOUT_MS) {
          console.info(`[AgentManager] Inactivity timeout: stopping ${instanceId}`);
          void this.stopForInactivity(instanceId).catch(err => {
            console.error(`[AgentManager] Failed to stop inactive ${instanceId}:`, err);
          });
        }
      }
    }, INACTIVITY_CHECK_INTERVAL_MS);
  }
}
