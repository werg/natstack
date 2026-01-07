/**
 * Format a date as relative time (e.g., "5m ago", "2h ago", "3d ago")
 */
export function formatRelativeTime(date: Date): string {
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffSecs = Math.floor(diffMs / 1000);
  const diffMins = Math.floor(diffSecs / 60);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffSecs < 60) return "just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  if (diffDays < 30) return `${Math.floor(diffDays / 7)}w ago`;
  if (diffDays < 365) return `${Math.floor(diffDays / 30)}mo ago`;
  return `${Math.floor(diffDays / 365)}y ago`;
}

/**
 * Convert a Unix timestamp to a Date, handling both seconds and milliseconds.
 * Git timestamps are typically in seconds, but some APIs return milliseconds.
 *
 * Heuristic: If the timestamp is before year 2001 when interpreted as seconds,
 * assume it's in milliseconds. Year 2001 = ~978307200 seconds.
 *
 * @param timestamp - Unix timestamp (seconds or milliseconds)
 * @returns Date object, or null if timestamp is invalid
 */
export function timestampToDate(timestamp: number): Date | null {
  if (typeof timestamp !== "number" || !Number.isFinite(timestamp) || timestamp <= 0) {
    return null;
  }

  // Threshold: timestamps before ~2001 in seconds are likely milliseconds
  // This handles timestamps that are in the range of years 2001-2100 correctly
  const SECONDS_THRESHOLD = 978307200; // Jan 1, 2001 in seconds

  // If timestamp is larger than what we'd expect for seconds (> year 3000),
  // it's likely in milliseconds
  const LIKELY_MS_THRESHOLD = 32503680000; // Year 3000 in seconds

  let ms: number;
  if (timestamp > LIKELY_MS_THRESHOLD) {
    // Definitely in milliseconds
    ms = timestamp;
  } else if (timestamp < SECONDS_THRESHOLD) {
    // Very old date if seconds, likely milliseconds
    // Check if it makes sense as milliseconds (> year 2001)
    if (timestamp > SECONDS_THRESHOLD * 1000) {
      // Makes no sense either way, treat as invalid
      return null;
    }
    // Ambiguous but treat as seconds for old commits
    ms = timestamp * 1000;
  } else {
    // In the normal range, treat as seconds
    ms = timestamp * 1000;
  }

  const date = new Date(ms);
  // Sanity check: date should be between 1970 and 2100
  const year = date.getFullYear();
  if (year < 1970 || year > 2100) {
    return null;
  }

  return date;
}
