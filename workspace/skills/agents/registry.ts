/**
 * AgentRegistry — High-level API for spawning and managing personality agents.
 *
 * Wraps subscribeHeadlessAgent() from @workspace/agentic-session to spawn
 * PersonalityAgentWorker DOs from agent.yml manifests.
 */

import { subscribeHeadlessAgent } from "@workspace/agentic-session";
import { rpc, contextId, workers } from "@workspace/runtime";
import { discoverManifests, manifestToSubscriptionConfig } from "./manifest.js";
import type { AgentManifest, AgentInstance } from "./types.js";

export class AgentRegistry {
  private manifests = new Map<string, AgentManifest>();
  private instances = new Map<string, AgentInstance>();

  /** Discover and load all manifests from workspace/agents/. */
  async discover(): Promise<Map<string, AgentManifest>> {
    this.manifests = await discoverManifests();
    return this.manifests;
  }

  /** List discovered but not-yet-spawned agent manifests. */
  available(): AgentManifest[] {
    return [...this.manifests.values()];
  }

  /** List spawned agent instances. */
  list(): AgentInstance[] {
    return [...this.instances.values()];
  }

  /**
   * Spawn a personality agent DO and subscribe it to a channel.
   * The agent's personality, model, tools, etc. come from its manifest.
   */
  async spawn(handle: string, channelId: string): Promise<AgentInstance> {
    const manifest = this.manifests.get(handle);
    if (!manifest) {
      throw new Error(
        `Unknown agent "${handle}". Available: ${[...this.manifests.keys()].join(", ") || "(none — did you call discover()?)"}`,
      );
    }

    const objectKey = `personality-${handle}-${crypto.randomUUID().slice(0, 8)}`;
    const config = manifestToSubscriptionConfig(manifest);

    await subscribeHeadlessAgent({
      rpcCall: (target: string, method: string, ...args: unknown[]) =>
        rpc.call(target, method, ...args),
      source: "workers/personality-agent",
      className: "PersonalityAgentWorker",
      objectKey,
      channelId,
      contextId,
      systemPrompt: manifest.personality,
      hasEval: manifest.tools?.includes("eval") ?? false,
      extraConfig: config,
    });

    const instance: AgentInstance = {
      handle,
      name: manifest.name,
      objectKey,
      source: "workers/personality-agent",
      className: "PersonalityAgentWorker",
      channels: [channelId],
      manifest,
    };
    this.instances.set(handle, instance);
    return instance;
  }

  /** Subscribe an existing spawned agent to an additional channel. */
  async subscribe(handle: string, channelId: string): Promise<void> {
    const instance = this.instances.get(handle);
    if (!instance) {
      throw new Error(`Agent "${handle}" has not been spawned yet. Call spawn() first.`);
    }

    const config = manifestToSubscriptionConfig(instance.manifest);

    await rpc.call(
      "main",
      "workers.callDO",
      instance.source,
      instance.className,
      instance.objectKey,
      "subscribeChannel",
      { channelId, contextId, config, replay: true },
    );

    instance.channels.push(channelId);
  }

  /** Remove a spawned agent — unsubscribe from all channels and destroy the DO. */
  async remove(handle: string): Promise<void> {
    const instance = this.instances.get(handle);
    if (!instance) return;

    // Unsubscribe from all channels
    for (const channelId of instance.channels) {
      try {
        await rpc.call(
          "main",
          "workers.callDO",
          instance.source,
          instance.className,
          instance.objectKey,
          "unsubscribeChannel",
          channelId,
        );
      } catch (err) {
        console.warn(`[AgentRegistry] Failed to unsubscribe ${handle} from ${channelId}:`, err);
      }
    }

    // Destroy the DO
    try {
      await workers.destroyDO({
        source: instance.source,
        className: instance.className,
        objectKey: instance.objectKey,
      });
    } catch (err) {
      console.warn(`[AgentRegistry] Failed to destroy DO for ${handle}:`, err);
    }

    this.instances.delete(handle);
  }
}
