import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const APP_NAME = "NatStack";
const APP_BUNDLE_IDENTIFIER = "com.natstack.app.dev";
const CACHE_VERSION = 2;

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

export function resolveElectronExecutableForNatStack() {
  const electronExecutable = require("electron");
  if (process.platform !== "darwin") return electronExecutable;
  return ensureBrandedMacElectronApp(electronExecutable);
}

function ensureBrandedMacElectronApp(electronExecutable) {
  const sourceApp = findMacAppBundle(electronExecutable);
  if (!sourceApp) return electronExecutable;

  const electronVersion = readElectronVersion();
  const cacheRoot = path.join(
    repoRoot,
    ".cache",
    "natstack-electron",
    `darwin-${process.arch}-${electronVersion}`
  );
  const brandedApp = path.join(cacheRoot, `${APP_NAME}.app`);
  const markerPath = path.join(cacheRoot, "metadata.json");
  const marker = {
    cacheVersion: CACHE_VERSION,
    sourceApp,
    electronVersion,
    appName: APP_NAME,
    bundleIdentifier: APP_BUNDLE_IDENTIFIER,
  };

  if (!isCurrentBrandedApp(brandedApp, markerPath, marker)) {
    fs.rmSync(brandedApp, { recursive: true, force: true });
    fs.mkdirSync(cacheRoot, { recursive: true });
    fs.cpSync(sourceApp, brandedApp, { recursive: true, preserveTimestamps: true });
    patchBundleMetadata(brandedApp);
    fs.writeFileSync(markerPath, `${JSON.stringify(marker, null, 2)}\n`, "utf8");
  }

  return path.join(brandedApp, path.relative(sourceApp, electronExecutable));
}

function findMacAppBundle(executablePath) {
  let current = path.resolve(executablePath);
  while (current !== path.dirname(current)) {
    if (current.endsWith(".app")) return current;
    current = path.dirname(current);
  }
  return null;
}

function readElectronVersion() {
  try {
    return require("electron/package.json").version;
  } catch {
    return "unknown";
  }
}

function isCurrentBrandedApp(brandedApp, markerPath, expectedMarker) {
  if (!fs.existsSync(brandedApp) || !fs.existsSync(markerPath)) return false;
  try {
    const marker = JSON.parse(fs.readFileSync(markerPath, "utf8"));
    return JSON.stringify(marker) === JSON.stringify(expectedMarker);
  } catch {
    return false;
  }
}

function patchBundleMetadata(appPath) {
  const plistPath = path.join(appPath, "Contents", "Info.plist");
  let plist = fs.readFileSync(plistPath, "utf8");
  plist = setPlistString(plist, "CFBundleDisplayName", APP_NAME);
  plist = setPlistString(plist, "CFBundleName", APP_NAME);
  plist = setPlistString(plist, "CFBundleIdentifier", APP_BUNDLE_IDENTIFIER);

  const iconSource = path.join(repoRoot, "build-resources", "icon.icns");
  if (fs.existsSync(iconSource)) {
    const iconName = "natstack.icns";
    fs.copyFileSync(iconSource, path.join(appPath, "Contents", "Resources", iconName));
    plist = setPlistString(plist, "CFBundleIconFile", iconName);
  }

  fs.writeFileSync(plistPath, plist, "utf8");
}

function setPlistString(plist, key, value) {
  const escapedKey = escapeRegExp(key);
  const pattern = new RegExp(`(<key>${escapedKey}</key>\\s*<string>)([^<]*)(</string>)`);
  if (pattern.test(plist)) {
    return plist.replace(pattern, (_match, prefix, _current, suffix) => {
      return `${prefix}${escapeXml(value)}${suffix}`;
    });
  }

  const dictOpen = plist.indexOf("<dict>");
  if (dictOpen < 0) throw new Error(`Cannot add ${key} to Electron Info.plist`);
  const insertAt = dictOpen + "<dict>".length;
  return `${plist.slice(0, insertAt)}\n\t<key>${key}</key>\n\t<string>${escapeXml(
    value
  )}</string>${plist.slice(insertAt)}`;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function escapeXml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
