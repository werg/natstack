import { app } from "electron";
import { z } from "zod";
import type { ServiceDefinition } from "../../shared/serviceDefinition.js";
import type { CentralDataManager } from "../centralData.js";
import { createAndRegisterWorkspace, deleteWorkspaceDir } from "../workspaceOps.js";

export function createWorkspaceService(deps: {
  centralData: CentralDataManager;
  activeWorkspaceName: string;
}): ServiceDefinition {
  return {
    name: "workspace",
    description: "Workspace management (list, create, select, delete)",
    policy: { allowed: ["shell"] },
    methods: {
      list: { args: z.tuple([]) },
      create: { args: z.tuple([z.string(), z.object({ gitUrl: z.string().optional(), forkFrom: z.string().optional() }).optional()]) },
      select: { args: z.tuple([z.string()]) },
      delete: { args: z.tuple([z.string()]) },
      getActive: { args: z.tuple([]) },
    },
    handler: async (_ctx, method, args) => {
      switch (method) {
        case "list":
          return deps.centralData.listWorkspaces();

        case "create": {
          const [name, opts] = args as [string, { gitUrl?: string; forkFrom?: string } | undefined];
          return createAndRegisterWorkspace(name, deps.centralData, opts);
        }

        case "select": {
          const name = args[0] as string;
          deps.centralData.touchWorkspace(name);
          // Strip existing --workspace=... or --workspace <value> args, then add the new one
          const filteredArgs: string[] = [];
          const rawArgs = process.argv.slice(1);
          for (let i = 0; i < rawArgs.length; i++) {
            const a = rawArgs[i]!;
            if (a.startsWith("--workspace=")) continue;
            if (a === "--workspace" && i + 1 < rawArgs.length && !rawArgs[i + 1]!.startsWith("--")) {
              i++; // skip the value too
              continue;
            }
            filteredArgs.push(a);
          }
          filteredArgs.push(`--workspace=${name}`);
          app.relaunch({ args: filteredArgs });
          app.exit(0);
          return;
        }

        case "delete": {
          const name = args[0] as string;
          if (name === deps.activeWorkspaceName) {
            throw new Error("Cannot delete the currently running workspace");
          }
          deleteWorkspaceDir(name);
          deps.centralData.removeWorkspace(name);
          return;
        }

        case "getActive":
          return deps.activeWorkspaceName;

        default:
          throw new Error(`Unknown workspace method: ${method}`);
      }
    },
  };
}
