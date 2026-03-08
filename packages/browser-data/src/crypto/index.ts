import type { CryptoProvider, BrowserName } from "../types.js";

/**
 * Create the platform-appropriate crypto provider.
 * Loaded lazily since crypto implementations may have platform-specific deps.
 */
export async function createCryptoProvider(): Promise<CryptoProvider> {
  const { FirefoxCrypto } = await import("./firefoxCrypto.js");
  const { ChromiumCrypto } = await import("./chromiumCrypto.js");

  const firefoxCrypto = new FirefoxCrypto();
  const chromiumCrypto = new ChromiumCrypto();

  return {
    async decryptChromiumValue(
      encrypted: Buffer,
      browser: BrowserName,
      localStatePath: string,
    ): Promise<string> {
      return chromiumCrypto.decrypt(encrypted, browser, localStatePath);
    },

    async decryptFirefoxLogin(
      encryptedBase64: string,
      key4DbPath: string,
      masterPassword?: string,
    ): Promise<string> {
      return firefoxCrypto.decryptLogin(encryptedBase64, key4DbPath, masterPassword);
    },

    canDecryptChromiumPasswords(): boolean {
      return chromiumCrypto.canDecrypt();
    },

    canDecryptChromiumCookies(): boolean {
      return chromiumCrypto.canDecrypt();
    },

    getUnsupportedReason(): string | null {
      return chromiumCrypto.getUnsupportedReason();
    },
  };
}
