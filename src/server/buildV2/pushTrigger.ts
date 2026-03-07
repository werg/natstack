/**
 * Push Trigger — subscribes to git push events, triggers EV recomputation
 * and rebuilds for main-branch pushes.
 *
 * Replaces the chokidar-based BuildWatcher. Concurrent pushes are serialized
 * via a promise queue to ensure consistent EV map and ref state updates.
 *
 * Immutability: the push trigger never mutates the PackageGraph. Content hashes
 * are tracked in a separate ContentHashMap, and EV maps are value types.
 */

import { EventEmitter } from "events";
import { execFileSync } from "child_process";
import { discoverPackageGraph, type PackageGraph } from "./packageGraph.js";
import type { ContentHashMap, EffectiveVersionMap } from "./effectiveVersion.js";
import {
  recomputeFromNode,
  diffEvMaps,
  persistEvMap,
  persistRefState,
  snapshotRefState,
  loadPersistedRefState,
  getCommitAt,
  computeGitTreeHash,
  computeEffectiveVersions,
  computeBuildKey,
} from "./effectiveVersion.js";
import * as buildStore from "./buildStore.js";
import { buildUnit } from "./builder.js";
import type { GitPushEvent, GitServer } from "@natstack/git-server";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PushTriggerEvents {
  "build-started": { name: string };
  "build-complete": { name: string; buildKey: string };
  "build-error": { name: string; error: string };
  "change-detected": { names: string[] };
  "graph-updated": { graph: PackageGraph; evMap: EffectiveVersionMap; contentHashes: ContentHashMap };
}

// ---------------------------------------------------------------------------
// Push Trigger
// ---------------------------------------------------------------------------

const MAIN_BRANCHES = new Set(["main", "master"]);

export class PushTrigger extends EventEmitter {
  private queue: Promise<void> = Promise.resolve();
  private graph: PackageGraph;
  private evMap: EffectiveVersionMap;
  private contentHashes: ContentHashMap;
  private workspaceRoot: string;
  private unsubscribe: (() => void) | null = null;

  constructor(
    graph: PackageGraph,
    evMap: EffectiveVersionMap,
    contentHashes: ContentHashMap,
    workspaceRoot: string,
  ) {
    super();
    this.graph = graph;
    this.evMap = evMap;
    this.contentHashes = contentHashes;
    this.workspaceRoot = workspaceRoot;
  }

  /** Subscribe to push events from the git server. */
  subscribeTo(gitServer: GitServer): void {
    this.unsubscribe = gitServer.onPush((event) => this.handlePush(event));
  }

  /** Unsubscribe from push events. */
  stop(): void {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
  }

  updateState(graph: PackageGraph, evMap: EffectiveVersionMap, contentHashes: ContentHashMap): void {
    this.graph = graph;
    this.evMap = evMap;
    this.contentHashes = contentHashes;
  }

  private handlePush(event: GitPushEvent): void {
    const nodeName = this.findNodeByRepoPath(event.repo);
    if (!nodeName) {
      // Unknown repo — likely a newly created project not yet in the package graph.
      // Trigger full rediscovery so it gets picked up and built.
      console.log(
        `[PushTrigger] Push from unknown repo "${event.repo}", triggering full rediscovery`,
      );
      this.queue = this.queue
        .then(() => this.fullRediscovery())
        .catch((error) =>
          console.error(`[PushTrigger] Error during rediscovery for ${event.repo}:`, error),
        );
      return;
    }
    if (!this.shouldProcessPush(nodeName, event)) return;

    const isMainLike = MAIN_BRANCHES.has(event.branch);

    // Serialize: queue behind any in-progress push processing
    this.queue = this.queue
      .then(async () => {
        // Non-main/main-master-ref pushes are dependency-ref specific; use full rediscovery.
        // Main/master keeps fast incremental path.
        if (!isMainLike) {
          console.log(
            `[PushTrigger] Tracked ref push ${event.branch} for ${nodeName}, triggering full rediscovery`,
          );
          await this.fullRediscovery();
          return;
        }

        // Main/master: check if package.json deps/manifest changed — if so, full rediscovery
        if (this.checkPackageJsonChanged(nodeName, event.commit)) {
          console.log(
            `[PushTrigger] package.json changed for ${nodeName}, triggering full rediscovery`,
          );
          await this.fullRediscovery();
        } else {
          await this.processChange(nodeName, event.commit);
        }
      })
      .catch((error) =>
        console.error(`[PushTrigger] Error processing push for ${nodeName}:`, error),
      );
  }

  private shouldProcessPush(nodeName: string, event: GitPushEvent): boolean {
    if (MAIN_BRANCHES.has(event.branch)) return true;

    // Branch/ref-pinned dependency edges: if any dependent references this node
    // at the pushed branch/ref, we must refresh EVs.
    const reverseDeps = this.graph.getReverseDeps(nodeName);
    for (const dependentName of reverseDeps) {
      const dependent = this.graph.tryGet(dependentName);
      if (!dependent) continue;
      const depRef = dependent.internalDepRefs[nodeName];
      if (!depRef) continue;

      if (depRef.mode === "branch" && depRef.branch === event.branch) return true;
      if (
        depRef.mode === "ref" &&
        (depRef.ref === event.branch || depRef.ref === `refs/heads/${event.branch}`)
      ) {
        return true;
      }
      if (depRef.mode === "commit" && depRef.commit === event.commit) return true;
    }

    return false;
  }

  /**
   * Find the graph node whose relativePath matches the push event's repo path.
   * The repo path from the git server is e.g. "panels/chat", matching node.relativePath.
   */
  private findNodeByRepoPath(repoPath: string): string | null {
    for (const node of this.graph.allNodes()) {
      if (node.relativePath === repoPath) return node.name;
    }
    return null;
  }

  private async processChange(nodeName: string, commitSha: string): Promise<void> {
    // 1. Build commitMap: pushed node at push commit, deps at their EV-basis commits
    const prevRefState = loadPersistedRefState();
    const commitMap = new Map<string, string>();
    commitMap.set(nodeName, commitSha);
    for (const node of this.graph.allNodes()) {
      if (node.name !== nodeName) {
        // Use persisted ref (matches the commit EVs were computed from)
        const ref = prevRefState[node.name];
        if (ref) {
          commitMap.set(node.name, ref);
        } else {
          // New node not in previous ref state — snapshot current
          const sha = getCommitAt(node.path);
          if (sha) commitMap.set(node.name, sha);
        }
      }
    }

    // 2. Recompute EVs using the pushed node's pinned commit (no graph mutation)
    const result = recomputeFromNode(this.graph, nodeName, this.evMap, this.contentHashes, commitSha);
    const changeset = diffEvMaps(this.evMap, result.evMap);

    // Update state and persist
    this.evMap = result.evMap;
    this.contentHashes = result.contentHashes;
    persistEvMap(result.evMap);
    persistRefState(snapshotRefState(this.graph));

    // Sync to build system closure
    this.emit("graph-updated", { graph: this.graph, evMap: result.evMap, contentHashes: result.contentHashes });

    const allChanged = [...changeset.changed, ...changeset.added];
    if (allChanged.length === 0) return;

    this.emit("change-detected", { names: allChanged });

    // 3. Trigger builds for changed units that are buildable (panels, about, agents — not packages)
    for (const name of allChanged) {
      const node = this.graph.tryGet(name);
      if (!node) continue;
      if (node.kind === "package") continue; // Packages are libraries, not buildable

      const ev = result.evMap[name]!;
      const sourcemap = node.manifest.sourcemap !== false;
      const buildKey = computeBuildKey(name, ev, sourcemap);

      if (buildStore.has(buildKey)) continue; // Already built

      this.emit("build-started", { name });

      try {
        await buildUnit(node, ev, this.graph, this.workspaceRoot, commitMap);
        this.emit("build-complete", { name, buildKey });
      } catch (error) {
        this.emit("build-error", {
          name,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  /**
   * Check whether the pushed commit changed package.json deps or natstack manifest
   * compared to the current graph node. Returns true if rediscovery is needed.
   */
  private checkPackageJsonChanged(nodeName: string, commitSha: string): boolean {
    const node = this.graph.get(nodeName);
    try {
      const pkgStr = execFileSync(
        "git", ["show", `${commitSha}:package.json`],
        { cwd: node.path, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
      );
      const pkg = JSON.parse(pkgStr);
      const newDeps = { ...pkg.peerDependencies, ...pkg.dependencies };
      const newManifest = pkg.natstack ?? {};

      // Compare deps (names AND versions) — sorted to avoid key-order false positives
      if (sortedJsonStr(newDeps) !== sortedJsonStr(node.dependencies)) return true;
      // Compare manifest — sorted for same reason
      if (sortedJsonStr(newManifest) !== sortedJsonStr(node.manifest as Record<string, unknown>)) return true;
      return false;
    } catch {
      return true; // Can't read — assume changed (safe)
    }
  }

  /**
   * Full graph rediscovery: re-scan workspace, snapshot commit SHAs,
   * recompute all EVs, and build changed units.
   *
   * Snapshot-first: captures commit SHAs for all nodes before computing EVs,
   * ensuring EV/source consistency when the same commitMap is used for extraction.
   */
  private async fullRediscovery(): Promise<void> {
    // 1. Fresh graph from disk
    const newGraph = discoverPackageGraph(this.workspaceRoot);

    // 2. Snapshot commit SHAs and pre-compute content hashes
    const commitMap = new Map<string, string>();
    const preHashes: ContentHashMap = {};
    for (const node of newGraph.allNodes()) {
      const sha = getCommitAt(node.path);
      if (sha) {
        commitMap.set(node.name, sha);
        try {
          preHashes[node.name] = computeGitTreeHash(node.path, sha);
        } catch {
          // Skip — computeEffectiveVersions will handle it
        }
      }
    }

    // 3. Compute EVs using pre-computed hashes (no graph mutation)
    const result = computeEffectiveVersions(newGraph, preHashes);
    const changeset = diffEvMaps(this.evMap, result.evMap);

    // 4. Update state and persist
    this.graph = newGraph;
    this.evMap = result.evMap;
    this.contentHashes = result.contentHashes;
    persistEvMap(result.evMap);
    persistRefState(snapshotRefState(newGraph));

    // 5. Emit graph-updated so index.ts can sync
    this.emit("graph-updated", { graph: newGraph, evMap: result.evMap, contentHashes: result.contentHashes });

    // 6. Build changed units using the same commitMap
    const allChanged = [...changeset.changed, ...changeset.added];
    if (allChanged.length === 0) return;

    this.emit("change-detected", { names: allChanged });

    for (const name of allChanged) {
      const node = newGraph.tryGet(name);
      if (!node) continue;
      if (node.kind === "package") continue;

      const ev = result.evMap[name]!;
      const sourcemap = node.manifest.sourcemap !== false;
      const buildKey = computeBuildKey(name, ev, sourcemap);

      if (buildStore.has(buildKey)) continue;

      this.emit("build-started", { name });

      try {
        await buildUnit(node, ev, newGraph, this.workspaceRoot, commitMap);
        this.emit("build-complete", { name, buildKey });
      } catch (error) {
        this.emit("build-error", {
          name,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Stable JSON string for shallow object comparison (avoids key-order false positives). */
function sortedJsonStr(obj: Record<string, unknown>): string {
  return JSON.stringify(Object.entries(obj).sort(([a], [b]) => a.localeCompare(b)));
}
