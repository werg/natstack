/**
 * StartupMode — discriminated union for local vs remote startup.
 *
 * TypeScript enforces you can't access `wsDir` in remote mode.
 * Includes `resolveStartupMode()` with proper URL validation.
 */

import * as path from "path";
import * as fs from "fs";
import { createDevLogger } from "@natstack/dev-log";
import { isDev } from "./utils.js";
import { getAppRoot, getCentralConfigDirectory } from "./paths.js";
import {
  resolveWorkspaceName,
  loadCentralConfig,
} from "@natstack/shared/workspace/loader";
import { resolveLocalWorkspaceStartup } from "@natstack/shared/workspace/startup";
import type { CentralDataManager } from "@natstack/shared/centralData";

const log = createDevLogger("StartupMode");

export type StartupMode =
  | { kind: "local"; wsDir: string; workspaceId: string; isEphemeral: boolean }
  | { kind: "remote"; remoteUrl: URL; adminToken: string };

/**
 * Parse remote startup mode from env vars, falling back to config.yml.
 * Returns null if not in remote mode.
 *
 * Priority: environment variables > config.yml > nothing
 */
export function parseRemoteStartupMode(): { remoteUrl: URL; adminToken: string } | null {
  const centralConfig = loadCentralConfig();
  const rawUrl = process.env["NATSTACK_REMOTE_URL"] ?? centralConfig.remote?.url;
  const adminToken = process.env["NATSTACK_REMOTE_TOKEN"] ?? centralConfig.remote?.token;

  if (!rawUrl || !adminToken) return null;

  let remoteUrl: URL;
  try {
    remoteUrl = new URL(rawUrl);
  } catch {
    throw new Error(`Invalid NATSTACK_REMOTE_URL: "${rawUrl}" is not a valid URL`);
  }

  if (remoteUrl.protocol !== "http:" && remoteUrl.protocol !== "https:") {
    throw new Error(`Invalid NATSTACK_REMOTE_URL: protocol must be http or https, got "${remoteUrl.protocol}"`);
  }

  return { remoteUrl, adminToken };
}

/**
 * Get the user data directory for remote mode.
 * Electron internals go here, NOT on the server's statePath.
 */
export function getRemoteUserDataDir(): string {
  const dir = path.join(getCentralConfigDirectory(), "remote-state");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Resolve the startup mode from environment and CLI args.
 *
 * Local mode: resolves workspace from disk, returns wsDir.
 * Remote mode: parses URL, returns remoteUrl + adminToken.
 */
export function resolveStartupMode(centralData: CentralDataManager): StartupMode {
  const remote = parseRemoteStartupMode();
  if (remote) {
    log.info("[Workspace] Remote mode — workspace on server");
    return { kind: "remote", ...remote };
  }

  // Local mode: resolve workspace from disk
  const wsName = resolveWorkspaceName();
  const appRoot = getAppRoot();
  const startup = resolveLocalWorkspaceStartup({
    appRoot,
    centralData,
    name: wsName ?? undefined,
    isDev: isDev(),
  });
  log.info(`[Workspace] Loaded: ${startup.resolved.wsDir} (id: ${startup.resolved.workspace.config.id})`);
  return {
    kind: "local",
    wsDir: startup.resolved.wsDir,
    workspaceId: startup.resolved.workspace.config.id,
    isEphemeral: startup.isEphemeral,
  };
}
