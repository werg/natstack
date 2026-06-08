import type { ImportedBookmark } from "../types.js";

/**
 * Deduplicate bookmarks by URL within the same folder.
 * Keeps the most recently added bookmark when duplicates are found.
 */
export function deduplicateBookmarks(bookmarks: ImportedBookmark[]): ImportedBookmark[] {
  const seen = new Map<string, ImportedBookmark>();

  for (const bookmark of bookmarks) {
    const key = `${bookmark.folder.join("/")}|${bookmark.url}`;
    const existing = seen.get(key);
    if (!existing || bookmark.dateAdded > existing.dateAdded) {
      seen.set(key, bookmark);
    }
  }

  return Array.from(seen.values());
}

/**
 * Reconstruct a folder path from a parent chain.
 * Used by Firefox reader where bookmarks have parent IDs.
 */
export function buildFolderPath(
  parentId: number,
  parentMap: Map<number, { title: string; parentId: number }>,
  rootIds: Set<number>,
): string[] {
  const path: string[] = [];
  let currentId = parentId;

  while (currentId && !rootIds.has(currentId)) {
    const parent = parentMap.get(currentId);
    if (!parent) break;
    if (parent.title) {
      path.unshift(parent.title);
    }
    currentId = parent.parentId;
  }

  return path;
}

/**
 * Normalize a bookmark title - trim whitespace, remove null bytes.
 */
export function normalizeTitle(title: string | null | undefined): string {
  if (!title) return "";
  return title.replace(/\0/g, "").trim();
}
