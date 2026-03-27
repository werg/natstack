/**
 * WorkspaceInfo RPC service — server-side workspace metadata.
 *
 * Provides workspace info, config, and catalog operations so clients
 * (Electron, remote) can query workspace state without local filesystem access.
 */

import { z } from "zod";
import type { ServiceDefinition } from "../../shared/serviceDefinition.js";
import type { Workspace, WorkspaceConfig } from "../../shared/workspace/types.js";

export interface WorkspaceInfoServiceDeps {
  workspace: Workspace;
  getConfig: () => WorkspaceConfig;
  setConfigField: (key: string, value: unknown) => void;
}

export function createWorkspaceInfoService(deps: WorkspaceInfoServiceDeps): ServiceDefinition {
  const { workspace } = deps;

  return {
    name: "workspaceInfo",
    description: "Workspace metadata and configuration",
    policy: { allowed: ["shell", "server"] },
    methods: {
      getInfo: { args: z.tuple([]) },
      getConfig: { args: z.tuple([]) },
      setConfigField: { args: z.tuple([z.string(), z.unknown()]) },
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

        default:
          throw new Error(`Unknown workspaceInfo method: ${method}`);
      }
    },
  };
}
