import type { ImportedCookie, SameSiteValue, SourceScheme } from "../types.js";

/**
 * Map Chromium sameSite integer to our string enum.
 * Chromium uses: -1=unspecified, 0=no_restriction, 1=lax, 2=strict
 */
export function chromiumSameSite(value: number): SameSiteValue {
  switch (value) {
    case 0: return "no_restriction";
    case 1: return "lax";
    case 2: return "strict";
    default: return "unspecified";
  }
}

/**
 * Map Chromium source_scheme integer to our string enum.
 * Chromium uses: 0=unset, 1=non_secure, 2=secure
 */
export function chromiumSourceScheme(value: number): SourceScheme {
  switch (value) {
    case 1: return "non_secure";
    case 2: return "secure";
    default: return "unset";
  }
}

/**
 * Derive a URL from cookie domain, path, and secure flag.
 * This is needed for Electron's cookies.set() API which requires a `url` field.
 */
export function deriveCookieUrl(cookie: ImportedCookie): string {
  const scheme = cookie.secure ? "https" : "http";
  const host = cookie.domain.replace(/^\./, "");
  return `${scheme}://${host}${cookie.path}`;
}

/**
 * Normalize cookie expiry. Chromium stores epoch seconds.
 * Firefox stores epoch seconds. Safari uses Mac epoch.
 * Returns Unix seconds, or undefined for session cookies.
 */
export function normalizeCookieExpiry(
  value: number | null | undefined,
  isSession: boolean,
): number | undefined {
  if (isSession || value == null || value === 0) return undefined;
  return value;
}

/**
 * Determine if a cookie is host-only based on its domain.
 * A domain cookie has a leading dot; a host-only cookie does not.
 */
export function isHostOnlyCookie(domain: string): boolean {
  return !domain.startsWith(".");
}
