import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { getBuildArtifactsDirectory } from "../paths.js";

export type BuildKind = "panel" | "worker" | "agent";

export interface BuildArtifactKey {
  kind: BuildKind;
  canonicalPath: string;
  commit: string;
}

export interface BuildWorkspace {
  rootDir: string;
  depsDir: string;
  nodeModulesDir: string;
  buildDir: string;
  cleanupBuildDir: () => Promise<void>;
}

function stableId(input: string): string {
  return crypto.createHash("sha256").update(input).digest("hex").slice(0, 16);
}

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

export function getGitTempBuildsDirectory(repoPath: string): string {
  const base = getBuildArtifactsDirectory();
  const repoId = stableId(path.resolve(repoPath));
  const dir = path.join(base, "git", repoId, "temp-builds");
  ensureDir(dir);
  return dir;
}

export function getBuildKeyDirectories(key: BuildArtifactKey): {
  rootDir: string;
  depsDir: string;
  buildsDir: string;
  nodeModulesDir: string;
} {
  const base = getBuildArtifactsDirectory();
  const pathId = stableId(path.resolve(key.canonicalPath));
  const commitId = key.commit;

  const rootDir = path.join(base, key.kind, pathId, commitId);
  const depsDir = path.join(rootDir, "deps");
  const buildsDir = path.join(rootDir, "builds");
  const nodeModulesDir = path.join(depsDir, "node_modules");

  ensureDir(depsDir);
  ensureDir(buildsDir);

  return { rootDir, depsDir, buildsDir, nodeModulesDir };
}

/**
 * Get the stable artifacts directory for a build.
 * This is a deterministic path based on kind/pathId/commit - no random components.
 * Files written here persist and can be reused across builds.
 */
export function getStableArtifactsDir(key: BuildArtifactKey): string {
  const base = getBuildArtifactsDirectory();
  const pathId = stableId(path.resolve(key.canonicalPath));
  return path.join(base, key.kind, pathId, key.commit, "stable");
}

/**
 * Get the stable bundle path for a build.
 */
export function getStableBundlePath(key: BuildArtifactKey): string {
  const stableDir = getStableArtifactsDir(key);
  const ext = key.kind === "agent" ? ".mjs" : ".js";
  return path.join(stableDir, `bundle${ext}`);
}

/**
 * Check if a stable build already exists.
 */
export function stableBuildExists(key: BuildArtifactKey): boolean {
  const bundlePath = getStableBundlePath(key);
  return fs.existsSync(bundlePath);
}

export function createBuildWorkspace(key: BuildArtifactKey): BuildWorkspace {
  const { rootDir, depsDir, buildsDir, nodeModulesDir } = getBuildKeyDirectories(key);

  // Create a temp build directory for the build process
  const nonce = crypto.randomBytes(4).toString("hex");
  const buildDir = path.join(buildsDir, `build-${Date.now()}-${nonce}`);
  ensureDir(buildDir);

  return {
    rootDir,
    depsDir,
    nodeModulesDir,
    buildDir,
    cleanupBuildDir: async () => {
      await fs.promises.rm(buildDir, { recursive: true, force: true });
    },
  };
}

/**
 * Move build artifacts from temp directory to stable location.
 * Uses atomic rename when possible.
 */
export async function promoteToStable(
  tempBuildDir: string,
  key: BuildArtifactKey
): Promise<string> {
  const stableDir = getStableArtifactsDir(key);

  // Remove existing stable dir if present (rebuild case)
  if (fs.existsSync(stableDir)) {
    await fs.promises.rm(stableDir, { recursive: true, force: true });
  }

  // Ensure parent exists
  ensureDir(path.dirname(stableDir));

  // Atomic rename (same filesystem) or copy+delete (cross-filesystem)
  try {
    await fs.promises.rename(tempBuildDir, stableDir);
  } catch (err) {
    // Cross-device link error - fall back to copy
    if ((err as NodeJS.ErrnoException).code === "EXDEV") {
      await copyDir(tempBuildDir, stableDir);
      await fs.promises.rm(tempBuildDir, { recursive: true, force: true });
    } else {
      throw err;
    }
  }

  return stableDir;
}

/**
 * Recursively copy a directory.
 */
async function copyDir(src: string, dest: string): Promise<void> {
  await fs.promises.mkdir(dest, { recursive: true });
  const entries = await fs.promises.readdir(src, { withFileTypes: true });

  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    if (entry.isDirectory()) {
      await copyDir(srcPath, destPath);
    } else {
      await fs.promises.copyFile(srcPath, destPath);
    }
  }
}

