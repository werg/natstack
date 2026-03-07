import { z } from "zod";
import type { ServiceDefinition } from "../../shared/serviceDefinition.js";
import type { DatabaseManager } from "../../shared/db/databaseManager.js";

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
      const ownerId = ctx.callerId;
      const dbManager = deps.databaseManager;

      switch (method) {
        case "open": {
          const [dbName, readOnly] = args as [string, boolean?];
          return dbManager.open(ownerId, dbName, readOnly ?? false);
        }
        case "query": {
          const [handle, sql, params] = args as [string, string, unknown[]?];
          return dbManager.query(handle, sql, params);
        }
        case "run": {
          const [handle, sql, params] = args as [string, string, unknown[]?];
          return dbManager.run(handle, sql, params);
        }
        case "get": {
          const [handle, sql, params] = args as [string, string, unknown[]?];
          return dbManager.get(handle, sql, params);
        }
        case "exec": {
          const [handle, sql] = args as [string, string];
          dbManager.exec(handle, sql);
          return;
        }
        case "close": {
          const [handle] = args as [string];
          dbManager.close(handle);
          return;
        }
        default:
          throw new Error(`Unknown db method: ${method}`);
      }
    },
  };
}
