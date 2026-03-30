import { z } from "zod";
import type { ServiceDefinition } from "@natstack/shared/serviceDefinition";
import type { WorkspaceConfig } from "@natstack/shared/workspace/types";

/**
 * Electron-side workspace service.
 *
 * Pure RPC adapter — all catalog/filesystem operations delegate to the server's
 * workspaceInfo service. The only Electron-local concern is `select` which calls
 * app.relaunch() after telling the server to touch the workspace.
 */
export function createWorkspaceService(deps: {
  activeWorkspaceName: string;
  getWorkspaceConfig: () => Promise<WorkspaceConfig> | WorkspaceConfig;
  setWorkspaceConfigField: (key: string, value: unknown) => void;
  /** Restart the app with a different workspace. Inherently Electron-local (app.relaunch). */
  restartWithWorkspace: (name: string) => void;
  /** Server RPC client */
  serverClient: { call(service: string, method: string, args: unknown[]): Promise<unknown> };
}): ServiceDefinition {
  const sc = deps.serverClient;

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
      if (method === "delete" && ctx.callerKind !== "shell") {
        throw new Error("Only the shell UI can delete workspaces");
      }

      switch (method) {
        case "list":
          return sc.call("workspaceInfo", "listWorkspaces", []);

        case "create": {
          const [name, opts] = args as [string, { forkFrom?: string } | undefined];
          return sc.call("workspaceInfo", "createWorkspace", [name, opts]);
        }

        case "select": {
          const name = args[0] as string;
          // Server-side: touch workspace in catalog
          void sc.call("workspaceInfo", "touchWorkspace", [name]).catch(() => {});
          // Client-side: Electron relaunch (inherently local)
          deps.restartWithWorkspace(name);
          return;
        }

        case "delete": {
          const name = args[0] as string;
          if (name === deps.activeWorkspaceName) {
            throw new Error("Cannot delete the currently running workspace");
          }
          return sc.call("workspaceInfo", "deleteWorkspace", [name]);
        }

        case "getActive":
          return deps.activeWorkspaceName;

        case "getActiveEntry":
          return sc.call("workspaceInfo", "getWorkspaceEntry", [deps.activeWorkspaceName]);

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
