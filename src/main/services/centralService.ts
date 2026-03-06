import * as path from "path";
import { z } from "zod";
import type { ServiceDefinition } from "../serviceDefinition.js";
import { getCentralData } from "../centralData.js";

export function createCentralService(): ServiceDefinition {
  return {
    name: "central",
    description: "Central data store (recent workspaces)",
    policy: { allowed: ["shell"] },
    methods: {
      getRecentWorkspaces: { args: z.tuple([]) },
      addRecentWorkspace: { args: z.tuple([z.string()]) },
      removeRecentWorkspace: { args: z.tuple([z.string()]) },
    },
    handler: async (_ctx, method, args) => {
      const centralData = getCentralData();

      switch (method) {
        case "getRecentWorkspaces":
          return centralData.getRecentWorkspaces();

        case "addRecentWorkspace": {
          const workspacePath = args[0] as string;
          centralData.addRecentWorkspace(workspacePath, path.basename(workspacePath));
          return;
        }

        case "removeRecentWorkspace": {
          const workspacePath = args[0] as string;
          centralData.removeRecentWorkspace(workspacePath);
          return;
        }

        default:
          throw new Error(`Unknown central method: ${method}`);
      }
    },
  };
}
