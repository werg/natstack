/**
 * External Dependency Cache — transitive external dep collection + cached installation.
 *
 * For a given panel/agent, walks the package graph and collects ALL external
 * dependencies from the unit itself and every internal package it transitively
 * depends on. The union is hashed and installed into a shared cache.
 *
 * {userData}/external-deps/{hash}/
 *   ├── node_modules/
 *   └── .ready   ← sentinel marking completed installation
 */

import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { getCentralDataPath } from "@natstack/env-paths";
import { runNpmInstall } from "@natstack/shared/npmInstaller";
import type { PackageGraph, GraphNode } from "./packageGraph.js";
import { assertPresent } from "../../lintHelpers";

// ---------------------------------------------------------------------------
// Transitive collection
// ---------------------------------------------------------------------------

/**
 * Collect all external (non-workspace) dependencies transitively
 * from a unit and all its internal dependencies.
 */
export function collectTransitiveExternalDeps(
  unit: GraphNode,
  graph: PackageGraph,
  workspaceRoot?: string,
  packageRoots: string[] = []
): Record<string, string> {
  const externals: Record<string, string> = {};
  const visited = new Set<string>();
  const visitedPackageJson = new Set<string>();

  function recordExternal(name: string, version: string) {
    // Skip workspace:* deps — these are source packages resolved from the app
    // install or the package graph. Their own npm deps are collected by walking
    // the package.json when available.
    if (version.startsWith("workspace:")) return;
    // External dependency — take higher version if conflict
    if (!externals[name] || compareVersions(version, assertPresent(externals[name])) > 0) {
      externals[name] = version;
    }
  }

  function walkDeps(dependencies: Record<string, string>, options: { walkWorkspaceDeps: boolean }) {
    for (const [name, version] of Object.entries(dependencies)) {
      if (graph.isInternal(name)) {
        const dep = graph.tryGet(name);
        if (dep) walkNode(dep);
        continue;
      }
      if (version.startsWith("workspace:") && options.walkWorkspaceDeps) {
        const pkg = workspaceRoot
          ? readWorkspacePackageJson(workspaceRoot, name, packageRoots)
          : null;
        if (pkg) walkPackageJson(pkg.path, pkg.dependencies);
        continue;
      }
      recordExternal(name, version);
    }
  }

  function walkPackageJson(packageJsonPath: string, dependencies: Record<string, string>) {
    if (visitedPackageJson.has(packageJsonPath)) return;
    visitedPackageJson.add(packageJsonPath);
    walkDeps(dependencies, { walkWorkspaceDeps: false });
  }

  function walkNode(node: GraphNode) {
    if (visited.has(node.name)) return;
    visited.add(node.name);
    walkDeps(node.dependencies, { walkWorkspaceDeps: true });
  }

  walkNode(unit);
  return externals;
}

function readWorkspacePackageJson(
  workspaceRoot: string,
  packageName: string,
  packageRoots: string[] = []
): { path: string; dependencies: Record<string, string> } | null {
  for (const pkgJsonPath of workspacePackageJsonCandidates(
    workspaceRoot,
    packageName,
    packageRoots
  )) {
    if (!fs.existsSync(pkgJsonPath)) continue;
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, "utf-8")) as {
        name?: string;
        dependencies?: Record<string, string>;
        peerDependencies?: Record<string, string>;
      };
      if (pkg.name !== packageName) continue;
      return {
        path: pkgJsonPath,
        dependencies: { ...pkg.peerDependencies, ...pkg.dependencies },
      };
    } catch {
      continue;
    }
  }

  for (const baseDir of workspacePackageRoots(workspaceRoot)) {
    if (!fs.existsSync(baseDir)) continue;
    for (const entry of fs.readdirSync(baseDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const pkgJsonPath = path.join(baseDir, entry.name, "package.json");
      if (!fs.existsSync(pkgJsonPath)) continue;
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, "utf-8")) as {
          name?: string;
          dependencies?: Record<string, string>;
          peerDependencies?: Record<string, string>;
        };
        if (pkg.name !== packageName) continue;
        return {
          path: pkgJsonPath,
          dependencies: { ...pkg.peerDependencies, ...pkg.dependencies },
        };
      } catch {
        continue;
      }
    }
  }
  return null;
}

function workspacePackageJsonCandidates(
  workspaceRoot: string,
  packageName: string,
  packageRoots: string[]
): string[] {
  const candidates: string[] = [];
  const addNodeModulesCandidate = (baseDir: string) => {
    candidates.push(path.join(baseDir, ...packageName.split("/"), "package.json"));
  };
  const addWorkspacePackageCandidate = (baseDir: string) => {
    candidates.push(path.join(baseDir, packageName.replace(/^@[^/]+\//, ""), "package.json"));
  };

  for (const baseDir of packageRoots) {
    addNodeModulesCandidate(baseDir);
  }
  for (const baseDir of workspacePackageRoots(workspaceRoot)) {
    addWorkspacePackageCandidate(baseDir);
  }

  return candidates;
}

function workspacePackageRoots(workspaceRoot: string): string[] {
  const repoRoot = path.dirname(workspaceRoot);
  return [path.join(workspaceRoot, "packages"), path.join(repoRoot, "packages")];
}

/**
 * Simple semver-ish comparison. Returns >0 if a > b.
 * Handles workspace:*, *, ^x.y.z, ~x.y.z, x.y.z
 */
function compareVersions(a: string, b: string): number {
  // Wildcards are lowest priority
  if (a === "*" || a === "workspace:*") return -1;
  if (b === "*" || b === "workspace:*") return 1;

  const parseVersion = (v: string): number[] => {
    const cleaned = v.replace(/^[\^~>=<]+/, "");
    return cleaned.split(".").map((n) => parseInt(n, 10) || 0);
  };

  const aParts = parseVersion(a);
  const bParts = parseVersion(b);

  for (let i = 0; i < Math.max(aParts.length, bParts.length); i++) {
    const diff = (aParts[i] ?? 0) - (bParts[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Cached Installation
// ---------------------------------------------------------------------------

function hashDeps(deps: Record<string, string>): string {
  const entries = Object.entries(deps).sort(([a], [b]) => a.localeCompare(b));
  const hash = crypto.createHash("sha256");
  hash.update(JSON.stringify(entries));
  return hash.digest("hex").slice(0, 16);
}

function getExternalDepsBaseDir(): string {
  return path.join(getCentralDataPath(), "external-deps");
}

function getExtensionRuntimeDepsBaseDir(): string {
  return path.join(getCentralDataPath(), "extension-runtime-deps");
}

function isFileSystemErrorCode(error: unknown, codes: readonly string[]): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as NodeJS.ErrnoException).code;
  return typeof code === "string" && codes.includes(code);
}

function warnCleanupFailure(pathName: string, error: unknown): void {
  console.warn(
    `[externalDeps] Failed to remove ${pathName}: ${error instanceof Error ? error.message : String(error)}`
  );
}

/**
 * Get or install external dependencies. Returns the path to the
 * node_modules directory.
 */
export async function ensureExternalDeps(deps: Record<string, string>): Promise<string> {
  return ensureDepsInstalled(deps, {
    baseDir: getExternalDepsBaseDir(),
    key: hashDeps(deps),
    ignoreScripts: true,
  });
}

export async function ensureExtensionRuntimeDeps(
  deps: Record<string, string>
): Promise<{ key: string | null; nodeModulesDir: string }> {
  if (Object.keys(deps).length === 0) {
    return { key: null, nodeModulesDir: "" };
  }
  const key = [
    hashDeps(deps),
    process.platform,
    process.arch,
    `abi${process.versions.modules ?? "unknown"}`,
  ].join("-");
  const nodeModulesDir = await ensureDepsInstalled(deps, {
    baseDir: getExtensionRuntimeDepsBaseDir(),
    key,
    ignoreScripts: false,
  });
  return { key, nodeModulesDir };
}

async function ensureDepsInstalled(
  deps: Record<string, string>,
  options: { baseDir: string; key: string; ignoreScripts: boolean }
): Promise<string> {
  if (Object.keys(deps).length === 0) {
    // No external deps — return a dummy path
    return "";
  }

  // Reject any version specifier that npm would interpret as a non-registry
  // source (file:, git+ssh://, https://, github:, npm:, local paths). Panel
  // / worker manifests can pass arbitrary `version` strings here through
  // the package.json transitive-collection path; without this guard, a
  // hostile manifest could `npm install` from any URL or copy any
  // user-readable file path into the build cache. See `buildNpmLibrary`'s
  // `validateNpmVersion` for the authoritative shape allow-list.
  // TODO: route legitimate non-registry installs through a separate,
  // shell-only API rather than relaxing this regex.
  const NPM_DEP_VERSION_RE = /^(\^|~|>=|<=|=|>|<)?\d+\.\d+\.\d+(-[\w.+-]+)?(\+[\w.+-]+)?$/;
  for (const [name, version] of Object.entries(deps)) {
    if (typeof version !== "string" || version.length === 0 || version.length > 64) {
      throw new Error(`Invalid npm version for ${name}: ${version}`);
    }
    if (version === "latest" || version === "*") continue;
    if (version.startsWith("workspace:")) continue;
    if (!NPM_DEP_VERSION_RE.test(version)) {
      throw new Error(
        `Refusing non-registry npm specifier for ${name}: "${version}". ` +
          `Only strict semver, "latest", or "*" allowed.`
      );
    }
  }

  const cacheDir = path.join(options.baseDir, options.key);
  const sentinelPath = path.join(cacheDir, ".ready");
  const nodeModulesDir = path.join(cacheDir, "node_modules");

  // Check sentinel
  if (fs.existsSync(sentinelPath)) {
    if (fs.existsSync(nodeModulesDir)) {
      return nodeModulesDir;
    }
    try {
      fs.rmSync(cacheDir, { recursive: true, force: true });
    } catch (cleanupError) {
      warnCleanupFailure(cacheDir, cleanupError);
    }
  }

  // Install to temp dir, then atomically rename. Use crypto.randomBytes for
  // an unpredictable name; predictable names invite local symlink races
  // where another process pre-creates `${cacheDir}.tmp.<guessed-ms>.<pid>`
  // as a symlink to a writable target.
  const tmpDir = `${cacheDir}.tmp.${crypto.randomBytes(16).toString("hex")}`;
  fs.mkdirSync(tmpDir, { recursive: true });

  // Write a minimal package.json for installation
  const pkgJson = {
    name: "external-deps-install",
    version: "0.0.0",
    private: true,
    dependencies: deps,
  };
  fs.writeFileSync(path.join(tmpDir, "package.json"), JSON.stringify(pkgJson, null, 2));

  try {
    runNpmInstall(tmpDir, { ignoreScripts: options.ignoreScripts });

    // Write sentinel inside tmpDir BEFORE rename so winner is always complete
    fs.writeFileSync(path.join(tmpDir, ".ready"), new Date().toISOString());

    // Race-safe promotion: try rename, handle concurrent winner
    try {
      fs.renameSync(tmpDir, cacheDir);
    } catch (err: unknown) {
      if (isFileSystemErrorCode(err, ["ENOTEMPTY", "EEXIST", "ENOTDIR"])) {
        // Another process won — verify their sentinel, use their cache
        if (fs.existsSync(sentinelPath)) {
          try {
            fs.rmSync(tmpDir, { recursive: true, force: true });
          } catch (cleanupError) {
            warnCleanupFailure(tmpDir, cleanupError);
          }
          return nodeModulesDir;
        }
        // Winner incomplete — remove stale dir, retry rename
        try {
          fs.rmSync(cacheDir, { recursive: true, force: true });
          fs.renameSync(tmpDir, cacheDir);
        } catch {
          // Clean up both dirs to avoid stale state, let build fail transiently
          try {
            fs.rmSync(tmpDir, { recursive: true, force: true });
          } catch (cleanupError) {
            warnCleanupFailure(tmpDir, cleanupError);
          }
          try {
            fs.rmSync(cacheDir, { recursive: true, force: true });
          } catch (cleanupError) {
            warnCleanupFailure(cacheDir, cleanupError);
          }
          throw new Error(`External deps cache race: failed to install for key ${options.key}`);
        }
      } else {
        throw err;
      }
    }

    return nodeModulesDir;
  } catch (error) {
    // Clean up temp dir on failure
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (cleanupError) {
      warnCleanupFailure(tmpDir, cleanupError);
    }
    throw new Error(
      `Failed to install external dependencies: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}
