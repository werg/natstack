/**
 * WorkspaceInfo RPC service — server-side workspace metadata.
 *
 * Provides workspace info, config, and catalog operations so clients
 * (Electron, remote) can query workspace state without local filesystem access.
 * The server owns the workspace catalog (CentralDataManager) and filesystem ops.
 */

import { z } from "zod";
import type { ServiceDefinition } from "@natstack/shared/serviceDefinition";
import type { Workspace, WorkspaceConfig } from "@natstack/shared/workspace/types";

export interface CentralDataLike {
  listWorkspaces(): unknown[];
  hasWorkspace(name: string): boolean;
  addWorkspace(name: string): void;
  removeWorkspace(name: string): void;
  touchWorkspace(name: string): void;
  getWorkspaceEntry(name: string): unknown | null;
}

export interface WorkspaceInfoServiceDeps {
  workspace: Workspace;
  getConfig: () => WorkspaceConfig;
  setConfigField: (key: string, value: unknown) => void;
  /** Central workspace catalog. null only in remote-server mode. */
  centralData: CentralDataLike | null;
  /** Create + register a new workspace on disk. */
  createWorkspace: (name: string, opts?: { forkFrom?: string }) => unknown;
  /** Delete a workspace directory from disk. */
  deleteWorkspaceDir: (name: string) => void;
}

export function createWorkspaceInfoService(deps: WorkspaceInfoServiceDeps): ServiceDefinition {
  const { workspace } = deps;

  return {
    name: "workspaceInfo",
    description: "Workspace metadata, configuration, and catalog operations",
    policy: { allowed: ["shell", "server"] },
    methods: {
      getInfo: { args: z.tuple([]) },
      getConfig: { args: z.tuple([]) },
      setConfigField: { args: z.tuple([z.string(), z.unknown()]) },
      listWorkspaces: { args: z.tuple([]) },
      touchWorkspace: { args: z.tuple([z.string()]) },
      createWorkspace: { args: z.tuple([z.string(), z.object({ forkFrom: z.string().optional() }).optional()]) },
      deleteWorkspace: { args: z.tuple([z.string()]) },
      getWorkspaceEntry: { args: z.tuple([z.string()]) },
    },
    handler: async (_ctx, method, args) => {
      switch (method) {
        case "getInfo":
          return {
            path: workspace.path,
            statePath: workspace.statePath,
            contextsPath: workspace.contextsPath,
            config: deps.getConfig(),
          };

        case "getConfig":
          return deps.getConfig();

        case "setConfigField": {
          const [key, value] = args as [string, unknown];
          deps.setConfigField(key, value);
          return;
        }

        case "listWorkspaces":
          if (!deps.centralData) throw new Error("Workspace catalog not available");
          return deps.centralData.listWorkspaces();

        case "touchWorkspace": {
          const [name] = args as [string];
          deps.centralData?.touchWorkspace(name);
          return;
        }

        case "createWorkspace": {
          if (!deps.centralData) throw new Error("Workspace creation not available");
          const [name, opts] = args as [string, { forkFrom?: string } | undefined];
          return deps.createWorkspace(name, opts);
        }

        case "deleteWorkspace": {
          if (!deps.centralData) throw new Error("Workspace deletion not available");
          const [name] = args as [string];
          deps.deleteWorkspaceDir(name);
          deps.centralData.removeWorkspace(name);
          return;
        }

        case "getWorkspaceEntry": {
          if (!deps.centralData) return null;
          const [name] = args as [string];
          return deps.centralData.getWorkspaceEntry(name);
        }

        default:
          throw new Error(`Unknown workspaceInfo method: ${method}`);
      }
    },
  };
}
