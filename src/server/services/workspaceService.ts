/**
 * Workspace RPC service — server-side workspace catalog and configuration.
 *
 * Single source of truth for all workspace operations: listing, reading config,
 * creating, deleting, switching, init-panel management. Lives on the server
 * because the server owns the workspace catalog (CentralDataManager) and the
 * filesystem ops; panels and workers reach it directly via WebSocket without
 * going through Electron.
 *
 * Method names match the runtime's `WorkspaceClient` interface (see
 * `workspace/packages/runtime/src/shared/workspace.ts`) so eval'd code can
 * `import { workspace } from "@workspace/runtime"` and call `workspace.list()`,
 * `workspace.create("name")`, etc. without an intermediate proxy.
 *
 * The `select` (workspace switch) method needs Electron's `app.relaunch()`,
 * which lives in the Electron main process. The server signals the relaunch
 * by calling `requestRelaunch(name)` from this service's deps; in IPC mode
 * that callback posts a parent-port message that ServerProcessManager
 * forwards to its `onRelaunch` handler. In standalone (no Electron) mode the
 * callback is a no-op and the caller is expected to reconnect manually.
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

export interface WorkspaceServiceDeps {
  workspace: Workspace;
  getConfig: () => WorkspaceConfig;
  setConfigField: (key: string, value: unknown) => void;
  /** Central workspace catalog. null only in remote-server mode. */
  centralData: CentralDataLike | null;
  /** Create + register a new workspace on disk. */
  createWorkspace: (name: string, opts?: { forkFrom?: string }) => unknown;
  /** Delete a workspace directory from disk. */
  deleteWorkspaceDir: (name: string) => void;
  /**
   * Signal the host (Electron main) to relaunch into a different workspace.
   * In IPC mode this posts a parent-port message; in standalone mode it's
   * a no-op (the caller is expected to reconnect manually).
   */
  requestRelaunch?: (name: string) => void;
}

export function createWorkspaceService(deps: WorkspaceServiceDeps): ServiceDefinition {
  const { workspace } = deps;

  // Catalog-dependent methods are conditionally registered based on whether
  // we have a workspace catalog (`centralData`) at all. In remote-server /
  // mobile-client mode there's no catalog here, so creation/deletion can't
  // be fulfilled — and advertising them only to fail with "Workspace creation
  // not available" AFTER schema validation is confusing for callers (they
  // see two completely different errors depending on whether their args
  // happen to be schema-valid). Omit the methods entirely instead: callers
  // get a single, consistent "Unknown workspace method: create" that makes
  // it obvious the API isn't available in this mode.
  const catalogMethods: ServiceDefinition["methods"] = deps.centralData ? {
    create: { args: z.tuple([z.string(), z.object({ forkFrom: z.string().optional() }).optional()]) },
    delete: { args: z.tuple([z.string()]) },
  } : {};

  return {
    name: "workspace",
    description: "Workspace catalog, configuration, and lifecycle (list, create, switch, etc.)",
    policy: { allowed: ["shell", "panel", "worker", "server"] },
    methods: {
      // Read methods
      getInfo: { args: z.tuple([]) },
      list: { args: z.tuple([]) },
      getActive: { args: z.tuple([]) },
      getActiveEntry: { args: z.tuple([]) },
      getConfig: { args: z.tuple([]) },
      // Catalog-dependent write methods (conditionally registered above).
      ...catalogMethods,
      // Always-available write methods.
      select: { args: z.tuple([z.string()]) },
      setInitPanels: { args: z.tuple([z.array(z.object({
        source: z.string(),
        stateArgs: z.record(z.unknown()).optional(),
      }))]) },
      // Internal — used by other server services for low-level config writes.
      // Not part of the runtime client surface.
      setConfigField: { args: z.tuple([z.string(), z.unknown()]) },
    },
    handler: async (ctx, method, args) => {
      switch (method) {
        // -----------------------------------------------------------------
        // Reads
        // -----------------------------------------------------------------

        case "getInfo":
          return {
            path: workspace.path,
            statePath: workspace.statePath,
            contextsPath: workspace.contextsPath,
            config: deps.getConfig(),
          };

        case "list":
          if (!deps.centralData) return [];
          return deps.centralData.listWorkspaces();

        case "getActive":
          return deps.getConfig().id;

        case "getActiveEntry":
          if (!deps.centralData) return null;
          return deps.centralData.getWorkspaceEntry(deps.getConfig().id);

        case "getConfig":
          return deps.getConfig();

        // -----------------------------------------------------------------
        // Writes
        // -----------------------------------------------------------------

        case "create": {
          if (!deps.centralData) throw new Error("Workspace creation not available");
          const [name, opts] = args as [string, { forkFrom?: string } | undefined];
          return deps.createWorkspace(name, opts);
        }

        case "delete": {
          // Deletion is disruptive — only the shell UI should drive it.
          if (ctx.callerKind !== "shell") {
            throw new Error("Only the shell UI can delete workspaces");
          }
          if (!deps.centralData) throw new Error("Workspace deletion not available");
          const [name] = args as [string];
          if (name === deps.getConfig().id) {
            throw new Error("Cannot delete the currently running workspace");
          }
          deps.deleteWorkspaceDir(name);
          deps.centralData.removeWorkspace(name);
          return;
        }

        case "select": {
          const [name] = args as [string];
          // Touch the catalog so the workspace is marked as recently opened.
          deps.centralData?.touchWorkspace(name);
          // Signal the host to relaunch with the new workspace. In IPC mode
          // this posts a parent-port message that ServerProcessManager forwards
          // to Electron main, which calls app.relaunch(). In standalone mode
          // requestRelaunch is undefined and the caller must reconnect manually.
          deps.requestRelaunch?.(name);
          return;
        }

        case "setInitPanels": {
          const [initPanels] = args as [Array<{ source: string; stateArgs?: Record<string, unknown> }>];
          deps.setConfigField("initPanels", initPanels);
          return;
        }

        case "setConfigField": {
          const [key, value] = args as [string, unknown];
          deps.setConfigField(key, value);
          return;
        }

        default:
          throw new Error(`Unknown workspace method: ${method}`);
      }
    },
  };
}
