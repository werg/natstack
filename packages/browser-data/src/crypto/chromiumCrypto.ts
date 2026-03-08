import type { BrowserName } from "../types.js";
import { BrowserDataError } from "../errors.js";

/**
 * Chromium password/cookie decryption.
 *
 * Version-dispatching decryptor that handles v10, v11, and v20 encryption
 * across Linux, macOS, and Windows.
 */
export class ChromiumCrypto {
  private keyCache = new Map<string, Buffer>();
  private platform: NodeJS.Platform;

  constructor(platform?: NodeJS.Platform) {
    this.platform = platform ?? process.platform;
  }

  /**
   * Decrypt a Chromium encrypted value (cookie or password).
   *
   * Detects the encryption version from the prefix bytes and dispatches
   * to the appropriate platform-specific decryption.
   */
  async decrypt(
    encrypted: Buffer,
    browser: BrowserName,
    localStatePath: string,
  ): Promise<string> {
    if (!encrypted || encrypted.length === 0) {
      return "";
    }

    // Detect version prefix from first 3 bytes
    const prefix = encrypted.subarray(0, 3).toString("ascii");

    if (prefix === "v20") {
      return this.decryptV20(encrypted, localStatePath);
    }
    if (prefix === "v11") {
      return this.decryptV11(encrypted, browser);
    }
    if (prefix === "v10") {
      return this.decryptV10(encrypted, browser, localStatePath);
    }

    // No recognized prefix: try platform default (legacy unencrypted or old DPAPI)
    return this.decryptLegacy(encrypted, browser, localStatePath);
  }

  /**
   * Whether this platform can decrypt Chromium values.
   */
  canDecrypt(): boolean {
    return this.platform === "linux"
      || this.platform === "darwin"
      || this.platform === "win32";
  }

  /**
   * If decryption is unsupported, explains why. Returns null if supported.
   */
  getUnsupportedReason(): string | null {
    if (this.canDecrypt()) return null;
    return `Chromium decryption is not supported on platform: ${this.platform}`;
  }

  // ---- Version-specific decryption ----

  /**
   * v10: Standard cross-platform encryption.
   * - Linux: AES-128-CBC with "peanuts"-derived key
   * - macOS: AES-128-CBC with Keychain-derived key
   * - Windows: AES-256-GCM with DPAPI-protected key from Local State
   */
  private async decryptV10(
    encrypted: Buffer,
    browser: BrowserName,
    localStatePath: string,
  ): Promise<string> {
    switch (this.platform) {
      case "linux": {
        const { getLinuxDecryptionKey, decryptLinuxValue } = await import("./platforms/linux.js");
        const key = await this.getCachedKey(`linux:v10:${browser}`, () =>
          getLinuxDecryptionKey(browser, "v10"),
        );
        return decryptLinuxValue(encrypted, key);
      }
      case "darwin": {
        const { getDarwinDecryptionKey, decryptDarwinValue } = await import("./platforms/darwin.js");
        const key = await this.getCachedKey(`darwin:${browser}`, () =>
          getDarwinDecryptionKey(browser),
        );
        return decryptDarwinValue(encrypted, key);
      }
      case "win32": {
        const { getWin32DecryptionKey, decryptWin32Value } = await import("./platforms/win32.js");
        const key = await this.getCachedKey(`win32:${localStatePath}`, () =>
          getWin32DecryptionKey(localStatePath),
        );
        return decryptWin32Value(encrypted, key);
      }
      default:
        throw new BrowserDataError(
          "UNSUPPORTED_PLATFORM",
          `v10 decryption not supported on ${this.platform}`,
        );
    }
  }

  /**
   * v11: GNOME Keyring / KWallet encryption (Linux only).
   * Uses the same AES-128-CBC algorithm as v10 but with a keyring-provided password.
   */
  private async decryptV11(encrypted: Buffer, browser: BrowserName): Promise<string> {
    if (this.platform !== "linux") {
      throw new BrowserDataError(
        "UNSUPPORTED_ENCRYPTION_VERSION",
        `v11 encryption is Linux-specific, current platform: ${this.platform}`,
      );
    }

    const { getLinuxDecryptionKey, decryptLinuxValue } = await import("./platforms/linux.js");

    let key: Buffer;
    try {
      key = await this.getCachedKey(`linux:v11:${browser}`, () =>
        getLinuxDecryptionKey(browser, "v11"),
      );
    } catch (err) {
      if (err instanceof BrowserDataError && err.code === "KEYRING_UNAVAILABLE") {
        // Fall back to "peanuts" key
        const { deriveKey } = await import("./platforms/linux.js");
        key = deriveKey("peanuts");
      } else {
        throw err;
      }
    }

    return decryptLinuxValue(encrypted, key);
  }

  /**
   * v20: App-Bound Encryption (Windows only, Chrome 127+).
   * Currently not decryptable without elevated privileges.
   */
  private async decryptV20(
    _encrypted: Buffer,
    _localStatePath: string,
  ): Promise<string> {
    throw new BrowserDataError(
      "UNSUPPORTED_ENCRYPTION_VERSION",
      "v20 (App-Bound Encryption) is not yet supported. " +
        "Chrome 127+ on Windows uses this for cookies. " +
        "Password export via CSV is recommended instead.",
    );
  }

  /**
   * Legacy: No version prefix.
   * - Windows: raw DPAPI-encrypted blob (pre-v10)
   * - Linux/macOS: may be plaintext or very old encryption
   */
  private async decryptLegacy(
    encrypted: Buffer,
    _browser: BrowserName,
    _localStatePath: string,
  ): Promise<string> {
    if (this.platform === "win32") {
      // Old Windows DPAPI without AES layer - decrypt directly via PowerShell
      const { execSync } = await import("node:child_process");
      const psScript = [
        "Add-Type -AssemblyName System.Security;",
        `$encrypted = [Convert]::FromBase64String("${encrypted.toString("base64")}");`,
        "$decrypted = [Security.Cryptography.ProtectedData]::Unprotect($encrypted, $null, 'CurrentUser');",
        "[Text.Encoding]::UTF8.GetString($decrypted)",
      ].join(" ");

      try {
        return execSync(`powershell -NoProfile -Command "${psScript}"`, {
          encoding: "utf-8",
          timeout: 10000,
          stdio: ["pipe", "pipe", "pipe"],
        }).trim();
      } catch (err) {
        throw new BrowserDataError(
          "DECRYPTION_FAILED",
          "Legacy DPAPI decryption failed",
          err instanceof Error ? err.message : String(err),
        );
      }
    }

    // On Linux/macOS, values without a prefix might be plaintext
    const text = encrypted.toString("utf-8");
    // Heuristic: if it looks like printable text, return it
    if (/^[\x20-\x7e]*$/.test(text)) {
      return text;
    }

    throw new BrowserDataError(
      "DECRYPTION_FAILED",
      "Unrecognized encryption format (no version prefix)",
    );
  }

  // ---- Key caching ----

  private async getCachedKey(
    cacheKey: string,
    derive: () => Promise<Buffer>,
  ): Promise<Buffer> {
    const cached = this.keyCache.get(cacheKey);
    if (cached) return cached;

    const key = await derive();
    this.keyCache.set(cacheKey, key);
    return key;
  }
}
