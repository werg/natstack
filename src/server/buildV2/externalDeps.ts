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
import { execSync } from "child_process";
import { getUserDataPath } from "../../main/envPaths.js";
import type { PackageGraph, GraphNode } from "./packageGraph.js";

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
): Record<string, string> {
  const externals: Record<string, string> = {};
  const visited = new Set<string>();

  function walk(node: GraphNode) {
    if (visited.has(node.name)) return;
    visited.add(node.name);

    for (const [name, version] of Object.entries(node.dependencies)) {
      if (graph.isInternal(name)) {
        const dep = graph.tryGet(name);
        if (dep) walk(dep);
      } else {
        // Skip workspace:* deps — these are internal packages resolvable via rootNodeModules
        if (version.startsWith("workspace:")) continue;
        // External dependency — take higher version if conflict
        if (!externals[name] || compareVersions(version, externals[name]!) > 0) {
          externals[name] = version;
        }
      }
    }
  }

  walk(unit);
  return externals;
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
  return path.join(getUserDataPath(), "external-deps");
}

/**
 * Get or install external dependencies. Returns the path to the
 * node_modules directory.
 */
export async function ensureExternalDeps(
  deps: Record<string, string>,
): Promise<string> {
  if (Object.keys(deps).length === 0) {
    // No external deps — return a dummy path
    return "";
  }

  const key = hashDeps(deps);
  const cacheDir = path.join(getExternalDepsBaseDir(), key);
  const sentinelPath = path.join(cacheDir, ".ready");
  const nodeModulesDir = path.join(cacheDir, "node_modules");

  // Check sentinel
  if (fs.existsSync(sentinelPath)) {
    return nodeModulesDir;
  }

  // Install to temp dir, then atomically rename
  const tmpDir = `${cacheDir}.tmp.${Date.now()}.${process.pid}`;
  fs.mkdirSync(tmpDir, { recursive: true });

  // Write a minimal package.json for installation
  const pkgJson = {
    name: "external-deps-install",
    version: "0.0.0",
    private: true,
    dependencies: deps,
  };
  fs.writeFileSync(
    path.join(tmpDir, "package.json"),
    JSON.stringify(pkgJson, null, 2),
  );

  try {
    // Use npm install (or pnpm if available)
    execSync("npm install --prefer-offline --no-audit --no-fund --ignore-scripts --legacy-peer-deps", {
      cwd: tmpDir,
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 120_000,
    });

    // Write sentinel inside tmpDir BEFORE rename so winner is always complete
    fs.writeFileSync(path.join(tmpDir, ".ready"), new Date().toISOString());

    // Race-safe promotion: try rename, handle concurrent winner
    try {
      fs.renameSync(tmpDir, cacheDir);
    } catch (err: any) {
      if (err.code === "ENOTEMPTY" || err.code === "EEXIST" || err.code === "ENOTDIR") {
        // Another process won — verify their sentinel, use their cache
        if (fs.existsSync(sentinelPath)) {
          try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
          return nodeModulesDir;
        }
        // Winner incomplete — remove stale dir, retry rename
        try {
          fs.rmSync(cacheDir, { recursive: true, force: true });
          fs.renameSync(tmpDir, cacheDir);
        } catch {
          // Clean up both dirs to avoid stale state, let build fail transiently
          try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
          try { fs.rmSync(cacheDir, { recursive: true, force: true }); } catch {}
          throw new Error(`External deps cache race: failed to install for key ${key}`);
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
    } catch {
      // Ignore
    }
    throw new Error(
      `Failed to install external dependencies: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
