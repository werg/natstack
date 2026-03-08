import * as path from "path";
import * as os from "os";
import type { BrowserName, BrowserFamily } from "../types.js";

export interface BrowserPathEntry {
  name: BrowserName;
  family: BrowserFamily;
  displayName: string;
  linux?: string;
  darwin?: string;
  win32?: string;
}

const home = os.homedir();

function linuxConfig(subdir: string): string {
  return path.join(process.env["XDG_CONFIG_HOME"] || path.join(home, ".config"), subdir);
}

function darwinAppSupport(subdir: string): string {
  return path.join(home, "Library", "Application Support", subdir);
}

function winLocal(subdir: string): string {
  return path.join(process.env["LOCALAPPDATA"] || path.join(home, "AppData", "Local"), subdir);
}

function winRoaming(subdir: string): string {
  return path.join(process.env["APPDATA"] || path.join(home, "AppData", "Roaming"), subdir);
}

export const BROWSER_PATHS: BrowserPathEntry[] = [
  // Firefox family
  {
    name: "firefox",
    family: "firefox",
    displayName: "Firefox",
    linux: path.join(home, ".mozilla", "firefox"),
    darwin: darwinAppSupport("Firefox/Profiles"),
    win32: winRoaming("Mozilla/Firefox/Profiles"),
  },
  {
    name: "zen",
    family: "firefox",
    displayName: "Zen Browser",
    linux: path.join(home, ".zen"),
    darwin: darwinAppSupport("Zen/Profiles"),
    win32: winRoaming("Zen/Profiles"),
  },

  // Chromium family
  {
    name: "chrome",
    family: "chromium",
    displayName: "Google Chrome",
    linux: linuxConfig("google-chrome"),
    darwin: darwinAppSupport("Google/Chrome"),
    win32: winLocal("Google/Chrome/User Data"),
  },
  {
    name: "chrome-beta",
    family: "chromium",
    displayName: "Google Chrome Beta",
    linux: linuxConfig("google-chrome-beta"),
    darwin: darwinAppSupport("Google/Chrome Beta"),
    win32: winLocal("Google/Chrome Beta/User Data"),
  },
  {
    name: "chrome-dev",
    family: "chromium",
    displayName: "Google Chrome Dev",
    linux: linuxConfig("google-chrome-unstable"),
    darwin: darwinAppSupport("Google/Chrome Dev"),
    win32: winLocal("Google/Chrome Dev/User Data"),
  },
  {
    name: "chrome-canary",
    family: "chromium",
    displayName: "Google Chrome Canary",
    darwin: darwinAppSupport("Google/Chrome Canary"),
    win32: winLocal("Google/Chrome SxS/User Data"),
  },
  {
    name: "chromium",
    family: "chromium",
    displayName: "Chromium",
    linux: linuxConfig("chromium"),
    darwin: darwinAppSupport("Chromium"),
    win32: winLocal("Chromium/User Data"),
  },
  {
    name: "edge",
    family: "chromium",
    displayName: "Microsoft Edge",
    linux: linuxConfig("microsoft-edge"),
    darwin: darwinAppSupport("Microsoft Edge"),
    win32: winLocal("Microsoft/Edge/User Data"),
  },
  {
    name: "edge-beta",
    family: "chromium",
    displayName: "Microsoft Edge Beta",
    linux: linuxConfig("microsoft-edge-beta"),
    darwin: darwinAppSupport("Microsoft Edge Beta"),
    win32: winLocal("Microsoft/Edge Beta/User Data"),
  },
  {
    name: "edge-dev",
    family: "chromium",
    displayName: "Microsoft Edge Dev",
    linux: linuxConfig("microsoft-edge-dev"),
    darwin: darwinAppSupport("Microsoft Edge Dev"),
    win32: winLocal("Microsoft/Edge Dev/User Data"),
  },
  {
    name: "brave",
    family: "chromium",
    displayName: "Brave",
    linux: linuxConfig("BraveSoftware/Brave-Browser"),
    darwin: darwinAppSupport("BraveSoftware/Brave-Browser"),
    win32: winLocal("BraveSoftware/Brave-Browser/User Data"),
  },
  {
    name: "vivaldi",
    family: "chromium",
    displayName: "Vivaldi",
    linux: linuxConfig("vivaldi"),
    darwin: darwinAppSupport("Vivaldi"),
    win32: winLocal("Vivaldi/User Data"),
  },
  {
    name: "opera",
    family: "chromium",
    displayName: "Opera",
    linux: linuxConfig("opera"),
    darwin: darwinAppSupport("com.operasoftware.Opera"),
    win32: winRoaming("Opera Software/Opera Stable"),
  },
  {
    name: "opera-gx",
    family: "chromium",
    displayName: "Opera GX",
    linux: linuxConfig("opera-gx"),
    darwin: darwinAppSupport("com.operasoftware.OperaGX"),
    win32: winRoaming("Opera Software/Opera GX Stable"),
  },
  {
    name: "arc",
    family: "chromium",
    displayName: "Arc",
    darwin: darwinAppSupport("Arc/User Data"),
  },

  // Safari
  {
    name: "safari",
    family: "safari",
    displayName: "Safari",
    darwin: path.join(home, "Library", "Safari"),
  },
];

/**
 * Get the data directory for a browser on the current platform.
 */
export function getBrowserDataDir(entry: BrowserPathEntry): string | undefined {
  return entry[process.platform as "linux" | "darwin" | "win32"];
}
