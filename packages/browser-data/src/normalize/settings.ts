import type { ImportedSettings } from "../types.js";

/**
 * Extract settings from Chromium Preferences JSON.
 */
export function extractChromiumSettings(
  prefs: Record<string, unknown>,
): ImportedSettings {
  const settings: ImportedSettings = {};

  // Homepage
  const homepage = prefs["homepage"] as string | undefined;
  if (homepage) settings.homepage = homepage;

  // Default search engine (keyword from default_search_provider_data)
  const searchProvider = prefs["default_search_provider_data"] as
    | Record<string, unknown>
    | undefined;
  if (searchProvider?.["template_url_data"]) {
    const templateData = searchProvider["template_url_data"] as Record<string, unknown>;
    settings.defaultSearchEngine = String(templateData["keyword"] || templateData["short_name"] || "");
  }

  // Bookmarks bar visibility
  const bookmarkBar = prefs["bookmark_bar"] as Record<string, unknown> | undefined;
  if (bookmarkBar) {
    settings.showBookmarksBar = bookmarkBar["show_on_all_tabs"] === true;
  }

  return settings;
}

/**
 * Extract settings from Firefox prefs.js content.
 * prefs.js contains lines like: user_pref("key", value);
 */
export function extractFirefoxSettings(
  prefsMap: Map<string, unknown>,
): ImportedSettings {
  const settings: ImportedSettings = {};

  const homepage = prefsMap.get("browser.startup.homepage");
  if (typeof homepage === "string") settings.homepage = homepage;

  const defaultEngine = prefsMap.get("browser.urlbar.placeholderName");
  if (typeof defaultEngine === "string") settings.defaultSearchEngine = defaultEngine;

  const bookmarksToolbar = prefsMap.get("browser.toolbars.bookmarks.visibility");
  if (bookmarksToolbar !== undefined) {
    settings.showBookmarksBar = bookmarksToolbar === "always";
  }

  return settings;
}
