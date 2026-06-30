/**
 * remoteCredStore — the client-side persistence of a WebRTC remote pairing.
 *
 * Replaces the deleted cleartext `remoteCredentialStore` (URL + CA + TLS
 * fingerprint, §8c). A desktop client that has paired with a remote server over
 * WebRTC persists, encrypted at rest:
 *   - the pairing material (`room`/`fp`/`sig`/`ice`/`srv`) MINUS the one-time
 *     `code` (consumed at pairing), so it can re-dial the same answerer, and
 *   - the durable device credential (`deviceId` + `refreshToken`) the server
 *     issued, so it can re-authenticate without re-pairing (`refresh:…`).
 *
 * The store logic is pure (path + cipher injected) so it is unit-testable
 * without Electron; the service layer binds `app.getPath('userData')` +
 * `safeStorage`. The refresh secret is the only durable secret on the client,
 * so it is never written in plaintext.
 */

import type { ConnectPairing } from "@natstack/shared/connect";

/** The pairing material persisted for reconnect (no one-time `code`). */
export type StoredPairing = Omit<ConnectPairing, "code">;

export interface StoredRemote {
  pairing: StoredPairing;
  deviceId: string;
  refreshToken: string;
  label?: string;
  workspaceName?: string;
  serverId?: string;
  pairedAt: number;
}

/** Cipher seam — Electron `safeStorage` in production, identity in tests. */
export interface StoreCipher {
  encrypt(plaintext: string): Buffer;
  decrypt(ciphertext: Buffer): string;
  isAvailable(): boolean;
}

export interface RemoteCredStore {
  load(): StoredRemote | null;
  save(value: StoredRemote): void;
  clear(): void;
}

/**
 * Create a store backed by a single encrypted file. Reads tolerate a missing or
 * corrupt file (returns null — pair again) but never silently swallow a write
 * failure (the caller must know the credential did not persist).
 */
export function createRemoteCredStore(deps: {
  filePath: string;
  cipher: StoreCipher;
  fs: Pick<
    typeof import("node:fs"),
    "readFileSync" | "writeFileSync" | "mkdirSync" | "rmSync" | "existsSync"
  >;
  dirname: (p: string) => string;
}): RemoteCredStore {
  const { filePath, cipher, fs, dirname } = deps;
  return {
    load(): StoredRemote | null {
      if (!fs.existsSync(filePath)) return null;
      // We never write plaintext (see save), so without the cipher we cannot read a
      // legitimately-stored credential — treat as unpaired rather than attempt a
      // plaintext parse (which would only succeed on an insecure legacy file).
      if (!cipher.isAvailable()) return null;
      try {
        const raw = fs.readFileSync(filePath);
        const json = cipher.decrypt(raw);
        const value = JSON.parse(json) as StoredRemote;
        if (!value.deviceId || !value.refreshToken || !value.pairing?.room || !value.pairing?.fp) {
          return null;
        }
        return value;
      } catch {
        // Corrupt / undecryptable (e.g. OS keychain reset) ⇒ treat as unpaired.
        return null;
      }
    },
    save(value: StoredRemote): void {
      // Fail loud: the device refresh secret is the only durable client secret and
      // MUST NOT be written in plaintext. If OS secure storage (safeStorage) is
      // unavailable (a Linux box with no keyring, or headless), refuse to persist
      // rather than silently writing the token in the clear. The caller surfaces
      // this (the device re-pairs each launch) instead of leaking the secret.
      if (!cipher.isAvailable()) {
        throw new Error(
          "Refusing to persist the device refresh credential: OS secure storage (safeStorage) " +
            "is unavailable, and the refresh token must never be stored in plaintext."
        );
      }
      const json = JSON.stringify(value);
      const bytes = cipher.encrypt(json);
      fs.mkdirSync(dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, bytes, { mode: 0o600 });
    },
    clear(): void {
      if (fs.existsSync(filePath)) fs.rmSync(filePath, { force: true });
    },
  };
}
