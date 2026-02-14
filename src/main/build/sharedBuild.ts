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
import { isVerdaccioReady, getVerdaccioUrl, getPackageVersionResolver } from "../verdaccioConfig.js";
import { getPackagesDir, getActiveWorkspace } from "../paths.js";
import { getDependencyGraph } from "../dependencyGraph.js";
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
} from "@natstack/typecheck";
import { ESM_SAFE_PACKAGES } from "../lazyBuild/esmTransformer.js";
// Re-export TypeCheckDiagnostic for consumers
export type { TypeCheckDiagnostic };

const execFileAsync = promisify(execFile);

// ===========================================================================
// Package Scope Constants
// ===========================================================================

/**
 * Package scopes that are considered "internal" (built locally via Verdaccio).
 * Used for dependency tracking, cache invalidation, and version resolution.
 */
export const INTERNAL_PACKAGE_PREFIXES = [
  "@natstack/",
  "@workspace/",
  "@workspace-panels/",
  "@workspace-workers/",
  "@workspace-agents/",
] as const;

/**
 * Check if a package name is an internal/local package.
 */
export function isInternalPackage(name: string): boolean {
  return INTERNAL_PACKAGE_PREFIXES.some((prefix) => name.startsWith(prefix));
}

/**
 * Package scopes from user workspaces (excludes @natstack/).
 * Used for determining repo source (user workspace vs natstack).
 */
export const USER_WORKSPACE_PREFIXES = [
  "@workspace/",
  "@workspace-panels/",
  "@workspace-workers/",
  "@workspace-agents/",
] as const;

/**
 * Check if a package name is from a user workspace.
 */
export function isUserWorkspacePackage(name: string): boolean {
  return USER_WORKSPACE_PREFIXES.some((prefix) => name.startsWith(prefix));
}

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
  /** Pre-resolved commit from resolveTargetCommit — skips redundant git ops when no gitRef */
  preResolved?: { commit: string };
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
  const { sourceRoot, sourcePath, version, onProgress, preResolved } = options;
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

  // Fast path: if commit was pre-resolved by resolveTargetCommit and no gitRef,
  // skip redundant assertCleanWorktree + getGitCommit calls
  if (preResolved && !version?.gitRef) {
    onProgress?.({ stage: "ready", message: "Using current working directory" });
    return {
      sourcePath: absoluteSourcePath,
      commit: preResolved.commit,
      cleanup: null,
    };
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
  /** Consumer key for dependency graph registration (e.g., "panel:/path/to/panel") */
  consumerKey?: string;
}

export interface DependencyInstallResult {
  /** Hash of installed dependencies */
  hash: string;
  /** Path to node_modules */
  nodeModulesDir: string;
  /** Resolved versions for ESM-safe packages (for version pinning in externals) */
  esmVersions?: Map<string, string>;
}

/**
 * Install dependencies into a directory.
 * Uses Verdaccio for package resolution and content-addressable store for efficiency.
 *
 * Cache invalidation is now handled at publish-time via the dependency graph,
 * so we no longer need to walk the dependency tree or track versions here.
 */
export async function installDependencies(
  options: DependencyInstallOptions
): Promise<DependencyInstallResult | undefined> {
  const { depsDir, dependencies, previousHash, log = console.log.bind(console), userWorkspacePath, consumerKey } = options;

  if (!dependencies || Object.keys(dependencies).length === 0) {
    return undefined;
  }

  fs.mkdirSync(depsDir, { recursive: true });
  const packageJsonPath = path.join(depsDir, "package.json");
  const npmrcPath = path.join(depsDir, ".npmrc");

  // Verdaccio is required for dependency resolution
  if (!isVerdaccioReady()) {
    throw new Error(
      "Verdaccio server not initialized. Cannot resolve dependencies without local npm registry."
    );
  }

  const verdaccioUrl = getVerdaccioUrl()!;

  // Verify Verdaccio is reachable
  try {
    await fetch(verdaccioUrl + "/-/ping");
  } catch {
    throw new Error("Verdaccio server is not reachable. Cannot resolve dependencies.");
  }

  // Helper to check if a package is a local/workspace package
  const isLocalPackage = isInternalPackage;

  // Translate workspace:* to * (Verdaccio serves local packages)
  // Also warn about bare "*" usage for local packages (Option 2)
  const resolvedDependencies: Record<string, string> = {};
  const bareStarPackages: string[] = [];
  for (const [name, version] of Object.entries(dependencies)) {
    if (version === "*" && isLocalPackage(name)) {
      bareStarPackages.push(name);
    }
    resolvedDependencies[name] = version.startsWith("workspace:") ? "*" : version;
  }

  // Warn about bare "*" usage - developers should use "workspace:*" for clarity
  if (bareStarPackages.length > 0) {
    log(`[sharedBuild] Warning: Using bare "*" for local packages: ${bareStarPackages.join(", ")}`);
    log(`[sharedBuild] Consider using "workspace:*" instead for clarity and pnpm compatibility`);
  }

  // Write .npmrc to point to local Verdaccio registry
  fs.writeFileSync(npmrcPath, `registry=${verdaccioUrl}\n`);

  // Resolve actual versions for local packages with "*" using branch-aware lookup.
  // This ensures Arborist installs the correct branch-tagged version instead of
  // resolving "*" to the "latest" tag (which may point to a different branch).
  const localVersions: Record<string, string> = {};
  const localPackagesWithStar = Object.entries(resolvedDependencies)
    .filter(([name, version]) => version === "*" && isLocalPackage(name))
    .map(([name]) => name);

  if (localPackagesWithStar.length > 0) {
    // Query Verdaccio for current versions of local packages (branch-aware)
    const versionQueries = localPackagesWithStar.map(async (name) => {
      const version = await getPackageVersionResolver()(name);
      return { name, version };
    });
    const results = await Promise.all(versionQueries);
    for (const { name, version } of results) {
      if (version) {
        localVersions[name] = version;
        // Use exact versions in dependencies so Arborist installs the correct
        // branch-tagged version instead of resolving "*" to "latest"
        resolvedDependencies[name] = version;
      }
    }
  }

  const desiredPackageJson = {
    name: "natstack-build-runtime",
    private: true,
    version: "1.0.0",
    dependencies: resolvedDependencies,
  };
  const serialized = JSON.stringify(desiredPackageJson, null, 2);

  // Compute hash including resolved local package versions
  // This ensures cache is invalidated when local packages are updated
  // Sort keys for deterministic hashing
  const sortedLocalVersions = Object.keys(localVersions).sort().reduce(
    (acc, key) => { acc[key] = localVersions[key]!; return acc; },
    {} as Record<string, string>
  );
  const hashInput = localPackagesWithStar.length > 0
    ? serialized + "\n" + JSON.stringify(sortedLocalVersions)
    : serialized;
  const desiredHash = crypto.createHash("sha256").update(hashInput).digest("hex");

  const nodeModulesPath = path.join(depsDir, "node_modules");

  if (previousHash === desiredHash && fs.existsSync(nodeModulesPath)) {
    const existingContent = fs.existsSync(packageJsonPath)
      ? fs.readFileSync(packageJsonPath, "utf-8")
      : null;
    if (existingContent !== serialized) {
      fs.writeFileSync(packageJsonPath, serialized);
    }
    // Extract ESM versions from cached resolution for version pinning
    const store = await getPackageStore();
    const cachedResolution = store.getResolutionCache(desiredHash);
    const esmVersions = new Map<string, string>();
    if (cachedResolution) {
      try {
        const cachedTree = JSON.parse(cachedResolution.treeJson) as SerializedTree;
        for (const pkg of cachedTree.packages) {
          if (ESM_SAFE_PACKAGES.has(pkg.name)) {
            esmVersions.set(pkg.name, pkg.version);
          }
        }
        // Register consumer even on cache hit to ensure publish-time invalidation works after app restart
        if (consumerKey) {
          const graph = await getDependencyGraph();
          const resolvedPackages = cachedTree.packages
            .map((p) => p.name)
            .filter(isInternalPackage);
          graph.registerConsumer(consumerKey, resolvedPackages);
        }
      } catch {
        // Ignore parse errors, externals will use unversioned URLs
      }
    }
    return { hash: desiredHash, nodeModulesDir: nodeModulesPath, esmVersions };
  }

  fs.writeFileSync(packageJsonPath, serialized);

  // Resolution is cached by our content-addressable store using the dep hash.
  // We don't use package-lock.json since any dep change produces a new hash
  // and triggers fresh resolution anyway.

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

  // Register this consumer with the dependency graph for targeted cache invalidation
  if (consumerKey) {
    try {
      const graph = await getDependencyGraph();
      // Extract internal packages (only @natstack/* and @workspace*) from resolved tree
      const resolvedPackages = tree.packages
        .map((p) => p.name)
        .filter(isInternalPackage);
      graph.registerConsumer(consumerKey, resolvedPackages);
    } catch (err) {
      // Don't fail the build if graph registration fails
      console.warn(`[sharedBuild] Failed to register consumer ${consumerKey}:`, err);
    }
  }

  // Extract ESM versions for version pinning in externals
  const esmVersions = new Map<string, string>();
  for (const pkg of tree.packages) {
    if (ESM_SAFE_PACKAGES.has(pkg.name)) {
      esmVersions.set(pkg.name, pkg.version);
    }
  }

  return { hash: desiredHash, nodeModulesDir: nodeModulesPath, esmVersions };
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
