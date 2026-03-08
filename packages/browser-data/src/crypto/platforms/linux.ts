import * as crypto from "node:crypto";
import { execSync } from "node:child_process";
import type { BrowserName } from "../../types.js";
import { BrowserDataError } from "../../errors.js";

/** Map browser names to keyring application identifiers. */
const KEYRING_APP_NAMES: Partial<Record<BrowserName, string>> = {
  chrome: "chrome",
  "chrome-beta": "chrome",
  "chrome-dev": "chrome",
  "chrome-canary": "chrome",
  chromium: "chromium",
  edge: "microsoft-edge",
  "edge-beta": "microsoft-edge",
  "edge-dev": "microsoft-edge",
  brave: "brave",
  vivaldi: "vivaldi",
  opera: "opera",
  "opera-gx": "opera",
};

/**
 * Derive an AES-128-CBC key from a password using PBKDF2.
 * Chromium on Linux/macOS uses: salt="saltysalt", iterations=1, keylen=16, sha1.
 */
export function deriveKey(password: string): Buffer {
  return crypto.pbkdf2Sync(password, "saltysalt", 1, 16, "sha1");
}

/**
 * Try to retrieve the browser's encryption password from GNOME Keyring or KWallet.
 * Returns null if the password cannot be found.
 */
export async function getKeyFromKeyring(browser: BrowserName): Promise<string | null> {
  const app = KEYRING_APP_NAMES[browser] || browser;

  // Try GNOME Keyring via secret-tool
  try {
    const result = execSync(`secret-tool lookup application ${app}`, {
      encoding: "utf-8",
      timeout: 5000,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    if (result) return result;
  } catch {
    // Not available or no entry
  }

  // Try KWallet via kwallet-query
  try {
    const result = execSync(
      `kwallet-query kdewallet -f "Chrome Keys" -r "${app}"`,
      {
        encoding: "utf-8",
        timeout: 5000,
        stdio: ["pipe", "pipe", "pipe"],
      },
    ).trim();
    if (result) return result;
  } catch {
    // Not available or no entry
  }

  return null;
}

/**
 * Get the decryption key for a Chromium browser on Linux.
 *
 * For v11: attempts GNOME Keyring / KWallet lookup.
 * For v10 or fallback: uses the hardcoded "peanuts" password.
 */
export async function getLinuxDecryptionKey(
  browser: BrowserName,
  version: "v10" | "v11",
): Promise<Buffer> {
  if (version === "v11") {
    try {
      const password = await getKeyFromKeyring(browser);
      if (password) {
        return deriveKey(password);
      }
    } catch {
      // Fall through to peanuts
    }
    throw new BrowserDataError(
      "KEYRING_UNAVAILABLE",
      "Could not retrieve encryption key from keyring; falling back to default key",
    );
  }

  // v10 always uses "peanuts"
  return deriveKey("peanuts");
}

/**
 * Decrypt a Chromium encrypted value using AES-128-CBC (Linux format).
 * The encrypted buffer should have its 3-byte version prefix already stripped
 * OR be passed as the full buffer (prefix will be stripped here).
 */
export function decryptLinuxValue(encrypted: Buffer, key: Buffer): string {
  // Strip version prefix (3 bytes: "v10" or "v11") if present
  const prefix = encrypted.subarray(0, 3).toString("ascii");
  const data = prefix === "v10" || prefix === "v11"
    ? encrypted.subarray(3)
    : encrypted;

  // AES-128-CBC with IV = 16 bytes of space (0x20)
  const iv = Buffer.alloc(16, 0x20);
  const decipher = crypto.createDecipheriv("aes-128-cbc", key, iv);
  const decrypted = Buffer.concat([decipher.update(data), decipher.final()]);
  return decrypted.toString("utf-8");
}
