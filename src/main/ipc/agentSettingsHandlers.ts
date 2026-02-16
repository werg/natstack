/**
 * RPC handlers for AgentSettingsService.
 *
 * Provides the agentSettings.* RPC namespace for panels to access
 * centralized agent preferences.
 */

import type { GlobalAgentSettings, AgentSettings } from "@natstack/types";
import { getAgentSettingsService } from "../agentSettings.js";
import { RESPONDER_REGISTRY } from "../responders/index.js";

/**
 * Handle agentSettings service calls.
 *
 * @param method - The method name (e.g., "getGlobalSettings", "setAgentSettings")
 * @param args - The method arguments
 * @returns The result of the method call
 */
export async function handleAgentSettingsCall(
  method: string,
  args: unknown[]
): Promise<unknown> {
  const service = getAgentSettingsService();
  if (!service) {
    throw new Error("AgentSettingsService not initialized");
  }

  switch (method) {
    case "getGlobalSettings": {
      return service.getGlobalSettings();
    }

    case "setGlobalSetting": {
      const [key, value] = args as [keyof GlobalAgentSettings, GlobalAgentSettings[keyof GlobalAgentSettings]];
      if (!key) {
        throw new Error("Missing key argument");
      }
      service.setGlobalSetting(key, value);
      return;
    }

    case "getAgentSettings": {
      const [agentId] = args as [string];
      if (!agentId) {
        throw new Error("Missing agentId argument");
      }
      return service.getAgentSettings(agentId);
    }

    case "getAllAgentSettings": {
      return service.getAllAgentSettings();
    }

    case "setAgentSettings": {
      const [agentId, settings] = args as [string, AgentSettings];
      if (!agentId) {
        throw new Error("Missing agentId argument");
      }
      if (!settings || typeof settings !== "object") {
        throw new Error("Invalid settings argument");
      }
      service.setAgentSettings(agentId, settings);
      return;
    }

    case "listAgents": {
      return [...RESPONDER_REGISTRY.values()].map((r) => r.manifest);
    }

    default:
      throw new Error(`Unknown agentSettings method: ${method}`);
  }
}
