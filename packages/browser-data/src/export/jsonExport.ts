import type {
  ImportedAutofillEntry,
  ImportedBookmark,
  ImportedCookie,
  ImportedHistoryEntry,
  ImportedPassword,
  ImportedPermission,
  ImportedSearchEngine,
} from "../types.js";

export interface FullExportData {
  exportedAt: string;
  version: 1;
  bookmarks?: ImportedBookmark[];
  history?: ImportedHistoryEntry[];
  cookies?: ImportedCookie[];
  passwords?: ImportedPassword[];
  autofill?: ImportedAutofillEntry[];
  searchEngines?: ImportedSearchEngine[];
  permissions?: ImportedPermission[];
}

function replacer(_key: string, value: unknown): unknown {
  if (Buffer.isBuffer(value)) {
    return value.toString("base64");
  }
  // Buffer.toJSON() returns { type: 'Buffer', data: number[] } so also handle that
  if (
    value != null &&
    typeof value === "object" &&
    (value as { type?: string }).type === "Buffer" &&
    Array.isArray((value as { data?: unknown }).data)
  ) {
    return Buffer.from((value as { data: number[] }).data).toString("base64");
  }
  return value;
}

export function exportJson(data: FullExportData): string {
  return JSON.stringify(data, replacer, 2);
}
