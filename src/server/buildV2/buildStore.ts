/**
 * Content-Addressed Build Store — immutable artifact storage.
 *
 * {userData}/builds/{build_key}/
 *   ├── bundle.js
 *   ├── bundle.css  (if any)
 *   ├── index.html  (panels/about only)
 *   ├── assets/     (chunks, images, fonts)
 *   └── metadata.json
 *
 * Same key = same content. Forever. GC prunes unreferenced entries.
 */

import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { getUserDataPath } from "@natstack/env-paths";
import { assertPresent } from "../../lintHelpers";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BuildArtifacts {
  /** Main JS bundle content */
  bundle: string;
  /** CSS content (may be empty) */
  css?: string;
  /** HTML content (panels/about only) */
  html?: string;
  /** Additional assets: relative path → { content, encoding } */
  assets?: Record<string, { content: string; encoding?: "base64" }>;
}

export interface BuildMetadata {
  kind: "panel" | "package" | "worker" | "extension" | "template";
  name: string;
  ev: string;
  sourcemap: boolean;
  framework?: string;
  runtimeDepsKey?: string | null;
  extensionRuntimeAbi?: string | null;
  extensionDependencyMode?: "auto" | "bundle" | "external";
  extensionExternalDeps?: Record<string, string>;
  extensionClassifiedDeps?: Array<{
    name: string;
    version: string;
    external: boolean;
    format: "cjs" | "esm" | "unknown";
    reasons: string[];
    explanation: string;
  }>;
  extensionSmokeTest?: {
    mode: "child-process";
    passed: boolean;
  };
  builtAt: string;
}

export interface BuildResult {
  /** Absolute path to the build directory */
  dir: string;
  /** Build metadata */
  metadata: BuildMetadata;
  /** Absolute path to main bundle */
  bundlePath: string;
  /** Absolute path to CSS (if exists) */
  cssPath?: string;
  /** Absolute path to HTML (if exists) */
  htmlPath?: string;
  /** Bundle content (for protocol serving) */
  bundle: string;
  /** CSS content (for protocol serving) */
  css?: string;
  /** HTML content (for protocol serving) */
  html?: string;
  /** Asset map: relative path → content */
  assets?: Record<string, { content: string; encoding?: string }>;
}

// ---------------------------------------------------------------------------
// Build Store
// ---------------------------------------------------------------------------

function getBuildsDir(): string {
  return path.join(getUserDataPath(), "builds");
}

function getBuildDir(key: string): string {
  return path.join(getBuildsDir(), key);
}

function isFileSystemErrorCode(error: unknown, codes: readonly string[]): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as NodeJS.ErrnoException).code;
  return typeof code === "string" && codes.includes(code);
}

function warnCleanupFailure(pathName: string, error: unknown): void {
  console.warn(
    `[buildStore] Failed to remove ${pathName}: ${error instanceof Error ? error.message : String(error)}`
  );
}

function walkFilesRecursive(dir: string): string[] {
  const out: string[] = [];
  if (!fs.existsSync(dir)) return out;

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkFilesRecursive(full));
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
  return out;
}

function isBinaryAsset(file: string): boolean {
  const ext = path.extname(file).toLowerCase();
  return [
    ".png",
    ".jpg",
    ".jpeg",
    ".gif",
    ".webp",
    ".avif",
    ".ico",
    ".bmp",
    ".tif",
    ".tiff",
    ".woff",
    ".woff2",
    ".ttf",
    ".otf",
    ".eot",
    ".mp3",
    ".mp4",
    ".ogg",
    ".wav",
    ".webm",
    ".wasm",
    ".pdf",
  ].includes(ext);
}

export function has(key: string): boolean {
  const dir = getBuildDir(key);
  return fs.existsSync(path.join(dir, "metadata.json"));
}

export function get(key: string): BuildResult | null {
  const dir = getBuildDir(key);
  const metadataPath = path.join(dir, "metadata.json");

  if (!fs.existsSync(metadataPath)) return null;

  try {
    const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf-8")) as BuildMetadata;

    const bundlePath = path.join(dir, "bundle.js");
    const cssPath = path.join(dir, "bundle.css");
    const htmlPath = path.join(dir, "index.html");

    const bundle = fs.existsSync(bundlePath) ? fs.readFileSync(bundlePath, "utf-8") : "";
    const css = fs.existsSync(cssPath) ? fs.readFileSync(cssPath, "utf-8") : undefined;
    const html = fs.existsSync(htmlPath) ? fs.readFileSync(htmlPath, "utf-8") : undefined;

    // Load assets
    let assets: Record<string, { content: string; encoding?: string }> | undefined;
    const assetsDir = path.join(dir, "assets");
    if (fs.existsSync(assetsDir)) {
      assets = {};
      for (const filePath of walkFilesRecursive(assetsDir)) {
        const relativeName = path.relative(assetsDir, filePath).replace(/\\/g, "/");
        if (isBinaryAsset(filePath)) {
          assets[relativeName] = {
            content: fs.readFileSync(filePath, "base64"),
            encoding: "base64",
          };
        } else {
          assets[relativeName] = {
            content: fs.readFileSync(filePath, "utf-8"),
          };
        }
      }
    }

    return {
      dir,
      metadata,
      bundlePath,
      cssPath: fs.existsSync(cssPath) ? cssPath : undefined,
      htmlPath: fs.existsSync(htmlPath) ? htmlPath : undefined,
      bundle,
      css,
      html,
      assets,
    };
  } catch {
    return null;
  }
}

export function put(key: string, artifacts: BuildArtifacts, metadata: BuildMetadata): BuildResult {
  const dir = getBuildDir(key);
  const metadataPath = path.join(dir, "metadata.json");

  // Write to temp first, then rename atomically. Use crypto.randomBytes for
  // an unpredictable name — `${Date.now()}.${process.pid}` is guessable and
  // invites local symlink races (a co-tenant pre-creates the tmp path as a
  // symlink before our mkdirSync, redirecting our writes).
  const tmpDir = `${dir}.tmp.${crypto.randomBytes(16).toString("hex")}`;

  fs.mkdirSync(tmpDir, { recursive: true });

  // Write bundle
  fs.writeFileSync(path.join(tmpDir, "bundle.js"), artifacts.bundle);

  // Ensure Node.js treats bundle.js as ESM.
  if (metadata.kind === "worker" || metadata.kind === "extension") {
    fs.writeFileSync(path.join(tmpDir, "package.json"), '{"type":"module"}');
  }

  // Write CSS if present
  if (artifacts.css) {
    fs.writeFileSync(path.join(tmpDir, "bundle.css"), artifacts.css);
  }

  // Write HTML if present
  if (artifacts.html) {
    fs.writeFileSync(path.join(tmpDir, "index.html"), artifacts.html);
  }

  // Write assets
  if (artifacts.assets) {
    const assetsDir = path.join(tmpDir, "assets");
    fs.mkdirSync(assetsDir, { recursive: true });
    for (const [name, asset] of Object.entries(artifacts.assets)) {
      const encoding = asset.encoding === "base64" ? "base64" : "utf-8";
      const targetPath = path.join(assetsDir, name);
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      fs.writeFileSync(targetPath, asset.content, encoding as BufferEncoding);
    }
  }

  // Write metadata (sentinel) inside tmpDir BEFORE rename so winner is always complete
  fs.writeFileSync(path.join(tmpDir, "metadata.json"), JSON.stringify(metadata, null, 2));

  // Race-safe promotion: try rename, handle concurrent winner
  try {
    fs.renameSync(tmpDir, dir);
  } catch (err: unknown) {
    if (isFileSystemErrorCode(err, ["ENOTEMPTY", "EEXIST", "ENOTDIR"])) {
      // Another build won the race — verify their sentinel, use their result
      if (fs.existsSync(metadataPath)) {
        try {
          fs.rmSync(tmpDir, { recursive: true, force: true });
        } catch (cleanupError) {
          warnCleanupFailure(tmpDir, cleanupError);
        }
        return assertPresent(get(key));
      }
      // Winner incomplete — remove stale dir, retry rename
      try {
        fs.rmSync(dir, { recursive: true, force: true });
        fs.renameSync(tmpDir, dir);
      } catch {
        try {
          fs.rmSync(tmpDir, { recursive: true, force: true });
        } catch (cleanupError) {
          warnCleanupFailure(tmpDir, cleanupError);
        }
        try {
          fs.rmSync(dir, { recursive: true, force: true });
        } catch (cleanupError) {
          warnCleanupFailure(dir, cleanupError);
        }
        throw new Error(`Build store race: failed to store build for key ${key}`);
      }
    } else {
      // Clean up tmpDir on unexpected errors
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch (cleanupError) {
        warnCleanupFailure(tmpDir, cleanupError);
      }
      throw err;
    }
  }

  return assertPresent(get(key));
}

export function gc(activeKeys: Set<string>): { freed: number } {
  const buildsDir = getBuildsDir();
  if (!fs.existsSync(buildsDir)) return { freed: 0 };

  let freed = 0;
  for (const entry of fs.readdirSync(buildsDir)) {
    if (!activeKeys.has(entry)) {
      const entryPath = path.join(buildsDir, entry);
      try {
        fs.rmSync(entryPath, { recursive: true, force: true });
        freed++;
      } catch {
        // Ignore cleanup errors
      }
    }
  }

  return { freed };
}
