import * as crypto from "node:crypto";
import { execSync } from "node:child_process";
import type { BrowserName } from "../../types.js";
import { BrowserDataError } from "../../errors.js";

/** Map browser names to macOS Keychain service names. */
const KEYCHAIN_SERVICE_NAMES: Partial<Record<BrowserName, string>> = {
  chrome: "Chrome Safe Storage",
  "chrome-beta": "Chrome Safe Storage",
  "chrome-dev": "Chrome Safe Storage",
  "chrome-canary": "Chrome Safe Storage",
  chromium: "Chromium Safe Storage",
  edge: "Microsoft Edge Safe Storage",
  "edge-beta": "Microsoft Edge Safe Storage",
  "edge-dev": "Microsoft Edge Safe Storage",
  brave: "Brave Safe Storage",
  vivaldi: "Vivaldi Safe Storage",
  opera: "Opera Safe Storage",
  "opera-gx": "Opera Safe Storage",
  arc: "Arc Safe Storage",
};

/**
 * Derive an AES-128-CBC key from a password using PBKDF2.
 * Same parameters as Linux: salt="saltysalt", iterations=1, keylen=16, sha1.
 */
export function deriveKey(password: string): Buffer {
  return crypto.pbkdf2Sync(password, "saltysalt", 1, 16, "sha1");
}

/**
 * Get the decryption key for a Chromium browser on macOS.
 * Retrieves the password from the macOS Keychain via `security` CLI.
 */
export async function getDarwinDecryptionKey(browser: BrowserName): Promise<Buffer> {
  const service = KEYCHAIN_SERVICE_NAMES[browser];
  if (!service) {
    throw new BrowserDataError(
      "UNSUPPORTED_PLATFORM",
      `Unknown browser for macOS Keychain: ${browser}`,
    );
  }

  let password: string;
  try {
    password = execSync(
      `security find-generic-password -s "${service}" -w`,
      {
        encoding: "utf-8",
        timeout: 5000,
        stdio: ["pipe", "pipe", "pipe"],
      },
    ).trim();
  } catch (err) {
    throw new BrowserDataError(
      "DECRYPTION_FAILED",
      `Could not retrieve "${service}" password from Keychain`,
      err instanceof Error ? err.message : String(err),
    );
  }

  return deriveKey(password);
}

/**
 * Decrypt a Chromium encrypted value using AES-128-CBC (macOS format).
 * Identical to the Linux decryption format.
 */
export function decryptDarwinValue(encrypted: Buffer, key: Buffer): string {
  // Strip version prefix (3 bytes: "v10")
  const prefix = encrypted.subarray(0, 3).toString("ascii");
  const data = prefix === "v10" ? encrypted.subarray(3) : encrypted;

  // AES-128-CBC with IV = 16 bytes of space (0x20)
  const iv = Buffer.alloc(16, 0x20);
  const decipher = crypto.createDecipheriv("aes-128-cbc", key, iv);
  const decrypted = Buffer.concat([decipher.update(data), decipher.final()]);
  return decrypted.toString("utf-8");
}
