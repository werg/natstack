import { z } from "zod";
import type { ServiceDefinition } from "../../main/serviceDefinition.js";
import type { GlobalAgentSettings, AgentSettings } from "@natstack/types";

export function createAgentSettingsService(): ServiceDefinition {
  return {
    name: "agentSettings",
    description: "Agent preferences and configuration",
    policy: { allowed: ["shell", "panel", "server"] },
    methods: {
      getGlobalSettings: { args: z.tuple([]) },
      setGlobalSetting: { args: z.tuple([z.string(), z.unknown()]) },
      getAgentSettings: { args: z.tuple([z.string()]) },
      getAllAgentSettings: { args: z.tuple([]) },
      setAgentSettings: { args: z.tuple([z.string(), z.record(z.unknown())]) },
      listAgents: { args: z.tuple([]) },
    },
    handler: async (_ctx, method, args) => {
      const { handleAgentSettingsCall } = await import("../../main/ipc/agentSettingsHandlers.js");
      return handleAgentSettingsCall(method, args as unknown[]);
    },
  };
}
