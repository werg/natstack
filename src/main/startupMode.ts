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
import { isTrustedCleartextHost } from "@natstack/shared/connect";
import type { CentralDataManager } from "@natstack/shared/centralData";
import { loadRemoteCredentials } from "./remoteCredentialStore.js";
import { assertPresent } from "../lintHelpers";

const log = createDevLogger("StartupMode");

export interface RemoteTlsOptions {
  /** Absolute path to a CA certificate (PEM) for self-signed servers */
  caPath?: string;
  /** SHA-256 fingerprint (uppercase, colon-separated) of the expected leaf cert */
  fingerprint?: string;
}

export type StartupMode =
  | {
      kind: "local";
      wsDir: string;
      workspaceName: string;
      workspaceId: string;
      isEphemeral: boolean;
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

export function isTrustworthyRemoteOrigin(remoteUrl: URL): boolean {
  if (remoteUrl.protocol === "https:") {
    return true;
  }

  if (remoteUrl.protocol !== "http:") {
    return false;
  }

  return isTrustedCleartextHost(remoteUrl.hostname);
}

/**
 * Parse remote startup mode from env vars or the safeStorage-backed store.
 * Returns null if not in remote mode.
 *
 * Priority: environment variables > safeStorage-backed store > nothing
 */
export function parseRemoteStartupMode(): {
  remoteUrl: URL;
  bootstrap: "admin-token" | "device" | "hybrid";
  adminToken?: string;
  deviceId?: string;
  refreshToken?: string;
  tls?: RemoteTlsOptions;
} | null {
  const stored = loadRemoteCredentials();

  // Resolution order: env var -> safeStorage-backed store.
  const rawUrl = process.env["NATSTACK_REMOTE_URL"] ?? stored?.url;
  const adminToken =
    process.env["NATSTACK_REMOTE_TOKEN"] ??
    (stored?.kind === "admin-token" || stored?.kind === "hybrid" ? stored.adminToken : undefined);
  const deviceId =
    process.env["NATSTACK_REMOTE_DEVICE_ID"] ??
    (stored?.kind === "device" || stored?.kind === "hybrid" ? stored.deviceId : undefined);
  const refreshToken =
    process.env["NATSTACK_REMOTE_REFRESH_TOKEN"] ??
    (stored?.kind === "device" || stored?.kind === "hybrid" ? stored.refreshToken : undefined);

  if (!rawUrl) return null;
  const hasAdmin = !!adminToken;
  const hasDevice = !!deviceId && !!refreshToken;
  if (!hasAdmin && !hasDevice) return null;
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

  const caPath = process.env["NATSTACK_REMOTE_CA"] ?? stored?.caPath;
  const fingerprint = process.env["NATSTACK_REMOTE_FINGERPRINT"] ?? stored?.fingerprint;
  const tls: RemoteTlsOptions | undefined =
    caPath || fingerprint ? { caPath, fingerprint: normalizeFingerprint(fingerprint) } : undefined;

  return { remoteUrl, bootstrap, adminToken, deviceId, refreshToken, tls };
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
 * Resolve the startup mode from environment and CLI args.
 *
 * Local mode: resolves workspace from disk, returns wsDir.
 * Remote mode: parses URL, returns remoteUrl + adminToken.
 */
export function resolveStartupMode(centralData: CentralDataManager): StartupMode {
  const remote = parseRemoteStartupMode();
  if (remote) {
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

  return resolveLocalStartupMode(centralData);
}

export function resolveLocalStartupMode(centralData: CentralDataManager): LocalStartupMode {
  // Local mode: resolve workspace from disk
  const wsName = resolveWorkspaceName();
  const appRoot = getAppRoot();
  const startup = resolveLocalWorkspaceStartup({
    appRoot,
    centralData,
    name: wsName ?? undefined,
    isDev: isDev(),
  });
  log.info(
    `[Workspace] Loaded: ${startup.resolved.wsDir} (id: ${startup.resolved.workspace.config.id})`
  );
  return {
    kind: "local",
    wsDir: startup.resolved.wsDir,
    workspaceName: startup.resolved.name,
    workspaceId: startup.resolved.workspace.config.id,
    isEphemeral: startup.isEphemeral,
  };
}
