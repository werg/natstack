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
import { resolveWorkspaceName } from "@natstack/shared/workspace/loader";
import { resolveLocalWorkspaceStartup } from "@natstack/shared/workspace/startup";
import { isSelectedWorkspaceUrl, isTrustedCleartextHost } from "@natstack/shared/connect";
import type { CentralDataManager } from "@natstack/shared/centralData";
import { loadRemoteCredentials } from "./remoteCredentialStore.js";
import { assertPresent } from "../lintHelpers";

const log = createDevLogger("StartupMode");
export const CONNECT_SELECTED_REMOTE_ARG = "--connect-selected-remote";
export const CHOOSE_CONNECTION_ARG = "--choose-connection";
export const WORKSPACE_CREATE_IF_MISSING_ARG = "--workspace-create-if-missing";
/**
 * Marks a local launch as a disposable dev workspace: the workspace dir is deleted on exit
 * (see the will-quit cleanup). Paired with `--workspace <name>` so the same workspace is kept
 * across relaunches within a session rather than minting a new one each time.
 */
export const EPHEMERAL_WORKSPACE_ARG = "--ephemeral-workspace";

export interface RemoteTlsOptions {
  /** Absolute path to a CA certificate (PEM) for self-signed servers */
  caPath?: string;
  /** SHA-256 fingerprint (uppercase, colon-separated) of the expected leaf cert */
  fingerprint?: string;
}

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
    }
  | {
      kind: "remote";
      remoteUrl: URL;
      bootstrap: "admin-token" | "device" | "hybrid";
      adminToken?: string;
      deviceId?: string;
      refreshToken?: string;
      tls?: RemoteTlsOptions;
    };

export type LocalStartupMode = Extract<StartupMode, { kind: "local" }>;
export type RemoteStartupMode = Extract<StartupMode, { kind: "remote" }>;
export type ConnectedStartupMode = LocalStartupMode | RemoteStartupMode;

export function shouldRequestSingleInstanceLock(
  mode: StartupMode,
  opts: { isHeadlessHost: boolean; isDevelopment: boolean }
): boolean {
  if (opts.isHeadlessHost) return false;
  if (opts.isDevelopment && mode.kind === "local") return false;
  return true;
}

export function isTrustworthyRemoteOrigin(remoteUrl: URL): boolean {
  if (remoteUrl.protocol === "https:") {
    return true;
  }

  if (remoteUrl.protocol !== "http:") {
    return false;
  }

  return isTrustedCleartextHost(remoteUrl.hostname);
}

export type RemoteStartupCredentials = {
  remoteUrl: URL;
  bootstrap: "admin-token" | "device" | "hybrid";
  adminToken?: string;
  deviceId?: string;
  refreshToken?: string;
  tls?: RemoteTlsOptions;
};

/**
 * Outcome of resolving remote startup inputs (env vars and/or the safeStorage store):
 *  - "none": not in remote mode (no URL or no credentials).
 *  - "ready": fully resolved, workspace-scoped remote credentials.
 *  - "awaiting-workspace-selection": a stored device/admin credential is paired with a hub but
 *    has not selected a workspace yet. This is a RECOVERABLE state, not a fatal misconfiguration —
 *    the caller should drive workspace selection (chooser UI, or headless auto-select) rather than
 *    crash. An explicit NATSTACK_REMOTE_URL that lacks a workspace path still throws (misconfig).
 */
export type RemoteStartupResolution =
  | { status: "none" }
  | { status: "ready"; credentials: RemoteStartupCredentials }
  | { status: "awaiting-workspace-selection" };

/**
 * Resolve remote startup from env vars or the safeStorage-backed store.
 *
 * Priority: environment variables > safeStorage-backed store > nothing
 */
export function resolveRemoteStartup(opts?: {
  includeStoredCredentials?: boolean;
}): RemoteStartupResolution {
  const includeStoredCredentials = opts?.includeStoredCredentials ?? true;
  const stored = includeStoredCredentials ? loadRemoteCredentials() : null;

  // Resolution order: env var -> safeStorage-backed store. Track the URL's provenance so a
  // not-yet-selected stored credential can recover, while an explicit env URL still fails loudly.
  const envUrl = process.env["NATSTACK_REMOTE_URL"];
  const rawUrl = envUrl ?? stored?.url;
  const adminToken =
    process.env["NATSTACK_REMOTE_TOKEN"] ??
    (stored?.kind === "admin-token" || stored?.kind === "hybrid" ? stored.adminToken : undefined);
  const deviceId =
    process.env["NATSTACK_REMOTE_DEVICE_ID"] ??
    (stored?.kind === "device" || stored?.kind === "hybrid" ? stored.deviceId : undefined);
  const refreshToken =
    process.env["NATSTACK_REMOTE_REFRESH_TOKEN"] ??
    (stored?.kind === "device" || stored?.kind === "hybrid" ? stored.refreshToken : undefined);

  if (!rawUrl) return { status: "none" };
  const hasAdmin = !!adminToken;
  const hasDevice = !!deviceId && !!refreshToken;
  if (!hasAdmin && !hasDevice) return { status: "none" };
  const bootstrap = hasAdmin && hasDevice ? "hybrid" : hasAdmin ? "admin-token" : "device";

  let remoteUrl: URL;
  try {
    remoteUrl = new URL(rawUrl);
  } catch {
    throw new Error(`Invalid NATSTACK_REMOTE_URL: "${rawUrl}" is not a valid URL`);
  }

  if (remoteUrl.protocol !== "http:" && remoteUrl.protocol !== "https:") {
    throw new Error(
      `Invalid NATSTACK_REMOTE_URL: protocol must be http or https, got "${remoteUrl.protocol}"`
    );
  }

  if (!isTrustworthyRemoteOrigin(remoteUrl)) {
    throw new Error(
      "Invalid NATSTACK_REMOTE_URL: remote panel mode requires HTTPS, or trusted cleartext HTTP " +
        "(loopback, private LAN, Tailscale, or local hostnames)"
    );
  }
  if (!isSelectedWorkspaceUrl(remoteUrl)) {
    if (envUrl) {
      // An explicit env URL without a workspace path is a misconfiguration — fail loudly.
      throw new Error(
        "Invalid NATSTACK_REMOTE_URL: remote startup requires a selected workspace URL. " +
          "Pair with the server first, then choose a workspace."
      );
    }
    // A stored credential paired with a hub but not yet scoped to a workspace is recoverable.
    return { status: "awaiting-workspace-selection" };
  }

  const caPath = process.env["NATSTACK_REMOTE_CA"] ?? stored?.caPath;
  const fingerprint = process.env["NATSTACK_REMOTE_FINGERPRINT"] ?? stored?.fingerprint;
  const tls: RemoteTlsOptions | undefined =
    caPath || fingerprint ? { caPath, fingerprint: normalizeFingerprint(fingerprint) } : undefined;

  return {
    status: "ready",
    credentials: { remoteUrl, bootstrap, adminToken, deviceId, refreshToken, tls },
  };
}

/**
 * Normalize a fingerprint string to uppercase colon-separated hex.
 * Accepts lowercase, spaces, or no separators.
 */
function normalizeFingerprint(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const hex = raw.replace(/[^0-9a-fA-F]/g, "").toUpperCase();
  if (hex.length !== 64) return raw.toUpperCase(); // let caller surface the mismatch
  return assertPresent(hex.match(/.{2}/g)).join(":");
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
 * Local mode: resolves workspace from disk, returns wsDir.
 * Remote mode: parses URL, returns remoteUrl + adminToken.
 */
export function resolveStartupMode(
  centralData: CentralDataManager,
  opts?: { interactiveDesktop?: boolean }
): StartupMode {
  const explicitRemote = resolveRemoteStartup({ includeStoredCredentials: false });
  if (explicitRemote.status === "ready") {
    return toRemoteStartupMode(explicitRemote.credentials);
  }

  if (hasExplicitWorkspaceSelection()) {
    return resolveLocalStartupMode(centralData);
  }

  const connectSelectedRemote = process.argv.includes(CONNECT_SELECTED_REMOTE_ARG);
  if (process.argv.includes(CHOOSE_CONNECTION_ARG) && opts?.interactiveDesktop === true) {
    log.info("[Workspace] Waiting for user to choose a server or local workspace");
    return { kind: "pending" };
  }

  if (opts?.interactiveDesktop === true && isDev() && !connectSelectedRemote) {
    return resolveLocalStartupMode(centralData);
  }

  const lastTarget =
    typeof centralData.getLastWorkspaceTarget === "function"
      ? centralData.getLastWorkspaceTarget()
      : null;
  const shouldUseStoredRemote =
    connectSelectedRemote || opts?.interactiveDesktop !== true || lastTarget?.kind === "remote";
  if (shouldUseStoredRemote) {
    const storedRemote = resolveRemoteStartup();
    if (storedRemote.status === "ready") {
      return toRemoteStartupMode(storedRemote.credentials);
    }
    if (storedRemote.status === "awaiting-workspace-selection") {
      // Paired with a hub but no workspace chosen yet. Recoverable for desktop AND headless:
      // surface `pending` so workspace selection can be driven (chooser UI, or headless
      // auto-select/relaunch) instead of crashing the process at startup.
      log.info(
        "[Workspace] Paired with remote server but no workspace selected; awaiting selection"
      );
      return { kind: "pending" };
    }
  }

  if (lastTarget?.kind === "local") {
    return resolveLocalStartupMode(centralData, lastTarget.name);
  }

  return resolveLocalStartupMode(centralData);
}

function toRemoteStartupMode(remote: RemoteStartupCredentials): RemoteStartupMode {
  log.info(`[Workspace] Remote mode — workspace on server (${remote.bootstrap})`);
  return {
    kind: "remote",
    remoteUrl: remote.remoteUrl,
    bootstrap: remote.bootstrap,
    adminToken: remote.adminToken,
    deviceId: remote.deviceId,
    refreshToken: remote.refreshToken,
    tls: remote.tls,
  };
}

function hasExplicitWorkspaceSelection(): boolean {
  return resolveWorkspaceName() !== null;
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
    if (arg === CONNECT_SELECTED_REMOTE_ARG) continue;
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

export function connectSelectedRemoteRelaunchArgs(rawArgs = process.argv.slice(1)): string[] {
  return [...stripStartupSelectionArgs(rawArgs), CONNECT_SELECTED_REMOTE_ARG];
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
