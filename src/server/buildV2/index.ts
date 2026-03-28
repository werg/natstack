/**
 * Build System V2 — Public API + RPC service registration.
 *
 * The build system lives entirely in the server process.
 * Electron requests builds via RPC. The headless server gets builds for free.
 *
 * Builds are triggered by git push events (main/master branches only).
 * Cold-start detects what changed while the server was down via ref-state
 * comparison.
 *
 * Immutability: the PackageGraph is never mutated after creation. Content
 * hashes are tracked in a separate ContentHashMap, ensuring EV computations
 * are always consistent with their inputs.
 */

import * as path from "path";
import { discoverPackageGraph, type PackageGraph, type GraphNode } from "./packageGraph.js";
import {
  computeEffectiveVersions,
  computeEffectiveVersionsWithCache,
  computeGitTreeHashAsync,
  recomputeFromNode,
  snapshotRefState,
  loadPersistedRefState,
  loadPersistedEvMap,
  persistEvMap,
  persistRefState,
  diffEvMaps,
  computeBuildKey,
  getCommitAt,
  resolveDepRefToGitRef,
  type EffectiveVersionMap,
  type ContentHashMap,
  type ChangeSet,
} from "./effectiveVersion.js";
import * as buildStore from "./buildStore.js";
import type { BuildResult } from "./buildStore.js";
import { buildUnit, buildNpmLibrary, buildPlatformLibrary, initBuilder, type BuildUnitOptions } from "./builder.js";
import { PushTrigger } from "./pushTrigger.js";
import type { GitServer } from "@natstack/git-server";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AboutPageMeta {
  name: string;
  title: string;
  description?: string;
  hiddenInLauncher: boolean;
}

export type { BuildUnitOptions } from "./builder.js";

export interface BuildSystemV2 {
  /** Get build result for a panel/agent/worker/library. Optional ref builds at a specific git ref. */
  getBuild(unitPath: string, ref?: string, options?: BuildUnitOptions): Promise<BuildResult>;

  /** Build an npm package as a CJS library bundle for sandbox use. */
  getBuildNpm(specifier: string, version: string, externals?: string[]): Promise<{ bundle: string }>;

  /** Get effective version for a unit */
  getEffectiveVersion(unitName: string): string | null;

  /** Force recompute all effective versions */
  recompute(): Promise<ChangeSet>;

  /** Garbage collect unreferenced builds */
  gc(activeUnits: string[]): Promise<{ freed: number }>;

  /** List available about pages (for launcher UI) */
  getAboutPages(): Promise<AboutPageMeta[]>;

  /** Get the package graph */
  getGraph(): PackageGraph;

  /** Check if a unit exists */
  hasUnit(name: string): boolean;

  /** Get the workspace root */
  getWorkspaceRoot(): string;

  /**
   * Register a callback for when a push-triggered build completes.
   * The callback receives the source path (e.g. "panels/chat") so the
   * HTTP server can invalidate its serving cache.
   */
  onPushBuild(callback: (source: string) => void): void;

  /** Shut down (stop push trigger) */
  shutdown(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------

export async function initBuildSystemV2(
  workspaceRoot: string,
  gitServer: GitServer,
  appNodeModules: string,
): Promise<BuildSystemV2> {
  console.log("[BuildV2] Initializing...");

  // Declare where @natstack/* platform packages live (workspace:* deps).
  initBuilder(appNodeModules);

  // Step 1: Discover package graph
  const graph = discoverPackageGraph(workspaceRoot);
  const nodeCount = graph.allNodes().length;
  console.log(`[BuildV2] Discovered ${nodeCount} units in workspace`);

  // Step 2: Snapshot current ref state (main-branch commit per repo)
  const currentRefs = snapshotRefState(graph);
  const prevRefs = loadPersistedRefState();
  const previousEvMap = loadPersistedEvMap();

  // Step 3: Compute effective versions with cold-start optimization
  const initResult = computeEffectiveVersionsWithCache(graph, currentRefs, prevRefs, previousEvMap);
  const changeset = diffEvMaps(previousEvMap, initResult.evMap);
  console.log(
    `[BuildV2] EV diff: ${changeset.changed.length} changed, ` +
      `${changeset.added.length} added, ${changeset.removed.length} removed`,
  );

  // Step 4: Persist new ref state + EV map
  persistRefState(currentRefs);
  persistEvMap(initResult.evMap);

  // Step 5: Build anything that's missing from the store
  const buildableNodes = graph
    .allNodes()
    .filter((n) => n.kind !== "package" && n.kind !== "template"); // Panels, agents, and workers

  let buildCount = 0;
  for (const node of buildableNodes) {
    const ev = initResult.evMap[node.name];
    if (!ev) continue;

    const sourcemap = node.manifest.sourcemap !== false;
    const buildKey = computeBuildKey(node.name, ev, sourcemap);

    if (!buildStore.has(buildKey)) {
      buildCount++;
    }
  }

  if (buildCount > 0) {
    console.log(`[BuildV2] Building ${buildCount} units...`);
    const buildPromises = buildableNodes
      .filter((node) => {
        const ev = initResult.evMap[node.name];
        if (!ev) return false;
        const sourcemap = node.manifest.sourcemap !== false;
        return !buildStore.has(computeBuildKey(node.name, ev, sourcemap));
      })
      .map(async (node) => {
        try {
          await buildUnit(node, initResult.evMap[node.name]!, graph, workspaceRoot);
          console.log(`[BuildV2] Built ${node.name}`);
        } catch (error) {
          console.error(
            `[BuildV2] Failed to build ${node.name}:`,
            error instanceof Error ? error.message : String(error),
          );
        }
      });

    await Promise.all(buildPromises);
    console.log(`[BuildV2] Initial builds complete`);
  } else {
    console.log(`[BuildV2] All builds up-to-date`);
  }

  // Step 6: Start push trigger (subscribes to git push events)
  const pushTrigger = new PushTrigger(graph, initResult.evMap, initResult.contentHashes, workspaceRoot);
  pushTrigger.subscribeTo(gitServer);
  console.log("[BuildV2] Push trigger started");

  // Track current state — these are the single source of truth for the build API.
  // The push trigger emits "graph-updated" to keep them in sync.
  let currentEvMap = initResult.evMap;
  let currentContentHashes: ContentHashMap = initResult.contentHashes;
  let currentGraph = graph;

  pushTrigger.on("graph-updated", ({ graph: g, evMap: ev, contentHashes: ch }) => {
    currentGraph = g;
    currentEvMap = ev;
    currentContentHashes = ch;
  });

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  return {
    async getBuild(unitPath: string, ref?: string, options?: BuildUnitOptions): Promise<BuildResult> {
      // unitPath can be a package name or workspace-relative path
      let node = resolveUnit(currentGraph, unitPath, workspaceRoot);
      if (!node) {
        // Unit not in current graph — may have been just created via create_project.
        // Try a quick rediscovery before giving up.
        const newGraph = discoverPackageGraph(workspaceRoot);
        const result = computeEffectiveVersions(newGraph);
        currentGraph = newGraph;
        currentEvMap = result.evMap;
        currentContentHashes = result.contentHashes;
        persistEvMap(result.evMap);
        persistRefState(snapshotRefState(newGraph));
        pushTrigger.updateState(newGraph, result.evMap, result.contentHashes);

        node = resolveUnit(currentGraph, unitPath, workspaceRoot);
        if (!node) {
          // @natstack/* packages aren't in the workspace graph — they're compiled
          // platform packages in node_modules. Build them as library bundles
          // so eval can import them.
          if (unitPath.startsWith("@natstack/") && options?.library) {
            const bundle = await buildPlatformLibrary(unitPath, options.externals ?? []);
            return { bundle, manifest: null } as unknown as BuildResult;
          }
          throw new Error(`Unknown build unit: ${unitPath}`);
        }
      }

      // ── Ref-specific build path ──
      if (ref) {
        const commitSha = getCommitAt(node.path, ref);
        if (!commitSha) {
          throw new Error(`Ref not found: ${ref}`);
        }

        // Build commitMap by walking the dep tree parent-by-parent.
        // Each parent resolves its own children's refs via internalDepRefs,
        // so transitive deps (A→B→C) correctly use B's ref spec for C.
        const commitMap = new Map<string, string>();
        commitMap.set(node.name, commitSha);

        function walkDeps(parent: GraphNode): void {
          for (const depName of parent.internalDeps) {
            if (commitMap.has(depName)) continue;
            const dep = currentGraph.tryGet(depName);
            if (!dep) continue;
            const depRef = parent.internalDepRefs[depName];
            const gitRef = resolveDepRefToGitRef(dep.path, depRef);
            const depCommit = getCommitAt(dep.path, gitRef);
            if (depCommit) commitMap.set(dep.name, depCommit);
            walkDeps(dep);
          }
        }
        walkDeps(node);

        // Recompute EV at the requested ref
        const refResult = recomputeFromNode(currentGraph, node.name, currentEvMap, currentContentHashes, commitSha);
        const ev = refResult.evMap[node.name];
        if (!ev) {
          throw new Error(`No effective version for ${node.name} at ref ${ref}`);
        }

        return buildUnit(node, ev, currentGraph, workspaceRoot, commitMap, options);
      }

      // ── HEAD build path (existing behavior) ──

      // Check if the git tree hash has changed since the last EV computation.
      // This catches the race where commit_and_push returns before the push
      // trigger has processed the event. Fast path: if hash matches, skip
      // the expensive recomputeFromNode call entirely.
      // Uses async git to avoid blocking the event loop on every HTML request.
      let ev = currentEvMap[node.name];
      try {
        const freshTreeHash = await computeGitTreeHashAsync(node.path);
        if (freshTreeHash !== currentContentHashes[node.name]) {
          const result = recomputeFromNode(currentGraph, node.name, currentEvMap, currentContentHashes);
          const freshEv = result.evMap[node.name];
          if (freshEv && freshEv !== ev) {
            currentEvMap = result.evMap;
            currentContentHashes = result.contentHashes;
            persistEvMap(result.evMap);
            ev = freshEv;
          }
        }
      } catch {
        // Git hash check failed — use cached EV (best effort)
      }

      if (!ev) {
        throw new Error(`No effective version for ${node.name}`);
      }

      // Build on demand (buildUnit handles cache + coalescing internally)
      return buildUnit(node, ev, currentGraph, workspaceRoot, undefined, options);
    },

    async getBuildNpm(specifier: string, version: string, externals?: string[]): Promise<{ bundle: string }> {
      const bundle = await buildNpmLibrary(specifier, version, externals ?? []);
      return { bundle };
    },

    getEffectiveVersion(unitName: string): string | null {
      return currentEvMap[unitName] ?? null;
    },

    async recompute(): Promise<ChangeSet> {
      // Re-discover and recompute
      const newGraph = discoverPackageGraph(workspaceRoot);
      const result = computeEffectiveVersions(newGraph);
      const changes = diffEvMaps(currentEvMap, result.evMap);

      currentGraph = newGraph;
      currentEvMap = result.evMap;
      currentContentHashes = result.contentHashes;
      persistEvMap(result.evMap);
      persistRefState(snapshotRefState(newGraph));

      // Update push trigger with new state
      pushTrigger.updateState(newGraph, result.evMap, result.contentHashes);

      // Trigger builds for changed buildable units
      const buildableChanged = [...changes.changed, ...changes.added].filter(
        (name) => {
          const n = newGraph.tryGet(name);
          return n && n.kind !== "package" && n.kind !== "template";
        },
      );

      for (const name of buildableChanged) {
        const n = newGraph.get(name);
        const ev = result.evMap[name]!;
        const sourcemap = n.manifest.sourcemap !== false;
        const bk = computeBuildKey(name, ev, sourcemap);

        if (!buildStore.has(bk)) {
          try {
            await buildUnit(n, ev, newGraph, workspaceRoot);
          } catch (error) {
            console.error(
              `[BuildV2] Failed to rebuild ${name}:`,
              error instanceof Error ? error.message : String(error),
            );
          }
        }
      }

      return changes;
    },

    async gc(activeUnits: string[]): Promise<{ freed: number }> {
      const activeKeys = new Set<string>();
      for (const name of activeUnits) {
        const ev = currentEvMap[name];
        if (!ev) continue;
        const n = currentGraph.tryGet(name);
        if (!n) continue;
        const sourcemap = n.manifest.sourcemap !== false;
        activeKeys.add(computeBuildKey(name, ev, sourcemap));
      }
      return buildStore.gc(activeKeys);
    },

    async getAboutPages(): Promise<AboutPageMeta[]> {
      const pages: AboutPageMeta[] = [];
      for (const n of currentGraph.allNodes()) {
        if (!n.manifest.shell) continue;
        pages.push({
          name: n.relativePath.startsWith("about/") ? n.relativePath.slice(6) : n.relativePath,
          title: n.manifest.title ?? n.name,
          description: n.manifest.description,
          hiddenInLauncher: n.manifest.hiddenInLauncher ?? false,
        });
      }
      return pages;
    },

    getGraph(): PackageGraph {
      return currentGraph;
    },

    hasUnit(name: string): boolean {
      return currentGraph.has(name);
    },

    getWorkspaceRoot(): string {
      return workspaceRoot;
    },

    onPushBuild(callback: (source: string) => void): void {
      pushTrigger.on("build-complete", ({ name }: { name: string }) => {
        const node = currentGraph.tryGet(name);
        if (node) callback(node.relativePath);
      });
    },

    async shutdown(): Promise<void> {
      pushTrigger.stop();
      console.log("[BuildV2] Shut down");
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveUnit(
  graph: PackageGraph,
  unitPath: string,
  workspaceRoot: string,
): GraphNode | null {
  // Try direct name lookup first
  const byName = graph.tryGet(unitPath);
  if (byName) return byName;

  // Try workspace-relative path (e.g., "panels/chat", "about/about")
  for (const node of graph.allNodes()) {
    if (node.relativePath === unitPath) return node;
  }

  // Try as partial path (e.g., "chat" → "panels/chat")
  for (const node of graph.allNodes()) {
    const basename = path.basename(node.relativePath);
    if (basename === unitPath) return node;
  }

  return null;
}
