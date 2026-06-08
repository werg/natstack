import type { BrowserFamily, BrowserName, BrowserDataReader, CryptoProvider } from "../types.js";

export interface ReaderOptions {
  cryptoProvider?: CryptoProvider;
  browser?: BrowserName;
}

/**
 * Get the appropriate reader for a browser family.
 * Readers are loaded lazily to avoid loading all parsers upfront.
 */
export async function getReader(family: BrowserFamily, options?: ReaderOptions): Promise<BrowserDataReader> {
  switch (family) {
    case "firefox": {
      const { FirefoxReader } = await import("./firefoxReader.js");
      return new FirefoxReader();
    }
    case "chromium": {
      const { ChromiumReader } = await import("./chromiumReader.js");
      return new ChromiumReader(options);
    }
    case "safari": {
      const { SafariReader } = await import("./safariReader.js");
      return new SafariReader();
    }
    default:
      throw new Error(`Unknown browser family: ${family}`);
  }
}
