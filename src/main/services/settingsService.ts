import { z } from "zod";
import type { ServiceDefinition } from "@natstack/shared/serviceDefinition";
import type {
  SettingsData,
  ModelRoleConfig,
} from "@natstack/shared/types";
import type { ServerClient } from "../serverClient.js";
import { loadCentralConfig } from "@natstack/shared/workspace/loader";

export function createSettingsService(_deps: {
  serverClient: ServerClient | null;
}): ServiceDefinition {
  return {
    name: "settings",
    description: "Settings, model roles",
    policy: { allowed: ["shell"] },
    methods: {
      getData: { args: z.tuple([]) },
    },
    handler: async (_ctx, method, _args) => {
      switch (method) {
        case "getData": {
          const centralConfig = loadCentralConfig();

          const modelRoles: ModelRoleConfig = {};
          if (centralConfig.models) {
            for (const [role, value] of Object.entries(centralConfig.models)) {
              if (typeof value === "string") {
                modelRoles[role] = value;
              } else if (value && typeof value === "object" && "provider" in value && "model" in value) {
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
