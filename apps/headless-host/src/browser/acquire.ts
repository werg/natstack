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
  getInstalledBrowsers,
  install,
  resolveBuildId,
  type BrowserPlatform,
  type InstalledBrowser,
} from "@puppeteer/browsers";
import { createDevLogger } from "@natstack/dev-log";

const log = createDevLogger("HeadlessHost:acquire");

const SYSTEM_CANDIDATES = ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"];
const MACOS_BUNDLES = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
];

interface CachedManagedBrowser {
  buildId: string;
  executablePath: string;
}

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

function compareBuildIds(left: string, right: string): number {
  const leftParts = left.split(".").map((part) => Number.parseInt(part, 10));
  const rightParts = right.split(".").map((part) => Number.parseInt(part, 10));
  const numeric =
    leftParts.every((part) => Number.isFinite(part)) &&
    rightParts.every((part) => Number.isFinite(part));

  if (numeric) {
    const max = Math.max(leftParts.length, rightParts.length);
    for (let index = 0; index < max; index += 1) {
      const diff = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
      if (diff !== 0) return diff;
    }
  }

  return left.localeCompare(right);
}

async function findLatestCachedManagedBrowser(opts: {
  browser: Browser;
  platform: BrowserPlatform;
  cacheDir: string;
  excludingBuildId?: string;
}): Promise<CachedManagedBrowser | null> {
  let installed: InstalledBrowser[];
  try {
    installed = await getInstalledBrowsers({ cacheDir: opts.cacheDir });
  } catch (error) {
    log.warn(`Unable to inspect Chromium cache at ${opts.cacheDir}: ${String(error)}`);
    return null;
  }

  const candidates = installed
    .filter(
      (entry) =>
        entry.browser === opts.browser &&
        entry.platform === opts.platform &&
        entry.buildId !== opts.excludingBuildId &&
        fs.existsSync(entry.executablePath)
    )
    .sort((left, right) => compareBuildIds(left.buildId, right.buildId));

  if (candidates.length === 0) return null;
  const latest = candidates[candidates.length - 1]!;
  return { buildId: latest.buildId, executablePath: latest.executablePath };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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

  const browser = opts.leanBrowser ? Browser.CHROMEHEADLESSSHELL : Browser.CHROME;
  const platform = detectBrowserPlatform();
  if (!platform) throw new Error("Unsupported platform for Chromium download");
  const cacheDir = opts.cacheDir;
  fs.mkdirSync(cacheDir, { recursive: true });

  const cached = await findLatestCachedManagedBrowser({
    browser,
    platform,
    cacheDir,
  });
  if (cached) {
    log.info(`Using cached ${browser} ${cached.buildId}: ${cached.executablePath}`);
    return { executablePath: cached.executablePath, source: "downloaded" };
  }

  if (opts.allowDownload === false || process.env["NATSTACK_HEADLESS_NO_DOWNLOAD"] === "1") {
    throw new Error(
      "No Chromium found (NATSTACK_CHROMIUM_PATH unset, no system chrome/chromium) and download is disabled"
    );
  }

  const buildId = await resolveBuildId(browser, platform, "stable");
  const existing = computeExecutablePath({ browser, buildId, cacheDir });
  if (fs.existsSync(existing)) {
    return { executablePath: existing, source: "downloaded" };
  }

  log.info(`Downloading ${browser} ${buildId} to ${cacheDir}...`);
  try {
    const installed = await install({
      browser,
      buildId,
      cacheDir,
      downloadProgressCallback: opts.onDownloadProgress,
    });
    log.info(`Downloaded ${browser} ${buildId}`);
    return { executablePath: installed.executablePath, source: "downloaded" };
  } catch (error) {
    const cached = await findLatestCachedManagedBrowser({
      browser,
      platform,
      cacheDir,
      excludingBuildId: buildId,
    });
    if (cached) {
      log.warn(
        `Failed to download ${browser} ${buildId}; using cached ${cached.buildId}: ${cached.executablePath}. ${errorMessage(error)}`
      );
      return { executablePath: cached.executablePath, source: "downloaded" };
    }
    throw error;
  }
}
