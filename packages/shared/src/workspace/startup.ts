import { randomBytes } from "crypto";
import { resolveOrCreateWorkspace, type ResolvedWorkspace } from "./loader.js";
import type { CentralDataManager } from "../centralData.js";

export interface ResolveLocalWorkspaceStartupOpts {
  appRoot: string;
  centralData?: CentralDataManager | null;
  wsDir?: string;
  name?: string;
  init?: boolean;
  isDev?: boolean;
  requireExplicitSelection?: boolean;
}

export interface LocalWorkspaceStartup {
  resolved: ResolvedWorkspace;
  isEphemeral: boolean;
}

/**
 * Shared local-workspace startup resolution for desktop and standalone server.
 *
 * Resolution order:
 * 1. Explicit workspace directory
 * 2. Explicit workspace name
 * 3. Ephemeral dev workspace when `isDev`
 * 4. Last-opened workspace from central data
 * 5. Default workspace
 *
 * IPC/server callers can set `requireExplicitSelection` to reject implicit
 * selection when they do not own central workspace state.
 */
export function resolveLocalWorkspaceStartup(
  opts: ResolveLocalWorkspaceStartupOpts,
): LocalWorkspaceStartup {
  const centralData = opts.centralData ?? null;

  if (opts.wsDir) {
    const resolved = resolveOrCreateWorkspace({
      wsDir: opts.wsDir,
      appRoot: opts.appRoot,
      init: opts.init,
    });
    centralData?.addWorkspace(resolved.name);
    return {
      resolved,
      isEphemeral: false,
    };
  }

  if (opts.name) {
    const resolved = resolveOrCreateWorkspace({
      name: opts.name,
      appRoot: opts.appRoot,
      init: opts.init,
    });
    centralData?.addWorkspace(resolved.name);
    return { resolved, isEphemeral: false };
  }

  if (opts.isDev) {
    const devName = `dev-${randomBytes(4).toString("hex")}`;
    const resolved = resolveOrCreateWorkspace({
      name: devName,
      appRoot: opts.appRoot,
      init: true,
    });
    centralData?.addWorkspace(resolved.name);
    return { resolved, isEphemeral: true };
  }

  if (centralData) {
    const last = centralData.getLastOpenedWorkspace();
    if (last) {
      const resolved = resolveOrCreateWorkspace({
        name: last.name,
        appRoot: opts.appRoot,
      });
      centralData.touchWorkspace(last.name);
      return { resolved, isEphemeral: false };
    }

    const resolved = resolveOrCreateWorkspace({
      name: "default",
      appRoot: opts.appRoot,
      init: true,
    });
    centralData.addWorkspace("default");
    return { resolved, isEphemeral: false };
  }

  if (opts.requireExplicitSelection) {
    throw new Error("No workspace specified (set NATSTACK_WORKSPACE_DIR or pass --workspace)");
  }

  return {
    resolved: resolveOrCreateWorkspace({
      name: "default",
      appRoot: opts.appRoot,
      init: true,
    }),
    isEphemeral: false,
  };
}
