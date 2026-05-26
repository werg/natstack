/**
 * Content-Addressed Build Store — immutable artifact storage.
 *
 * {userData}/builds/{build_key}/
 *   ├── bundle.js
 *   ├── bundle.css  (if any)
 *   ├── index.html  (panels/about only)
 *   ├── assets/     (chunks, images, fonts)
 *   ├── artifacts.json
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
  entries: BuildArtifactInput[];
}

export type BuildArtifactRole = "primary" | "asset" | "html" | "css" | "map";
export type BuildArtifactEncoding = "utf8" | "base64";

export interface BuildArtifactInput {
  path: string;
  role: BuildArtifactRole;
  contentType: string;
  encoding?: BuildArtifactEncoding;
  platform?: string;
  integrity?: string;
  content: string;
}

export interface BuildArtifactManifestEntry {
  path: string;
  role: BuildArtifactRole;
  contentType: string;
  encoding: BuildArtifactEncoding;
  platform?: string;
  integrity?: string;
}

export type BuildArtifactWithContent = BuildArtifactManifestEntry & { content: string };

export type BuildMetadataDetails =
  | {
      kind: "extension";
      runtimeDepsKey: string | null;
      runtimeAbi: string | null;
      dependencyMode?: "auto" | "bundle" | "external";
      externalDeps?: Record<string, string>;
      dependencyOverrides?: Record<string, string>;
      classifiedDeps?: Array<{
        name: string;
        version: string;
        external: boolean;
        format: "cjs" | "esm" | "unknown";
        reasons: string[];
        explanation: string;
      }>;
      smokeTest?: {
        mode: "child-process";
        passed: boolean;
      };
    }
  | {
      kind: "app";
      target: "electron" | "react-native" | "terminal";
      platform?: "electron" | "ios" | "android" | "terminal";
      integrity?: string | null;
      rnHostAbi?: string | null;
      provider?: {
        name: string;
        activeEv: string | null;
        activeBuildKey: string | null;
        contractVersion: string;
      } | null;
    }
  | { kind: "generic" };

export interface BuildMetadata {
  kind: "panel" | "package" | "worker" | "extension" | "app" | "template";
  name: string;
  ev: string;
  sourcemap: boolean;
  framework?: string;
  details: BuildMetadataDetails;
  builtAt: string;
}

export interface BuildResult {
  /** Absolute path to the build directory */
  dir: string;
  /** Build metadata */
  metadata: BuildMetadata;
  /** Target-agnostic artifact manifest with content loaded. */
  artifacts: BuildArtifactWithContent[];
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

export function contentTypeForPath(filePath: string): string {
  switch (path.extname(filePath).toLowerCase()) {
    case ".js":
    case ".mjs":
      return "text/javascript; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".html":
      return "text/html; charset=utf-8";
    case ".json":
    case ".map":
      return "application/json; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    case ".gif":
      return "image/gif";
    case ".wasm":
      return "application/wasm";
    default:
      return "application/octet-stream";
  }
}

function readArtifactContent(dir: string, entry: BuildArtifactManifestEntry): string {
  const filePath = path.join(dir, entry.path);
  return entry.encoding === "base64"
    ? fs.readFileSync(filePath, "base64")
    : fs.readFileSync(filePath, "utf-8");
}

function manifestForEntry(entry: BuildArtifactInput): BuildArtifactManifestEntry {
  return {
    path: entry.path,
    role: entry.role,
    contentType: entry.contentType,
    encoding: entry.encoding ?? "utf8",
    ...(entry.platform ? { platform: entry.platform } : {}),
    ...(entry.integrity ? { integrity: entry.integrity } : {}),
  };
}

function artifactIntegrity(entry: BuildArtifactInput): string {
  const bytes =
    (entry.encoding ?? "utf8") === "base64"
      ? Buffer.from(entry.content, "base64")
      : Buffer.from(entry.content, "utf-8");
  return `sha256-${crypto.createHash("sha256").update(bytes).digest("hex")}`;
}

function buildArtifactSetIntegrity(entries: BuildArtifactManifestEntry[]): string {
  const canonical = entries
    .map((entry) => ({
      path: entry.path,
      role: entry.role,
      contentType: entry.contentType,
      encoding: entry.encoding,
      platform: entry.platform ?? null,
      integrity: entry.integrity ?? null,
    }))
    .sort((a, b) =>
      `${a.path}\0${a.platform ?? ""}`.localeCompare(`${b.path}\0${b.platform ?? ""}`)
    );
  return `sha256-${crypto.createHash("sha256").update(JSON.stringify(canonical)).digest("hex")}`;
}

function metadataForEntries(
  metadata: BuildMetadata,
  entries: BuildArtifactManifestEntry[]
): BuildMetadata {
  if (metadata.details.kind !== "app") return metadata;
  return {
    ...metadata,
    details: {
      ...metadata.details,
      integrity: buildArtifactSetIntegrity(entries),
    },
  };
}

function legacyArtifactFromFile(
  dir: string,
  artifactPath: string,
  role: BuildArtifactRole
): BuildArtifactWithContent | null {
  const filePath = path.join(dir, artifactPath);
  if (!fs.existsSync(filePath)) return null;
  const encoding: BuildArtifactEncoding = isBinaryAsset(filePath) ? "base64" : "utf8";
  const input: BuildArtifactInput = {
    path: artifactPath.split(path.sep).join(path.posix.sep),
    role,
    contentType: contentTypeForPath(artifactPath),
    encoding,
    content:
      encoding === "base64"
        ? fs.readFileSync(filePath, "base64")
        : fs.readFileSync(filePath, "utf-8"),
  };
  return {
    ...manifestForEntry({ ...input, integrity: artifactIntegrity(input) }),
    content: input.content,
  };
}

function readLegacyArtifacts(dir: string): BuildArtifactWithContent[] | null {
  const artifacts: BuildArtifactWithContent[] = [];
  const add = (artifactPath: string, role: BuildArtifactRole) => {
    const artifact = legacyArtifactFromFile(dir, artifactPath, role);
    if (artifact) artifacts.push(artifact);
  };

  add("bundle.js", "primary");
  add("bundle.css", "css");
  add("index.html", "html");

  const assetsDir = path.join(dir, "assets");
  for (const filePath of walkFilesRecursive(assetsDir).sort()) {
    const relative = path.relative(dir, filePath).split(path.sep).join(path.posix.sep);
    add(relative, path.extname(filePath).toLowerCase() === ".map" ? "map" : "asset");
  }

  return artifacts.length > 0 ? artifacts : null;
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
    const manifestPath = path.join(dir, "artifacts.json");
    const artifacts = fs.existsSync(manifestPath)
      ? (JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as BuildArtifactManifestEntry[])
          .filter((entry) => fs.existsSync(path.join(dir, entry.path)))
          .map((entry) => ({ ...entry, content: readArtifactContent(dir, entry) }))
      : readLegacyArtifacts(dir);
    if (!artifacts) return null;
    const artifactManifest = artifacts.map(({ content: _content, ...entry }) => entry);
    return {
      dir,
      metadata: metadataForEntries(metadata, artifactManifest),
      artifacts,
    };
  } catch {
    return null;
  }
}

export function primaryArtifact(
  build: Pick<BuildResult, "artifacts">,
  opts: { platform?: string } = {}
): BuildArtifactWithContent | null {
  return (
    build.artifacts.find(
      (entry) =>
        entry.role === "primary" &&
        (opts.platform === undefined || entry.platform === opts.platform)
    ) ?? null
  );
}

export function primaryTextArtifactContent(
  build: Pick<BuildResult, "artifacts" | "metadata">,
  opts: { platform?: string } = {}
): string {
  const artifact = primaryArtifact(build, opts);
  if (!artifact) {
    throw new Error(
      `Build ${build.metadata.name} has no primary artifact${opts.platform ? ` for ${opts.platform}` : ""}`
    );
  }
  if (artifact.encoding !== "utf8") {
    throw new Error(
      `Build ${build.metadata.name} primary artifact ${artifact.path} is not UTF-8 text`
    );
  }
  return artifact.content;
}

export function artifactFilePath(
  build: Pick<BuildResult, "dir">,
  artifact: Pick<BuildArtifactManifestEntry, "path">
): string {
  if (path.isAbsolute(artifact.path) || artifact.path.split(/[\\/]/).includes("..")) {
    throw new Error(`Invalid build artifact path: ${artifact.path}`);
  }
  return path.join(build.dir, artifact.path);
}

export function primaryArtifactFilePath(
  build: Pick<BuildResult, "dir" | "artifacts" | "metadata">,
  opts: { platform?: string } = {}
): string {
  const artifact = primaryArtifact(build, opts);
  if (!artifact) {
    throw new Error(
      `Build ${build.metadata.name} has no primary artifact${opts.platform ? ` for ${opts.platform}` : ""}`
    );
  }
  return artifactFilePath(build, artifact);
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

  const entries = artifacts.entries.map((entry) => ({
    ...entry,
    encoding: entry.encoding ?? "utf8",
    integrity: artifactIntegrity(entry),
  }));
  if (entries.length === 0) {
    throw new Error(`Build ${key} has no artifact entries`);
  }
  for (const entry of entries) {
    if (path.isAbsolute(entry.path) || entry.path.split(/[\\/]/).includes("..")) {
      throw new Error(`Invalid build artifact path: ${entry.path}`);
    }
    const targetPath = path.join(tmpDir, entry.path);
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(
      targetPath,
      entry.content,
      (entry.encoding === "base64" ? "base64" : "utf-8") as BufferEncoding
    );
  }
  const artifactManifest = entries.map(manifestForEntry);
  const storedMetadata = metadataForEntries(metadata, artifactManifest);

  // Ensure Node.js treats bundle.js as ESM.
  if (storedMetadata.kind === "worker" || storedMetadata.kind === "extension") {
    fs.writeFileSync(path.join(tmpDir, "package.json"), '{"type":"module"}');
  }

  fs.writeFileSync(path.join(tmpDir, "artifacts.json"), JSON.stringify(artifactManifest, null, 2));

  // Write metadata (sentinel) inside tmpDir BEFORE rename so winner is always complete
  fs.writeFileSync(path.join(tmpDir, "metadata.json"), JSON.stringify(storedMetadata, null, 2));

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
