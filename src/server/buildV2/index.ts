/**
 * Build System V2 — Public API + RPC service registration.
 *
 * The build system lives entirely in the server process.
 * Electron requests builds via RPC. The headless server gets builds for free.
 *
 * Builds are triggered by git push events (main/master branches only).
 * Cold-start detects what changed while the server was down via ref-state
 * comparison.
 */

import * as path from "path";
import { discoverPackageGraph, type PackageGraph, type GraphNode } from "./packageGraph.js";
import {
  computeEffectiveVersions,
  computeEffectiveVersionsWithCache,
  snapshotRefState,
  loadPersistedRefState,
  loadPersistedEvMap,
  persistEvMap,
  persistRefState,
  diffEvMaps,
  computeBuildKey,
  type EffectiveVersionMap,
  type ChangeSet,
} from "./effectiveVersion.js";
import * as buildStore from "./buildStore.js";
import type { BuildResult } from "./buildStore.js";
import { buildUnit } from "./builder.js";
import { PushTrigger } from "./pushTrigger.js";
import type { GitServer } from "../../main/gitServer.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AboutPageMeta {
  name: string;
  title: string;
  description?: string;
  hiddenInLauncher: boolean;
}

export interface BuildSystemV2 {
  /** Get build result for a panel/about page */
  getBuild(unitPath: string): Promise<BuildResult>;

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

  /** Shut down (stop push trigger) */
  shutdown(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------

export async function initBuildSystemV2(
  workspaceRoot: string,
  gitServer: GitServer,
): Promise<BuildSystemV2> {
  console.log("[BuildV2] Initializing...");

  // Step 1: Discover package graph
  const graph = discoverPackageGraph(workspaceRoot);
  const nodeCount = graph.allNodes().length;
  console.log(`[BuildV2] Discovered ${nodeCount} units in workspace`);

  // Step 2: Snapshot current ref state (main-branch commit per repo)
  const currentRefs = snapshotRefState(graph);
  const prevRefs = loadPersistedRefState();
  const previousEvMap = loadPersistedEvMap();

  // Step 3: Compute effective versions with cold-start optimization
  const evMap = computeEffectiveVersionsWithCache(graph, currentRefs, prevRefs, previousEvMap);
  const changeset = diffEvMaps(previousEvMap, evMap);
  console.log(
    `[BuildV2] EV diff: ${changeset.changed.length} changed, ` +
      `${changeset.added.length} added, ${changeset.removed.length} removed`,
  );

  // Step 4: Persist new ref state + EV map
  persistRefState(currentRefs);
  persistEvMap(evMap);

  // Step 5: Build anything that's missing from the store
  const buildableNodes = graph
    .allNodes()
    .filter((n) => n.kind !== "package"); // Only panels and about pages

  let buildCount = 0;
  for (const node of buildableNodes) {
    const ev = evMap[node.name];
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
        const ev = evMap[node.name];
        if (!ev) return false;
        const sourcemap = node.manifest.sourcemap !== false;
        return !buildStore.has(computeBuildKey(node.name, ev, sourcemap));
      })
      .map(async (node) => {
        try {
          await buildUnit(node, evMap[node.name]!, graph, workspaceRoot);
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
  const pushTrigger = new PushTrigger(graph, evMap, workspaceRoot);
  pushTrigger.subscribeTo(gitServer);
  console.log("[BuildV2] Push trigger started");

  // Track current state
  let currentEvMap = evMap;
  let currentGraph = graph;

  // Keep in sync when pushTrigger does a full rediscovery (Fix 4)
  pushTrigger.on("graph-updated", ({ graph: g, evMap: ev }) => {
    currentGraph = g;
    currentEvMap = ev;
  });

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  return {
    async getBuild(unitPath: string): Promise<BuildResult> {
      // unitPath can be a package name or workspace-relative path
      const node = resolveUnit(currentGraph, unitPath, workspaceRoot);
      if (!node) {
        throw new Error(`Unknown build unit: ${unitPath}`);
      }

      const ev = currentEvMap[node.name];
      if (!ev) {
        throw new Error(`No effective version for ${node.name}`);
      }

      const sourcemap = node.manifest.sourcemap !== false;
      const buildKey = computeBuildKey(node.name, ev, sourcemap);

      // Check store
      const cached = buildStore.get(buildKey);
      if (cached) return cached;

      // Build on demand (push trigger should have caught this, but fallback)
      return buildUnit(node, ev, currentGraph, workspaceRoot);
    },

    getEffectiveVersion(unitName: string): string | null {
      return currentEvMap[unitName] ?? null;
    },

    async recompute(): Promise<ChangeSet> {
      // Re-discover and recompute
      const newGraph = discoverPackageGraph(workspaceRoot);
      const newEvMap = computeEffectiveVersions(newGraph);
      const changes = diffEvMaps(currentEvMap, newEvMap);

      currentGraph = newGraph;
      currentEvMap = newEvMap;
      persistEvMap(newEvMap);
      persistRefState(snapshotRefState(newGraph));

      // Update push trigger with new state
      pushTrigger.updateGraph(newGraph);
      pushTrigger.updateEvMap(newEvMap);

      // Trigger builds for changed buildable units
      const buildableChanged = [...changes.changed, ...changes.added].filter(
        (name) => {
          const node = newGraph.tryGet(name);
          return node && node.kind !== "package";
        },
      );

      for (const name of buildableChanged) {
        const node = newGraph.get(name);
        const ev = newEvMap[name]!;
        const sourcemap = node.manifest.sourcemap !== false;
        const buildKey = computeBuildKey(name, ev, sourcemap);

        if (!buildStore.has(buildKey)) {
          try {
            await buildUnit(node, ev, newGraph, workspaceRoot);
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
        const node = currentGraph.tryGet(name);
        if (!node) continue;
        const sourcemap = node.manifest.sourcemap !== false;
        activeKeys.add(computeBuildKey(name, ev, sourcemap));
      }
      return buildStore.gc(activeKeys);
    },

    async getAboutPages(): Promise<AboutPageMeta[]> {
      const pages: AboutPageMeta[] = [];
      for (const node of currentGraph.allNodes()) {
        if (node.kind !== "about") continue;
        pages.push({
          name: node.relativePath.replace("about/", ""),
          title: node.manifest.title ?? node.name,
          description: node.manifest.description,
          hiddenInLauncher: node.manifest.hiddenInLauncher ?? false,
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

    async shutdown(): Promise<void> {
      pushTrigger.stop();
      console.log("[BuildV2] Shut down");
    },
  };
}

// ---------------------------------------------------------------------------
// RPC Service Handler
// ---------------------------------------------------------------------------

/**
 * Create an RPC service handler for the build system.
 * Register this on the service dispatcher as "build".
 */
export function createBuildServiceHandler(
  buildSystem: BuildSystemV2,
): (
  ctx: { callerId: string; callerKind: string },
  method: string,
  args: unknown[],
) => Promise<unknown> {
  return async (_ctx, method, args) => {
    switch (method) {
      case "getBuild":
        return buildSystem.getBuild(args[0] as string);
      case "getEffectiveVersion":
        return buildSystem.getEffectiveVersion(args[0] as string);
      case "recompute":
        return buildSystem.recompute();
      case "gc":
        return buildSystem.gc(args[0] as string[]);
      case "getAboutPages":
        return buildSystem.getAboutPages();
      case "hasUnit":
        return buildSystem.hasUnit(args[0] as string);
      default:
        throw new Error(`Unknown build method: ${method}`);
    }
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
