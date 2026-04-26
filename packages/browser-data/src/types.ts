import { z } from "zod";

// ---- Browser Detection ----

export const BROWSER_NAMES = [
  "firefox", "zen", "chrome", "chrome-beta", "chrome-dev", "chrome-canary",
  "chromium", "edge", "edge-beta", "edge-dev", "brave", "vivaldi",
  "opera", "opera-gx", "arc", "safari",
] as const;

export type BrowserName = (typeof BROWSER_NAMES)[number];

export const BrowserNameSchema = z.enum(BROWSER_NAMES);

export const BROWSER_FAMILIES = ["firefox", "chromium", "safari"] as const;
export type BrowserFamily = (typeof BROWSER_FAMILIES)[number];

export const BrowserFamilySchema = z.enum(BROWSER_FAMILIES);

export interface DetectedProfile {
  id: string;
  displayName: string;
  path: string;
  isDefault: boolean;
  avatarUrl?: string;
}

export const DetectedProfileSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  path: z.string(),
  isDefault: z.boolean(),
  avatarUrl: z.string().optional(),
});

export interface DetectedBrowser {
  name: BrowserName;
  family: BrowserFamily;
  displayName: string;
  version?: string;
  dataDir: string;
  profiles: DetectedProfile[];
  tccBlocked?: boolean;
}

export const DetectedBrowserSchema = z.object({
  name: BrowserNameSchema,
  family: BrowserFamilySchema,
  displayName: z.string(),
  version: z.string().optional(),
  dataDir: z.string(),
  profiles: z.array(DetectedProfileSchema),
  tccBlocked: z.boolean().optional(),
});

// ---- History Transition Types ----

export const HISTORY_TRANSITIONS = [
  "link", "typed", "auto_bookmark", "auto_subframe", "manual_subframe",
  "generated", "auto_toplevel", "form_submit", "reload", "keyword",
  "keyword_generated", "redirect_permanent", "redirect_temporary",
] as const;

export type HistoryTransition = (typeof HISTORY_TRANSITIONS)[number];

// ---- Normalized Data Types ----

export interface ImportedBookmark {
  title: string;
  url: string;
  dateAdded: number;
  dateModified?: number;
  folder: string[];
  favicon?: Buffer;
  tags?: string[];
  keyword?: string;
}

export interface ImportedHistoryEntry {
  url: string;
  title: string;
  visitCount: number;
  lastVisitTime: number;
  firstVisitTime?: number;
  typedCount?: number;
  transition?: HistoryTransition;
}

export const SAME_SITE_VALUES = ["unspecified", "no_restriction", "lax", "strict"] as const;
export type SameSiteValue = (typeof SAME_SITE_VALUES)[number];

export const SOURCE_SCHEME_VALUES = ["unset", "non_secure", "secure"] as const;
export type SourceScheme = (typeof SOURCE_SCHEME_VALUES)[number];

export interface ImportedCookie {
  name: string;
  value: string;
  domain: string;
  hostOnly: boolean;
  path: string;
  expirationDate?: number;
  secure: boolean;
  httpOnly: boolean;
  sameSite: SameSiteValue;
  sourceScheme: SourceScheme;
  sourcePort: number;
}

export interface ImportedPassword {
  url: string;
  actionUrl?: string;
  username: string;
  password: string;
  realm?: string;
  dateCreated?: number;
  dateLastUsed?: number;
  datePasswordChanged?: number;
  timesUsed?: number;
}

export interface ImportedAutofillEntry {
  fieldName: string;
  value: string;
  dateCreated?: number;
  dateLastUsed?: number;
  timesUsed: number;
}

export interface ImportedSearchEngine {
  name: string;
  keyword?: string;
  searchUrl: string;
  suggestUrl?: string;
  faviconUrl?: string;
  isDefault: boolean;
}

export interface ImportedExtension {
  id: string;
  name: string;
  version: string;
  description?: string;
  homepageUrl?: string;
  enabled: boolean;
}

export interface ImportedPermission {
  origin: string;
  permission: string;
  setting: "allow" | "block" | "ask";
}

export interface ImportedSettings {
  homepage?: string;
  defaultSearchEngine?: string;
  showBookmarksBar?: boolean;
  [key: string]: unknown;
}

export interface ImportedFavicon {
  url: string;
  data: Buffer;
  mimeType: string;
}

// ---- Import Pipeline ----

export const IMPORT_DATA_TYPES = [
  "bookmarks", "history", "cookies", "passwords", "autofill",
  "searchEngines", "extensions", "permissions", "settings", "favicons",
] as const;

export type ImportDataType = (typeof IMPORT_DATA_TYPES)[number];

export const ImportDataTypeSchema = z.enum(IMPORT_DATA_TYPES);

export interface ImportRequest {
  browser: BrowserName;
  /** Pass a DetectedProfile object or a profile path string. */
  profile?: DetectedProfile | string;
  dataTypes: ImportDataType[];
  masterPassword?: string;
  csvPasswordFile?: string;
}

export const ImportRequestSchema = z.object({
  browser: BrowserNameSchema,
  profile: z.union([DetectedProfileSchema, z.string()]).optional(),
  dataTypes: z.array(ImportDataTypeSchema),
  masterPassword: z.string().optional(),
  csvPasswordFile: z.string().optional(),
}).refine(
  (r) => r.profile != null,
  { message: "'profile' (DetectedProfile or path string) is required" },
);

/** Resolve an ImportRequest's profile to a concrete path string. */
export function resolveProfilePath(request: ImportRequest): string {
  if (request.profile != null) {
    return typeof request.profile === "string" ? request.profile : request.profile.path;
  }
  throw new Error("'profile' must be provided");
}

export type ImportPhase =
  | "copying" | "reading" | "decrypting" | "normalizing"
  | "storing" | "done" | "error";

export interface ImportProgress {
  requestId: string;
  dataType: ImportDataType;
  phase: ImportPhase;
  itemsProcessed: number;
  totalItems?: number;
  error?: string;
}

export interface ImportResult {
  dataType: ImportDataType;
  success: boolean;
  itemCount: number;
  skippedCount: number;
  error?: string;
  warnings: string[];
}

// ---- Crypto ----

export interface CryptoProvider {
  decryptChromiumValue(
    encrypted: Buffer,
    browser: BrowserName,
    localStatePath: string,
  ): Promise<string>;
  decryptFirefoxLogin(
    encryptedBase64: string,
    key4DbPath: string,
    masterPassword?: string,
  ): Promise<string>;
  canDecryptChromiumPasswords(): boolean;
  canDecryptChromiumCookies(): boolean;
  getUnsupportedReason(): string | null;
}

// ---- Reader Interface ----

export interface BrowserDataReader {
  readBookmarks(profilePath: string): Promise<ImportedBookmark[]>;
  readHistory(profilePath: string): Promise<ImportedHistoryEntry[]>;
  readCookies(profilePath: string): Promise<ImportedCookie[]>;
  readPasswords(profilePath: string): Promise<ImportedPassword[]>;
  readAutofill(profilePath: string): Promise<ImportedAutofillEntry[]>;
  readSearchEngines(profilePath: string): Promise<ImportedSearchEngine[]>;
  readExtensions(profilePath: string): Promise<ImportedExtension[]>;
  readPermissions(profilePath: string): Promise<ImportedPermission[]>;
  readSettings(profilePath: string): Promise<ImportedSettings>;
  readFavicons(profilePath: string): Promise<ImportedFavicon[]>;
}

// ---- Export Formats ----

export type BookmarkExportFormat = "html" | "json" | "chrome-json";
export type PasswordExportFormat = "csv-chrome" | "csv-firefox" | "json";
export type CookieExportFormat = "json" | "netscape-txt";

// ---- Storage Query Types ----

export interface HistoryQuery {
  search?: string;
  startTime?: number;
  endTime?: number;
  limit?: number;
  offset?: number;
}

export const HistoryQuerySchema = z.object({
  search: z.string().optional(),
  startTime: z.number().optional(),
  endTime: z.number().optional(),
  limit: z.number().optional(),
  offset: z.number().optional(),
});

// ---- Zod Schemas for Service Methods ----

export const BookmarkSchema = z.object({
  title: z.string(),
  url: z.string().optional(),
  folderPath: z.string().optional(),
  dateAdded: z.number().optional(),
  tags: z.string().optional(),
  keyword: z.string().optional(),
  position: z.number().optional(),
});

export const PasswordSchema = z.object({
  url: z.string(),
  username: z.string(),
  password: z.string(),
  actionUrl: z.string().optional(),
  realm: z.string().optional(),
});
