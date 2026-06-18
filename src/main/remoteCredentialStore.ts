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
import { ensureCentralConfigDir } from "@natstack/shared/centralAuth";
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
      hubUrl?: string;
      workspaceName?: string;
      caPath?: string;
      fingerprint?: string;
      adminToken: EncryptedField;
    }
  | {
      schemaVersion: 2;
      kind: "device";
      url: string;
      hubUrl?: string;
      workspaceName?: string;
      caPath?: string;
      fingerprint?: string;
      deviceId: string;
      refreshToken: EncryptedField;
    }
  | {
      schemaVersion: 2;
      kind: "hybrid";
      url: string;
      hubUrl?: string;
      workspaceName?: string;
      caPath?: string;
      fingerprint?: string;
      adminToken: EncryptedField;
      deviceId: string;
      refreshToken: EncryptedField;
    };

export type LoadedCredentials =
  | {
      kind: "admin-token";
      url: string;
      hubUrl?: string;
      workspaceName?: string;
      adminToken: string;
      caPath?: string;
      fingerprint?: string;
    }
  | {
      kind: "device";
      url: string;
      hubUrl?: string;
      workspaceName?: string;
      deviceId: string;
      refreshToken: string;
      caPath?: string;
      fingerprint?: string;
    }
  | {
      kind: "hybrid";
      url: string;
      hubUrl?: string;
      workspaceName?: string;
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

  const stored = raw as Partial<StoredV2>;
  if (stored.schemaVersion !== 2) {
    log.warn(`Unsupported remote credential schema in ${p}`);
    return null;
  }
  return loadV2(stored as StoredV2, p);
}

export function saveRemoteCredentials(creds: LoadedCredentials): void {
  const p = storePath();
  ensureCentralConfigDir();

  const common = {
    schemaVersion: 2 as const,
    kind: creds.kind,
    url: creds.url,
    hubUrl: creds.hubUrl,
    workspaceName: creds.workspaceName,
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
        hubUrl: stored.hubUrl,
        workspaceName: stored.workspaceName,
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
        hubUrl: stored.hubUrl,
        workspaceName: stored.workspaceName,
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
      hubUrl: stored.hubUrl,
      workspaceName: stored.workspaceName,
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

function encryptField(value: string): EncryptedField {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error(
      "safeStorage encryption is unavailable; refusing to persist remote credentials"
    );
  }
  return { value: safeStorage.encryptString(value).toString("base64"), encrypted: true };
}

function decryptField(field: EncryptedField, p: string): string | null {
  if (!field.encrypted) {
    log.warn(`Unencrypted remote credential secret rejected at ${p}`);
    return null;
  }
  if (!safeStorage.isEncryptionAvailable()) {
    log.warn(`safeStorage unavailable — cannot decrypt secret at ${p}`);
    return null;
  }
  return safeStorage.decryptString(Buffer.from(field.value, "base64"));
}
