import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const APP_NAME = "NatStack";
const APP_BUNDLE_IDENTIFIER = "com.natstack.app.dev";
const CACHE_VERSION = 3;

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

/**
 * Resolve the Electron executable, branded as "NatStack" on macOS.
 *
 * @param {{ installed?: boolean }} [opts] When `installed` is true (the npm
 *   global-install launcher), the branded copy is cached under the per-user
 *   data dir (the package prefix may be root-owned), uses the production bundle
 *   id, and is ad-hoc re-signed so it launches on Apple Silicon. The default
 *   (dev) path keeps the repo-local cache and the `.dev` bundle id.
 */
export function resolveElectronExecutableForNatStack(opts = {}) {
  const electronExecutable = require("electron");
  if (process.platform !== "darwin") return electronExecutable;
  return ensureBrandedMacElectronApp(electronExecutable, opts);
}

function ensureBrandedMacElectronApp(electronExecutable, opts = {}) {
  const sourceApp = findMacAppBundle(electronExecutable);
  if (!sourceApp) return electronExecutable;

  const installed = opts.installed === true;
  const bundleIdentifier = installed ? "com.natstack.app" : APP_BUNDLE_IDENTIFIER;
  const electronVersion = readElectronVersion();
  // Dev caches under the (writable) repo; an installed global package may live
  // in a root-owned prefix, so the branded copy goes in the per-user data dir.
  const cacheBase = installed
    ? path.join(os.homedir(), "Library", "Application Support", "natstack", "electron-cache")
    : path.join(repoRoot, ".cache", "natstack-electron");
  const cacheRoot = path.join(cacheBase, `darwin-${process.arch}-${electronVersion}`);
  const brandedApp = path.join(cacheRoot, `${APP_NAME}.app`);
  const markerPath = path.join(cacheRoot, "metadata.json");
  const marker = {
    cacheVersion: CACHE_VERSION,
    sourceApp,
    electronVersion,
    appName: APP_NAME,
    bundleIdentifier,
    installed,
  };

  if (!isCurrentBrandedApp(brandedApp, markerPath, marker)) {
    fs.rmSync(brandedApp, { recursive: true, force: true });
    fs.mkdirSync(cacheRoot, { recursive: true });
    fs.cpSync(sourceApp, brandedApp, {
      recursive: true,
      preserveTimestamps: true,
      verbatimSymlinks: true,
    });
    patchBundleMetadata(brandedApp, bundleIdentifier);
    // Patching Info.plist/Resources invalidates the bundle's code signature.
    // Apple Silicon refuses to launch an invalidly-signed bundle, so re-seal the
    // copy with an ad-hoc signature (free, no Developer ID). The npm-delivered
    // app is non-quarantined, so Gatekeeper's hard-block never applies.
    if (installed) adhocCodesign(brandedApp);
    fs.writeFileSync(markerPath, `${JSON.stringify(marker, null, 2)}\n`, "utf8");
  }

  return path.join(brandedApp, path.relative(sourceApp, electronExecutable));
}

function adhocCodesign(appPath) {
  try {
    execFileSync("codesign", ["--force", "--deep", "--sign", "-", appPath], {
      stdio: "ignore",
    });
  } catch (error) {
    // Non-fatal: on x64 a non-quarantined unsigned app still launches; on arm64
    // the user gets a clear OS error rather than a silent launcher failure.
    console.warn(
      `[branded-electron] ad-hoc codesign failed (app may not launch on Apple Silicon): ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
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

function patchBundleMetadata(appPath, bundleIdentifier) {
  const plistPath = path.join(appPath, "Contents", "Info.plist");
  let plist = fs.readFileSync(plistPath, "utf8");
  plist = setPlistString(plist, "CFBundleDisplayName", APP_NAME);
  plist = setPlistString(plist, "CFBundleName", APP_NAME);
  plist = setPlistString(plist, "CFBundleIdentifier", bundleIdentifier);

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
