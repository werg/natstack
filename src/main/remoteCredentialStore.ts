/**
 * remoteCredentialStore — persist remote-server credentials via Electron safeStorage.
 *
 * Secret fields are encrypted independently so the store can safely hold an
 * admin token, a device refresh credential, or both.
 */

import { safeStorage } from "electron";
import * as fs from "fs";
import * as path from "path";
import { createDevLogger } from "@natstack/dev-log";
import { ensureCentralConfigDir } from "@natstack/shared/workspace/loader";
import { getCentralConfigDirectory } from "./paths.js";

const log = createDevLogger("RemoteCredStore");

const STORE_FILENAME = "remote-credentials.json";

interface EncryptedField {
  value: string;
  encrypted: boolean;
}

type StoredV2 =
  | {
      schemaVersion: 2;
      kind: "admin-token";
      url: string;
      caPath?: string;
      fingerprint?: string;
      adminToken: EncryptedField;
    }
  | {
      schemaVersion: 2;
      kind: "device";
      url: string;
      caPath?: string;
      fingerprint?: string;
      deviceId: string;
      refreshToken: EncryptedField;
    }
  | {
      schemaVersion: 2;
      kind: "hybrid";
      url: string;
      caPath?: string;
      fingerprint?: string;
      adminToken: EncryptedField;
      deviceId: string;
      refreshToken: EncryptedField;
    };

interface StoredV1 {
  url?: string;
  caPath?: string;
  fingerprint?: string;
  token?: string;
  refreshToken?: string;
  deviceId?: string;
  encrypted?: boolean;
}

export type LoadedCredentials =
  | {
      kind: "admin-token";
      url: string;
      adminToken: string;
      caPath?: string;
      fingerprint?: string;
    }
  | {
      kind: "device";
      url: string;
      deviceId: string;
      refreshToken: string;
      caPath?: string;
      fingerprint?: string;
    }
  | {
      kind: "hybrid";
      url: string;
      adminToken: string;
      deviceId: string;
      refreshToken: string;
      caPath?: string;
      fingerprint?: string;
    };

export type RemoteCredentials = LoadedCredentials;

function storePath(): string {
  return path.join(getCentralConfigDirectory(), STORE_FILENAME);
}

export function loadRemoteCredentials(): LoadedCredentials | null {
  const p = storePath();
  if (!fs.existsSync(p)) return null;

  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(p, "utf-8"));
  } catch (err) {
    log.warn(`Failed to parse ${p}: ${(err as Error).message}`);
    return null;
  }

  const stored = raw as Partial<StoredV2> & StoredV1;
  if (stored.schemaVersion === 2) {
    return loadV2(stored as StoredV2, p);
  }
  return loadV1(stored, p);
}

export function saveRemoteCredentials(creds: LoadedCredentials): void {
  const p = storePath();
  ensureCentralConfigDir();

  const common = {
    schemaVersion: 2 as const,
    kind: creds.kind,
    url: creds.url,
    caPath: creds.caPath,
    fingerprint: creds.fingerprint,
  };
  let payload: StoredV2;
  if (creds.kind === "admin-token") {
    payload = {
      ...common,
      kind: "admin-token",
      adminToken: encryptField(creds.adminToken),
    };
  } else if (creds.kind === "device") {
    payload = {
      ...common,
      kind: "device",
      deviceId: creds.deviceId,
      refreshToken: encryptField(creds.refreshToken),
    };
  } else {
    payload = {
      ...common,
      kind: "hybrid",
      adminToken: encryptField(creds.adminToken),
      deviceId: creds.deviceId,
      refreshToken: encryptField(creds.refreshToken),
    };
  }

  fs.writeFileSync(p, JSON.stringify(payload, null, 2), { mode: 0o600 });
  try {
    fs.chmodSync(p, 0o600);
  } catch (err) {
    log.warn(`Failed to restrict permissions on ${p}: ${(err as Error).message}`);
  }
}

export function clearRemoteCredentials(): void {
  const p = storePath();
  if (fs.existsSync(p)) fs.unlinkSync(p);
}

function loadV2(stored: StoredV2, p: string): LoadedCredentials | null {
  try {
    if (stored.kind === "admin-token") {
      const adminToken = decryptField(stored.adminToken, p);
      if (!adminToken) return null;
      return {
        kind: "admin-token",
        url: stored.url,
        adminToken,
        caPath: stored.caPath,
        fingerprint: stored.fingerprint,
      };
    }
    if (stored.kind === "device") {
      const refreshToken = decryptField(stored.refreshToken, p);
      if (!refreshToken || !stored.deviceId) return null;
      return {
        kind: "device",
        url: stored.url,
        deviceId: stored.deviceId,
        refreshToken,
        caPath: stored.caPath,
        fingerprint: stored.fingerprint,
      };
    }
    const adminToken = decryptField(stored.adminToken, p);
    const refreshToken = decryptField(stored.refreshToken, p);
    if (!adminToken || !refreshToken || !stored.deviceId) return null;
    return {
      kind: "hybrid",
      url: stored.url,
      adminToken,
      deviceId: stored.deviceId,
      refreshToken,
      caPath: stored.caPath,
      fingerprint: stored.fingerprint,
    };
  } catch (err) {
    log.warn(`Failed to decrypt remote credentials: ${(err as Error).message}`);
    return null;
  }
}

function loadV1(stored: StoredV1, p: string): LoadedCredentials | null {
  if (!stored.url) return null;
  const adminToken = stored.token
    ? decryptLegacyField(stored.token, stored.encrypted === true, p)
    : undefined;
  const refreshToken = stored.refreshToken
    ? decryptLegacyField(stored.refreshToken, stored.encrypted === true, p)
    : undefined;

  if (adminToken && stored.deviceId && refreshToken) {
    return {
      kind: "hybrid",
      url: stored.url,
      adminToken,
      deviceId: stored.deviceId,
      refreshToken,
      caPath: stored.caPath,
      fingerprint: stored.fingerprint,
    };
  }
  if (adminToken) {
    return {
      kind: "admin-token",
      url: stored.url,
      adminToken,
      caPath: stored.caPath,
      fingerprint: stored.fingerprint,
    };
  }
  if (stored.deviceId && refreshToken) {
    return {
      kind: "device",
      url: stored.url,
      deviceId: stored.deviceId,
      refreshToken,
      caPath: stored.caPath,
      fingerprint: stored.fingerprint,
    };
  }
  return null;
}

function encryptField(value: string): EncryptedField {
  const encrypted = safeStorage.isEncryptionAvailable();
  if (!encrypted) {
    log.warn(`safeStorage unavailable — secret written plaintext at ${storePath()}`);
    return { value, encrypted: false };
  }
  return { value: safeStorage.encryptString(value).toString("base64"), encrypted: true };
}

function decryptField(field: EncryptedField, p: string): string | null {
  if (!field.encrypted) return field.value;
  if (!safeStorage.isEncryptionAvailable()) {
    log.warn(`safeStorage unavailable — cannot decrypt secret at ${p}`);
    return null;
  }
  return safeStorage.decryptString(Buffer.from(field.value, "base64"));
}

function decryptLegacyField(value: string, encrypted: boolean, p: string): string | undefined {
  if (!encrypted) return value;
  if (!safeStorage.isEncryptionAvailable()) {
    log.warn(`safeStorage unavailable — cannot decrypt token at ${p}`);
    return undefined;
  }
  return safeStorage.decryptString(Buffer.from(value, "base64"));
}
