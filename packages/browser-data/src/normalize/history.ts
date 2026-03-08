import type { ImportedHistoryEntry } from "../types.js";

/** Firefox timestamps are microseconds since Unix epoch */
export function firefoxTimestampToMs(microseconds: number): number {
  return Math.floor(microseconds / 1000);
}

/** Chrome timestamps are microseconds since 1601-01-01 */
const CHROME_EPOCH_OFFSET = 11644473600000000n; // microseconds between 1601-01-01 and 1970-01-01

export function chromeTimestampToMs(chromeTimestamp: number | bigint): number {
  const us = BigInt(chromeTimestamp);
  const unixUs = us - CHROME_EPOCH_OFFSET;
  return Number(unixUs / 1000n);
}

/** Safari timestamps are seconds since 2001-01-01 (Mac epoch) */
const MAC_EPOCH_OFFSET = 978307200; // seconds between 1970-01-01 and 2001-01-01

export function macTimestampToMs(macSeconds: number): number {
  return Math.floor((macSeconds + MAC_EPOCH_OFFSET) * 1000);
}

/**
 * Deduplicate history entries by URL, merging visit counts and keeping
 * the most recent visit time and earliest first visit time.
 */
export function deduplicateHistory(entries: ImportedHistoryEntry[]): ImportedHistoryEntry[] {
  const byUrl = new Map<string, ImportedHistoryEntry>();

  for (const entry of entries) {
    const existing = byUrl.get(entry.url);
    if (!existing) {
      byUrl.set(entry.url, { ...entry });
    } else {
      existing.visitCount += entry.visitCount;
      existing.typedCount = (existing.typedCount || 0) + (entry.typedCount || 0);
      if (entry.lastVisitTime > existing.lastVisitTime) {
        existing.lastVisitTime = entry.lastVisitTime;
        existing.title = entry.title || existing.title;
      }
      if (entry.firstVisitTime) {
        existing.firstVisitTime = existing.firstVisitTime
          ? Math.min(existing.firstVisitTime, entry.firstVisitTime)
          : entry.firstVisitTime;
      }
    }
  }

  return Array.from(byUrl.values());
}
