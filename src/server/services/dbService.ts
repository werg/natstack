import { z } from "zod";
import type { ServiceDefinition } from "../../main/serviceDefinition.js";
import type { DatabaseManager } from "../../main/db/databaseManager.js";

export function createDbService(deps: {
  databaseManager: DatabaseManager;
}): ServiceDefinition {
  return {
    name: "db",
    description: "Database operations",
    policy: { allowed: ["shell", "panel", "server"] },
    methods: {
      open: { args: z.tuple([z.string(), z.boolean().optional()]) },
      query: { args: z.tuple([z.string(), z.string(), z.array(z.unknown()).optional()]) },
      run: { args: z.tuple([z.string(), z.string(), z.array(z.unknown()).optional()]) },
      get: { args: z.tuple([z.string(), z.string(), z.array(z.unknown()).optional()]) },
      exec: { args: z.tuple([z.string(), z.string()]) },
      close: { args: z.tuple([z.string()]) },
    },
    handler: async (ctx, method, args) => {
      const { handleDbCall } = await import("../../main/ipc/dbHandlers.js");
      return handleDbCall(deps.databaseManager, ctx.callerId, method, args as unknown[]);
    },
  };
}
