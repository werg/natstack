/**
 * Agent Registry — factory registry for agent services.
 *
 * Simple map of agent factories with manifest metadata.
 * Agent configuration is code-level.
 */

import type { AgentManifest } from "@natstack/types";
import type { AgentService } from "./agentAdapter.js";

export interface AgentRegistryEntry {
  /** Async factory — uses dynamic import() to avoid loading SDKs at startup. */
  factory: () => Promise<AgentService>;
  /** Manifest metadata returned by agents.list RPC */
  manifest: AgentManifest;
}

/**
 * The agent registry. Each key is the agent ID used for spawn requests.
 */
export const AGENTS: Record<string, AgentRegistryEntry> = {
  "pubsub-chat-responder": {
    factory: async () => new (await import("./pubsubChatResponder.js")).PubsubChatResponder(),
    manifest: {
      id: "pubsub-chat-responder",
      name: "AI Chat Responder",
      version: "1.0.0",
      channels: ["chat:*"],
      proposedHandle: "ai",
    },
  },
  "claude-code-responder": {
    factory: async () => new (await import("./claudeCodeResponder.js")).ClaudeCodeResponder(),
    manifest: {
      id: "claude-code-responder",
      name: "Claude Code",
      version: "1.0.0",
      channels: ["chat:*"],
      proposedHandle: "cc",
    },
  },
  "pi-responder": {
    factory: async () => new (await import("./piResponder.js")).PiResponder(),
    manifest: {
      id: "pi-responder",
      name: "Pi Responder",
      version: "1.0.0",
      channels: ["chat:*"],
      proposedHandle: "pi",
    },
  },
};

/**
 * List all available agent types as AgentManifest objects.
 */
export function listAgentTypes(): AgentManifest[] {
  return Object.values(AGENTS).map(entry => entry.manifest);
}
