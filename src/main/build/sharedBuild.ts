/**
 * Shared build infrastructure for panels, workers, and agents.
 *
 * This module extracts common build logic that's used across all build targets:
 * - Git provisioning (source checkout at specific versions)
 * - Dependency installation (npm via Verdaccio)
 * - TypeScript configuration (tsconfig generation)
 * - Type checking
 * - Entry point resolution
 * - Cache helpers
 */

import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import * as ts from "typescript";
import { execFile } from "child_process";
import { promisify } from "util";
import { createRequire } from "module";
import Arborist from "@npmcli/arborist";

import { getGitTempBuildsDirectory, type BuildKind } from "./artifacts.js";
import { getMainCacheManager } from "../cacheManager.js";
import { isDev } from "../utils.js";
import { isVerdaccioServerInitialized, getVerdaccioServer } from "../verdaccioServer.js";
import { getPackagesDir, getActiveWorkspace } from "../paths.js";
import {
  getPackageStore,
  createPackageFetcher,
  createPackageLinker,
  serializeTree,
  type SerializedTree,
} from "../package-store/index.js";
import {
  createTypeCheckService,
  createDiskFileSource,
  loadSourceFiles,
  type TypeCheckDiagnostic,
} from "@natstack/runtime/typecheck";
// Re-export TypeCheckDiagnostic for consumers
export type { TypeCheckDiagnostic };

const execFileAsync = promisify(execFile);

// ===========================================================================
// Git Provisioning
// ===========================================================================

export interface VersionSpec {
  /** Git ref (branch name, tag, or commit SHA) */
  gitRef?: string;
}

export interface ProvisionOptions {
  /** Absolute path to the workspace root (e.g., userWorkspacePath) */
  sourceRoot: string;
  /** Relative path within root (e.g., "agents/my-agent", "panels/chat") */
  sourcePath: string;
  /** Optional git ref to checkout */
  version?: VersionSpec;
  /** Optional progress callback */
  onProgress?: (progress: ProvisionProgress) => void;
}

export interface ProvisionResult {
  /** Absolute path to the provisioned source */
  sourcePath: string;
  /** The resolved commit SHA */
  commit: string;
  /** Cleanup function to remove temp directory (only for versioned checkouts) */
  cleanup: (() => Promise<void>) | null;
}

export interface ProvisionProgress {
  stage: "resolving" | "checking-out" | "ready";
  message: string;
}

/**
 * Provision source code at a specific version.
 *
 * For sources without version specifiers, returns the workspace path directly.
 * For versioned sources, creates a temporary worktree or checkout.
 */
export async function provisionSource(options: ProvisionOptions): Promise<ProvisionResult> {
  const { sourceRoot, sourcePath, version, onProgress } = options;
  const absoluteSourcePath = path.resolve(sourceRoot, sourcePath);

  // Validate source exists
  if (!fs.existsSync(absoluteSourcePath)) {
    throw new Error(`Source directory not found: ${absoluteSourcePath}`);
  }

  // Require sources to be git repos (submodules are allowed via .git file)
  const gitDir = path.join(absoluteSourcePath, ".git");
  if (!fs.existsSync(gitDir)) {
    throw new Error(`Source must be a git repository (or submodule): ${absoluteSourcePath}`);
  }

  // Ensure we only use committed state; reject dirty worktrees
  await assertCleanWorktree(absoluteSourcePath);

  // Get current commit for cache keying
  const currentCommit = await getGitCommit(absoluteSourcePath);

  // No version specifier - use working directory as-is
  if (!version?.gitRef) {
    onProgress?.({ stage: "ready", message: "Using current working directory" });
    return {
      sourcePath: absoluteSourcePath,
      commit: currentCommit,
      cleanup: null,
    };
  }

  // Resolve the target ref
  onProgress?.({ stage: "resolving", message: "Resolving version..." });

  const targetRef = version.gitRef;
  const resolvedCommit = await resolveRef(absoluteSourcePath, targetRef);

  // If resolved commit matches current HEAD, no need for temp checkout
  if (resolvedCommit === currentCommit) {
    onProgress?.({ stage: "ready", message: "Already at requested version" });
    return {
      sourcePath: absoluteSourcePath,
      commit: resolvedCommit,
      cleanup: null,
    };
  }

  // Create temp directory for the versioned checkout
  onProgress?.({ stage: "checking-out", message: `Checking out ${targetRef}...` });

  const { tempDir, cleanup } = await createTempCheckout(absoluteSourcePath, resolvedCommit);

  return {
    sourcePath: tempDir,
    commit: resolvedCommit,
    cleanup,
  };
}

/**
 * Resolve the target commit for a source without creating any temp directories.
 * This allows early cache lookup before expensive git operations.
 *
 * @returns The commit SHA that would be used, or null if not determinable
 */
export async function resolveTargetCommit(
  sourceRoot: string,
  sourcePath: string,
  version?: VersionSpec
): Promise<string | null> {
  const absoluteSourcePath = path.resolve(sourceRoot, sourcePath);

  if (!fs.existsSync(absoluteSourcePath)) {
    return null;
  }

  const gitDir = path.join(absoluteSourcePath, ".git");
  if (!fs.existsSync(gitDir)) {
    throw new Error(`Source must be a git repository (or submodule): ${absoluteSourcePath}`);
  }

  // No version specifier - use current HEAD, but only if worktree is clean
  if (!version?.gitRef) {
    const isDirty = await isWorktreeDirty(absoluteSourcePath);
    if (isDirty) {
      return null; // Skip cache, force full provision which will error
    }
    return getGitCommit(absoluteSourcePath);
  }

  // Resolve the target ref to a commit SHA
  return resolveRef(absoluteSourcePath, version.gitRef);
}

/**
 * Get the current HEAD commit SHA for a git repo.
 */
export async function getGitCommit(repoPath: string): Promise<string> {
  return runGit(["rev-parse", "HEAD"], repoPath);
}

/**
 * Check if a git worktree has uncommitted changes.
 */
export async function isWorktreeDirty(repoPath: string): Promise<boolean> {
  const status = await runGit(["status", "--porcelain"], repoPath);
  return status.trim().length > 0;
}

/**
 * Assert that a git worktree is clean (no uncommitted changes).
 */
export async function assertCleanWorktree(repoPath: string): Promise<void> {
  if (await isWorktreeDirty(repoPath)) {
    throw new Error(
      `Source repo has uncommitted changes. Commit or stash before building: ${repoPath}`
    );
  }
}

/**
 * Check if worktree is clean and return the result with the path.
 */
export async function checkWorktreeClean(repoPath: string): Promise<{ clean: boolean; path: string }> {
  const dirty = await isWorktreeDirty(repoPath);
  return { clean: !dirty, path: repoPath };
}

/**
 * Check if a directory is a git repository and return detailed result.
 */
export async function checkGitRepository(repoPath: string): Promise<{ isRepo: boolean; path: string }> {
  const isRepo = await isGitRepositoryRoot(repoPath);
  return { isRepo, path: repoPath };
}

async function isGitRepositoryRoot(repoPath: string): Promise<boolean> {
  const gitDir = path.join(repoPath, ".git");
  if (!fs.existsSync(gitDir)) {
    return false;
  }

  try {
    const gitRoot = await runGit(["rev-parse", "--show-toplevel"], repoPath);
    const normalizedRepoPath = path.resolve(repoPath);
    const normalizedGitRoot = path.resolve(gitRoot);
    return normalizedRepoPath === normalizedGitRoot;
  } catch {
    return false;
  }
}

async function resolveRef(repoPath: string, ref: string): Promise<string> {
  try {
    return await runGit(["rev-parse", ref], repoPath);
  } catch (error) {
    const candidates: string[] = [];
    if (ref === "main") candidates.push("master");
    if (ref === "master") candidates.push("main");

    if (!ref.includes("/") && !ref.startsWith("refs/")) {
      candidates.push(`origin/${ref}`);
    }

    for (const candidate of candidates) {
      try {
        return await runGit(["rev-parse", candidate], repoPath);
      } catch {
        // continue
      }
    }

    const msg = error instanceof Error ? error.message : String(error);
    const hint =
      ref === "main" || ref === "master"
        ? `Hint: this repo may use "${ref === "main" ? "master" : "main"}" instead of "${ref}".`
        : `Hint: if you meant the default branch, omit the gitRef fragment (no "#...").`;
    throw new Error(`${msg}\n${hint}`);
  }
}

async function createTempCheckout(
  repoPath: string,
  commit: string
): Promise<{ tempDir: string; cleanup: () => Promise<void> }> {
  const tempBase = getGitTempBuildsDirectory(repoPath);
  const tempDir = path.join(tempBase, `build-${commit.slice(0, 8)}-${Date.now()}`);

  try {
    // Try using git worktree first (more efficient, shares object store)
    await runGit(["worktree", "add", "--detach", tempDir, commit], repoPath);
    return {
      tempDir,
      cleanup: async () => {
        try {
          await runGit(["worktree", "remove", "--force", tempDir], repoPath);
        } catch (error) {
          console.warn(`[sharedBuild] Failed to remove worktree: ${tempDir}`, error);
          try {
            await fs.promises.rm(tempDir, { recursive: true, force: true });
          } catch (rmError) {
            console.warn(`[sharedBuild] Failed to cleanup temp dir: ${tempDir}`, rmError);
          }
        }
      },
    };
  } catch (worktreeError) {
    // Fallback to archive extraction if worktree fails
    console.warn("[sharedBuild] Worktree failed, falling back to archive:", worktreeError);

    await fs.promises.mkdir(tempDir, { recursive: true });

    const archivePath = path.join(tempBase, `archive-${commit.slice(0, 8)}.tar`);
    await runGit(["archive", "-o", archivePath, commit], repoPath);
    await execFileAsync("tar", ["-xf", archivePath, "-C", tempDir]);
    await fs.promises.rm(archivePath, { force: true });

    return {
      tempDir,
      cleanup: async () => {
        try {
          await fs.promises.rm(tempDir, { recursive: true, force: true });
        } catch (error) {
          console.warn(`[sharedBuild] Failed to cleanup temp dir: ${tempDir}`, error);
        }
      },
    };
  }
}

async function runGit(args: string[], cwd: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd,
      maxBuffer: 10 * 1024 * 1024,
    });
    return stdout.trim();
  } catch (error) {
    throw new Error(
      `Git command failed (${args.join(" ")}): ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

// ===========================================================================
// Dependency Management
// ===========================================================================

export interface DependencyInstallOptions {
  /** Directory for deps (node_modules will be created here) */
  depsDir: string;
  /** Dependencies to install */
  dependencies: Record<string, string>;
  /** Previous dependency hash for cache comparison */
  previousHash?: string;
  /** Canonical path for cache keying */
  canonicalPath?: string;
  /** Logger function */
  log?: (message: string) => void;
  /** User workspace path for @workspace-* package resolution (overrides getActiveWorkspace) */
  userWorkspacePath?: string;
}

export interface DependencyInstallResult {
  /** Hash of installed dependencies */
  hash: string;
  /** Path to node_modules */
  nodeModulesDir: string;
}

// Cache for Verdaccio versions (shared across builds)
let lastVerdaccioVersions: Record<string, string> | null = null;
const relevantVersionsCache = new Map<string, Record<string, string>>();

/**
 * Install dependencies into a directory.
 * Uses Verdaccio for package resolution and content-addressable store for efficiency.
 */
export async function installDependencies(
  options: DependencyInstallOptions
): Promise<DependencyInstallResult | undefined> {
  const { depsDir, dependencies, previousHash, canonicalPath, log = console.log.bind(console), userWorkspacePath } = options;

  if (!dependencies || Object.keys(dependencies).length === 0) {
    return undefined;
  }

  fs.mkdirSync(depsDir, { recursive: true });
  const packageJsonPath = path.join(depsDir, "package.json");
  const npmrcPath = path.join(depsDir, ".npmrc");

  // Verdaccio is required for dependency resolution
  if (!isVerdaccioServerInitialized()) {
    throw new Error(
      "Verdaccio server not initialized. Cannot resolve dependencies without local npm registry."
    );
  }

  const verdaccio = getVerdaccioServer();
  const verdaccioRunning = await verdaccio.ensureRunning();
  if (!verdaccioRunning) {
    throw new Error(
      "Verdaccio server failed to start. Cannot resolve dependencies. " +
      `Last error: ${verdaccio.getExitError()?.message ?? "unknown"}`
    );
  }

  // Use provided workspace path, falling back to active workspace
  const activeWorkspace = getActiveWorkspace();
  const effectiveWorkspacePath = userWorkspacePath ?? activeWorkspace?.path;
  if (effectiveWorkspacePath) {
    verdaccio.setUserWorkspacePath(effectiveWorkspacePath);
  }

  // Create a workspace-like object for the rest of the function
  const userWorkspace = effectiveWorkspacePath ? { path: effectiveWorkspacePath } : null;

  // Translate workspace:* to * (Verdaccio serves local packages)
  const resolvedDependencies: Record<string, string> = {};
  for (const [name, version] of Object.entries(dependencies)) {
    resolvedDependencies[name] = version.startsWith("workspace:") ? "*" : version;
  }

  // Write .npmrc to point to local Verdaccio registry
  const verdaccioUrl = verdaccio.getBaseUrl();
  fs.writeFileSync(npmrcPath, `registry=${verdaccioUrl}\n`);

  const desiredPackageJson = {
    name: "natstack-build-runtime",
    private: true,
    version: "1.0.0",
    dependencies: resolvedDependencies,
  };
  const serialized = JSON.stringify(desiredPackageJson, null, 2);

  // Get Verdaccio versions for cache invalidation
  const natstackVersions = await verdaccio.getVerdaccioVersions();
  const userWorkspaceVersions = userWorkspace
    ? await verdaccio.getUserWorkspaceVersions(userWorkspace.path)
    : {};
  const verdaccioVersions = { ...natstackVersions, ...userWorkspaceVersions };

  // Check if versions changed
  const allKeys = [...new Set([
    ...Object.keys(verdaccioVersions),
    ...Object.keys(lastVerdaccioVersions ?? {})
  ])].sort();
  const versionsChanged = !lastVerdaccioVersions ||
    JSON.stringify(verdaccioVersions, allKeys) !== JSON.stringify(lastVerdaccioVersions, allKeys);

  if (versionsChanged) {
    relevantVersionsCache.clear();
  }

  let relevantVersions: Record<string, string>;

  if (!versionsChanged && canonicalPath) {
    relevantVersions = relevantVersionsCache.get(canonicalPath) ?? {};
  } else {
    relevantVersions = {};
    const packagesDir = getPackagesDir();

    if (!packagesDir) {
      relevantVersions = { ...verdaccioVersions };
    } else {
      const visited = new Set<string>();

      const walkDeps = (pkgName: string) => {
        if (visited.has(pkgName)) return;

        let pkgJsonPath: string | null = null;

        if (pkgName.startsWith("@natstack/")) {
          const pkgDir = pkgName.replace("@natstack/", "");
          pkgJsonPath = path.join(packagesDir, pkgDir, "package.json");
        } else if (userWorkspace) {
          if (pkgName.startsWith("@workspace-panels/")) {
            const pkgDir = pkgName.replace("@workspace-panels/", "");
            pkgJsonPath = path.join(userWorkspace.path, "panels", pkgDir, "package.json");
          } else if (pkgName.startsWith("@workspace-workers/")) {
            const pkgDir = pkgName.replace("@workspace-workers/", "");
            pkgJsonPath = path.join(userWorkspace.path, "workers", pkgDir, "package.json");
          } else if (pkgName.startsWith("@workspace-agents/")) {
            const pkgDir = pkgName.replace("@workspace-agents/", "");
            pkgJsonPath = path.join(userWorkspace.path, "agents", pkgDir, "package.json");
          } else if (pkgName.startsWith("@workspace/")) {
            const pkgDir = pkgName.replace("@workspace/", "");
            pkgJsonPath = path.join(userWorkspace.path, "packages", pkgDir, "package.json");
          }
        }

        if (!pkgJsonPath) return;

        visited.add(pkgName);
        if (verdaccioVersions[pkgName]) {
          relevantVersions[pkgName] = verdaccioVersions[pkgName];
        }

        if (fs.existsSync(pkgJsonPath)) {
          try {
            const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, "utf-8"));
            for (const dep of Object.keys(pkgJson.dependencies ?? {})) {
              walkDeps(dep);
            }
          } catch {
            // Skip malformed package.json
          }
        }
      };

      for (const dep of Object.keys(resolvedDependencies)) {
        walkDeps(dep);
      }
    }

    if (canonicalPath) {
      relevantVersionsCache.set(canonicalPath, relevantVersions);
    }
    lastVerdaccioVersions = verdaccioVersions;
  }

  const hashInput = serialized + JSON.stringify(relevantVersions, Object.keys(relevantVersions).sort());
  const desiredHash = crypto.createHash("sha256").update(hashInput).digest("hex");

  const nodeModulesPath = path.join(depsDir, "node_modules");
  const packageLockPath = path.join(depsDir, "package-lock.json");

  if (previousHash === desiredHash && fs.existsSync(nodeModulesPath)) {
    const existingContent = fs.existsSync(packageJsonPath)
      ? fs.readFileSync(packageJsonPath, "utf-8")
      : null;
    if (existingContent !== serialized) {
      fs.writeFileSync(packageJsonPath, serialized);
    }
    return { hash: desiredHash, nodeModulesDir: nodeModulesPath };
  }

  fs.writeFileSync(packageJsonPath, serialized);

  if (fs.existsSync(packageLockPath)) {
    fs.rmSync(packageLockPath, { recursive: true, force: true });
  }

  const store = await getPackageStore();
  const cachedResolution = store.getResolutionCache(desiredHash);

  let tree: SerializedTree;

  if (cachedResolution) {
    tree = JSON.parse(cachedResolution.treeJson) as SerializedTree;
  } else {
    const arborist = new Arborist({
      path: depsDir,
      registry: verdaccioUrl,
      preferOnline: true,
    });
    const idealTree = await arborist.buildIdealTree();
    tree = serializeTree(idealTree);
    store.setResolutionCache(desiredHash, JSON.stringify(tree));
  }

  const fetcher = await createPackageFetcher(verdaccioUrl);
  const packages = tree.packages.map((p) => ({
    name: p.name,
    version: p.version,
    integrity: p.integrity,
  }));
  await fetcher.fetchAll(packages, { concurrency: 10 });

  const linker = await createPackageLinker(fetcher);
  await linker.linkFromCache(depsDir, tree);

  return { hash: desiredHash, nodeModulesDir: nodeModulesPath };
}

/**
 * Get node module resolution paths for a build.
 */
export function getNodeResolutionPaths(
  sourcePath: string,
  runtimeNodeModules: string,
  appNodeModules?: string
): string[] {
  const localNodeModules = path.join(sourcePath, "node_modules");
  const paths: string[] = [runtimeNodeModules, localNodeModules];
  if (appNodeModules) {
    paths.push(appNodeModules);
  }
  return paths;
}

/**
 * Get a hash of all current Verdaccio package versions.
 */
export async function getVerdaccioVersionsHash(): Promise<string> {
  if (!isVerdaccioServerInitialized()) {
    return "";
  }

  try {
    const verdaccio = getVerdaccioServer();
    const natstackVersions = await verdaccio.getVerdaccioVersions();
    const userWorkspace = getActiveWorkspace();
    const userWorkspaceVersions = userWorkspace
      ? await verdaccio.getUserWorkspaceVersions(userWorkspace.path)
      : {};

    const allVersions = { ...natstackVersions, ...userWorkspaceVersions };

    if (Object.keys(allVersions).length === 0) {
      return "";
    }

    const sorted = Object.keys(allVersions).sort();
    return crypto.createHash("sha256").update(JSON.stringify(allVersions, sorted)).digest("hex").slice(0, 12);
  } catch {
    return "";
  }
}

/**
 * Compute a dependency hash from dependencies and Verdaccio versions.
 */
export function computeDependencyHash(
  deps: Record<string, string>,
  verdaccioVersions: Record<string, string>,
  canonicalPath?: string
): string {
  const input = JSON.stringify(deps) + JSON.stringify(verdaccioVersions, Object.keys(verdaccioVersions).sort());
  if (canonicalPath) {
    return crypto.createHash("sha256").update(input + canonicalPath).digest("hex");
  }
  return crypto.createHash("sha256").update(input).digest("hex");
}

// ===========================================================================
// TypeScript Configuration
// ===========================================================================

/**
 * Read user's tsconfig.json compiler options, resolving extends chains.
 */
export function readUserCompilerOptions(sourcePath: string): Record<string, unknown> {
  const tsconfigPath = path.join(sourcePath, "tsconfig.json");
  if (!fs.existsSync(tsconfigPath)) {
    return {};
  }

  try {
    const visited = new Set<string>();
    const read = (configPath: string): Record<string, unknown> => {
      const resolvedPath = path.resolve(configPath);
      if (visited.has(resolvedPath)) {
        return {};
      }
      visited.add(resolvedPath);

      const content = fs.readFileSync(resolvedPath, "utf-8");
      const parsed = ts.parseConfigFileTextToJson(resolvedPath, content);
      const config = (parsed.config ?? {}) as {
        extends?: string | string[];
        compilerOptions?: Record<string, unknown>;
      };

      const baseExtends = config.extends;
      let baseOptions: Record<string, unknown> = {};
      if (typeof baseExtends === "string") {
        const basePath = resolveTsconfigExtends(resolvedPath, baseExtends);
        if (basePath) {
          baseOptions = read(basePath);
        }
      }

      return { ...baseOptions, ...(config.compilerOptions ?? {}) };
    };

    return read(tsconfigPath);
  } catch {
    return {};
  }
}

function resolveTsconfigExtends(fromTsconfigPath: string, extendsValue: string): string | null {
  const baseDir = path.dirname(fromTsconfigPath);

  const isFileLike =
    extendsValue.startsWith(".") ||
    extendsValue.startsWith("/") ||
    extendsValue.includes(path.sep) ||
    extendsValue.includes("/");

  if (isFileLike) {
    const candidate = path.resolve(baseDir, extendsValue);
    const withJson = candidate.endsWith(".json") ? candidate : `${candidate}.json`;
    if (fs.existsSync(candidate)) return candidate;
    if (fs.existsSync(withJson)) return withJson;
    return null;
  }

  try {
    const req = createRequire(import.meta.url);
    const resolved = req.resolve(extendsValue, { paths: [baseDir] });
    return resolved;
  } catch {
    return null;
  }
}

/**
 * Pick safe compiler options from user's tsconfig based on build kind.
 *
 * - panel: allows jsxImportSource for JSX transform customization
 * - worker: does not allow jsxImportSource (runs in WebContentsView but uses worker patterns)
 * - agent: does not allow jsxImportSource (Node.js process, no JSX expected)
 */
export function pickSafeCompilerOptions(
  userCompilerOptions: Record<string, unknown>,
  kind: BuildKind
): Record<string, unknown> {
  const allowlist = new Set<string>([
    "experimentalDecorators",
    "emitDecoratorMetadata",
    "useDefineForClassFields",
  ]);

  // Only panels get jsxImportSource (they render React UI)
  if (kind === "panel") {
    allowlist.add("jsxImportSource");
  }

  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(userCompilerOptions)) {
    if (allowlist.has(key) && value !== undefined) {
      safe[key] = value;
    }
  }
  return safe;
}

/**
 * Write a build-specific tsconfig.json.
 * Only allowlisted user compiler options are merged.
 */
export function writeBuildTsconfig(
  buildDir: string,
  sourcePath: string,
  kind: BuildKind,
  baseCompilerOptions: Record<string, unknown>
): string {
  const userOptions = readUserCompilerOptions(sourcePath);
  const safeOverrides = pickSafeCompilerOptions(userOptions, kind);
  const compilerOptions = { ...baseCompilerOptions, ...safeOverrides };

  const tsconfigPath = path.join(buildDir, "tsconfig.json");
  fs.writeFileSync(
    tsconfigPath,
    JSON.stringify({ compilerOptions }, null, 2)
  );
  return tsconfigPath;
}

// ===========================================================================
// Type Checking
// ===========================================================================

export interface TypeCheckOptions {
  /** Path to source directory */
  sourcePath: string;
  /** Path to node_modules for type resolution */
  nodeModulesDir: string;
  /** Whether fs shimming is enabled (true for safe panels/workers, false for unsafe/agents) */
  fsShimEnabled: boolean;
  /** Logger function */
  log: (message: string) => void;
}

/**
 * Run TypeScript type checking on a source directory.
 * Returns an array of type errors (diagnostics with severity "error").
 */
export async function runTypeCheck(options: TypeCheckOptions): Promise<TypeCheckDiagnostic[]> {
  const { sourcePath, nodeModulesDir, fsShimEnabled, log } = options;

  log(`Type checking...`);

  try {
    const fileSource = createDiskFileSource(sourcePath);
    const files = await loadSourceFiles(fileSource, ".");

    if (files.size === 0) {
      log(`No TypeScript files found to type check`);
      return [];
    }

    log(`Type checking ${files.size} files...`);

    const packagesDir = getPackagesDir();
    const workspaceRoot = packagesDir ? path.dirname(packagesDir) : undefined;
    const userWorkspace = getActiveWorkspace();

    const service = createTypeCheckService({
      panelPath: sourcePath,
      resolution: {
        fsShimEnabled,
        runtimeNodeModules: nodeModulesDir,
      },
      workspaceRoot,
      skipSuggestions: true,
      nodeModulesPaths: [nodeModulesDir],
      userWorkspacePath: userWorkspace?.path,
    });

    for (const [relativePath, content] of files) {
      const absolutePath = path.join(sourcePath, relativePath);
      service.updateFile(absolutePath, content);
    }

    const result = await service.checkWithExternalTypes();
    const errors = result.diagnostics.filter((d) => d.severity === "error");

    if (errors.length > 0) {
      log(`Type check found ${errors.length} error(s)`);
    } else {
      log(`Type check passed`);
    }

    return errors;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(`Type check failed: ${message}`);
    return [{
      file: sourcePath,
      line: 1,
      column: 1,
      message: `Type checking failed: ${message}`,
      severity: "error",
      code: 0,
      category: ts.DiagnosticCategory.Error,
    }];
  }
}

// ===========================================================================
// Entry Point Resolution
// ===========================================================================

export interface ResolveEntryOptions {
  /** Path to source directory */
  sourcePath: string;
  /** Explicit entry from manifest (natstack.entry) */
  manifestEntry?: string;
  /** Candidate file names to check */
  candidates?: string[];
}

const DEFAULT_ENTRY_CANDIDATES = [
  "index.tsx",
  "index.ts",
  "index.jsx",
  "index.js",
  "main.tsx",
  "main.ts",
];

/**
 * Resolve the entry point for a build.
 * Uses manifest.entry if specified, otherwise searches for conventional entry files.
 *
 * NOTE: This does NOT use package.json main/exports - only natstack.entry or candidate list.
 * This is intentional: natstack builds are self-contained bundles, not npm packages.
 */
export function resolveEntryPoint(options: ResolveEntryOptions): string {
  const { sourcePath, manifestEntry, candidates = DEFAULT_ENTRY_CANDIDATES } = options;
  const absoluteSourcePath = path.resolve(sourcePath);

  const verifyEntry = (entryCandidate: string): string | null => {
    const entryPath = path.join(absoluteSourcePath, entryCandidate);
    return fs.existsSync(entryPath) ? entryCandidate : null;
  };

  if (manifestEntry) {
    const entry = verifyEntry(manifestEntry);
    if (!entry) {
      throw new Error(`Entry point not found: ${manifestEntry}`);
    }
    return entry;
  }

  const entries = candidates.filter(verifyEntry);
  if (entries.length > 1) {
    throw new Error(
      `Multiple conventional entry points found (${entries.join(", ")}). ` +
      `Please specify a single entry in your manifest.`
    );
  } else if (entries.length === 1) {
    return entries[0]!;
  }

  throw new Error(
    `No entry point found. Provide an entry file (e.g., index.ts) or set 'entry' in your manifest.`
  );
}

// ===========================================================================
// Manifest Loading (Base)
// ===========================================================================

export interface PackageJsonBase {
  name?: string;
  version?: string;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  natstack?: Record<string, unknown>;
}

/**
 * Load and parse package.json from a source directory.
 * Returns base fields; type-specific validation is done by each builder.
 */
export function loadPackageJson(sourcePath: string): PackageJsonBase {
  const packageJsonPath = path.join(sourcePath, "package.json");

  if (!fs.existsSync(packageJsonPath)) {
    throw new Error(`package.json not found in ${sourcePath}`);
  }

  const content = fs.readFileSync(packageJsonPath, "utf-8");
  return JSON.parse(content) as PackageJsonBase;
}

// ===========================================================================
// Cache Helpers
// ===========================================================================

const cacheManager = getMainCacheManager();

/**
 * Get a cached dependency hash.
 */
export function getDependencyHashFromCache(cacheKey: string): string | undefined {
  const cached = cacheManager.get(cacheKey, isDev());
  return cached ?? undefined;
}

/**
 * Save a dependency hash to cache.
 */
export async function saveDependencyHashToCache(cacheKey: string, hash: string): Promise<void> {
  await cacheManager.set(cacheKey, hash);
}
