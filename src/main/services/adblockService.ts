import { z } from "zod";
import type { ServiceDefinition } from "../../shared/serviceDefinition.js";
import type { AdBlockManager, AdBlockListConfig } from "../adblock/index.js";

export function createAdblockService(deps: {
  adBlockManager: AdBlockManager;
}): ServiceDefinition {
  return {
    name: "adblock",
    description: "Ad blocking configuration and stats",
    policy: { allowed: ["shell"] },
    methods: {
      getConfig: { args: z.tuple([]) },
      setEnabled: { args: z.tuple([z.boolean()]) },
      setListEnabled: { args: z.tuple([z.string(), z.boolean()]) },
      addCustomList: { args: z.tuple([z.string()]) },
      removeCustomList: { args: z.tuple([z.string()]) },
      addToWhitelist: { args: z.tuple([z.string()]) },
      removeFromWhitelist: { args: z.tuple([z.string()]) },
      getStats: { args: z.tuple([]) },
      resetStats: { args: z.tuple([]) },
      rebuildEngine: { args: z.tuple([]) },
      isActive: { args: z.tuple([]) },
      getStatsForPanel: { args: z.tuple([z.number()]) },
      isEnabledForPanel: { args: z.tuple([z.number()]) },
      setEnabledForPanel: { args: z.tuple([z.number(), z.boolean()]) },
      resetStatsForPanel: { args: z.tuple([z.number()]) },
      getPanelUrl: { args: z.tuple([z.number()]) },
    },
    handler: async (_ctx, method, args) => {
      const manager = deps.adBlockManager;

      switch (method) {
        case "getConfig":
          return manager.getConfig();
        case "setEnabled":
          await manager.setEnabled(args[0] as boolean);
          return true;
        case "setListEnabled":
          await manager.setListEnabled(args[0] as keyof AdBlockListConfig, args[1] as boolean);
          return true;
        case "addCustomList":
          await manager.addCustomList(args[0] as string);
          return true;
        case "removeCustomList":
          await manager.removeCustomList(args[0] as string);
          return true;
        case "addToWhitelist":
          manager.addToWhitelist(args[0] as string);
          return true;
        case "removeFromWhitelist":
          manager.removeFromWhitelist(args[0] as string);
          return true;
        case "getStats":
          return manager.getStats();
        case "resetStats":
          manager.resetStats();
          return true;
        case "rebuildEngine":
          await manager.rebuildEngine();
          return true;
        case "isActive":
          return manager.isActive();
        case "getStatsForPanel":
          return manager.getStatsForPanel(args[0] as number);
        case "isEnabledForPanel":
          return manager.isEnabledForPanel(args[0] as number);
        case "setEnabledForPanel":
          manager.setEnabledForPanel(args[0] as number, args[1] as boolean);
          return true;
        case "resetStatsForPanel":
          manager.resetStatsForPanel(args[0] as number);
          return true;
        case "getPanelUrl":
          return manager.getPanelUrl(args[0] as number);
        default:
          throw new Error(`Unknown adblock method: ${method}`);
      }
    },
  };
}
