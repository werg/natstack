import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { getBuildArtifactsDirectory } from "../paths.js";

export type BuildKind = "panel" | "worker";

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

export function createBuildWorkspace(key: BuildArtifactKey): BuildWorkspace {
  const { rootDir, depsDir, buildsDir, nodeModulesDir } = getBuildKeyDirectories(key);

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

