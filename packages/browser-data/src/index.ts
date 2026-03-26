// Types
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
  HistoryQuery,
  CryptoProvider,
  BrowserDataReader,
  BookmarkExportFormat,
  PasswordExportFormat,
  CookieExportFormat,
  HistoryTransition,
  SameSiteValue,
  SourceScheme,
  ImportPhase,
} from "./types.js";

// Schemas & helpers
export {
  BrowserNameSchema,
  BrowserFamilySchema,
  DetectedBrowserSchema,
  DetectedProfileSchema,
  ImportDataTypeSchema,
  ImportRequestSchema,
  HistoryQuerySchema,
  BookmarkSchema,
  PasswordSchema,
  BROWSER_NAMES,
  BROWSER_FAMILIES,
  IMPORT_DATA_TYPES,
  resolveProfilePath,
} from "./types.js";

// Errors
export { BrowserDataError } from "./errors.js";
export type { BrowserDataErrorCode } from "./errors.js";

// Detection
export { detectBrowsers } from "./detection/index.js";

// Readers
export { getReader } from "./readers/index.js";

// Crypto
export { createCryptoProvider } from "./crypto/index.js";

// Import
export { copyDatabaseToTemp, copyFileToTemp, cleanupTempCopy } from "./import/fileCopier.js";
export { ProgressEmitter } from "./import/progressEmitter.js";
export type { ProgressCallback } from "./import/progressEmitter.js";

// Storage
export { BrowserDataStore } from "./storage/index.js";
export { BROWSER_DATA_SCHEMA } from "./storage/index.js";
export type {
  StoredBookmark,
  StoredHistory,
  StoredVisit,
  StoredPassword,
  StoredCookie,
  StoredAutofill,
  StoredSearchEngine,
  StoredFavicon,
  StoredPermission,
  StoredImportLog,
  ImportLogEntry,
} from "./storage/index.js";

// Export
export {
  exportNetscapeBookmarks,
  exportChromiumBookmarks,
  exportCsvPasswords,
  exportNetscapeCookies,
  exportJson,
} from "./export/index.js";
export type { FullExportData } from "./export/index.js";

// Normalize helpers
export { deriveCookieUrl } from "./normalize/cookies.js";

// Pipeline
export { runImportPipeline } from "./import/pipeline.js";
