import * as crypto from "node:crypto";
import * as fs from "node:fs";
import { execSync } from "node:child_process";
import { BrowserDataError } from "../../errors.js";

/**
 * Get the AES-256-GCM decryption key for a Chromium browser on Windows.
 *
 * Reads the encrypted key from the browser's "Local State" file,
 * strips the "DPAPI" prefix, and decrypts via Windows DPAPI (PowerShell).
 */
export async function getWin32DecryptionKey(localStatePath: string): Promise<Buffer> {
  let localState: { os_crypt?: { encrypted_key?: string } };
  try {
    localState = JSON.parse(fs.readFileSync(localStatePath, "utf-8"));
  } catch (err) {
    throw new BrowserDataError(
      "DECRYPTION_FAILED",
      `Could not read Local State file: ${localStatePath}`,
      err instanceof Error ? err.message : String(err),
    );
  }

  const encryptedKeyB64 = localState?.os_crypt?.encrypted_key;
  if (!encryptedKeyB64) {
    throw new BrowserDataError(
      "DECRYPTION_FAILED",
      "No encrypted_key found in Local State os_crypt section",
    );
  }

  // Base64-decode and strip the 5-byte "DPAPI" prefix
  const encryptedKey = Buffer.from(encryptedKeyB64, "base64").subarray(5);

  // Decrypt via DPAPI using PowerShell
  const psScript = [
    "Add-Type -AssemblyName System.Security;",
    `$encrypted = [Convert]::FromBase64String("${encryptedKey.toString("base64")}");`,
    "$decrypted = [Security.Cryptography.ProtectedData]::Unprotect($encrypted, $null, 'CurrentUser');",
    "[Convert]::ToBase64String($decrypted)",
  ].join(" ");

  let result: string;
  try {
    result = execSync(`powershell -NoProfile -Command "${psScript}"`, {
      encoding: "utf-8",
      timeout: 10000,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch (err) {
    throw new BrowserDataError(
      "DECRYPTION_FAILED",
      "DPAPI decryption of browser key failed",
      err instanceof Error ? err.message : String(err),
    );
  }

  return Buffer.from(result, "base64");
}

/**
 * Decrypt a Chromium encrypted value using AES-256-GCM (Windows format).
 *
 * Layout after stripping the 3-byte "v10" prefix:
 *   [nonce: 12 bytes][ciphertext: N bytes][auth tag: 16 bytes]
 */
export function decryptWin32Value(encrypted: Buffer, key: Buffer): string {
  // Strip version prefix (3 bytes: "v10")
  const prefix = encrypted.subarray(0, 3).toString("ascii");
  const data = prefix === "v10" ? encrypted.subarray(3) : encrypted;

  const nonce = data.subarray(0, 12);
  const ciphertext = data.subarray(12, data.length - 16);
  const tag = data.subarray(data.length - 16);

  const decipher = crypto.createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return decrypted.toString("utf-8");
}
