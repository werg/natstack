export type {
  BrowserName,
  BrowserFamily,
  DetectedBrowser,
  DetectedProfile,
  ImportedBookmark,
  ImportedHistoryEntry,
  ImportedHistoryVisit,
  ImportHistoryBatchMeta,
  ImportBatchMeta,
  ImportedCookie,
  ImportedPassword,
  ImportedAutofillEntry,
  ImportedSearchEngine,
  ImportedExtension,
  ImportedPermission,
  ImportedSettings,
  ImportedFavicon,
  ImportedOpenTab,
  BrowserOpenTabsRequest,
  OpenTabsAsPanelsResult,
  ImportDataType,
  ImportRequest,
  ImportProgress,
  ImportResult,
  CryptoProvider,
  BrowserDataReader,
  BookmarkExportFormat,
  PasswordExportFormat,
  CookieExportFormat,
  HistoryVisitSource,
  ImportPhase,
} from "@natstack/browser-data";

export {
  BrowserDataError,
  resolveProfilePath,
} from "@natstack/browser-data";
export type { BrowserDataErrorCode } from "@natstack/browser-data";

export { detectBrowsers } from "./detection/index.js";
export { getReader } from "./readers/index.js";
export { readOpenTabs } from "./readers/openTabs.js";
export { createCryptoProvider } from "./crypto/index.js";

export { copyDatabaseToTemp, copyFileToTemp, cleanupTempCopy } from "./import/fileCopier.js";
export { ProgressEmitter } from "./import/progressEmitter.js";
export type { ProgressCallback } from "./import/progressEmitter.js";
export { runImportPipeline, previewImportPipeline } from "./import/pipeline.js";
export type { PreviewResult, PreviewTypeCounts, PreviewClassifier } from "./import/pipeline.js";

export {
  exportNetscapeBookmarks,
  exportChromiumBookmarks,
  exportCsvPasswords,
  exportNetscapeCookies,
  exportJson,
} from "./export/index.js";
export type { FullExportData } from "./export/index.js";

export { deriveCookieUrl } from "./normalize/cookies.js";
