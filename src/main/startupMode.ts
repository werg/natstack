/**
 * StartupMode — discriminated union for local vs remote startup.
 *
 * TypeScript enforces you can't access `wsDir` in remote mode.
 * Includes `resolveStartupMode()` with proper URL validation.
 */

import * as path from "path";
import * as fs from "fs";
import { isIP } from "net";
import { createDevLogger } from "@natstack/dev-log";
import { isDev } from "./utils.js";
import { getAppRoot, getCentralConfigDirectory } from "./paths.js";
import {
  resolveWorkspaceName,
  loadCentralConfig,
} from "@natstack/shared/workspace/loader";
import { resolveLocalWorkspaceStartup } from "@natstack/shared/workspace/startup";
import type { CentralDataManager } from "@natstack/shared/centralData";
import { loadRemoteCredentials } from "./remoteCredentialStore.js";

const log = createDevLogger("StartupMode");

export interface RemoteTlsOptions {
  /** Absolute path to a CA certificate (PEM) for self-signed servers */
  caPath?: string;
  /** SHA-256 fingerprint (uppercase, colon-separated) of the expected leaf cert */
  fingerprint?: string;
}

export type StartupMode =
  | { kind: "local"; wsDir: string; workspaceId: string; isEphemeral: boolean }
  | { kind: "remote"; remoteUrl: URL; adminToken: string; tls?: RemoteTlsOptions };

function isLoopbackHostname(hostname: string): boolean {
  if (hostname === "localhost" || hostname.endsWith(".localhost")) {
    return true;
  }

  const normalized = hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;

  if (normalized === "::1") {
    return true;
  }

  return isIP(normalized) === 4 && normalized.startsWith("127.");
}

export function isTrustworthyRemoteOrigin(remoteUrl: URL): boolean {
  if (remoteUrl.protocol === "https:") {
    return true;
  }

  if (remoteUrl.protocol !== "http:") {
    return false;
  }

  return isLoopbackHostname(remoteUrl.hostname);
}

/**
 * Parse remote startup mode from env vars, falling back to config.yml.
 * Returns null if not in remote mode.
 *
 * Priority: environment variables > config.yml > nothing
 */
export function parseRemoteStartupMode(): { remoteUrl: URL; adminToken: string; tls?: RemoteTlsOptions } | null {
  const centralConfig = loadCentralConfig();
  const stored = loadRemoteCredentials();

  // Resolution order: env var → safeStorage-backed store → legacy config.yml
  const rawUrl =
    process.env["NATSTACK_REMOTE_URL"] ??
    stored?.url ??
    centralConfig.remote?.url;
  const adminToken =
    process.env["NATSTACK_REMOTE_TOKEN"] ??
    stored?.token ??
    centralConfig.remote?.token;

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

  if (!isTrustworthyRemoteOrigin(remoteUrl)) {
    throw new Error(
      "Invalid NATSTACK_REMOTE_URL: remote panel mode requires HTTPS, or loopback HTTP " +
      "(localhost, *.localhost, 127.0.0.1, ::1)"
    );
  }

  const caPath =
    process.env["NATSTACK_REMOTE_CA"] ??
    stored?.caPath ??
    centralConfig.remote?.caPath;
  const fingerprint =
    process.env["NATSTACK_REMOTE_FINGERPRINT"] ??
    stored?.fingerprint ??
    centralConfig.remote?.fingerprint;
  const tls: RemoteTlsOptions | undefined =
    caPath || fingerprint ? { caPath, fingerprint: normalizeFingerprint(fingerprint) } : undefined;

  return { remoteUrl, adminToken, tls };
}

/**
 * Normalize a fingerprint string to uppercase colon-separated hex.
 * Accepts lowercase, spaces, or no separators.
 */
function normalizeFingerprint(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const hex = raw.replace(/[^0-9a-fA-F]/g, "").toUpperCase();
  if (hex.length !== 64) return raw.toUpperCase(); // let caller surface the mismatch
  return hex.match(/.{2}/g)!.join(":");
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
    return { kind: "remote", remoteUrl: remote.remoteUrl, adminToken: remote.adminToken, tls: remote.tls };
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
