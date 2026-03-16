import { app } from "electron";
import { z } from "zod";
import type { ServiceDefinition } from "../../shared/serviceDefinition.js";
import type { CentralDataManager } from "../centralData.js";
import type { WorkspaceConfig } from "../../shared/workspace/types.js";
import { createAndRegisterWorkspace, deleteWorkspaceDir } from "../workspaceOps.js";

export function createWorkspaceService(deps: {
  centralData: CentralDataManager;
  activeWorkspaceName: string;
  getWorkspaceConfig: () => WorkspaceConfig;
  setWorkspaceConfigField: (key: "rootPanel" | "initPanels", value: unknown) => void;
}): ServiceDefinition {
  return {
    name: "workspace",
    description: "Workspace management (list, create, select, delete, config)",
    policy: { allowed: ["shell", "panel", "worker"] },
    methods: {
      list: { args: z.tuple([]) },
      create: { args: z.tuple([z.string(), z.object({ gitUrl: z.string().optional(), forkFrom: z.string().optional() }).optional()]) },
      select: { args: z.tuple([z.string()]) },
      delete: { args: z.tuple([z.string()]) },
      getActive: { args: z.tuple([]) },
      getActiveEntry: { args: z.tuple([]) },
      getConfig: { args: z.tuple([]) },
      setRootPanel: { args: z.tuple([z.string().nullable()]) },
      setInitPanels: { args: z.tuple([z.array(z.string())]) },
    },
    handler: async (ctx, method, args) => {
      // Only shell callers can delete workspaces
      if (method === "delete" && ctx.callerKind !== "shell") {
        throw new Error("Only the shell UI can delete workspaces");
      }

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

        case "getActiveEntry": {
          const entry = deps.centralData.getWorkspaceEntry(deps.activeWorkspaceName);
          if (!entry) throw new Error(`Active workspace "${deps.activeWorkspaceName}" not found in registry`);
          return entry;
        }

        case "getConfig":
          return deps.getWorkspaceConfig();

        case "setRootPanel": {
          const [rootPanel] = args as [string | null];
          deps.setWorkspaceConfigField("rootPanel", rootPanel ?? undefined);
          return;
        }

        case "setInitPanels": {
          const [initPanels] = args as [string[]];
          deps.setWorkspaceConfigField("initPanels", initPanels);
          return;
        }

        default:
          throw new Error(`Unknown workspace method: ${method}`);
      }
    },
  };
}
