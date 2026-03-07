import { z } from "zod";
import type { ServiceDefinition } from "../../shared/serviceDefinition.js";
import type { GlobalAgentSettings, AgentSettings } from "@natstack/types";
import type { AgentSettingsService } from "../../main/agentSettings.js";
import type { AgentDiscovery } from "../../main/agentDiscovery.js";

export function createAgentSettingsService(deps: {
  agentSettingsService: AgentSettingsService;
  agentDiscovery: AgentDiscovery | null;
}): ServiceDefinition {
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
      if (method === "listAgents") {
        const discovery = deps.agentDiscovery;
        if (!discovery) return [];
        return discovery.listValid().map((agent) => agent.manifest);
      }

      const service = deps.agentSettingsService;

      switch (method) {
        case "getGlobalSettings":
          return service.getGlobalSettings();

        case "setGlobalSetting": {
          const [key, value] = args as [keyof GlobalAgentSettings, GlobalAgentSettings[keyof GlobalAgentSettings]];
          if (!key) throw new Error("Missing key argument");
          service.setGlobalSetting(key, value);
          return;
        }

        case "getAgentSettings": {
          const [agentId] = args as [string];
          if (!agentId) throw new Error("Missing agentId argument");
          return service.getAgentSettings(agentId);
        }

        case "getAllAgentSettings":
          return service.getAllAgentSettings();

        case "setAgentSettings": {
          const [agentId, settings] = args as [string, AgentSettings];
          if (!agentId) throw new Error("Missing agentId argument");
          if (!settings || typeof settings !== "object") throw new Error("Invalid settings argument");
          service.setAgentSettings(agentId, settings);
          return;
        }

        default:
          throw new Error(`Unknown agentSettings method: ${method}`);
      }
    },
  };
}
