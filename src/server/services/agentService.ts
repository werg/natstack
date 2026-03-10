/**
 * Agents RPC Service — panel-facing API for agent management.
 *
 * Panels call these methods via the existing RPC transport.
 */

import { z } from "zod";
import type { ServiceDefinition } from "../../shared/serviceDefinition.js";
import type { AgentManager } from "../agents/agentManager.js";

export function createAgentService(deps: {
  agentManager: AgentManager;
}): ServiceDefinition {
  return {
    name: "agents",
    description: "Agent lifecycle management (spawn, kill, list)",
    policy: { allowed: ["panel", "shell"] },
    methods: {
      list: {
        description: "List available agent types",
        args: z.tuple([]),
      },
      spawn: {
        description: "Spawn an agent on a channel",
        args: z.tuple([
          z.string(), // agentId
          z.string(), // channel
          z.string(), // handle
          z.record(z.unknown()).optional(), // config
        ]),
      },
      kill: {
        description: "Kill a running agent instance",
        args: z.tuple([
          z.string(), // instanceId
          z.string(), // channel (for authorization)
        ]),
      },
      killByHandle: {
        description: "Kill a running agent by channel and handle",
        args: z.tuple([
          z.string(), // channel
          z.string(), // handle
        ]),
      },
      channelAgents: {
        description: "Get running agents on a channel",
        args: z.tuple([z.string()]), // channel
      },
    },
    handler: async (_ctx, method, args) => {
      const mgr = deps.agentManager;
      switch (method) {
        case "list":
          return mgr.listAgents();
        case "spawn":
          return mgr.spawn(
            args[0] as string,
            args[1] as string,
            args[2] as string,
            (args[3] as Record<string, unknown>) ?? {},
          );
        case "kill":
          return mgr.kill(args[0] as string, args[1] as string);
        case "killByHandle":
          return mgr.killByHandle(args[0] as string, args[1] as string);
        case "channelAgents":
          return mgr.getChannelAgents(args[0] as string);
        default:
          throw new Error(`Unknown agents method: ${method}`);
      }
    },
  };
}
