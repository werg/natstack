/**
 * Extract a search URL template from a Chromium keyword URL.
 * Chromium stores URLs with %s as the search term placeholder.
 * We normalize to {searchTerms} format (OpenSearch convention).
 */
export function normalizeSearchUrl(url: string): string {
  return url.replace(/%s/g, "{searchTerms}");
}

/**
 * Extract a search URL template from a Firefox search engine config.
 * Firefox stores the template URL directly with {searchTerms}.
 */
export function normalizeFirefoxSearchUrl(url: string): string {
  // Firefox already uses {searchTerms} in most cases
  return url;
}
