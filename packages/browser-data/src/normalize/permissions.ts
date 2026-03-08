import type { ImportedPermission } from "../types.js";

/**
 * Map Chromium content setting values to our setting enum.
 */
export function chromiumSettingToPermission(
  value: number | string,
): "allow" | "block" | "ask" {
  // Chromium uses: 1=allow, 2=block, 3=ask (or "session_only" etc.)
  if (value === 1 || value === "allow") return "allow";
  if (value === 2 || value === "block") return "block";
  return "ask";
}

/**
 * Map Firefox permission type integers to our setting enum.
 * Firefox uses: 1=allow, 2=deny
 */
export function firefoxPermissionToSetting(
  permission: number,
): "allow" | "block" | "ask" {
  if (permission === 1) return "allow";
  if (permission === 2) return "block";
  return "ask";
}

/**
 * Map Chromium content_settings exception key names to our permission names.
 */
const CHROMIUM_PERMISSION_MAP: Record<string, string> = {
  "notifications": "notifications",
  "geolocation": "geolocation",
  "media_stream_camera": "camera",
  "media_stream_mic": "microphone",
  "midi_sysex": "midi",
  "clipboard": "clipboard-read",
  "automatic_downloads": "automatic-downloads",
  "popups": "popups",
};

export function mapChromiumPermissionName(key: string): string {
  return CHROMIUM_PERMISSION_MAP[key] || key;
}

/**
 * Map Firefox permission type strings to our permission names.
 */
const FIREFOX_PERMISSION_MAP: Record<string, string> = {
  "desktop-notification": "notifications",
  "geo": "geolocation",
  "camera": "camera",
  "microphone": "microphone",
  "midi": "midi",
  "popup": "popups",
  "autoplay-media": "autoplay",
};

export function mapFirefoxPermissionType(type: string): string {
  return FIREFOX_PERMISSION_MAP[type] || type;
}
