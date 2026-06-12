import type { ServiceDefinition } from "@natstack/shared/serviceDefinition";
import { settingsMethods } from "@natstack/shared/serviceSchemas/settings";
import type { SettingsData, ModelRoleConfig } from "@natstack/shared/types";
import type { ServerClient } from "../serverClient.js";
import { loadCentralConfig } from "@natstack/shared/workspace/loader";
import type { ViewManager } from "../viewManager.js";
import { requireAppCapability } from "./appCapabilities.js";

export function createSettingsService(_deps: {
  serverClient: ServerClient | null;
  getViewManager?: () => ViewManager;
}): ServiceDefinition {
  return {
    name: "settings",
    description: "Settings, model roles",
    policy: { allowed: ["shell", "app"] },
    methods: settingsMethods,
    handler: async (ctx, method, _args) => {
      switch (method) {
        case "getData": {
          if (ctx.caller.runtime.kind === "app") {
            if (!_deps.getViewManager)
              throw new Error("settings.getData app capability unavailable");
            requireAppCapability(ctx, _deps.getViewManager(), "panel-hosting", "settings.getData");
          }
          const centralConfig = loadCentralConfig();

          const modelRoles: ModelRoleConfig = {};
          if (centralConfig.models) {
            for (const [role, value] of Object.entries(centralConfig.models)) {
              if (typeof value === "string") {
                modelRoles[role] = value;
              } else if (
                value &&
                typeof value === "object" &&
                "provider" in value &&
                "model" in value
              ) {
                modelRoles[role] = `${value.provider}:${value.model}`;
              }
            }
          }

          return {
            modelRoles,
          } as SettingsData;
        }

        default:
          throw new Error(`Unknown settings method: ${method}`);
      }
    },
  };
}
