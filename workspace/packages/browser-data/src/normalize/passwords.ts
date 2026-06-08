/**
 * Canonicalize a URL for password storage/matching.
 * Strips trailing slashes, normalizes scheme, removes fragment.
 */
export function canonicalizeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    // Normalize scheme to lowercase
    parsed.hash = "";
    // Remove trailing slash from pathname if it's just "/"
    let result = parsed.toString();
    if (result.endsWith("/") && parsed.pathname === "/") {
      result = result.slice(0, -1);
    }
    return result;
  } catch {
    // If URL parsing fails, return as-is
    return url;
  }
}

/**
 * Extract the origin (scheme + host + port) from a URL for matching.
 */
export function extractOrigin(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.origin;
  } catch {
    return url;
  }
}
