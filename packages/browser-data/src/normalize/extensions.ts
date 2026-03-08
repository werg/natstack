import type { ImportedExtension } from "../types.js";

/**
 * Parse a Chrome extension manifest.json to extract metadata.
 */
export function parseChromiumManifest(
  manifest: Record<string, unknown>,
  id: string,
  enabled: boolean,
): ImportedExtension {
  return {
    id,
    name: String(manifest["name"] || "Unknown"),
    version: String(manifest["version"] || "0.0.0"),
    description: manifest["description"]
      ? String(manifest["description"])
      : undefined,
    homepageUrl: manifest["homepage_url"]
      ? String(manifest["homepage_url"])
      : undefined,
    enabled,
  };
}

/**
 * Parse a Firefox extension entry from extensions.json.
 */
export function parseFirefoxExtension(
  entry: Record<string, unknown>,
): ImportedExtension {
  return {
    id: String(entry["id"] || ""),
    name: String(entry["name"] || (entry["defaultLocale"] as Record<string, unknown>)?.["name"] || "Unknown"),
    version: String(entry["version"] || "0.0.0"),
    description: entry["description"]
      ? String(entry["description"])
      : (entry["defaultLocale"] as Record<string, unknown>)?.["description"]
        ? String((entry["defaultLocale"] as Record<string, unknown>)["description"])
        : undefined,
    homepageUrl: entry["homepageURL"]
      ? String(entry["homepageURL"])
      : undefined,
    enabled: entry["active"] !== false && entry["userDisabled"] !== true,
  };
}
