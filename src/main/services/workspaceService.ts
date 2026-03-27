import { z } from "zod";
import type { ServiceDefinition } from "../../shared/serviceDefinition.js";
import type { CentralDataManager } from "../../shared/centralData.js";
import type { WorkspaceConfig } from "../../shared/workspace/types.js";
import { createAndRegisterWorkspace, deleteWorkspaceDir } from "../../shared/workspace/loader.js";

export function createWorkspaceService(deps: {
  centralData: CentralDataManager | null;
  activeWorkspaceName: string;
  getWorkspaceConfig: () => Promise<WorkspaceConfig> | WorkspaceConfig;
  setWorkspaceConfigField: (key: string, value: unknown) => void;
  /** Restart the app with a different workspace. Injected so headless can provide its own. */
  restartWithWorkspace: (name: string) => void;
}): ServiceDefinition {
  return {
    name: "workspace",
    description: "Workspace management (list, create, select, delete, config)",
    policy: { allowed: ["shell", "panel", "worker"] },
    methods: {
      list: { args: z.tuple([]) },
      create: { args: z.tuple([z.string(), z.object({ forkFrom: z.string().optional() }).optional()]) },
      select: { args: z.tuple([z.string()]) },
      delete: { args: z.tuple([z.string()]) },
      getActive: { args: z.tuple([]) },
      getActiveEntry: { args: z.tuple([]) },
      getConfig: { args: z.tuple([]) },
      setInitPanels: { args: z.tuple([z.array(z.object({
        source: z.string(),
        stateArgs: z.record(z.unknown()).optional(),
      }))]) },
    },
    handler: async (ctx, method, args) => {
      // Only shell callers can delete workspaces
      if (method === "delete" && ctx.callerKind !== "shell") {
        throw new Error("Only the shell UI can delete workspaces");
      }

      switch (method) {
        case "list":
          if (!deps.centralData) throw new Error("Workspace catalog not available in remote mode");
          return deps.centralData.listWorkspaces();

        case "create": {
          if (!deps.centralData) throw new Error("Workspace creation not available in remote mode");
          const [name, opts] = args as [string, { forkFrom?: string } | undefined];
          return createAndRegisterWorkspace(name, deps.centralData, opts);
        }

        case "select": {
          const name = args[0] as string;
          deps.centralData?.touchWorkspace(name);
          deps.restartWithWorkspace(name);
          return;
        }

        case "delete": {
          if (!deps.centralData) throw new Error("Workspace deletion not available in remote mode");
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
          if (!deps.centralData) return { name: deps.activeWorkspaceName };
          const entry = deps.centralData.getWorkspaceEntry(deps.activeWorkspaceName);
          if (!entry) throw new Error(`Active workspace "${deps.activeWorkspaceName}" not found in registry`);
          return entry;
        }

        case "getConfig":
          return await deps.getWorkspaceConfig();

        case "setInitPanels": {
          const [initPanels] = args as [Array<{ source: string; stateArgs?: Record<string, unknown> }>];
          deps.setWorkspaceConfigField("initPanels", initPanels);
          return;
        }

        default:
          throw new Error(`Unknown workspace method: ${method}`);
      }
    },
  };
}
