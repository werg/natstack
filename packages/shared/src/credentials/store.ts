import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { getCentralDataPath } from "@natstack/env-paths";
import type { Credential } from "./types.js";

const DEFAULT_POLL_INTERVAL_MS = 250;

/**
 * Validate a credential identifier (providerId / connectionId). Used as a path
 * component, so a strict charset is required to prevent path-traversal via
 * `path.join(basePath, providerId)` / `${connectionId}.json`.
 *
 * Audit finding #13 (credentials/secrets) — `CredentialStore` previously
 * accepted `z.string()` and fed it straight into `path.join`.
 */
const IDENTIFIER_RE = /^[a-zA-Z0-9][a-zA-Z0-9._@+=:-]{0,127}$/;

function assertValidIdentifier(kind: "providerId" | "connectionId", value: string): void {
  if (typeof value !== "string" || !IDENTIFIER_RE.test(value)) {
    throw new Error(
      `Invalid ${kind}: must be a safe path component matching /^[a-zA-Z0-9][a-zA-Z0-9._@+=:-]{0,127}$/ (got: ${JSON.stringify(value)})`,
    );
  }
}

interface DirectoryEntry {
  name: string;
  isDirectory(): boolean;
  isFile(): boolean;
}

function isNotFoundError(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
}

function getDefaultBasePath(): string {
  const homeDir = process.env["HOME"] ?? process.env["USERPROFILE"];
  if (!homeDir) {
    throw new Error("Unable to resolve a home directory for credential storage");
  }
  return path.join(homeDir, ".natstack", "credentials");
}

// ---------------------------------------------------------------------------
// Encryption-at-rest
//
// Audit finding #10 (credentials/secrets): OAuth access + refresh tokens were
// previously persisted as plaintext JSON. Two encryption backends:
//
//   1. Electron `safeStorage` (preferred) — uses OS keychain / DPAPI / libsecret.
//   2. AES-256-GCM with a per-machine random key under
//      `<centralConfigDir>/keys/store.key` (mode 0o600). Used in headless /
//      server-detached / test mode where Electron is unavailable.
//
// We NEVER write a plaintext credential. If both backends are unavailable we
// throw at save / load time.
// ---------------------------------------------------------------------------

interface EncryptedEnvelope {
  /** "v1-electron" (safeStorage) or "v1-aesgcm" (file-key fallback). */
  v: string;
  /** Base64-encoded ciphertext. For aesgcm the layout is [iv(12) | tag(16) | ct]. */
  ct: string;
}

function isEncryptedEnvelope(value: unknown): value is EncryptedEnvelope {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { v?: unknown }).v === "string" &&
    typeof (value as { ct?: unknown }).ct === "string"
  );
}

interface SafeStorage {
  isEncryptionAvailable(): boolean;
  encryptString(s: string): Buffer;
  decryptString(b: Buffer): string;
}

let safeStorageCache: SafeStorage | null | undefined;

/**
 * Try to obtain Electron's `safeStorage` without taking a hard dependency on
 * Electron — the shared package may run inside the Electron main process, in
 * the headless server, in tests, or anywhere else.
 */
function tryGetSafeStorage(): SafeStorage | null {
  if (safeStorageCache !== undefined) return safeStorageCache;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const electron = require("electron");
    const ss: SafeStorage | undefined = electron?.safeStorage;
    if (ss && typeof ss.isEncryptionAvailable === "function" && ss.isEncryptionAvailable()) {
      safeStorageCache = ss;
      return ss;
    }
  } catch {
    /* not in Electron */
  }
  safeStorageCache = null;
  return null;
}

/** Override safeStorage detection (test hook). */
export function __setSafeStorageForTests(ss: SafeStorage | null): void {
  safeStorageCache = ss;
}

function getKeyFilePath(): string {
  // Live alongside the rest of central config so it inherits the 0o700 dir
  // permissions. `~/.config/natstack/keys/store.key` on Linux.
  return path.join(getCentralDataPath(), "keys", "store.key");
}

function loadOrCreateAesKey(): Buffer {
  const keyPath = getKeyFilePath();
  try {
    const buf = fsSync.readFileSync(keyPath);
    if (buf.length === 32) return buf;
    // Wrong size — regenerate (treat as corrupt).
  } catch (err) {
    if (!isNotFoundError(err)) throw err;
  }
  const dir = path.dirname(keyPath);
  fsSync.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") {
    try {
      fsSync.chmodSync(dir, 0o700);
    } catch {
      /* best-effort */
    }
  }
  const key = crypto.randomBytes(32);
  fsSync.writeFileSync(keyPath, key, { mode: 0o600 });
  if (process.platform !== "win32") {
    try {
      fsSync.chmodSync(keyPath, 0o600);
    } catch {
      /* best-effort */
    }
  }
  return key;
}

function aesEncrypt(plaintext: string): EncryptedEnvelope {
  const key = loadOrCreateAesKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { v: "v1-aesgcm", ct: Buffer.concat([iv, tag, ct]).toString("base64") };
}

function aesDecrypt(envelope: EncryptedEnvelope): string {
  const key = loadOrCreateAesKey();
  const raw = Buffer.from(envelope.ct, "base64");
  if (raw.length < 12 + 16) throw new Error("Corrupt aes-gcm envelope");
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const ct = raw.subarray(28);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}

function encryptCredential(plaintext: string): EncryptedEnvelope {
  const ss = tryGetSafeStorage();
  if (ss) {
    return { v: "v1-electron", ct: ss.encryptString(plaintext).toString("base64") };
  }
  // No keychain available — fall back to file-keyed AES-256-GCM.
  return aesEncrypt(plaintext);
}

function decryptCredential(envelope: EncryptedEnvelope): string {
  if (envelope.v === "v1-electron") {
    const ss = tryGetSafeStorage();
    if (!ss) {
      throw new Error(
        "Credential was encrypted with Electron safeStorage but safeStorage is " +
          "unavailable in this process. Re-launch from Electron, or migrate the " +
          "credential store.",
      );
    }
    return ss.decryptString(Buffer.from(envelope.ct, "base64"));
  }
  if (envelope.v === "v1-aesgcm") {
    return aesDecrypt(envelope);
  }
  throw new Error(`Unknown credential envelope version: ${envelope.v}`);
}

function deserializeCredentialFile(raw: string, providerId: string, connectionId: string): {
  credential: Credential;
  needsMigration: boolean;
} {
  const parsed = JSON.parse(raw) as unknown;
  if (isEncryptedEnvelope(parsed)) {
    const decrypted = decryptCredential(parsed);
    return { credential: JSON.parse(decrypted) as Credential, needsMigration: false };
  }
  // Legacy plaintext format — migrate on first read.
  // Audit finding #10: one-time migration of pre-encryption files.
  const cred = parsed as Credential;
  if (
    !cred ||
    typeof cred !== "object" ||
    typeof cred.providerId !== "string" ||
    typeof cred.connectionId !== "string"
  ) {
    throw new Error(`Corrupt credential file for ${providerId}/${connectionId}`);
  }
  return { credential: cred, needsMigration: true };
}

function serializeCredential(credential: Credential): string {
  const envelope = encryptCredential(JSON.stringify(credential));
  return `${JSON.stringify(envelope)}\n`;
}

export class CredentialStore {
  private readonly basePath: string;

  constructor(options: { basePath?: string } = {}) {
    this.basePath = options.basePath ?? getDefaultBasePath();
  }

  async save(credential: Credential): Promise<void> {
    assertValidIdentifier("providerId", credential.providerId);
    assertValidIdentifier("connectionId", credential.connectionId);

    const providerDir = this.getProviderPath(credential.providerId);
    const targetPath = this.getCredentialPath(credential.providerId, credential.connectionId);
    // Audit finding #34 (fs report) / #17 (creds report): use crypto-grade
    // randomness for tmp filenames rather than Math.random().
    const tempPath = path.join(
      providerDir,
      `.${credential.connectionId}.${process.pid}.${Date.now()}.${crypto.randomBytes(16).toString("hex")}.tmp`,
    );
    const fileContents = serializeCredential(credential);

    await fs.mkdir(providerDir, { recursive: true, mode: 0o700 });

    let handle: fs.FileHandle | null = null;
    try {
      // mode: 0o600 explicit on every write (audit finding #10).
      handle = await fs.open(tempPath, "w", 0o600);
      await handle.writeFile(fileContents, "utf8");
      await handle.sync();
      await handle.close();
      handle = null;

      await fs.chmod(tempPath, 0o600);
      await fs.rename(tempPath, targetPath);
      await fs.chmod(targetPath, 0o600);
    } catch (error) {
      if (handle) {
        await handle.close().catch(() => undefined);
      }
      await fs.rm(tempPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  async load(providerId: string, connectionId: string): Promise<Credential | null> {
    assertValidIdentifier("providerId", providerId);
    assertValidIdentifier("connectionId", connectionId);
    const filePath = this.getCredentialPath(providerId, connectionId);
    return this.readCredentialFile(filePath);
  }

  async list(providerId?: string): Promise<Credential[]> {
    if (providerId !== undefined) {
      assertValidIdentifier("providerId", providerId);
    }
    const providerIds = providerId ? [providerId] : await this.listProviderIds();
    const credentials: Credential[] = [];

    for (const currentProviderId of providerIds.sort((left, right) => left.localeCompare(right))) {
      // Skip directory entries that aren't valid identifiers (defense-in-depth
      // — list() won't pick up suspicious dirs even if they exist).
      if (!IDENTIFIER_RE.test(currentProviderId)) continue;

      const providerDir = this.getProviderPath(currentProviderId);
      let entries: DirectoryEntry[];

      try {
        entries = await fs.readdir(providerDir, { withFileTypes: true });
      } catch (error) {
        if (isNotFoundError(error)) {
          continue;
        }
        throw error;
      }

      const sortedEntries = entries.sort((left, right) => left.name.localeCompare(right.name));
      for (const entry of sortedEntries) {
        if (!entry.isFile() || !entry.name.endsWith(".json")) {
          continue;
        }

        const connectionId = entry.name.slice(0, -".json".length);
        if (!IDENTIFIER_RE.test(connectionId)) continue;
        const credential = await this.load(currentProviderId, connectionId);
        if (credential) {
          credentials.push(credential);
        }
      }
    }

    return credentials;
  }

  async remove(providerId: string, connectionId: string): Promise<void> {
    assertValidIdentifier("providerId", providerId);
    assertValidIdentifier("connectionId", connectionId);
    try {
      await fs.unlink(this.getCredentialPath(providerId, connectionId));
    } catch (error) {
      if (!isNotFoundError(error)) {
        throw error;
      }
    }
  }

  watch(callback: (credential: Credential) => void): () => void {
    const knownFiles = new Map<string, string>();
    let stopped = false;
    let polling = false;

    const syncKnownFiles = async (emitChanges: boolean): Promise<void> => {
      const currentFiles = await this.collectCredentialSignatures();

      for (const [filePath, signature] of Array.from(currentFiles.entries())) {
        const previousSignature = knownFiles.get(filePath);
        if (emitChanges && previousSignature !== signature) {
          const credential = await this.readCredentialFile(filePath);
          if (credential) {
            callback(credential);
          }
        }
      }

      for (const filePath of Array.from(knownFiles.keys())) {
        if (!currentFiles.has(filePath)) {
          knownFiles.delete(filePath);
        }
      }

      for (const [filePath, signature] of Array.from(currentFiles.entries())) {
        knownFiles.set(filePath, signature);
      }
    };

    const poll = async (): Promise<void> => {
      if (stopped || polling) {
        return;
      }

      polling = true;
      try {
        await syncKnownFiles(true);
      } finally {
        polling = false;
      }
    };

    void syncKnownFiles(false);

    const timer = setInterval(() => {
      void poll();
    }, DEFAULT_POLL_INTERVAL_MS);

    if (typeof timer.unref === "function") {
      timer.unref();
    }

    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }

  private async collectCredentialSignatures(): Promise<Map<string, string>> {
    const signatures = new Map<string, string>();
    const providerIds = await this.listProviderIds();

    for (const providerId of providerIds) {
      if (!IDENTIFIER_RE.test(providerId)) continue;
      const providerDir = this.getProviderPath(providerId);
      let entries: DirectoryEntry[];

      try {
        entries = await fs.readdir(providerDir, { withFileTypes: true });
      } catch (error) {
        if (isNotFoundError(error)) {
          continue;
        }
        throw error;
      }

      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith(".json")) {
          continue;
        }
        const connectionId = entry.name.slice(0, -".json".length);
        if (!IDENTIFIER_RE.test(connectionId)) continue;

        const filePath = path.join(providerDir, entry.name);
        try {
          const stats = await fs.stat(filePath);
          signatures.set(filePath, `${stats.mtimeMs}:${stats.size}`);
        } catch (error) {
          if (!isNotFoundError(error)) {
            throw error;
          }
        }
      }
    }

    return signatures;
  }

  private async listProviderIds(): Promise<string[]> {
    let entries: DirectoryEntry[];

    try {
      entries = await fs.readdir(this.basePath, { withFileTypes: true });
    } catch (error) {
      if (isNotFoundError(error)) {
        return [];
      }
      throw error;
    }

    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort((left, right) => left.localeCompare(right));
  }

  private async readCredentialFile(filePath: string): Promise<Credential | null> {
    let raw: string;
    try {
      raw = await fs.readFile(filePath, "utf8");
    } catch (error) {
      if (isNotFoundError(error)) {
        return null;
      }
      throw error;
    }

    const { credential, needsMigration } = deserializeCredentialFile(
      raw,
      filePath,
      filePath,
    );

    if (needsMigration) {
      // One-time migration of pre-encryption plaintext files. Re-write through
      // the encrypted save path. Failure here is non-fatal (return the loaded
      // credential anyway and let the next save migrate it).
      try {
        await this.save(credential);
      } catch {
        /* migration is best-effort */
      }
    }

    return credential;
  }

  private getProviderPath(providerId: string): string {
    // Caller-side validation already enforced by assertValidIdentifier.
    return path.join(this.basePath, providerId);
  }

  private getCredentialPath(providerId: string, connectionId: string): string {
    return path.join(this.getProviderPath(providerId), `${connectionId}.json`);
  }
}
