/**
 * centralAuth — central-config auth artifacts (admin token).
 *
 * Extracted from `workspace/loader.ts` because the admin token is a
 * *central* concept (one token per machine, not per workspace): it lives
 * under `~/.config/natstack/admin-token` alongside `config.yml`, `.secrets.yml`,
 * and `remote-credentials.json`. Keeping it in `workspace/loader.ts`
 * conflated "workspace configuration" with "credential storage for the
 * local machine."
 *
 * Backwards compatibility: `workspace/loader.ts` re-exports these symbols so
 * existing call sites keep working.
 */

import * as fs from "fs";
import * as path from "path";
import { getCentralDataPath } from "@natstack/env-paths";

const ADMIN_TOKEN_FILE = "admin-token";

/** Central-config directory path (platform-appropriate). */
function getCentralDir(): string {
  return getCentralDataPath();
}

/**
 * Create (if needed) and lock down the central config dir to 0o700. Called
 * before writing any secret-bearing file into the directory.
 *
 * The chmod IS best-effort — on filesystems that don't support POSIX perms
 * (SMB, FAT, some container mounts), it'll fail. But a silently loose
 * directory is a security regression we want to know about; we log at
 * `warn` so it shows up in operator logs rather than being swallowed.
 */
export function ensureCentralConfigDir(): string {
  const dir = getCentralDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") {
    try {
      fs.chmodSync(dir, 0o700);
    } catch (err) {
      console.warn(
        `[centralAuth] Could not enforce 0o700 on ${dir}: ${(err as Error).message}. ` +
        `Secrets may be readable by other users on this machine.`,
      );
    }
  }
  return dir;
}

/** Absolute path of the persisted admin token file. */
export function getAdminTokenPath(): string {
  return path.join(getCentralDir(), ADMIN_TOKEN_FILE);
}

/** Read the persisted admin token, or `null` if the file is missing or empty. */
export function loadPersistedAdminToken(): string | null {
  const tokenPath = getAdminTokenPath();
  if (!fs.existsSync(tokenPath)) return null;
  try {
    const token = fs.readFileSync(tokenPath, "utf-8").trim();
    return token.length > 0 ? token : null;
  } catch (error) {
    console.warn(`[centralAuth] Failed to read admin token at ${tokenPath}:`, error);
    return null;
  }
}

/** Atomically write the admin token with file mode 0o600 inside a 0o700 dir. */
export function savePersistedAdminToken(token: string): void {
  ensureCentralConfigDir();
  fs.writeFileSync(getAdminTokenPath(), token, { mode: 0o600 });
}
