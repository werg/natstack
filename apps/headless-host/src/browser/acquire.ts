/**
 * Chromium executable resolution: explicit path → system browser → managed
 * download via @puppeteer/browsers into the NatStack cache dir.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  Browser,
  computeExecutablePath,
  detectBrowserPlatform,
  install,
  resolveBuildId,
} from "@puppeteer/browsers";
import { createDevLogger } from "@natstack/dev-log";

const log = createDevLogger("HeadlessHost:acquire");

const SYSTEM_CANDIDATES = [
  "google-chrome",
  "google-chrome-stable",
  "chromium",
  "chromium-browser",
];
const MACOS_BUNDLES = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
];

export interface ResolvedChromium {
  executablePath: string;
  source: "explicit" | "system" | "downloaded";
}

function which(binary: string): string | null {
  try {
    const result = execFileSync("which", [binary], { encoding: "utf8" }).trim();
    return result.length > 0 ? result : null;
  } catch {
    return null;
  }
}

export async function resolveChromium(opts: {
  chromiumPath?: string;
  cacheDir: string;
  leanBrowser?: boolean;
  allowDownload?: boolean;
  onDownloadProgress?: (downloadedBytes: number, totalBytes: number) => void;
}): Promise<ResolvedChromium> {
  if (opts.chromiumPath) {
    if (!fs.existsSync(opts.chromiumPath)) {
      throw new Error(`Chromium path does not exist: ${opts.chromiumPath}`);
    }
    return { executablePath: opts.chromiumPath, source: "explicit" };
  }

  for (const candidate of SYSTEM_CANDIDATES) {
    const found = which(candidate);
    if (found) return { executablePath: found, source: "system" };
  }
  for (const bundle of MACOS_BUNDLES) {
    if (fs.existsSync(bundle)) return { executablePath: bundle, source: "system" };
  }

  if (opts.allowDownload === false || process.env["NATSTACK_HEADLESS_NO_DOWNLOAD"] === "1") {
    throw new Error(
      "No Chromium found (NATSTACK_CHROMIUM_PATH unset, no system chrome/chromium) and download is disabled"
    );
  }

  const browser = opts.leanBrowser ? Browser.CHROMEHEADLESSSHELL : Browser.CHROME;
  const platform = detectBrowserPlatform();
  if (!platform) throw new Error("Unsupported platform for Chromium download");
  const buildId = await resolveBuildId(browser, platform, "stable");
  const cacheDir = opts.cacheDir;
  fs.mkdirSync(cacheDir, { recursive: true });

  const existing = computeExecutablePath({ browser, buildId, cacheDir });
  if (fs.existsSync(existing)) {
    return { executablePath: existing, source: "downloaded" };
  }

  log.info(`Downloading ${browser} ${buildId} to ${cacheDir}...`);
  const installed = await install({
    browser,
    buildId,
    cacheDir,
    downloadProgressCallback: opts.onDownloadProgress,
  });
  log.info(`Downloaded ${browser} ${buildId}`);
  return { executablePath: installed.executablePath, source: "downloaded" };
}
