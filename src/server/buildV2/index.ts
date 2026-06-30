/**
 * Build System V2 — Public API + RPC service registration.
 *
 * The build system lives entirely in the server process.
 * Electron requests builds via RPC. The headless server gets builds for free.
 *
 * Builds are triggered by workspace state advances on the GAD vcs log
 * (`vcs:workspace`). Cold start compares the persisted EV state's workspace
 * state hash against a fresh scan-on-demand snapshot — the snapshot IS the
 * change detection.
 *
 * Immutability: the PackageGraph is never mutated after creation. Content
 * hashes (GAD manifest subtree hashes) are tracked in a separate
 * ContentHashMap, ensuring EV computations are always consistent with their
 * inputs. Build sources are materialized from the immutable state the EVs
 * were computed at — the old commit/push race cannot exist.
 */

import * as path from "path";
import type { PackageGraph, GraphNode } from "./packageGraph.js";
import {
  computeEffectiveVersions,
  loadPersistedEvState,
  persistEvState,
  diffEvMaps,
  computeBuildKey,
  type ContentHashMap,
  type ChangeSet,
  type EffectiveVersionMap,
} from "./effectiveVersion.js";
import * as buildStore from "./buildStore.js";
import { primaryTextArtifactContent, type BuildResult } from "./buildStore.js";
import {
  analyzeExtensionDependencies,
  buildUnit,
  computeBuildUnitKey,
  buildNpmLibrary,
  buildPlatformLibrary,
  initBuilder,
  normalizeExtensionDependencyMode,
  type BuildUnitOptions,
  type ExtensionDependencyDiagnostics,
} from "./builder.js";
import {
  setBuildSourceProvider,
  getBuildSourceProvider,
  collectTransitiveInternalDeps,
  type BuildSourceProvider,
} from "./buildSource.js";
import { validateBuildRef } from "./refs.js";
import { typecheckUnit } from "./typecheckFold.js";
import { CONTAINER_SECTIONS, CONTENT_SECTIONS } from "../gadVcs/repoDiscovery.js";

/** Expected unit kind for a build-unit section, used to report a malformed
 *  (unresolvable) unit at the right kind even when no GraphNode exists. */
const SECTION_UNIT_KIND: Record<string, GraphNode["kind"]> = {
  packages: "package",
  panels: "panel",
  about: "panel",
  workers: "worker",
  extensions: "extension",
  apps: "app",
};
import { diagnosticsFromError, hasErrors, type BuildDiagnostic } from "./diagnostics.js";
import { recordDiagnostics, diagnosticsForUnit } from "./diagnosticsStore.js";
import type { LibraryBuildTarget } from "@natstack/shared/serviceSchemas/build";
import {
  StateTransitionTrigger,
  unitsForChangedPaths,
  isBuildableKind,
  sourcemapForKind,
  MAIN_HEAD,
  type StateAdvancedEvent,
  type StateChangedUnit,
  type WorkspaceStateSource,
} from "./stateTrigger.js";
import {
  collectTransitiveDependencyOverrides,
  collectTransitiveExternalDeps,
  ensureExternalDeps,
} from "./externalDeps.js";
import { EXTENSION_RUNTIME_ABI_VERSION } from "@natstack/shared/extensionRuntimeAbi";
import { assertPresent } from "../../lintHelpers";
import { onBuildProviderChange, resolveBuildProvider } from "./buildProviderRegistry.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AboutPageMeta {
  name: string;
  title: string;
  description?: string;
  hiddenInLauncher: boolean;
}

export interface ExtensionDoctorReport {
  name: string;
  kind: "extension";
  path: string;
  dependencyDiagnostics: ExtensionDependencyDiagnostics;
  buildMetadata: BuildResult["metadata"] | null;
  checks: Array<{ name: string; status: "pass" | "warn" | "fail"; message: string }>;
}

export interface BuildSystemBuildEvent {
  type: "build-started" | "build-complete" | "build-error";
  name: string;
  relativePath?: string;
  buildKey?: string;
  error?: string;
  /** Structured esbuild/tsc diagnostics on a build-error event. */
  diagnostics?: BuildDiagnostic[];
  trigger?: StateAdvancedEvent;
  timestamp: string;
}

export interface BuildSystemUnitChangeEvent extends StateChangedUnit {
  trigger: StateAdvancedEvent;
}

export interface RuntimeImageBinding {
  source: string;
  unitName: string;
  stateHash: string;
  effectiveVersion: string;
  buildKey: string;
}

// ---------------------------------------------------------------------------
// Per-repo build report (push gate contract) — agent-actionable, not a blob.
// ---------------------------------------------------------------------------

export type RepoBuildTargetKind = "runtime" | "library:panel" | "library:worker";

export interface RepoBuildTarget {
  target: RepoBuildTargetKind;
  exportPath?: string;
  buildKey?: string;
  /** Artifact manifests only — never byte content. */
  artifacts?: Array<{ path: string; role: string; contentType: string; integrity?: string }>;
  diagnostics: BuildDiagnostic[];
}

export interface RepoBuildReport {
  repoPath: string;
  unitName?: string;
  kind: GraphNode["kind"] | "content";
  role: "pushed" | "dependent";
  required: boolean;
  status: "ok" | "failed" | "skipped";
  builds: RepoBuildTarget[];
}

export interface ValidateRepoPushOptions {
  /** Workspace-rooted state to gate dependents against for the regression rule
   *  (the state BEFORE the push). When omitted, dependents gate absolutely. */
  baseView?: string;
}

export type { BuildUnitOptions } from "./builder.js";
export type {
  WorkspaceStateSource,
  StateAdvancedEvent,
  BuildRecord,
  StateChangedUnit,
} from "./stateTrigger.js";
export type { BuildSourceProvider } from "./buildSource.js";
export type { BuildDiagnostic } from "./diagnostics.js";
export { setBuildSourceProvider, directorySourceProvider } from "./buildSource.js";
export {
  clearBuildProvidersForTests,
  listBuildProviders,
  registerBuildProvider,
  resolveBuildProvider,
  onBuildProviderChange,
  unregisterBuildProvider,
} from "./buildProviderRegistry.js";

/**
 * The narrow push-gate contract WorkspaceVcs depends on — exactly the
 * `validateRepoPush` method, extracted so the VCS core (which must not import
 * the whole build system to avoid a build-dependency cycle) depends on a real
 * typed interface instead of an ad-hoc `as unknown as { … }` cast at the seam.
 * `BuildSystemV2` satisfies it structurally.
 */
export interface RepoPushValidator {
  validateRepoPush(
    repoPaths: string[],
    candidateView: string,
    options?: ValidateRepoPushOptions
  ): Promise<RepoBuildReport[]>;
  /**
   * On-demand build from a WORKING composed view, scoped to specific repos/units.
   * Unlike the push gate (`validateRepoPush`) this NEVER persists the EV baseline
   * or records builds — it never poisons the published baseline (builds are
   * authoritative only at push). Powers `vcs.previewBuild` (dev preview).
   */
  previewBuild(
    workingView: string,
    options?: { repoPaths?: string[]; units?: string[] }
  ): Promise<RepoBuildReport[]>;
}

export interface BuildUnitResolution {
  unitPath: string;
  unitName: string;
  kind: GraphNode["kind"];
  stateHash: string;
}

export interface BuildSystemV2 extends RepoPushValidator {
  /**
   * Get build result for a panel/worker/extension/library.
   * `ref` selects the workspace state to build from: undefined = main HEAD
   * (scan-on-demand), a head name (e.g. `ctx:abc`), or an immutable
   * `state:…` hash.
   */
  getBuild(
    unitPath: string,
    ref: string | undefined,
    options: BuildUnitOptions & { library: true }
  ): Promise<{ bundle: string }>;
  getBuild(
    unitPath: string,
    ref?: string,
    options?: BuildUnitOptions & { library?: false | undefined }
  ): Promise<BuildResult>;

  /** Resolve a build unit at main, a ctx:* head, or state:* without building it. */
  resolveBuildUnit(unitPath: string, ref?: string): Promise<BuildUnitResolution | null>;

  /** Get an immutable build-store artifact by build key. */
  getBuildByKey(key: string): BuildResult | null;

  /**
   * Binder API for runtime entities. Resolves a head/scope to a committed
   * state off the hot path, builds the unit from that immutable state, and
   * returns the global artifact identity the loader can fetch by key.
   */
  bindRuntimeImage(unitPath: string, ref?: string): Promise<RuntimeImageBinding>;

  /** Build an npm package as a CJS library bundle for sandbox use. */
  getBuildNpm(
    specifier: string,
    version: string,
    externals?: string[]
  ): Promise<{ bundle: string }>;

  /** Get effective version for a unit */
  getEffectiveVersion(unitName: string): string | null;

  /** Get external npm runtime/build dependencies for a unit. */
  getExternalDeps(unitName: string): Record<string, string>;

  /** Get the active provider identity that affects builds for a pluggable target. */
  getBuildProviderDetails(target: "react-native"): {
    name: string;
    activeEv: string | null;
    activeBuildKey: string | null;
    contractVersion: string;
  } | null;

  /** Subscribe to provider registration changes that can invalidate app build trust. */
  onBuildProviderChange(
    callback: (event: {
      type: "registered" | "unregistered";
      target: "react-native";
      provider: {
        name: string;
        activeEv: string | null;
        activeBuildKey: string | null;
        contractVersion: string;
      };
    }) => void
  ): () => void;

  /** Inspect an extension manifest, dependency routing, cached metadata, and smoke/build status. */
  doctorExtension(unitName: string): Promise<ExtensionDoctorReport>;

  /** Force recompute all effective versions */
  recompute(): Promise<ChangeSet>;

  /**
   * Server-internal push build gate. For each pushed repoPath, resolve the
   * owning unit against the candidate workspace view and build it directly
   * (not via the public `getBuild`, which strips library results) — capturing
   * structured esbuild + tsc diagnostics. Packages are validated as library
   * bundles for dependent-inferred targets × (root + declared exports).
   * EV-changed dependents are folded in under the regression gate (block only
   * if green on `baseView`, red on `candidateView`). Returns one
   * `RepoBuildReport` per repo, with artifact content stripped.
   */
  validateRepoPush(
    repoPaths: string[],
    candidateView: string,
    options?: ValidateRepoPushOptions
  ): Promise<RepoBuildReport[]>;

  /**
   * Queryable companion to `validateRepoPush`: build a single unit at a state
   * (or main HEAD) and return its `RepoBuildReport` with structured
   * diagnostics. Does NOT advance any head.
   */
  getBuildReport(unitName: string, stateHash?: string): Promise<RepoBuildReport>;

  /** Most recent structured build diagnostics for a unit, if any were captured. */
  getUnitDiagnostics(unitName: string): BuildDiagnostic[] | null;

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

  /** Recent state-triggered build lifecycle events and failures. */
  listRecentBuildEvents(unitName?: string): BuildSystemBuildEvent[];

  /** Wait until all queued state-advance processing has settled. */
  whenSettled(): Promise<void>;

  /**
   * Subscribe to state-triggered build lifecycle events (started/complete/error).
   * Returns an unsubscribe function. Used to feed unit diagnostics so build
   * failures are queryable alongside runtime logs.
   */
  onBuildEvent(callback: (event: BuildSystemBuildEvent) => void): () => void;

  /**
   * Subscribe to effective-version changes detected from VCS state advances.
   * Trusted unit hosts use this to rebuild apps/extensions through their
   * approval-aware activation paths because the state trigger intentionally
   * does not build trusted units directly.
   */
  onUnitChange(callback: (event: BuildSystemUnitChangeEvent) => void): () => void;

  /**
   * Register a callback for when a state-triggered build completes.
   * The callback receives the source path (e.g. "panels/chat") so the
   * HTTP server can invalidate its serving cache.
   */
  onPushBuild(
    callback: (source: string, trigger?: StateAdvancedEvent, buildKey?: string) => void
  ): void;

  /** Shut down (stop state trigger) */
  shutdown(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------

export async function initBuildSystemV2(
  workspaceRoot: string,
  source: WorkspaceStateSource & BuildSourceProvider,
  appNodeModules: string | string[]
): Promise<BuildSystemV2> {
  console.log("[BuildV2] Initializing...");
  const appNodeModuleRoots = Array.isArray(appNodeModules) ? appNodeModules : [appNodeModules];

  // Declare where @natstack/* platform packages live (workspace:* deps).
  initBuilder(appNodeModuleRoots);
  setBuildSourceProvider(source);

  // Step 1: Snapshot the workspace + discover package graph from that state
  // (scan-on-demand —
  // out-of-band edits made while the server was down become a first-class
  // observed transition right here).
  const { stateHash } = await source.ensureFresh();
  const graph = await source.discoverGraph(stateHash);
  const nodeCount = graph.allNodes().length;
  console.log(`[BuildV2] Discovered ${nodeCount} units in workspace`);

  // Step 2: Compute effective versions. Cold-start fast path: if the
  // persisted EV state was computed at this exact workspace state, reuse it
  // wholesale (zero DO hashing calls).
  const persisted = loadPersistedEvState();
  let evMap: EffectiveVersionMap;
  let contentHashes: ContentHashMap;
  if (persisted && persisted.stateHash === stateHash) {
    evMap = persisted.evMap;
    contentHashes = persisted.contentHashes;
    console.log(`[BuildV2] EV state reused (workspace unchanged at ${stateHash.slice(0, 18)}…)`);
  } else {
    const relPaths = graph.allNodes().map((node) => node.relativePath);
    const hashesByPath = await source.unitHashes(stateHash, relPaths);
    const fresh: ContentHashMap = {};
    for (const node of graph.allNodes()) {
      const hash = hashesByPath[node.relativePath];
      if (hash) fresh[node.name] = hash;
    }
    const result = computeEffectiveVersions(graph, fresh);
    evMap = result.evMap;
    contentHashes = result.contentHashes;
    const changeset = diffEvMaps(persisted?.evMap ?? {}, evMap);
    console.log(
      `[BuildV2] EV diff: ${changeset.changed.length} changed, ` +
        `${changeset.added.length} added, ${changeset.removed.length} removed`
    );
    persistEvState({ stateHash, evMap, contentHashes });
  }

  // Step 3: Identify missing non-trusted builds. The prewarm runs after the
  // build system is usable, so startup can continue to the app host while
  // unrelated workspace units compile in the background.
  const buildableNodes = graph
    .allNodes()
    // Trusted units are built only after the approval/reconcile path.
    .filter((n) => isNodeBuildable(n) && n.kind !== "extension" && n.kind !== "app");

  const missingInitialBuilds = buildableNodes.filter((node) => {
    const ev = evMap[node.name];
    if (!ev) return false;
    return !buildStore.has(computeBuildKey(node.name, ev, sourcemapForNode(node)));
  });
  let shuttingDown = false;
  let initialBuildPrewarm: Promise<void> = Promise.resolve();

  // Step 4: Start the state trigger (subscribes to vcs state advances)
  const trigger = new StateTransitionTrigger({
    graph,
    evMap,
    contentHashes,
    stateHash,
    workspaceRoot,
    source,
  });
  trigger.start();
  console.log("[BuildV2] State trigger started");

  const currentState = () => trigger.getState();
  const recentBuildEvents: BuildSystemBuildEvent[] = [];
  const buildEventListeners = new Set<(event: BuildSystemBuildEvent) => void>();
  const unitChangeListeners = new Set<(event: BuildSystemUnitChangeEvent) => void>();
  const recordBuildEvent = (event: Omit<BuildSystemBuildEvent, "relativePath" | "timestamp">) => {
    const node = currentState().graph.tryGet(event.name);
    const full: BuildSystemBuildEvent = {
      ...event,
      relativePath: node?.relativePath,
      timestamp: new Date().toISOString(),
    };
    recentBuildEvents.push(full);
    if (recentBuildEvents.length > 200) {
      recentBuildEvents.splice(0, recentBuildEvents.length - 200);
    }
    for (const listener of buildEventListeners) {
      try {
        listener(full);
      } catch (err) {
        console.error("[BuildV2] build-event listener failed:", err);
      }
    }
  };

  trigger.on("build-started", ({ name, trigger: t }) => {
    recordBuildEvent({ type: "build-started", name, trigger: t });
  });
  trigger.on("build-complete", ({ name, buildKey, trigger: t }) => {
    recordBuildEvent({ type: "build-complete", name, buildKey, trigger: t });
  });
  trigger.on("build-error", ({ name, error, diagnostics, trigger: t }) => {
    recordBuildEvent({ type: "build-error", name, error, diagnostics, trigger: t });
  });
  trigger.on("change-detected", ({ units, trigger: t }) => {
    for (const unit of units) {
      const event: BuildSystemUnitChangeEvent = { ...unit, trigger: t };
      for (const listener of unitChangeListeners) {
        try {
          listener(event);
        } catch (err) {
          console.error("[BuildV2] unit-change listener failed:", err);
        }
      }
    }
  });

  if (missingInitialBuilds.length > 0) {
    console.log(
      `[BuildV2] Prewarming ${missingInitialBuilds.length} missing non-app units in background...`
    );
    initialBuildPrewarm = new Promise<void>((resolve) => {
      setImmediate(() => {
        if (shuttingDown) {
          resolve();
          return;
        }
        void prewarmInitialBuilds({
          nodes: missingInitialBuilds,
          evMap,
          graph,
          workspaceRoot,
          stateHash,
          recordBuildEvent,
        }).then(resolve, (error: unknown) => {
          console.error(
            "[BuildV2] Initial build prewarm failed:",
            error instanceof Error ? error.message : String(error)
          );
          resolve();
        });
      });
    });
  } else {
    console.log(`[BuildV2] All builds up-to-date`);
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  const libraryBuildResult = (build: BuildResult): { bundle: string } => ({
    bundle: primaryTextArtifactContent(build),
  });

  /** Rediscover the graph and recompute all EVs at a state (new/unknown units). */
  const contentHashesAt = async (
    graphAtState: PackageGraph,
    atStateHash: string
  ): Promise<ContentHashMap> => {
    const relPaths = graphAtState.allNodes().map((node) => node.relativePath);
    const hashesByPath = await source.unitHashes(atStateHash, relPaths);
    const fresh: ContentHashMap = {};
    for (const node of graphAtState.allNodes()) {
      const hash = hashesByPath[node.relativePath];
      if (hash) fresh[node.name] = hash;
    }
    return fresh;
  };

  const rediscoverAt = (atStateHash: string): Promise<void> => trigger.rediscoverAt(atStateHash);

  const bindRuntimeImage: BuildSystemV2["bindRuntimeImage"] = async (unitPath, requestedRef) => {
    const ref = validateBuildRef(requestedRef);
    let graphAtState: PackageGraph;
    let evMapAtState: EffectiveVersionMap;
    let stateHash: string;

    if (!ref || ref === MAIN_HEAD) {
      const fresh = await source.ensureFresh();
      await trigger.whenSettled();
      if (currentState().stateHash !== fresh.stateHash) {
        await rediscoverAt(fresh.stateHash);
      }
      const snapshot = currentState();
      graphAtState = snapshot.graph;
      evMapAtState = snapshot.evMap;
      stateHash = snapshot.stateHash;
    } else {
      if (ref.startsWith("state:")) {
        stateHash = ref;
      } else if (ref.startsWith("ctx:")) {
        // A context ref builds against the context's composed view (all repos at
        // main, with the context's writable repos overlaid at their ctx heads).
        stateHash = await source.resolveContextView(ref.slice(4));
      } else {
        throw new Error(`Invalid build ref after validation: ${ref}`);
      }
      graphAtState = await source.discoverGraph(stateHash);
      const hashes = await contentHashesAt(graphAtState, stateHash);
      evMapAtState = computeEffectiveVersions(graphAtState, hashes).evMap;
    }

    let node = resolveUnit(graphAtState, unitPath, workspaceRoot);
    if (!node && (!ref || ref === MAIN_HEAD)) {
      await rediscoverAt(stateHash);
      const snapshot = currentState();
      graphAtState = snapshot.graph;
      evMapAtState = snapshot.evMap;
      node = resolveUnit(graphAtState, unitPath, workspaceRoot);
    }
    if (!node) throw new Error(`Unknown runtime build unit at ${ref ?? MAIN_HEAD}: ${unitPath}`);

    const ev = evMapAtState[node.name];
    if (!ev) throw new Error(`No effective version for ${node.name} at ${stateHash}`);

    const buildKey = computeBuildUnitKey(node, ev);
    await buildUnit(node, ev, graphAtState, workspaceRoot, stateHash);
    return {
      source: node.relativePath,
      unitName: node.name,
      stateHash,
      effectiveVersion: ev,
      buildKey,
    };
  };

  // -------------------------------------------------------------------------
  // Push build gate (W6) — validateRepoPush / getBuildReport
  // -------------------------------------------------------------------------

  interface GraphView {
    graph: PackageGraph;
    evMap: EffectiveVersionMap;
  }

  /** Discover + EV-compute over a workspace-rooted view (composed live union). */
  const viewAt = async (viewStateHash: string): Promise<GraphView> => {
    const graph = await source.discoverGraph(viewStateHash);
    const hashes = await contentHashesAt(graph, viewStateHash);
    const evMap = computeEffectiveVersions(graph, hashes).evMap;
    return { graph, evMap };
  };

  /** Manifest-only artifacts (no byte content) for a report. */
  const artifactManifests = (build: BuildResult): RepoBuildTarget["artifacts"] =>
    build.artifacts.map((a) => ({
      path: a.path,
      role: a.role,
      contentType: a.contentType,
      ...(a.integrity ? { integrity: a.integrity } : {}),
    }));

  /**
   * Build a single target for a unit at a state, capturing structured esbuild
   * diagnostics on failure + folding tsc diagnostics. Never throws — failures
   * land in the returned target's `diagnostics`.
   */
  const buildOneTarget = async (
    node: GraphNode,
    ev: string,
    graphAtView: PackageGraph,
    viewStateHash: string,
    spec: { target: "runtime" } | { target: "library:panel" | "library:worker"; exportPath: string }
  ): Promise<RepoBuildTarget> => {
    const libraryTarget: LibraryBuildTarget | null =
      spec.target === "library:panel"
        ? "panel"
        : spec.target === "library:worker"
          ? "worker"
          : null;
    const options: BuildUnitOptions | undefined = libraryTarget
      ? {
          library: true,
          libraryTarget,
          libraryEntrySubpath: (spec as { exportPath: string }).exportPath,
        }
      : undefined;
    const buildKey = computeBuildUnitKey(node, ev, options);

    const internalDeps = collectTransitiveInternalDeps(node, graphAtView);
    let diagnostics: BuildDiagnostic[] = [];
    let artifacts: RepoBuildTarget["artifacts"] | undefined;
    let buildError: unknown = null;
    try {
      const build = await buildUnit(node, ev, graphAtView, workspaceRoot, viewStateHash, options);
      artifacts = artifactManifests(build);
    } catch (error) {
      buildError = error;
    }

    // Fold typecheck diagnostics from the materialized source (best effort).
    // The same source root gives esbuild failure paths workspace coordinates
    // instead of cache/temp checkout paths.
    try {
      const { sourceRoot } = await getBuildSourceProvider().materializeForBuild(
        internalDeps,
        viewStateHash,
        workspaceRoot
      );
      if (buildError != null) {
        diagnostics = diagnosticsFromError(buildError, {
          workspaceRoot,
          sourceRoot,
          unitRelativePath: node.relativePath,
        });
      }
      // Provision resolution exactly like the build: workspace deps from the
      // materialized subtrees, external deps from the app node_modules. Without
      // both, the bare source root resolves nothing → false "Cannot find module".
      const tsc = await typecheckUnit(
        node.relativePath,
        sourceRoot,
        internalDeps.map((u) => ({ name: u.name, relativePath: u.relativePath })),
        appNodeModuleRoots
      );
      diagnostics = [...diagnostics, ...tsc];
    } catch (err) {
      console.warn(
        `[BuildV2] typecheck materialize failed for ${node.name}:`,
        err instanceof Error ? err.message : String(err)
      );
    }
    if (buildError != null && diagnostics.length === 0) {
      diagnostics = diagnosticsFromError(buildError, {
        workspaceRoot,
        unitRelativePath: node.relativePath,
      });
    }

    recordDiagnostics(node.name, buildKey, diagnostics);
    return {
      target: spec.target,
      ...(spec.target !== "runtime"
        ? { exportPath: (spec as { exportPath: string }).exportPath }
        : {}),
      buildKey,
      ...(artifacts ? { artifacts } : {}),
      diagnostics,
    };
  };

  /**
   * Infer which library targets a package needs based on its dependents' kinds.
   * panel/about → library:panel; worker/extension → library:worker; app builds
   * its own graph but may pull a package as either, so it contributes both.
   * Falls back to BOTH when no buildable dependents are known.
   */
  const libraryTargetsForDependents = (
    pkgName: string,
    graphAtView: PackageGraph
  ): Set<"library:panel" | "library:worker"> => {
    const targets = new Set<"library:panel" | "library:worker">();
    for (const depName of graphAtView.getReverseDeps(pkgName)) {
      const dep = graphAtView.tryGet(depName);
      if (!dep) continue;
      switch (dep.kind) {
        case "panel":
          targets.add("library:panel");
          break;
        case "worker":
        case "extension":
          targets.add("library:worker");
          break;
        case "app":
          targets.add("library:panel");
          targets.add("library:worker");
          break;
        default:
          break;
      }
    }
    if (targets.size === 0) {
      targets.add("library:panel");
      targets.add("library:worker");
    }
    return targets;
  };

  /** All export subpaths to validate for a package (root + declared exports). */
  const packageExportPaths = (node: GraphNode): string[] => {
    const set = new Set<string>(["."]);
    for (const e of node.exports ?? []) set.add(e);
    return [...set];
  };

  /**
   * Build a unit's full report at a view. For packages this produces a
   * library:* target per (inferred target × export path); for buildable units a
   * single runtime target; content-only / templates are skipped.
   */
  const buildUnitReport = async (
    node: GraphNode,
    view: GraphView,
    viewStateHash: string,
    role: "pushed" | "dependent"
  ): Promise<RepoBuildReport> => {
    const ev = view.evMap[node.name];
    const base: Omit<RepoBuildReport, "status" | "builds"> = {
      repoPath: node.relativePath,
      unitName: node.name,
      kind: node.kind,
      role,
      required: role === "pushed",
    };
    if (!ev) {
      return { ...base, status: "skipped", builds: [] };
    }
    if (node.kind === "template") {
      return { ...base, status: "skipped", builds: [] };
    }

    const builds: RepoBuildTarget[] = [];
    if (node.kind === "package") {
      const targets = libraryTargetsForDependents(node.name, view.graph);
      const exports = packageExportPaths(node);
      for (const target of targets) {
        for (const exportPath of exports) {
          builds.push(
            await buildOneTarget(node, ev, view.graph, viewStateHash, { target, exportPath })
          );
        }
      }
    } else {
      builds.push(await buildOneTarget(node, ev, view.graph, viewStateHash, { target: "runtime" }));
    }

    const failed = builds.some((b) => hasErrors(b.diagnostics));
    return { ...base, status: failed ? "failed" : "ok", builds };
  };

  const validateRepoPushImpl = async (
    repoPaths: string[],
    candidateView: string,
    options?: ValidateRepoPushOptions
  ): Promise<RepoBuildReport[]> => {
    const candidate = await viewAt(candidateView);
    const base: GraphView | null = options?.baseView ? await viewAt(options.baseView) : null;

    const reports: RepoBuildReport[] = [];
    const pushedUnitNames = new Set<string>();

    // 1) Pushed repos — absolute gate for buildable units; content-only skipped.
    //    The per-repo builds are independent (buildUnit coalesces by key), so
    //    build them concurrently; Promise.all preserves repoPaths order.
    const pushedResults = await Promise.all(
      repoPaths.map(async (repoPath): Promise<{ report: RepoBuildReport; unitName?: string }> => {
        const node = resolveUnit(candidate.graph, repoPath, workspaceRoot);
        if (!node) {
          const section = repoPath.split("/")[0] ?? "";
          const isBuildSection = CONTAINER_SECTIONS.has(section) && !CONTENT_SECTIONS.has(section);
          if (isBuildSection) {
            // A unit was expected here (packages/panels/workers/extensions/apps/about)
            // but none resolved — a malformed unit (missing/invalid package.json).
            // Surface a required failure with an actionable diagnostic instead of
            // silently skipping it as content.
            return {
              report: {
                repoPath,
                kind: SECTION_UNIT_KIND[section] ?? "package",
                role: "pushed",
                required: true,
                status: "failed",
                builds: [
                  {
                    target: "runtime",
                    diagnostics: [
                      {
                        source: "esbuild",
                        severity: "error",
                        file: `${repoPath}/package.json`,
                        line: 1,
                        column: 1,
                        message:
                          `No buildable unit resolved at ${repoPath}. A ${section}/ unit needs a ` +
                          `package.json with a "name" (and a natstack manifest). Create/fix it, then re-push.`,
                      },
                    ],
                  },
                ],
              },
            };
          }
          // Genuine content-only repo (projects/<vault>, skills, templates, meta).
          return {
            report: {
              repoPath,
              kind: "content",
              role: "pushed",
              required: false,
              status: "skipped",
              builds: [],
            },
          };
        }
        return {
          report: await buildUnitReport(node, candidate, candidateView, "pushed"),
          unitName: node.name,
        };
      })
    );
    for (const { report, unitName } of pushedResults) {
      reports.push(report);
      if (unitName) pushedUnitNames.add(unitName);
    }

    // 2) Dependents of pushed buildable units — EV-changed only, regression gate.
    const dependentNames = new Set<string>();
    for (const name of pushedUnitNames) {
      for (const dep of candidate.graph.getReverseDeps(name)) {
        if (!pushedUnitNames.has(dep)) dependentNames.add(dep);
      }
    }

    // Each dependent's candidate (and base-regression) build is independent —
    // build them concurrently rather than serializing the whole gate.
    const dependentReports = await Promise.all(
      [...dependentNames].map(async (depName): Promise<RepoBuildReport | null> => {
        const node = candidate.graph.tryGet(depName);
        if (!node) return null;
        const candEv = candidate.evMap[depName];
        const baseEv = base?.evMap[depName];
        // EV-changed only: skip dependents whose effective version is unchanged.
        if (base && candEv && baseEv && candEv === baseEv) return null;

        const report = await buildUnitReport(node, candidate, candidateView, "dependent");

        // Regression gate: a dependent that is ALSO red on the base view is a
        // pre-existing failure, not caused by this push — do not block on it.
        // With NO base to diff against we cannot tell pre-existing from new, so a
        // failed dependent gates absolutely (the documented `baseView`-omitted
        // contract) rather than slipping through as non-required.
        if (report.status === "failed") {
          if (!base) {
            report.required = true; // no base → gate absolutely
          } else {
            const baseReport = await buildUnitReport(node, base, options!.baseView!, "dependent");
            // Pre-existing red on the base is informational; newly red blocks.
            report.required = baseReport.status !== "failed";
          }
        } else {
          report.required = false;
        }
        return report;
      })
    );
    for (const report of dependentReports) {
      if (report) reports.push(report);
    }

    return reports;
  };

  /**
   * On-demand WORKING build (dev preview). Builds the requested repos/units from
   * a working composed view via the same ctx-ref build path as `validateRepoPush`
   * — BUT never persists the EV baseline and never records builds, so a preview
   * can never poison the published main baseline. Builds are authoritative only
   * at the push gate. Reports are role:"pushed" but required:false (advisory).
   */
  const previewBuildImpl = async (
    workingView: string,
    options?: { repoPaths?: string[]; units?: string[] }
  ): Promise<RepoBuildReport[]> => {
    const view = await viewAt(workingView);

    // Resolve the explicit scope to a deduped set of nodes. `repoPaths` are
    // workspace-relative repo roots; `units` are unit names / partial paths.
    // Both resolve through the same resolver used by the push gate.
    const requested = [...(options?.repoPaths ?? []), ...(options?.units ?? [])];
    const nodes = new Map<string, GraphNode>();
    const reports: RepoBuildReport[] = [];
    for (const spec of requested) {
      const node = resolveUnit(view.graph, spec, workspaceRoot);
      if (!node) {
        // Unresolvable target — surface as skipped/content rather than throwing,
        // mirroring the push gate's content-repo handling for preview ergonomics.
        reports.push({
          repoPath: spec,
          kind: "content",
          role: "pushed",
          required: false,
          status: "skipped",
          builds: [],
        });
        continue;
      }
      nodes.set(node.name, node);
    }

    // Build each resolved unit from the working view. buildUnitReport only calls
    // buildUnit + recordDiagnostics + typecheck (no persistEvState/recordBuild),
    // so this stays preview-only. Independent units build concurrently.
    const built = await Promise.all(
      [...nodes.values()].map((node) => buildUnitReport(node, view, workingView, "pushed"))
    );
    for (const report of built) {
      // Preview is advisory: never required (the push gate alone gates merges).
      reports.push({ ...report, required: false });
    }

    return reports;
  };

  const getBuild = async function getBuild(
    unitPath: string,
    ref?: string,
    options?: BuildUnitOptions
  ): Promise<BuildResult | { bundle: string }> {
    ref = validateBuildRef(ref);
    // ── Pinned-state / head-ref build path ──
    if (ref && ref !== MAIN_HEAD) {
      let buildState: string;
      if (ref.startsWith("state:")) {
        buildState = ref;
      } else if (ref.startsWith("ctx:")) {
        buildState = await source.resolveContextView(ref.slice(4));
      } else {
        throw new Error(`Invalid build ref after validation: ${ref}`);
      }

      const graphAtState = await source.discoverGraph(buildState);
      const resolvePinnedUnit = (): { node: GraphNode | null; libraryEntrySubpath?: string } => {
        if (options?.library) {
          const parsed = resolveLibraryUnit(graphAtState, unitPath);
          if (parsed) return parsed;
        }
        return { node: resolveUnit(graphAtState, unitPath, workspaceRoot) };
      };
      const resolved = resolvePinnedUnit();
      const node = resolved.node;
      if (!node) {
        if (unitPath.startsWith("@natstack/") && options?.library) {
          const bundle = await buildPlatformLibrary(unitPath, options.externals ?? []);
          return { bundle };
        }
        throw new Error(`Unknown build unit at ${ref}: ${unitPath}`);
      }
      assertNodeBuildable(node);

      const hashes = await contentHashesAt(graphAtState, buildState);
      const result = computeEffectiveVersions(graphAtState, hashes);
      const ev = result.evMap[node.name];
      if (!ev) {
        throw new Error(`No effective version for ${node.name} at ref ${ref}`);
      }
      const buildOptions = options?.library
        ? { ...options, library: true, libraryEntrySubpath: resolved.libraryEntrySubpath ?? "." }
        : options;
      const build = await buildUnit(
        node,
        ev,
        graphAtState,
        workspaceRoot,
        buildState,
        buildOptions
      );
      return options?.library ? libraryBuildResult(build) : build;
    }

    // unitPath can be a package name or workspace-relative path
    const resolveRequestedUnit = (): { node: GraphNode | null; libraryEntrySubpath?: string } => {
      const { graph } = currentState();
      if (options?.library) {
        const parsed = resolveLibraryUnit(graph, unitPath);
        if (parsed) return parsed;
      }
      return { node: resolveUnit(graph, unitPath, workspaceRoot) };
    };
    let resolved = resolveRequestedUnit();
    let node = resolved.node;
    if (!node) {
      // Unit not in current graph — may have been just created via
      // create_project. Snapshot + rediscover before giving up.
      const fresh = await source.ensureFresh();
      await trigger.whenSettled();
      await rediscoverAt(fresh.stateHash);

      resolved = resolveRequestedUnit();
      node = resolved.node;
      if (!node) {
        // @natstack/* packages aren't in the workspace graph — they're compiled
        // platform packages in node_modules. Build them as library bundles
        // so eval can import them.
        if (unitPath.startsWith("@natstack/") && options?.library) {
          const bundle = await buildPlatformLibrary(unitPath, options.externals ?? []);
          return { bundle };
        }
        throw new Error(`Unknown build unit: ${unitPath}`);
      }
    }
    assertNodeBuildable(node);
    let buildOptions = options?.library
      ? { ...options, library: true, libraryEntrySubpath: resolved.libraryEntrySubpath ?? "." }
      : options;

    // ── HEAD build path ──
    // Snapshot the workspace before building so the artifact is reconstructable
    // from a committed GAD state. Serving loaders do not call this method.
    try {
      const fresh = await source.ensureFresh();
      if (fresh.stateHash !== currentState().stateHash) {
        await trigger.whenSettled();
      }
    } catch {
      // Scan failed — use cached EV (best effort)
    }

    const { graph: headGraph, evMap: headEvMap, stateHash: headStateHash } = currentState();
    // Re-resolve the unit against the freshly-settled graph: settlement may have
    // rediscovered it with a changed entry/dependency set, and building the
    // pre-settle node against the fresh EV map would miss those changes on the
    // first build after a commit.
    const settled = resolveRequestedUnit();
    if (settled.node) {
      node = settled.node;
      resolved = settled;
      assertNodeBuildable(node);
      buildOptions = options?.library
        ? { ...options, library: true, libraryEntrySubpath: resolved.libraryEntrySubpath ?? "." }
        : options;
    }
    const ev = headEvMap[node.name];
    if (!ev) {
      throw new Error(`No effective version for ${node.name}`);
    }

    // Build on demand (buildUnit handles cache + coalescing internally)
    const build = await buildUnit(node, ev, headGraph, workspaceRoot, headStateHash, buildOptions);
    return options?.library ? libraryBuildResult(build) : build;
  } as BuildSystemV2["getBuild"];

  return {
    getBuild,
    bindRuntimeImage,

    async resolveBuildUnit(
      unitPath: string,
      requestedRef?: string
    ): Promise<BuildUnitResolution | null> {
      const ref = validateBuildRef(requestedRef);
      const toResolution = (node: GraphNode, stateHash: string): BuildUnitResolution => ({
        unitPath: node.relativePath,
        unitName: node.name,
        kind: node.kind,
        stateHash,
      });

      if (ref && ref !== MAIN_HEAD) {
        const stateHash = ref.startsWith("state:")
          ? ref
          : await source.resolveContextView(ref.slice("ctx:".length));
        const graph = await source.discoverGraph(stateHash);
        const node = resolveUnit(graph, unitPath, workspaceRoot);
        return node ? toResolution(node, stateHash) : null;
      }

      const resolveCurrent = (): BuildUnitResolution | null => {
        const snapshot = currentState();
        const node = resolveUnit(snapshot.graph, unitPath, workspaceRoot);
        return node ? toResolution(node, snapshot.stateHash) : null;
      };

      let resolved = resolveCurrent();
      if (!resolved) {
        const fresh = await source.ensureFresh();
        await trigger.whenSettled();
        if (currentState().stateHash !== fresh.stateHash) {
          await rediscoverAt(fresh.stateHash);
        }
        resolved = resolveCurrent();
      }
      return resolved;
    },

    async getBuildNpm(
      specifier: string,
      version: string,
      externals?: string[]
    ): Promise<{ bundle: string }> {
      const bundle = await buildNpmLibrary(specifier, version, externals ?? []);
      return { bundle };
    },

    getBuildByKey(key: string): BuildResult | null {
      return buildStore.get(key);
    },

    getEffectiveVersion(unitName: string): string | null {
      return currentState().evMap[unitName] ?? null;
    },

    getExternalDeps(unitName: string): Record<string, string> {
      const { graph } = currentState();
      const node = resolveUnit(graph, unitName, workspaceRoot);
      if (!node) return {};
      return collectTransitiveExternalDeps(node, graph, workspaceRoot, appNodeModuleRoots);
    },

    getBuildProviderDetails(target: "react-native") {
      try {
        const provider = resolveBuildProvider(target);
        return {
          name: provider.name,
          activeEv: provider.activeEv,
          activeBuildKey: provider.activeBuildKey,
          contractVersion: provider.contractVersion,
        };
      } catch {
        return null;
      }
    },

    onBuildProviderChange(callback) {
      return onBuildProviderChange((event) => {
        if (event.target !== "react-native") return;
        callback({
          type: event.type,
          target: event.target,
          provider: {
            name: event.provider.name,
            activeEv: event.provider.activeEv,
            activeBuildKey: event.provider.activeBuildKey,
            contractVersion: event.provider.contractVersion,
          },
        });
      });
    },

    async doctorExtension(unitName: string): Promise<ExtensionDoctorReport> {
      const { graph, evMap } = currentState();
      const node = resolveUnit(graph, unitName, workspaceRoot);
      if (!node) {
        throw new Error(`Unknown extension: ${unitName}`);
      }
      if (node.kind !== "extension") {
        throw new Error(`Build unit is not an extension: ${unitName}`);
      }

      const dependencyMode = normalizeExtensionDependencyMode(
        node.manifest.extension?.dependencyMode
      );
      const externalDeps = collectTransitiveExternalDeps(
        node,
        graph,
        workspaceRoot,
        appNodeModuleRoots
      );
      const dependencyOverrides = collectTransitiveDependencyOverrides(
        node,
        graph,
        workspaceRoot,
        appNodeModuleRoots
      );
      const nodeModulesDir = await ensureExternalDeps(externalDeps, dependencyOverrides);
      const nodePaths = [...(nodeModulesDir ? [nodeModulesDir] : []), ...appNodeModuleRoots];
      const dependencyDiagnostics = analyzeExtensionDependencies(
        externalDeps,
        nodePaths,
        dependencyMode
      );
      const ev = evMap[node.name] ?? null;
      const buildKey = ev
        ? computeBuildKey(
            node.name,
            `${ev}:extension-runtime-abi:${EXTENSION_RUNTIME_ABI_VERSION}`,
            true
          )
        : null;
      const build = buildKey ? buildStore.get(buildKey) : null;
      const extensionDetails =
        build?.metadata.details.kind === "extension" ? build.metadata.details : null;
      const checks: ExtensionDoctorReport["checks"] = [
        { name: "manifest", status: "pass", message: "Extension manifest was discovered." },
        {
          name: "dependency-mode",
          status: "pass",
          message: `dependencyMode=${dependencyDiagnostics.dependencyMode}`,
        },
        {
          name: "runtime-deps",
          status: "pass",
          message: Object.keys(dependencyDiagnostics.runtimeExternalDeps).length
            ? `External runtime deps: ${Object.keys(dependencyDiagnostics.runtimeExternalDeps).join(", ")}`
            : "No external runtime deps are required.",
        },
        {
          name: "build-cache",
          status: build ? "pass" : "warn",
          message: build
            ? `Cached build found with ABI ${extensionDetails?.runtimeAbi ?? "unknown"}.`
            : "No cached build found for the current runtime ABI.",
        },
      ];
      if (extensionDetails?.smokeTest?.passed) {
        checks.push({
          name: "smoke-test",
          status: "pass",
          message: `Build smoke test passed in ${extensionDetails.smokeTest.mode}.`,
        });
      } else if (build) {
        checks.push({
          name: "smoke-test",
          status: "warn",
          message: "Cached build has no recorded smoke-test result.",
        });
      }
      for (const dep of dependencyDiagnostics.classifiedDeps) {
        checks.push({
          name: `dependency:${dep.name}`,
          status:
            dep.reasons.includes("missing-package-json") ||
            dep.reasons.includes("unreadable-package-json")
              ? "warn"
              : "pass",
          message: dep.explanation,
        });
      }

      return {
        name: node.name,
        kind: "extension",
        path: node.relativePath,
        dependencyDiagnostics,
        buildMetadata: build?.metadata ?? null,
        checks,
      };
    },

    async recompute(): Promise<ChangeSet> {
      const fresh = await source.ensureFresh();
      await trigger.whenSettled();
      const previousEvMap = currentState().evMap;
      await rediscoverAt(fresh.stateHash);
      const snapshot = currentState();
      const changes = diffEvMaps(previousEvMap, snapshot.evMap);

      // Trigger builds for changed buildable units
      const buildableChanged = [...changes.changed, ...changes.added].filter((name) => {
        const n = snapshot.graph.tryGet(name);
        return n && isNodeBuildable(n) && n.kind !== "extension" && n.kind !== "app";
      });

      for (const name of buildableChanged) {
        const n = snapshot.graph.get(name);
        const ev = assertPresent(snapshot.evMap[name]);
        const bk = computeBuildKey(name, ev, sourcemapForNode(n));
        if (!buildStore.has(bk)) {
          try {
            await buildUnit(n, ev, snapshot.graph, workspaceRoot, snapshot.stateHash);
          } catch (error) {
            console.error(
              `[BuildV2] Failed to rebuild ${name}:`,
              error instanceof Error ? error.message : String(error)
            );
          }
        }
      }

      return changes;
    },

    validateRepoPush(
      repoPaths: string[],
      candidateView: string,
      options?: ValidateRepoPushOptions
    ): Promise<RepoBuildReport[]> {
      return validateRepoPushImpl(repoPaths, candidateView, options);
    },

    previewBuild(
      workingView: string,
      options?: { repoPaths?: string[]; units?: string[] }
    ): Promise<RepoBuildReport[]> {
      return previewBuildImpl(workingView, options);
    },

    async getBuildReport(unitName: string, stateHash?: string): Promise<RepoBuildReport> {
      const ref = validateBuildRef(stateHash);
      let view: GraphView;
      let viewStateHash: string;
      if (!ref || ref === MAIN_HEAD) {
        try {
          const fresh = await source.ensureFresh();
          await trigger.whenSettled();
          if (currentState().stateHash !== fresh.stateHash) {
            await rediscoverAt(fresh.stateHash);
          }
        } catch {
          // best effort — fall back to current snapshot
        }
        const snapshot = currentState();
        view = { graph: snapshot.graph, evMap: snapshot.evMap };
        viewStateHash = snapshot.stateHash;
      } else {
        let resolvedState: string;
        if (ref.startsWith("state:")) {
          resolvedState = ref;
        } else if (ref.startsWith("ctx:")) {
          resolvedState = await source.resolveContextView(ref.slice(4));
        } else {
          throw new Error(`Invalid build ref after validation: ${ref}`);
        }
        viewStateHash = resolvedState;
        view = await viewAt(resolvedState);
      }
      const node = resolveUnit(view.graph, unitName, workspaceRoot);
      if (!node) {
        return {
          repoPath: unitName,
          kind: "content",
          role: "pushed",
          required: false,
          status: "skipped",
          builds: [],
        };
      }
      return buildUnitReport(node, view, viewStateHash, "pushed");
    },

    getUnitDiagnostics(unitName: string): BuildDiagnostic[] | null {
      const node = resolveUnit(currentState().graph, unitName, workspaceRoot);
      return diagnosticsForUnit(node?.name ?? unitName);
    },

    async gc(activeUnits: string[]): Promise<{ freed: number }> {
      const { graph, evMap } = currentState();
      const activeKeys = new Set<string>();
      for (const name of activeUnits) {
        const ev = evMap[name];
        if (!ev) continue;
        const n = graph.tryGet(name);
        if (!n) continue;
        activeKeys.add(computeBuildKey(name, ev, sourcemapForNode(n)));
      }
      return buildStore.gc(activeKeys);
    },

    async getAboutPages(): Promise<AboutPageMeta[]> {
      const pages: AboutPageMeta[] = [];
      for (const n of currentState().graph.allNodes()) {
        // About pages are gated purely by location: any unit under workspace/about/.
        // (No `shell` manifest flag — an about page is just a normal panel that
        // lives in about/.)
        if (!n.relativePath.startsWith("about/")) continue;
        pages.push({
          name: n.relativePath.slice("about/".length),
          title: n.manifest.title ?? n.name,
          description: n.manifest.description,
          hiddenInLauncher: n.manifest.hiddenInLauncher ?? false,
        });
      }
      return pages;
    },

    getGraph(): PackageGraph {
      return currentState().graph;
    },

    hasUnit(name: string): boolean {
      return currentState().graph.has(name);
    },

    getWorkspaceRoot(): string {
      return workspaceRoot;
    },

    listRecentBuildEvents(unitName?: string): BuildSystemBuildEvent[] {
      const lookupKeys = unitName ? normalizeBuildEventLookupKeys(unitName, workspaceRoot) : null;
      const events = unitName
        ? recentBuildEvents.filter(
            (event) =>
              lookupKeys?.has(event.name) ||
              (event.relativePath ? lookupKeys?.has(event.relativePath) : false)
          )
        : recentBuildEvents;
      return [...events];
    },

    onBuildEvent(callback: (event: BuildSystemBuildEvent) => void): () => void {
      buildEventListeners.add(callback);
      return () => buildEventListeners.delete(callback);
    },

    onUnitChange(callback: (event: BuildSystemUnitChangeEvent) => void): () => void {
      unitChangeListeners.add(callback);
      return () => unitChangeListeners.delete(callback);
    },

    whenSettled(): Promise<void> {
      return trigger.whenSettled();
    },

    onPushBuild(
      callback: (source: string, trigger?: StateAdvancedEvent, buildKey?: string) => void
    ): void {
      trigger.on(
        "build-complete",
        ({
          name,
          buildKey,
          trigger: t,
        }: {
          name: string;
          buildKey: string;
          trigger?: StateAdvancedEvent;
        }) => {
          const node = currentState().graph.tryGet(name);
          if (node) callback(node.relativePath, t, buildKey);
        }
      );
    },

    async shutdown(): Promise<void> {
      shuttingDown = true;
      await initialBuildPrewarm.catch(() => {});
      trigger.stop();
      setBuildSourceProvider(null);
      console.log("[BuildV2] Shut down");
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface InitialBuildPrewarmOptions {
  nodes: GraphNode[];
  evMap: EffectiveVersionMap;
  graph: PackageGraph;
  workspaceRoot: string;
  stateHash: string;
  recordBuildEvent(event: Omit<BuildSystemBuildEvent, "relativePath" | "timestamp">): void;
}

async function prewarmInitialBuilds(opts: InitialBuildPrewarmOptions): Promise<void> {
  await runLimited(opts.nodes, initialBuildPrewarmConcurrency(), async (node) => {
    const ev = opts.evMap[node.name];
    if (!ev) return;
    const buildKey = computeBuildUnitKey(node, ev);
    if (buildStore.has(buildKey)) {
      opts.recordBuildEvent({ type: "build-complete", name: node.name, buildKey });
      return;
    }

    opts.recordBuildEvent({ type: "build-started", name: node.name });
    try {
      await buildUnit(node, ev, opts.graph, opts.workspaceRoot, opts.stateHash);
      opts.recordBuildEvent({ type: "build-complete", name: node.name, buildKey });
      console.log(`[BuildV2] Prewarmed ${node.name}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const diagnostics = diagnosticsFromError(error, opts.workspaceRoot);
      recordDiagnostics(node.name, buildKey, diagnostics);
      opts.recordBuildEvent({
        type: "build-error",
        name: node.name,
        error: message,
        diagnostics,
      });
      console.error(`[BuildV2] Failed to prewarm ${node.name}:`, message);
    }
  });
  console.log(`[BuildV2] Initial build prewarm complete`);
}

function initialBuildPrewarmConcurrency(): number {
  const raw = Number.parseInt(process.env["NATSTACK_INITIAL_BUILD_CONCURRENCY"] ?? "", 10);
  if (Number.isInteger(raw) && raw > 0) return raw;
  return 4;
}

async function runLimited<T>(
  items: readonly T[],
  concurrency: number,
  task: (item: T) => Promise<void>
): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++];
      if (item === undefined) continue;
      await task(item);
    }
  });
  await Promise.all(workers);
}

function resolveUnit(
  graph: PackageGraph,
  unitPath: string,
  _workspaceRoot: string
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

function resolveLibraryUnit(
  graph: PackageGraph,
  specifier: string
): { node: GraphNode; libraryEntrySubpath: string } | null {
  const names = graph
    .allNodes()
    .map((node) => node.name)
    .sort((a, b) => b.length - a.length);

  for (const name of names) {
    if (specifier === name) {
      return { node: graph.get(name), libraryEntrySubpath: "." };
    }
    if (specifier.startsWith(`${name}/`)) {
      return {
        node: graph.get(name),
        libraryEntrySubpath: `./${specifier.slice(name.length + 1)}`,
      };
    }
  }

  return null;
}

function normalizeBuildEventLookupKeys(input: string, workspaceRoot: string): Set<string> {
  const keys = new Set<string>();
  const add = (value: string): void => {
    const normalized = value
      .replace(/\\/g, "/")
      .replace(/^\.\/+/, "")
      .replace(/\/+$/, "");
    if (normalized) keys.add(normalized);
  };

  const raw = input.trim();
  if (!raw) return keys;
  add(raw);

  if (path.isAbsolute(raw)) {
    const relative = path.relative(workspaceRoot, raw);
    if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) add(relative);
  }

  const workspacePrefixed = raw.replace(/\\/g, "/").replace(/^\.\/+/, "");
  if (workspacePrefixed.startsWith("workspace/")) add(workspacePrefixed.slice("workspace/".length));

  return keys;
}

function sourcemapForNode(node: GraphNode): boolean {
  return sourcemapForKind(node.kind, node.manifest.sourcemap);
}

function dependencyErrorMessage(node: GraphNode): string | null {
  return node.dependencyErrors && node.dependencyErrors.length > 0
    ? node.dependencyErrors.join("; ")
    : null;
}

function isNodeBuildable(node: GraphNode): boolean {
  return isBuildableKind(node.kind) && dependencyErrorMessage(node) === null;
}

function assertNodeBuildable(node: GraphNode): void {
  const message = dependencyErrorMessage(node);
  if (message) throw new Error(`Build blocked for ${node.name}: ${message}`);
}

// re-exported for stateTrigger consumers
export { unitsForChangedPaths };
