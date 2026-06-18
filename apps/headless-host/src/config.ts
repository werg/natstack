import { randomUUID } from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";

export interface DeviceCredentialAuth {
  kind: "device";
  /** Base server URL the credential pairs with. */
  serverUrl: string;
  deviceId: string;
  refreshToken: string;
}

export interface TokenAuth {
  kind: "token";
  token: string;
}

export interface HeadlessHostConfig {
  /** Base server URL, e.g. http://127.0.0.1:3030 */
  serverUrl: string;
  auth: TokenAuth | DeviceCredentialAuth;
  label: string;
  clientSessionId: string;
  maxPanels: number;
  idleUnloadMs: number;
  /** Self-exit when holding zero leases for this long; 0/undefined disables. */
  idleExitMs?: number;
  chromiumPath?: string;
  cacheDir: string;
  profileDir: string;
  /** Prefer chrome-headless-shell over full Chrome when downloading. */
  leanBrowser?: boolean;
}

export interface ConfigOverrides {
  serverUrl?: string;
  token?: string;
  deviceCredential?: { serverUrl: string; deviceId: string; refreshToken: string };
  label?: string;
  clientSessionId?: string;
  maxPanels?: number;
  idleUnloadMs?: number;
  idleExitMs?: number;
  chromiumPath?: string;
  cacheDir?: string;
  profileDir?: string;
  leanBrowser?: boolean;
}

// Parse an optional non-negative integer env var, honoring an explicit 0 (so `|| undefined`
// doesn't silently swallow it). Returns undefined for missing or non-numeric values.
function parseOptionalNonNegativeInt(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

export function resolveConfig(overrides: ConfigOverrides = {}, env = process.env): HeadlessHostConfig {
  const serverUrl =
    overrides.serverUrl ?? overrides.deviceCredential?.serverUrl ?? env["NATSTACK_SERVER_URL"];
  if (!serverUrl) {
    throw new Error("headless-host: serverUrl is required (--url or NATSTACK_SERVER_URL)");
  }
  const token = overrides.token ?? env["NATSTACK_HEADLESS_TOKEN"];
  const auth: HeadlessHostConfig["auth"] = overrides.deviceCredential
    ? { kind: "device", ...overrides.deviceCredential }
    : token
      ? { kind: "token", token }
      : (() => {
          throw new Error("headless-host: auth is required (--token or a paired device credential)");
        })();

  const idleExitEnv = env["NATSTACK_HEADLESS_IDLE_EXIT_MS"];
  return {
    serverUrl: serverUrl.replace(/\/$/, ""),
    auth,
    label: overrides.label ?? "Headless",
    clientSessionId: overrides.clientSessionId ?? `headless-${randomUUID()}`,
    maxPanels: overrides.maxPanels ?? 8,
    idleUnloadMs: overrides.idleUnloadMs ?? 5 * 60_000,
    idleExitMs: overrides.idleExitMs ?? parseOptionalNonNegativeInt(idleExitEnv),
    chromiumPath: overrides.chromiumPath ?? env["NATSTACK_CHROMIUM_PATH"],
    cacheDir: overrides.cacheDir ?? path.join(os.homedir(), ".cache", "natstack", "chromium"),
    profileDir:
      overrides.profileDir ??
      path.join(os.homedir(), ".local", "state", "natstack", "headless-host"),
    leanBrowser: overrides.leanBrowser ?? false,
  };
}
