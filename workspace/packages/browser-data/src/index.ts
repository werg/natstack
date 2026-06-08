export type {
  BrowserName,
  BrowserFamily,
  DetectedBrowser,
  DetectedProfile,
  ImportedBookmark,
  ImportedHistoryEntry,
  ImportedCookie,
  ImportedPassword,
  ImportedAutofillEntry,
  ImportedSearchEngine,
  ImportedExtension,
  ImportedPermission,
  ImportedSettings,
  ImportedFavicon,
  ImportDataType,
  ImportRequest,
  ImportProgress,
  ImportResult,
  CryptoProvider,
  BrowserDataReader,
  BookmarkExportFormat,
  PasswordExportFormat,
  CookieExportFormat,
  ImportPhase,
} from "@natstack/browser-data";

export {
  BrowserDataError,
  resolveProfilePath,
} from "@natstack/browser-data";
export type { BrowserDataErrorCode } from "@natstack/browser-data";

export { detectBrowsers } from "./detection/index.js";
export { getReader } from "./readers/index.js";
export { createCryptoProvider } from "./crypto/index.js";

export { copyDatabaseToTemp, copyFileToTemp, cleanupTempCopy } from "./import/fileCopier.js";
export { ProgressEmitter } from "./import/progressEmitter.js";
export type { ProgressCallback } from "./import/progressEmitter.js";
export { runImportPipeline } from "./import/pipeline.js";

export {
  exportNetscapeBookmarks,
  exportChromiumBookmarks,
  exportCsvPasswords,
  exportNetscapeCookies,
  exportJson,
} from "./export/index.js";
export type { FullExportData } from "./export/index.js";

export { deriveCookieUrl } from "./normalize/cookies.js";
