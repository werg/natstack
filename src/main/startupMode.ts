/**
 * StartupMode — discriminated union for the desktop shell's startup target.
 *
 * Remote topology is now WebRTC (paired by QR via the remoteCred flow, not a
 * startup mode), so startup resolves only local-vs-pending; the shell always
 * spawns its own loopback server. Includes `resolveStartupMode()`.
 */

import * as path from "path";
import * as fs from "fs";
import { createDevLogger } from "@natstack/dev-log";
import { isDev } from "./utils.js";
import { getAppRoot, getCentralConfigDirectory } from "./paths.js";
import { resolveWorkspaceName } from "@natstack/shared/workspace/loader";
import { resolveLocalWorkspaceStartup } from "@natstack/shared/workspace/startup";
import type { CentralDataManager } from "@natstack/shared/centralData";

const log = createDevLogger("StartupMode");
export const CHOOSE_CONNECTION_ARG = "--choose-connection";
export const WORKSPACE_CREATE_IF_MISSING_ARG = "--workspace-create-if-missing";
/**
 * Marks a local launch as a disposable dev workspace: the workspace dir is deleted on exit
 * (see the will-quit cleanup). Paired with `--workspace <name>` so the same workspace is kept
 * across relaunches within a session rather than minting a new one each time.
 */
export const EPHEMERAL_WORKSPACE_ARG = "--ephemeral-workspace";

export type StartupMode =
  | {
      kind: "pending";
    }
  | {
      kind: "local";
      wsDir: string;
      workspaceName: string;
      workspaceId: string;
      isEphemeral: boolean;
      autoApproveStartupUnits: boolean;
    };

export type LocalStartupMode = Extract<StartupMode, { kind: "local" }>;
/**
 * A startup mode that establishes a server session. Remote topology is now
 * WebRTC (paired by QR via the remoteCred flow, not a startup mode), so the only
 * connected startup mode is local — the shell always spawns its own loopback
 * server. (`§8c` deleted the `kind: "remote"` arm + its env/stored-credential
 * resolution.)
 */
export type ConnectedStartupMode = LocalStartupMode;

export function shouldRequestSingleInstanceLock(
  mode: StartupMode,
  opts: { isHeadlessHost: boolean; isDevelopment: boolean }
): boolean {
  if (opts.isHeadlessHost) return false;
  if (opts.isDevelopment && mode.kind === "local") return false;
  return true;
}

/**
 * Get the user data directory for the pre-session bootstrap shell.
 * This keeps chooser state separate from workspace state because no workspace
 * has been selected yet.
 */
export function getPendingUserDataDir(): string {
  const dir = path.join(getCentralConfigDirectory(), "bootstrap-state");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Resolve the startup mode from environment and CLI args.
 *
 * Resolves local-vs-pending only. Remote is paired live via WebRTC (remoteCred /
 * QR), never a startup env URL or stored-remote relaunch (§8c).
 */
export function resolveStartupMode(
  centralData: CentralDataManager,
  opts?: { interactiveDesktop?: boolean }
): StartupMode {
  // Startup resolves local-vs-pending: resume the last/default local workspace
  // unless the user explicitly asked to choose a connection (which surfaces the
  // chooser to open a local workspace or pair a remote server via WebRTC QR).
  if (opts?.interactiveDesktop === true && hasConnectDeepLinkArg()) {
    log.info("[Workspace] Waiting for WebRTC pairing link opened at launch");
    return { kind: "pending" };
  }

  if (hasExplicitWorkspaceSelection()) {
    return resolveLocalStartupMode(centralData);
  }

  if (process.argv.includes(CHOOSE_CONNECTION_ARG) && opts?.interactiveDesktop === true) {
    log.info("[Workspace] Waiting for user to choose a server or local workspace");
    return { kind: "pending" };
  }

  if (opts?.interactiveDesktop === true && isDev()) {
    return resolveLocalStartupMode(centralData);
  }

  const lastTarget =
    typeof centralData.getLastWorkspaceTarget === "function"
      ? centralData.getLastWorkspaceTarget()
      : null;
  if (lastTarget?.kind === "local") {
    return resolveLocalStartupMode(centralData, lastTarget.name);
  }

  return resolveLocalStartupMode(centralData);
}

function hasExplicitWorkspaceSelection(): boolean {
  return resolveWorkspaceName() !== null;
}

function hasConnectDeepLinkArg(): boolean {
  return process.argv.some((arg) => arg.startsWith("natstack://connect"));
}

function shouldCreateExplicitWorkspaceIfMissing(): boolean {
  return process.argv.includes(WORKSPACE_CREATE_IF_MISSING_ARG);
}

export function stripStartupSelectionArgs(rawArgs: readonly string[]): string[] {
  const filteredArgs: string[] = [];
  for (let i = 0; i < rawArgs.length; i++) {
    const arg = rawArgs[i];
    if (arg === "--workspace" && i + 1 < rawArgs.length) {
      i++;
      continue;
    }
    if (arg?.startsWith("--workspace=")) continue;
    if (arg === CHOOSE_CONNECTION_ARG) continue;
    if (arg === WORKSPACE_CREATE_IF_MISSING_ARG) continue;
    if (arg === EPHEMERAL_WORKSPACE_ARG) continue;
    if (arg !== undefined) filteredArgs.push(arg);
  }
  return filteredArgs;
}

export function workspaceRelaunchArgs(name: string, rawArgs = process.argv.slice(1)): string[] {
  return [
    ...stripStartupSelectionArgs(rawArgs),
    "--workspace",
    name,
    WORKSPACE_CREATE_IF_MISSING_ARG,
  ];
}

export function chooseConnectionRelaunchArgs(rawArgs = process.argv.slice(1)): string[] {
  return [...stripStartupSelectionArgs(rawArgs), CHOOSE_CONNECTION_ARG];
}

/**
 * Relaunch into a fresh disposable dev workspace. Pins the generated name via `--workspace` so the
 * workspace is stable across relaunches in the session, and tags it ephemeral so it is deleted on
 * exit. Dev-only — the caller gates on isDev().
 */
export function ephemeralWorkspaceRelaunchArgs(
  name: string,
  rawArgs = process.argv.slice(1)
): string[] {
  return [
    ...stripStartupSelectionArgs(rawArgs),
    "--workspace",
    name,
    WORKSPACE_CREATE_IF_MISSING_ARG,
    EPHEMERAL_WORKSPACE_ARG,
  ];
}

export function resolveLocalStartupMode(
  centralData: CentralDataManager,
  preferredName?: string
): LocalStartupMode {
  // Local mode: resolve workspace from disk
  const wsName = resolveWorkspaceName() ?? preferredName;
  const appRoot = getAppRoot();
  const startup = resolveLocalWorkspaceStartup({
    appRoot,
    centralData,
    name: wsName ?? undefined,
    ...(wsName ? { init: shouldCreateExplicitWorkspaceIfMissing() } : {}),
    isDev: isDev(),
  });
  log.info(
    `[Workspace] Loaded: ${startup.resolved.wsDir} (id: ${startup.resolved.workspace.config.id})`
  );
  const isEphemeral = startup.isEphemeral || process.argv.includes(EPHEMERAL_WORKSPACE_ARG);
  return {
    kind: "local",
    wsDir: startup.resolved.wsDir,
    workspaceName: startup.resolved.name,
    workspaceId: startup.resolved.workspace.config.id,
    // A named launch tagged --ephemeral-workspace (the dev "new ephemeral workspace" button) is
    // disposable even though it was resolved by name; mark it so will-quit deletes it.
    isEphemeral,
    autoApproveStartupUnits:
      startup.resolved.name === "default" && startup.resolved.created && !isEphemeral,
  };
}
