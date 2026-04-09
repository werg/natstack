/**
 * Settings Service (Standalone Mode) — model role config for headless/remote
 * shell clients.
 *
 * Mirror of the Electron settingsService (src/main/services/settingsService.ts).
 */

import { z } from "zod";
import type { ServiceDefinition } from "@natstack/shared/serviceDefinition";
import type {
  SettingsData,
  ModelRoleConfig,
} from "@natstack/shared/types";
import type { ServiceDispatcher } from "@natstack/shared/serviceDispatcher";
import { loadCentralConfig } from "@natstack/shared/workspace/loader";

export function createSettingsServiceStandalone(_deps: {
  dispatcher: ServiceDispatcher;
}): ServiceDefinition {
  return {
    name: "settings",
    description: "Settings, model roles (standalone mode)",
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
                modelRoles[role] = `${(value as { provider: string }).provider}:${(value as { model: string }).model}`;
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
