import * as crypto from "node:crypto";
import type {
  ImportRequest,
  ImportResult,
  ImportDataType,
  BrowserName,
  BrowserFamily,
  CryptoProvider,
} from "../types.js";
import { resolveProfilePath } from "../types.js";
import { BrowserDataError } from "../errors.js";
import { detectBrowsers } from "../detection/index.js";
import { getReader } from "../readers/index.js";
import { createCryptoProvider } from "../crypto/index.js";
import { ProgressEmitter, type ProgressCallback } from "./progressEmitter.js";
import type { BrowserDataStore } from "../storage/index.js";

function getBrowserFamily(name: BrowserName): BrowserFamily {
  if (name === "firefox" || name === "zen") return "firefox";
  if (name === "safari") return "safari";
  return "chromium";
}

/**
 * Run a full import pipeline: detect -> read -> decrypt -> normalize -> store.
 *
 * Each data type is imported independently so failures in one type don't
 * block others.
 */
export async function runImportPipeline(
  request: ImportRequest,
  store: BrowserDataStore,
  onProgress?: ProgressCallback,
): Promise<ImportResult[]> {
  // Resolve profile/profilePath to a concrete path, then normalize request
  const profilePath = resolveProfilePath(request);
  const resolved = { ...request, profilePath };

  const requestId = crypto.randomUUID();
  const progress = new ProgressEmitter(requestId, onProgress || (() => {}));
  const family = getBrowserFamily(resolved.browser);

  // Create crypto provider once for the entire pipeline.
  // For Chromium, this is passed to the reader so it can decrypt inline.
  let cryptoProvider: CryptoProvider | undefined;
  try {
    cryptoProvider = await createCryptoProvider();
  } catch (err) {
    // Crypto unavailable — passwords/cookies may not decrypt
    console.warn("[BrowserData] Crypto provider unavailable — passwords/cookies may not decrypt:", err instanceof Error ? err.message : String(err));
  }

  const reader = await getReader(family, {
    cryptoProvider,
    browser: resolved.browser,
  });
  const results: ImportResult[] = [];

  for (const dataType of resolved.dataTypes) {
    try {
      const result = await importDataType(
        dataType,
        resolved,
        reader,
        family,
        store,
        progress,
        cryptoProvider,
      );
      results.push(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      results.push({
        dataType,
        success: false,
        itemCount: 0,
        skippedCount: 0,
        error: message,
        warnings: [],
      });
      progress.error(dataType, message);
    }
  }

  return results;
}

async function importDataType(
  dataType: ImportDataType,
  request: ImportRequest & { profilePath: string },
  reader: Awaited<ReturnType<typeof getReader>>,
  family: BrowserFamily,
  store: BrowserDataStore,
  progress: ProgressEmitter,
  cryptoProvider?: CryptoProvider,
): Promise<ImportResult> {
  const warnings: string[] = [];

  progress.copying(dataType);

  switch (dataType) {
    case "bookmarks": {
      progress.reading(dataType, 0);
      const bookmarks = await reader.readBookmarks(request.profilePath);
      progress.reading(dataType, bookmarks.length, bookmarks.length);
      progress.storing(dataType, 0, bookmarks.length);
      store.bookmarks.addBatch(bookmarks);
      progress.done(dataType, bookmarks.length);
      return {
        dataType,
        success: true,
        itemCount: bookmarks.length,
        skippedCount: 0,
        warnings,
      };
    }

    case "history": {
      progress.reading(dataType, 0);
      const history = await reader.readHistory(request.profilePath);
      progress.reading(dataType, history.length, history.length);
      progress.storing(dataType, 0, history.length);
      store.history.addBatch(history);
      progress.done(dataType, history.length);
      return {
        dataType,
        success: true,
        itemCount: history.length,
        skippedCount: 0,
        warnings,
      };
    }

    case "cookies": {
      progress.reading(dataType, 0);
      const cookies = await reader.readCookies(request.profilePath);
      progress.reading(dataType, cookies.length, cookies.length);

      // Count cookies with empty values (failed decryption) as skipped
      const skipped = cookies.filter((c) => c.value === "").length;
      if (skipped > 0) {
        warnings.push(
          `${skipped} cookies had encrypted values that could not be decrypted`,
        );
      }

      progress.storing(dataType, 0, cookies.length);
      store.cookies.addBatch(cookies);
      progress.done(dataType, cookies.length);
      return {
        dataType,
        success: true,
        itemCount: cookies.length - skipped,
        skippedCount: skipped,
        warnings,
      };
    }

    case "passwords": {
      progress.reading(dataType, 0);
      let passwords = await reader.readPasswords(request.profilePath);
      progress.reading(dataType, passwords.length, passwords.length);

      // Handle Safari CSV import
      if (family === "safari" && request.csvPasswordFile) {
        const { SafariReader } = await import("../readers/safariReader.js");
        const safariReader = new SafariReader();
        const csvPasswords = await safariReader.readPasswordsFromCsv(
          request.csvPasswordFile,
        );
        passwords = [...passwords, ...csvPasswords];
      }

      // Decrypt Firefox passwords (they come as base64-encoded encrypted strings)
      let skipped = 0;
      if (family === "firefox" && cryptoProvider) {
        progress.decrypting(dataType, 0, passwords.length);
        const decryptedPasswords = [];
        for (const pw of passwords) {
          try {
            const username = await cryptoProvider.decryptFirefoxLogin(
              pw.username,
              request.profilePath + "/key4.db",
              request.masterPassword,
            );
            const password = await cryptoProvider.decryptFirefoxLogin(
              pw.password,
              request.profilePath + "/key4.db",
              request.masterPassword,
            );
            decryptedPasswords.push({ ...pw, username, password });
          } catch (err) {
            if (
              err instanceof BrowserDataError &&
              err.code === "WRONG_MASTER_PASSWORD"
            ) {
              throw err; // Re-throw master password errors
            }
            skipped++;
            warnings.push(
              `Failed to decrypt password for ${pw.url}: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
          progress.decrypting(dataType, decryptedPasswords.length + skipped, passwords.length);
        }
        passwords = decryptedPasswords;
        if (skipped > 0) {
          warnings.push(`${skipped} passwords could not be decrypted`);
        }
      }

      // For Chromium, decryption happens in the reader. Count empty passwords as skipped.
      if (family === "chromium") {
        const emptyCount = passwords.filter((p) => p.password === "").length;
        if (emptyCount > 0) {
          skipped += emptyCount;
          warnings.push(
            `${emptyCount} passwords had encrypted values that could not be decrypted`,
          );
        }
      }

      progress.storing(dataType, 0, passwords.length);
      store.passwords.addBatch(passwords);
      progress.done(dataType, passwords.length);
      return {
        dataType,
        success: true,
        itemCount: passwords.length - skipped,
        skippedCount: skipped,
        warnings,
      };
    }

    case "autofill": {
      progress.reading(dataType, 0);
      const entries = await reader.readAutofill(request.profilePath);
      progress.reading(dataType, entries.length, entries.length);
      progress.storing(dataType, 0, entries.length);
      store.autofill.addBatch(entries);
      progress.done(dataType, entries.length);
      return {
        dataType,
        success: true,
        itemCount: entries.length,
        skippedCount: 0,
        warnings,
      };
    }

    case "searchEngines": {
      progress.reading(dataType, 0);
      const engines = await reader.readSearchEngines(request.profilePath);
      progress.reading(dataType, engines.length, engines.length);
      progress.storing(dataType, 0, engines.length);
      store.searchEngines.addBatch(engines);
      progress.done(dataType, engines.length);
      return {
        dataType,
        success: true,
        itemCount: engines.length,
        skippedCount: 0,
        warnings,
      };
    }

    case "extensions": {
      progress.reading(dataType, 0);
      const extensions = await reader.readExtensions(request.profilePath);
      progress.reading(dataType, extensions.length, extensions.length);
      // Extensions are metadata-only, no storage needed currently
      progress.done(dataType, extensions.length);
      return {
        dataType,
        success: true,
        itemCount: extensions.length,
        skippedCount: 0,
        warnings,
      };
    }

    case "permissions": {
      progress.reading(dataType, 0);
      const permissions = await reader.readPermissions(request.profilePath);
      progress.reading(dataType, permissions.length, permissions.length);
      progress.storing(dataType, 0, permissions.length);
      store.permissions.addBatch(permissions);
      progress.done(dataType, permissions.length);
      return {
        dataType,
        success: true,
        itemCount: permissions.length,
        skippedCount: 0,
        warnings,
      };
    }

    case "settings": {
      progress.reading(dataType, 0);
      const settings = await reader.readSettings(request.profilePath);
      progress.reading(dataType, 0, 0);
      // Settings are read but not stored (no settings table yet)
      const settingsCount = Object.keys(settings).length;
      if (settingsCount > 0) {
        warnings.push(
          `${settingsCount} settings were read but not stored (settings storage not yet implemented)`,
        );
      }
      progress.done(dataType, 0);
      return {
        dataType,
        success: true,
        itemCount: 0,
        skippedCount: settingsCount,
        warnings,
      };
    }

    case "favicons": {
      progress.reading(dataType, 0);
      const favicons = await reader.readFavicons(request.profilePath);
      progress.reading(dataType, favicons.length, favicons.length);
      progress.storing(dataType, 0, favicons.length);
      store.favicons.addBatch(favicons);
      progress.done(dataType, favicons.length);
      return {
        dataType,
        success: true,
        itemCount: favicons.length,
        skippedCount: 0,
        warnings,
      };
    }

    default:
      throw new BrowserDataError(
        "BROWSER_NOT_FOUND",
        `Unknown data type: ${dataType}`,
      );
  }
}
