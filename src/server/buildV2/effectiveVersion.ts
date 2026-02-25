/**
 * Effective Version Computer — git tree hash + bottom-up EV computation.
 *
 * Every buildable unit gets an effective version: a single hash capturing
 * its own content AND all its transitive internal dependencies.
 *
 * ev(leaf)    = hash(treeHash(leaf))
 * ev(package) = hash(treeHash(package), ev(dep_1), ev(dep_2), ...)
 *
 * Each workspace unit is its own git repo (checkout: true), so the main
 * branch's tree hash captures all tracked content in one command.
 */

import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { execFileSync } from "child_process";
import type { InternalDepRef, PackageGraph } from "./packageGraph.js";
import { getUserDataPath } from "../../main/envPaths.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EffectiveVersionMap {
  [packageName: string]: string;
}

export interface ChangeSet {
  changed: string[];
  added: string[];
  removed: string[];
}

/** Per-unit commit SHA at the main branch, used for cold-start change detection. */
export interface RefState {
  [unitName: string]: string;
}

// ---------------------------------------------------------------------------
// Git Tree Hashing
// ---------------------------------------------------------------------------

const MAIN_CANDIDATES = ["refs/heads/main", "refs/heads/master"];

/** Cache: repo path -> resolved main ref */
const mainRefCache = new Map<string, string>();

/** Resolve the main branch ref for a repo. Tries main first, then master. Cached per-repo. */
export function resolveMainRef(repoPath: string): string {
  const cached = mainRefCache.get(repoPath);
  if (cached) return cached;
  for (const ref of MAIN_CANDIDATES) {
    try {
      execFileSync("git", ["rev-parse", "--verify", ref], {
        cwd: repoPath, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"],
      });
      mainRefCache.set(repoPath, ref);
      return ref;
    } catch { /* try next */ }
  }
  throw new Error(`No main/master branch found in ${repoPath}`);
}

/**
 * Compute the git tree hash for a repo at the given ref (defaults to main branch).
 * Returns a 40-char hex SHA.
 */
export function computeGitTreeHash(repoPath: string, ref?: string): string {
  const resolvedRef = ref ?? resolveMainRef(repoPath);
  return execFileSync("git", ["rev-parse", `${resolvedRef}^{tree}`], {
    cwd: repoPath, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"],
  }).toString().trim();
}

/** Get the commit SHA at a specific ref. Returns null if ref doesn't exist. */
export function getCommitAt(repoPath: string, ref?: string): string | null {
  const resolvedRef = ref ?? resolveMainRef(repoPath);
  try {
    return execFileSync("git", ["rev-parse", resolvedRef], {
      cwd: repoPath, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"],
    }).toString().trim();
  } catch { return null; }
}

function resolveDepRefToGitRef(repoPath: string, depRef?: InternalDepRef): string {
  if (!depRef || depRef.mode === "default") return resolveMainRef(repoPath);
  if (depRef.mode === "branch") return `refs/heads/${depRef.branch ?? "main"}`;
  if (depRef.mode === "ref") return depRef.ref ?? resolveMainRef(repoPath);
  return depRef.commit ?? resolveMainRef(repoPath);
}

function buildDepSignatures(
  graph: PackageGraph,
  nodeName: string,
  evMap: EffectiveVersionMap,
  commitCache: Map<string, string | null>,
): string[] {
  const node = graph.get(nodeName);
  const deps: string[] = [];

  for (const depName of node.internalDeps) {
    const depNode = graph.tryGet(depName);
    if (!depNode) continue;

    const depRef = node.internalDepRefs[depName];
    const ref = resolveDepRefToGitRef(depNode.path, depRef);
    const commitKey = `${depNode.path}\0${ref}`;
    const depCommit =
      commitCache.has(commitKey)
        ? commitCache.get(commitKey)!
        : (() => {
            const commit = getCommitAt(depNode.path, ref);
            commitCache.set(commitKey, commit);
            return commit;
          })();

    deps.push(
      `${depName}\0ref:${depRef?.raw ?? "workspace:*"}\0commit:${depCommit ?? "missing"}\0ev:${evMap[depName] ?? ""}`,
    );
  }

  return deps.sort();
}

// ---------------------------------------------------------------------------
// Hashing Utility
// ---------------------------------------------------------------------------

function hashStrings(parts: string[]): string {
  const hash = crypto.createHash("sha256");
  for (const part of parts) {
    hash.update(part);
    hash.update("\0");
  }
  return hash.digest("hex").slice(0, 16);
}

// ---------------------------------------------------------------------------
// Effective Version Computation
// ---------------------------------------------------------------------------

/**
 * Compute effective versions for all nodes in the graph using git tree hashes
 * at the main branch. Nodes where refs/heads/main doesn't exist are skipped.
 */
export function computeEffectiveVersions(graph: PackageGraph): EffectiveVersionMap {
  const evMap: EffectiveVersionMap = {};
  const commitCache = new Map<string, string | null>();

  for (const node of graph.topologicalOrder()) {
    try {
      if (!node.contentHash) {
        node.contentHash = computeGitTreeHash(node.path);
      }
    } catch {
      // No main/master branch — skip this node (not buildable)
      continue;
    }

    // EV = hash(contentHash, dep edge signatures: name+ref+commit+depEv)
    const depSigs = buildDepSignatures(graph, node.name, evMap, commitCache);
    evMap[node.name] = hashStrings([node.contentHash, ...depSigs]);
  }

  return evMap;
}

/**
 * Recompute tree hash for a specific node and propagate EV changes
 * up through its reverse dependencies.
 *
 * @param commitSha - Optional commit SHA to pin the changed node at (from push event).
 *   Passed to computeGitTreeHash so the tree hash matches the exact push commit.
 */
export function recomputeFromNode(
  graph: PackageGraph,
  nodeName: string,
  currentEvMap: EffectiveVersionMap,
  commitSha?: string,
): EffectiveVersionMap {
  const commitCache = new Map<string, string | null>();
  const node = graph.get(nodeName);
  node.contentHash = computeGitTreeHash(node.path, commitSha);

  // Recompute EVs for this node and all its reverse deps
  const affected = new Set([nodeName]);
  const reverseDeps = graph.getReverseDeps(nodeName);
  for (const dep of reverseDeps) {
    affected.add(dep);
  }

  // Recompute in topo order (only affected nodes)
  const newEvMap = { ...currentEvMap };
  for (const n of graph.topologicalOrder()) {
    if (!affected.has(n.name)) continue;

    // Lazily compute contentHash for reverse deps that don't have one yet
    // (e.g., after cold-start cache hit where only the changed node was hashed)
    if (!n.contentHash) {
      try {
        n.contentHash = computeGitTreeHash(n.path);
      } catch { continue; }
    }

    const depSigs = buildDepSignatures(graph, n.name, newEvMap, commitCache);
    newEvMap[n.name] = hashStrings([n.contentHash, ...depSigs]);
  }

  return newEvMap;
}

/**
 * Diff two EV maps to produce a changeset.
 */
export function diffEvMaps(
  previous: EffectiveVersionMap,
  current: EffectiveVersionMap,
): ChangeSet {
  const changed: string[] = [];
  const added: string[] = [];
  const removed: string[] = [];

  for (const [name, ev] of Object.entries(current)) {
    if (!(name in previous)) {
      added.push(name);
    } else if (previous[name] !== ev) {
      changed.push(name);
    }
  }

  for (const name of Object.keys(previous)) {
    if (!(name in current)) {
      removed.push(name);
    }
  }

  return { changed, added, removed };
}

// ---------------------------------------------------------------------------
// EV Map Persistence
// ---------------------------------------------------------------------------

function getEvMapPath(): string {
  return path.join(getUserDataPath(), "ev-map.json");
}

export function loadPersistedEvMap(): EffectiveVersionMap {
  const p = getEvMapPath();
  try {
    if (fs.existsSync(p)) {
      return JSON.parse(fs.readFileSync(p, "utf-8")) as EffectiveVersionMap;
    }
  } catch {
    // Corrupted — treat as empty
  }
  return {};
}

export function persistEvMap(evMap: EffectiveVersionMap): void {
  const p = getEvMapPath();
  const dir = path.dirname(p);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(p, JSON.stringify(evMap, null, 2));
}

// ---------------------------------------------------------------------------
// Ref-State Persistence (for cold-start change detection)
// ---------------------------------------------------------------------------

function getRefStatePath(): string {
  return path.join(getUserDataPath(), "ref-state.json");
}

/** Snapshot the current main-branch commit SHA for each unit in the graph. */
export function snapshotRefState(graph: PackageGraph): RefState {
  const state: RefState = {};
  for (const node of graph.allNodes()) {
    const commit = getCommitAt(node.path);
    if (commit) state[node.name] = commit;
  }
  return state;
}

export function loadPersistedRefState(): RefState {
  const p = getRefStatePath();
  try {
    if (fs.existsSync(p)) {
      return JSON.parse(fs.readFileSync(p, "utf-8")) as RefState;
    }
  } catch {
    // Corrupted — treat as empty
  }
  return {};
}

export function persistRefState(state: RefState): void {
  const p = getRefStatePath();
  const dir = path.dirname(p);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(p, JSON.stringify(state, null, 2));
}

/**
 * Compute effective versions with cold-start optimization.
 * Compares current ref state against previous ref state:
 * - Same commit AND no dep changed → reuse cached EV (skip git rev-parse)
 * - Different commit or dep changed → recompute tree hash
 *
 * Makes cold start O(changed repos) not O(all repos).
 */
export function computeEffectiveVersionsWithCache(
  graph: PackageGraph,
  currentRefs: RefState,
  prevRefs: RefState,
  prevEvMap: EffectiveVersionMap,
): EffectiveVersionMap {
  const evMap: EffectiveVersionMap = {};
  const recomputed = new Set<string>();
  const commitCache = new Map<string, string | null>();

  for (const node of graph.topologicalOrder()) {
    const prevCommit = prevRefs[node.name];
    const curCommit = currentRefs[node.name];

    // Skip nodes without a main branch commit
    if (!curCommit) continue;

    // Check if any dependency was recomputed
    const depChanged = node.internalDeps.some((dep) => recomputed.has(dep));

    const hasNonDefaultDepRefs = node.internalDeps.some(
      (dep) => (node.internalDepRefs[dep]?.mode ?? "default") !== "default",
    );

    if (
      prevCommit === curCommit &&
      !depChanged &&
      !hasNonDefaultDepRefs &&
      prevEvMap[node.name]
    ) {
      // No change — reuse cached EV
      evMap[node.name] = prevEvMap[node.name]!;
    } else {
      // Changed — recompute tree hash
      try {
        node.contentHash = computeGitTreeHash(node.path);
      } catch {
        continue; // Can't resolve main ref — skip
      }

      const depSigs = buildDepSignatures(graph, node.name, evMap, commitCache);
      evMap[node.name] = hashStrings([node.contentHash, ...depSigs]);
      recomputed.add(node.name);
    }
  }

  return evMap;
}

// ---------------------------------------------------------------------------
// Build Key
// ---------------------------------------------------------------------------

/** Increment when build logic changes (plugins, esbuild options, shims) to invalidate all cached builds. */
const BUILD_CACHE_VERSION = "3";

/**
 * Compute the build key for a unit: hash(BUILD_CACHE_VERSION, unitName, ev, sourcemap).
 * This is the content-addressed store key. Unit name is included to prevent
 * different units with identical EVs from sharing builds (different entry points,
 * HTML titles, dependency sets produce different artifacts).
 */
export function computeBuildKey(unitName: string, ev: string, sourcemap: boolean): string {
  return hashStrings([BUILD_CACHE_VERSION, unitName, ev, `sourcemap:${sourcemap}`]);
}
