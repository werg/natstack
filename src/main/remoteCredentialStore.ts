/**
 * remoteCredentialStore — persist remote-server credentials via Electron safeStorage.
 *
 * The admin token is encrypted with the OS keychain (Keychain on macOS,
 * DPAPI on Windows, libsecret/kwallet on Linux). URL / CA path / fingerprint
 * are stored as plaintext JSON alongside the encrypted blob.
 *
 * Resolution order consumed by startupMode:
 *   1. NATSTACK_REMOTE_* env vars
 *   2. this store
 *   3. legacy central config.yml remote.{url,token,...}
 */

import { safeStorage } from "electron";
import * as fs from "fs";
import * as path from "path";
import { createDevLogger } from "@natstack/dev-log";
import { ensureCentralConfigDir } from "@natstack/shared/workspace/loader";
import { getCentralConfigDirectory } from "./paths.js";

const log = createDevLogger("RemoteCredStore");

const STORE_FILENAME = "remote-credentials.json";

interface StoredPlain {
  url: string;
  caPath?: string;
  fingerprint?: string;
  /** Base64 encoded ciphertext from safeStorage, or the raw token if safeStorage is unavailable. */
  token: string;
  /** Whether `token` is encrypted (true) or stored plaintext (fallback only). */
  encrypted: boolean;
}

export interface RemoteCredentials {
  url: string;
  token: string;
  caPath?: string;
  fingerprint?: string;
}

function storePath(): string {
  // Live in the central config dir (same place as oauth-tokens / secrets) so
  // it is readable before Electron's userData path is finalized for the session.
  return path.join(getCentralConfigDirectory(), STORE_FILENAME);
}

export function loadRemoteCredentials(): RemoteCredentials | null {
  const p = storePath();
  if (!fs.existsSync(p)) return null;

  let stored: StoredPlain;
  try {
    stored = JSON.parse(fs.readFileSync(p, "utf-8")) as StoredPlain;
  } catch (err) {
    log.warn(`Failed to parse ${p}: ${(err as Error).message}`);
    return null;
  }

  let token = stored.token;
  if (stored.encrypted) {
    if (!safeStorage.isEncryptionAvailable()) {
      log.warn(`safeStorage unavailable — cannot decrypt token at ${p}`);
      return null;
    }
    try {
      token = safeStorage.decryptString(Buffer.from(stored.token, "base64"));
    } catch (err) {
      log.warn(`Failed to decrypt token: ${(err as Error).message}`);
      return null;
    }
  }

  return {
    url: stored.url,
    token,
    caPath: stored.caPath,
    fingerprint: stored.fingerprint,
  };
}

export function saveRemoteCredentials(creds: RemoteCredentials): void {
  const p = storePath();
  ensureCentralConfigDir();

  const encrypted = safeStorage.isEncryptionAvailable();
  const tokenField = encrypted
    ? safeStorage.encryptString(creds.token).toString("base64")
    : creds.token;

  const payload: StoredPlain = {
    url: creds.url,
    token: tokenField,
    encrypted,
    caPath: creds.caPath,
    fingerprint: creds.fingerprint,
  };

  fs.writeFileSync(p, JSON.stringify(payload, null, 2), { mode: 0o600 });
  if (!encrypted) {
    log.warn(`safeStorage unavailable — token written plaintext at ${p}`);
  }
}

export function clearRemoteCredentials(): void {
  const p = storePath();
  if (fs.existsSync(p)) fs.unlinkSync(p);
}
