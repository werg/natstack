export const BROWSER_DATA_ERROR_CODES = [
  "BROWSER_NOT_FOUND",
  "PROFILE_NOT_FOUND",
  "PROFILE_LOCKED",
  "DB_LOCKED",
  "DB_CORRUPT",
  "PERMISSION_DENIED",
  "SCHEMA_MISMATCH",
  "DECRYPTION_FAILED",
  "WRONG_MASTER_PASSWORD",
  "KEYRING_UNAVAILABLE",
  "UNSUPPORTED_PLATFORM",
  "UNSUPPORTED_ENCRYPTION_VERSION",
  "LZ4_DECOMPRESS_FAILED",
  "EXPORT_FAILED",
  "TCC_ACCESS_DENIED",
] as const;

export type BrowserDataErrorCode = (typeof BROWSER_DATA_ERROR_CODES)[number];

export class BrowserDataError extends Error {
  readonly code: BrowserDataErrorCode;
  readonly detail?: string;

  constructor(code: BrowserDataErrorCode, message: string, detail?: string) {
    super(message);
    this.name = "BrowserDataError";
    this.code = code;
    this.detail = detail;
  }
}
