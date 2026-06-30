/**
 * PanelOrchestrator — Thin Electron coordinator.
 *
 * Replaces PanelLifecycle on the Electron side. All backend work (tokens,
 * persistence, FS context) goes through server RPCs. This class handles
 * only: server RPC → registry update → view management.
 */

import { createDevLogger } from "@natstack/dev-log";
import { randomUUID } from "crypto";
import type {
  Panel,
  PanelFocusResult,
  PanelLifecycleResult,
  PanelNavigationState,
  PanelRecoverySnapshot,
  PanelSnapshot,
  PanelTreeSnapshot,
  PaletteCommand,
  ThemeConfig,
} from "@natstack/shared/types";
import type { PanelRegistry } from "@natstack/shared/panelRegistry";
import type { EventService } from "@natstack/shared/eventsService";
import type { ScopedServerCaller, ServerClient } from "./serverClient.js";
import type { PanelManager } from "@natstack/shared/shell/panelManager";
import type {
  PanelHost,
  PanelHostRegistration,
  PanelRuntimeLease,
  PanelRuntimeLeaseChangedEvent,
} from "@natstack/shared/panel/panelLease";
import {
  createPanelHostRegistration,
  createPanelRuntimeLeaseRequest,
  formatPanelRuntimeLeaseDeniedMessage,
} from "@natstack/shared/panel/panelLease";
import { classifyRuntimeLeaseChange } from "@natstack/shared/panel/leaseTracker";
import type {
  BridgePanelLifecycle,
  PanelViewLike,
  PanelHttpServerLike,
  PanelCreateOptions,
} from "@natstack/shared/panelInterfaces";
import { BROWSER_SESSION_PARTITION } from "@natstack/shared/panelInterfaces";
import { contextIdToPartition } from "@natstack/shared/contextIdToPartition.js";
import { createTypedServiceClient } from "@natstack/shared/typedServiceClient";
import { panelRuntimeMethods } from "@natstack/shared/serviceSchemas/panelRuntime";
import type { WorkspaceConfig } from "@natstack/shared/workspace/types";
import type { PanelRestorePolicy } from "@natstack/shared/workspace/types";
import { buildPanelUrl } from "@natstack/shared/panelFactory";
import {
  selectCapEvictionVictims,
  selectIdlePanelVictims,
  type LoadedPanelSnapshot,
} from "@natstack/shared/panel/panelGc";
import {
  PANEL_UI_IDLE_SWEEP_MS,
  PANEL_UI_IDLE_SWEEP_MS_HEADLESS,
  PANEL_UI_IDLE_UNLOAD_MS_HEADLESS,
  PANEL_UI_MAX_LOADED_HEADLESS,
} from "@natstack/shared/constants";
import { asPanelSlotId } from "@natstack/shared/panel/ids";
import type { PanelPinStoreApi } from "./panelPinStore.js";
import {
  getCurrentSnapshot,
  getPanelSource,
  getPanelContextId,
  getPanelRef,
} from "@natstack/shared/panel/accessors";
import { assertPresent } from "../lintHelpers";

const log = createDevLogger("PanelOrchestrator");
type PanelTreeCall = (method: string, args: unknown[]) => Promise<unknown>;

export interface PanelOrchestratorDeps {
  registry: PanelRegistry;
  eventService: EventService;
  serverClient: ServerClient;
  shellCore: PanelManager;

  getPanelView?: () => PanelViewLike | null;
  cdpHost: {
    cleanupPanelAccess(panelId: string): void;
    unregisterTarget?(panelId: string): void;
    getAccessibilityTree?(panelId: string): Promise<unknown[]>;
  };
  panelHttpServer: PanelHttpServerLike;
  externalHost: string;
  protocol: "http" | "https";
  gatewayPort: number;
  gatewayBasePath?: string;

  /**
   * Send an event to a panel. In IPC mode, this calls
   * webContents.send("natstack:event", event, payload).
   */
  sendPanelEvent: (panelId: string, event: string, payload: unknown) => void;
  workspaceConfig?: WorkspaceConfig;
  runtimeClient?: Partial<PanelHostRegistration> & {
    maxAssignedPanelViews?: number;
    /**
     * Idle threshold for the UI GC sweep. When set, a periodic sweep unloads
     * panels inactive for this long via the shared GC selectors. Used by both
     * desktop (1h) and the in-app headless host (5m) — there is one idle
     * mechanism, not a separate per-panel-timer path.
     */
    uiIdleUnloadMs?: number;
    /** Sweep cadence; defaults to PANEL_UI_IDLE_SWEEP_MS. Headless uses a finer one. */
    uiIdleSweepMs?: number;
    restorePolicy?: PanelRestorePolicy;
  };
  /**
   * Client-local pin store (desktop). Absent on headless, where pins don't
   * apply; GC then treats every panel as unpinned.
   */
  pinStore?: PanelPinStoreApi;
}

export class PanelOrchestrator implements BridgePanelLifecycle, PanelHost {
  private readonly deps: PanelOrchestratorDeps;
  private currentTheme: "light" | "dark" = "dark";
  /** App-wide theme identity, broadcast to panels alongside appearance. */
  private currentThemeConfig: ThemeConfig = {
    accentColor: "iris",
    grayColor: "slate",
    radius: "medium",
    scaling: "100%",
    panelBackground: "translucent",
  };
  private readonly runtimeClientSessionId: string;
  private readonly runtimeClientLabel: string;
  private readonly runtimeClientPlatform: "desktop" | "headless" | "mobile";
  private readonly runtimeClientSupportsCdp: boolean;
  private readonly loadOnLeaseAssignment: boolean;
  private readonly maxAssignedPanelViews: number | null;
  /** Idle threshold for the UI GC sweep; null disables the sweep. */
  private readonly uiIdleUnloadMs: number | null;
  /** Sweep cadence; finer on headless than desktop. */
  private readonly uiIdleSweepMs: number;
  private idleSweepTimer?: ReturnType<typeof setInterval>;
  private runtimeClientRegistered = false;
  private readonly runtimeConnectionBySlot = new Map<
    string,
    { runtimeEntityId: string; connectionId: string }
  >();
  private readonly assignedPanelResources = new Map<string, { lastUsedAt: number }>();
  private readonly stateArgsPushUnsubs = new Map<string, () => void>();
  /** Last reactive view-build error per slot, surfaced to the imperative creator. */
  private readonly viewBuildFailures = new Map<string, string>();
  private viewRevision = 0;
  private lastAppliedServerPanelTreeRevision = 0;
  private readonly explicitTitlePanelIds = new Set<string>();
  /** Typed client for the server's panel-runtime lease coordinator. */
  private readonly panelRuntime = createTypedServiceClient(
    "panelRuntime",
    panelRuntimeMethods,
    (svc, method, args) => this.serverClient.call(svc, method, args)
  );
  private readonly restorePolicy: PanelRestorePolicy;

  constructor(deps: PanelOrchestratorDeps) {
    this.deps = deps;
    this.runtimeClientPlatform = deps.runtimeClient?.platform ?? "desktop";
    this.runtimeClientSessionId =
      deps.runtimeClient?.clientSessionId ?? `${this.runtimeClientPlatform}-${randomUUID()}`;
    this.runtimeClientLabel =
      deps.runtimeClient?.label ??
      (this.runtimeClientPlatform === "headless" ? "Headless" : "Desktop");
    this.runtimeClientSupportsCdp =
      deps.runtimeClient?.supportsCdp ?? this.runtimeClientPlatform !== "mobile";
    this.loadOnLeaseAssignment = deps.runtimeClient?.loadOnLeaseAssignment ?? false;
    const headlessAutoload =
      this.runtimeClientPlatform === "headless" && this.loadOnLeaseAssignment;
    this.maxAssignedPanelViews =
      deps.runtimeClient?.maxAssignedPanelViews ??
      (headlessAutoload ? PANEL_UI_MAX_LOADED_HEADLESS : null);
    // One idle mechanism for every host: the sweep. Headless gets a default
    // threshold/cadence so it keeps shedding idle panels without per-panel timers.
    this.uiIdleUnloadMs =
      deps.runtimeClient?.uiIdleUnloadMs ??
      (headlessAutoload ? PANEL_UI_IDLE_UNLOAD_MS_HEADLESS : null);
    this.uiIdleSweepMs =
      deps.runtimeClient?.uiIdleSweepMs ??
      (this.runtimeClientPlatform === "headless"
        ? PANEL_UI_IDLE_SWEEP_MS_HEADLESS
        : PANEL_UI_IDLE_SWEEP_MS);
    this.restorePolicy =
      deps.runtimeClient?.restorePolicy ?? deps.workspaceConfig?.panelRestorePolicy ?? "focused";
  }

  // Convenience accessors
  private get registry() {
    return this.deps.registry;
  }
  private get eventService() {
    return this.deps.eventService;
  }
  private get serverClient() {
    return this.deps.serverClient;
  }
  private get shellCore() {
    return this.deps.shellCore;
  }
  private get externalHost() {
    return this.deps.externalHost;
  }
  private getPanelView() {
    return this.deps.getPanelView?.() ?? null;
  }
  private get panelHttpServer() {
    return this.deps.panelHttpServer;
  }
  private get cdpHost() {
    return this.deps.cdpHost;
  }

  private callPanelTreeAs(
    caller: ScopedServerCaller,
    method: string,
    args: unknown[]
  ): Promise<unknown> {
    return this.serverClient.callAs(caller, "panelTree", method, args);
  }

  private callPanelTreeAsServer(method: string, args: unknown[]): Promise<unknown> {
    return this.serverClient.call("panelTree", method, args);
  }

  private panelTreeCallAs(caller: ScopedServerCaller): PanelTreeCall {
    return (method, args) => this.callPanelTreeAs(caller, method, args);
  }

  private panelTreeCallAsServer(): PanelTreeCall {
    return (method, args) => this.callPanelTreeAsServer(method, args);
  }

  // =========================================================================
  // Panel creation
  // =========================================================================

  /**
   * Route a tree-creating mutation through the panelTree authority, then build
   * the local view from the response. The server is the sole writer; it
   * broadcasts the new tree (the mirror updates reactively). We await
   * the panel landing in our mirror before attaching its view so the artifact
   * updates inside attachCreatedPanel have a registry target.
   */
  private async createViaPanelTree(
    source: string,
    createOpts: {
      parentId?: string | null;
      name?: string;
      contextId?: string;
      ref?: string;
      stateArgs?: Record<string, unknown>;
    },
    attachOpts: { focus?: boolean; browserUrl?: string },
    callPanelTree: PanelTreeCall
  ): Promise<{ id: string; title: string }> {
    const result = (await callPanelTree("create", [source, createOpts])) as {
      id: string;
      title: string;
      contextId?: string;
      source?: string;
    };
    try {
      await this.awaitPanelInMirror(result.id);
      await this.attachCreatedPanel(
        {
          panelId: result.id,
          title: result.title,
          contextId: result.contextId,
          source: result.source,
        },
        attachOpts
      );
      return { id: result.id, title: result.title };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (this.registry.getPanel(result.id)) {
        this.markPanelLoadError(result.id, message);
        if (attachOpts.focus) await this.focusPanel(result.id).catch(() => {});
      } else {
        await callPanelTree("archive", [result.id]).catch(() => {});
      }
      throw err;
    }
  }

  /** Wait (briefly) for a server-created panel to land in the broadcast mirror. */
  private async awaitPanelInMirror(panelId: string, timeoutMs = 4000): Promise<void> {
    if (this.registry.getPanel(panelId)) return;
    await new Promise<void>((resolve) => {
      const start = Date.now();
      const tick = () => {
        if (this.registry.getPanel(panelId) || Date.now() - start > timeoutMs) {
          resolve();
          return;
        }
        setTimeout(tick, 16);
      };
      tick();
    });
  }

  /**
   * Wait (briefly) for the reactive view-host to build a panel's view after we
   * acquired its lease. Building is now driven by the assigned-lease broadcast
   * (handleRuntimeLeaseChanged → loadAssignedLeaseIntoView), which is one WS
   * round-trip behind the synchronous acquire. By default this has no timeout:
   * slow builds are valid, and failure must be reported by the actual build/load
   * path. Tests or explicitly bounded probes may pass a timeout.
   */
  private async awaitViewBuilt(panelId: string, timeoutMs?: number): Promise<void> {
    const view = this.getPanelView();
    if (!view) return;
    if (view.hasView(panelId)) return;
    const failure = await new Promise<string | null | "built">((resolve) => {
      const start = Date.now();
      const tick = () => {
        if (view.hasView(panelId)) {
          resolve("built");
          return;
        }
        const recorded = this.viewBuildFailures.get(panelId);
        if (recorded !== undefined) {
          resolve(recorded);
          return;
        }
        if (timeoutMs !== undefined && Date.now() - start > timeoutMs) {
          resolve(null);
          return;
        }
        setTimeout(tick, 16);
      };
      tick();
    });
    if (failure === "built") return;
    if (failure === null) {
      throw new Error(`Timed out waiting for panel view to be created: ${panelId}`);
    }
    // The reactive host recorded a build error for this slot — surface it to the
    // imperative creator so it can roll back (release lease + archive the slot).
    this.viewBuildFailures.delete(panelId);
    throw new Error(failure);
  }

  private markPanelLoadError(panelId: string, message: string): void {
    const panel = this.registry.getPanel(panelId);
    if (!panel) return;
    this.registry.updateArtifacts(panelId, {
      ...panel.artifacts,
      buildState: "error",
      error: message,
      buildProgress: message,
    });
    this.registry.notifyPanelTreeUpdate();
  }

  async createPanel(
    callerId: string,
    source: string,
    options?: PanelCreateOptions,
    stateArgs?: Record<string, unknown>,
    scopedCaller?: ScopedServerCaller
  ): Promise<{ id: string; title: string }> {
    // App callers (the shell's test API, app-view links) create under their own
    // capability-gated authority via a scoped connection. Panel-hosted links
    // pass no scoped caller and are translated by the trusted host (see
    // panelView). The source view becomes the parent slot when it's a panel,
    // otherwise this is a new root panel.
    const caller = this.registry.getPanel(callerId);
    return this.createViaPanelTree(
      source,
      {
        parentId: caller ? asPanelSlotId(callerId) : null,
        name: options?.name,
        contextId: options?.contextId,
        ref: options?.ref,
        stateArgs,
      },
      { focus: options?.focus },
      scopedCaller ? this.panelTreeCallAs(scopedCaller) : this.panelTreeCallAsServer()
    );
  }

  async navigatePanel(
    panelId: string,
    source: string,
    options: {
      contextId?: string;
      env?: Record<string, string>;
      ref?: string;
      stateArgs?: Record<string, unknown>;
    } = {},
    scopedCaller?: ScopedServerCaller
  ): Promise<{ id: string; title: string } | null> {
    if (!this.registry.getPanel(panelId)) throw new Error(`Panel not found: ${panelId}`);
    // Panel navigation is host-mediated (trusted chrome) by default; an app
    // caller may still drive it under its own authority via a scoped connection.
    const result = (await (scopedCaller
      ? this.callPanelTreeAs(scopedCaller, "navigate", [panelId, source, options])
      : this.callPanelTreeAsServer("navigate", [panelId, source, options]))) as {
      id?: string;
      title?: string;
      source?: string;
      contextId?: string;
    } | null;
    if (!result) return null;
    await this.rebuildViewAfterServerNavigate(
      panelId,
      result.source ?? source,
      result.contextId,
      options
    );
    return { id: result.id ?? panelId, title: result.title ?? "" };
  }

  async navigatePanelHistory(
    panelId: string,
    delta: -1 | 1,
    caller?: ScopedServerCaller
  ): Promise<{ id: string; title: string } | null> {
    const result = (await (caller
      ? this.callPanelTreeAs(caller, "navigateHistory", [panelId, delta])
      : this.callPanelTreeAsServer("navigateHistory", [panelId, delta]))) as {
      id?: string;
      title?: string;
      source?: string;
      contextId?: string;
    } | null;
    if (!result) return null;
    await this.rebuildViewAfterServerNavigate(panelId, result.source ?? "", result.contextId);
    return { id: result.id ?? panelId, title: result.title ?? "" };
  }

  /**
   * Rebuild a panel's view after a server-side navigate/history mutation. The
   * desktop applies the broadcast to its registry mirror but does NOT re-sync the
   * panelManager's entity cache, so we explicitly refresh it (otherwise the lease
   * would target the retired previous entity). Browser panels are driven by their
   * own webContents (already navigated), so they only record the source change.
   */
  private async rebuildViewAfterServerNavigate(
    panelId: string,
    newSource: string,
    contextId: string | undefined,
    options?: Record<string, unknown>
  ): Promise<void> {
    if (!newSource || newSource.startsWith("browser:")) return;
    this.explicitTitlePanelIds.delete(panelId);
    await this.shellCore.refreshSlotEntity(asPanelSlotId(panelId));
    this.ensureStateArgsPush(panelId);
    const view = this.getPanelView();
    if (view && contextId) {
      this.destroyViewIfPartitionChanged(view, panelId, {
        source: newSource,
        contextId,
        options: {},
      } as PanelSnapshot);
    }
    await this.attachCreatedPanel(
      { panelId, title: "", contextId, source: newSource, options },
      { focus: true }
    );
  }

  async createBrowserUrlPanel(
    callerId: string,
    url: string,
    options?: { name?: string; focus?: boolean },
    caller?: ScopedServerCaller
  ): Promise<{ id: string; title: string }> {
    // Defensive: reject non-string or non-http(s) URLs early
    if (typeof url !== "string" || !/^https?:\/\//i.test(url)) {
      throw new Error(`Invalid browser panel URL (must be http/https string): ${String(url)}`);
    }
    const callerPanel = this.registry.getPanel(callerId);
    const parentId = callerPanel ? asPanelSlotId(callerId) : null;
    return this.createViaPanelTree(
      url,
      { parentId, name: options?.name },
      { focus: options?.focus, browserUrl: url },
      caller ? this.panelTreeCallAs(caller) : this.panelTreeCallAsServer()
    );
  }

  // =========================================================================
  // Panel destruction
  // =========================================================================

  async closePanel(panelId: string, caller?: ScopedServerCaller): Promise<PanelLifecycleResult> {
    const panel = this.registry.getPanel(panelId);
    if (!panel) throw new Error(`Panel not found: ${panelId}`);
    const result = this.lifecycleResult(panelId, "close", "closed", {
      loaded: false,
      reloaded: false,
    });

    // Determine sibling to focus before removal
    const parentId = this.registry.findParentId(panelId);
    const parent = parentId ? this.registry.getPanel(parentId) : null;
    const focusedPanelId = this.registry.getFocusedPanelId();
    const focusedPanelWillClose = Boolean(
      focusedPanelId &&
      (focusedPanelId === panelId || this.registry.isDescendantOf(focusedPanelId, panelId))
    );
    let siblingToFocus: string | null = null;
    if (focusedPanelWillClose && parent) {
      const siblings = parent.children.filter((c) => c.id !== panelId);
      siblingToFocus =
        siblings.length > 0 ? assertPresent(siblings[siblings.length - 1]).id : parentId;
    } else if (focusedPanelWillClose && !parentId) {
      const roots = this.registry.getRootPanels();
      const rootIndex = roots.findIndex((p) => p.id === panelId);
      const nextRoot = rootIndex >= 0 ? (roots[rootIndex + 1] ?? roots[rootIndex - 1]) : undefined;
      siblingToFocus = nextRoot?.id ?? null;
    }

    // Server authority closes the subtree + emits; the desktop reactively tears
    // down views/leases for the removed panels (applyServerPanelTreeSnapshot →
    // pruneRemovedPanelLocally).
    await (caller
      ? this.callPanelTreeAs(caller, "archive", [panelId])
      : this.callPanelTreeAsServer("archive", [panelId]));

    if (siblingToFocus) {
      this.eventService.emit("navigate-to-panel", { panelId: siblingToFocus });
    }
    return result;
  }

  // =========================================================================
  // Build lifecycle
  // =========================================================================

  async reloadPanel(panelId: string): Promise<PanelLifecycleResult> {
    const view = this.getPanelView();
    if (view?.hasView(panelId)) {
      view.reloadView(panelId);
      return this.lifecycleResult(panelId, "reload", "reloaded", {
        loaded: true,
        reloaded: true,
      });
    } else {
      const result = await this.rebuildUnloadedPanel(panelId);
      return {
        ...result,
        operation: "reload",
        status: result.rebuilt ? "loaded_after_rebuild" : result.status,
      };
    }
  }

  async rebuildUnloadedPanel(
    panelId: string,
    options: { force?: boolean } = {}
  ): Promise<PanelLifecycleResult> {
    const panel = this.registry.getPanel(panelId);
    if (!panel) throw new Error(`Panel not found: ${panelId}`);
    if (!options.force && panel.artifacts?.buildState !== "pending") {
      return this.lifecycleResult(panelId, "rebuild", "skipped_not_pending", {
        loaded: this.hasPanelView(panelId),
      });
    }

    // Re-registers the panel principal and issues a fresh connection grant.
    await this.shellCore.getPanelInit(asPanelSlotId(panelId));

    // Browser panels: skip build. Acquire-only — the reactive host builds the
    // view from the assigned-lease broadcast. A view that's still present is a
    // navigate-in-place, so drive the existing renderer directly.
    if (getPanelSource(panel).startsWith("browser:")) {
      const url = getPanelSource(panel).slice("browser:".length);
      const view = this.getPanelView();
      const navigateInPlace = Boolean(view?.hasView(panelId));
      await this.acquireRuntimeLease(panelId, "acquire");
      if (navigateInPlace) {
        if (view?.createViewForBrowser) {
          await view.createViewForBrowser(panelId, url, getPanelContextId(panel));
          this.bumpViewRevision();
        }
      } else {
        await this.awaitViewBuilt(panelId);
      }
      this.registry.updateArtifacts(panelId, { buildState: "ready", htmlPath: url });
      this.registry.notifyPanelTreeUpdate();
      return this.lifecycleResult(panelId, "rebuild", "browser_loaded", {
        loaded: Boolean(this.getPanelView()?.hasView(panelId)),
      });
    }

    this.registry.updateArtifacts(panelId, {
      buildState: "building",
      buildProgress: "Rebuilding panel...",
    });
    this.registry.notifyPanelTreeUpdate();

    this.panelHttpServer?.invalidateBuild(getPanelSource(panel));

    const view = this.getPanelView();
    const navigateInPlace = Boolean(view?.hasView(panelId));
    // buildPanelLoadUrl acquires the lease (triggering the reactive build).
    const panelUrl = await this.buildPanelLoadUrl(panelId);
    if (navigateInPlace && panelUrl && view) {
      await view.createViewForPanel(panelId, panelUrl, getPanelContextId(panel));
      this.bumpViewRevision();
    } else if (view) {
      await this.awaitViewBuilt(panelId);
    }
    return this.lifecycleResult(panelId, "rebuild", "rebuild_requested", {
      loaded: Boolean(this.getPanelView()?.hasView(panelId)),
      rebuilt: true,
    });
  }

  invalidateReadyPanels(): void {
    const focusedPanelId = this.registry.getFocusedPanelId();
    let focusedWasReset = false;

    for (const entry of this.registry.listPanels()) {
      const panel = this.registry.getPanel(entry.panelId);
      if (!panel) continue;
      const buildState = panel.artifacts?.buildState;
      if (buildState === "ready" || buildState === "error") {
        if (getPanelSource(panel).startsWith("browser:")) continue;
        this.panelHttpServer?.invalidateBuild(getPanelSource(panel));
        this.releaseLocalPanelRuntime(entry.panelId, "invalidate");
        this.registry.updateArtifacts(entry.panelId, {
          buildState: "pending",
          buildProgress: "Build cache cleared - will rebuild when focused",
        });
        if (entry.panelId === focusedPanelId) focusedWasReset = true;
      }
    }

    this.registry.notifyPanelTreeUpdate();
    if (focusedWasReset && focusedPanelId) {
      void this.rebuildUnloadedPanel(focusedPanelId).catch((e) =>
        console.warn(`[PanelOrchestrator] Failed to rebuild ${focusedPanelId}:`, e)
      );
    }
  }

  async rebuildPanel(panelId: string): Promise<PanelLifecycleResult> {
    return this.rebuildUnloadedPanel(panelId, { force: true });
  }

  async rebuildAndReloadPanel(panelId: string): Promise<PanelLifecycleResult> {
    const rebuild = await this.rebuildPanel(panelId);
    const reload = await this.reloadPanel(panelId);
    return this.lifecycleResult(panelId, "rebuildAndReload", "rebuilt_and_reloaded", {
      loaded: reload.loaded,
      rebuilt: rebuild.rebuilt,
      reloaded: reload.reloaded,
    });
  }

  applyBuildComplete(source: string, error?: string): void {
    for (const entry of this.registry.listPanels()) {
      const panel = this.registry.getPanel(entry.panelId);
      if (!panel || getPanelSource(panel) !== source) continue;
      const viewUrl = this.hasPanelView(entry.panelId)
        ? (this.getPanelUrl(entry.panelId) ?? undefined)
        : undefined;
      if (error) {
        this.registry.updateArtifacts(entry.panelId, {
          ...panel.artifacts,
          htmlPath: viewUrl,
          buildState: "error",
          buildRevision: this.getBuildRevision(source),
          error,
          buildProgress: error,
        });
      } else {
        this.registry.updateArtifacts(entry.panelId, {
          ...panel.artifacts,
          htmlPath: viewUrl,
          buildState: "ready",
          buildRevision: this.getBuildRevision(source),
          buildProgress: undefined,
          error: undefined,
        });
      }
    }
    this.registry.notifyPanelTreeUpdate();
  }

  // =========================================================================
  // Bootstrap config
  // =========================================================================

  async getBootstrapConfig(callerId: string): Promise<unknown> {
    const config = await this.shellCore.getPanelInit(asPanelSlotId(callerId));
    const lease = this.runtimeConnectionBySlot.get(callerId);
    if (!lease || !config || typeof config !== "object") return config;
    return {
      ...(config as Record<string, unknown>),
      connectionId: lease.connectionId,
      clientLabel: "Desktop",
    };
  }

  /**
   * The runtime entity id + lease connectionId for a panel, so the host can open
   * a panel-principal server session on that exact lease (ipcDispatcher relay).
   * Undefined until the panel's runtime lease is acquired.
   */
  getPanelRuntimeConnection(
    panelId: string
  ): { runtimeEntityId: string; connectionId: string } | undefined {
    return this.runtimeConnectionBySlot.get(panelId);
  }

  listRuntimePanels(parentId?: string | null) {
    return parentId ? this.registry.getChildren(parentId) : this.registry.listPanels();
  }

  async snapshot(panelId: string): Promise<unknown> {
    return this.callPanelTreeAsServer("snapshot", [panelId]);
  }

  async replaceCurrentSnapshot(
    panelId: string,
    contextId: string,
    source?: string,
    stateArgs?: Record<string, unknown>
  ): Promise<void> {
    await this.shellCore.replaceCurrentSnapshot(asPanelSlotId(panelId), {
      contextId,
      ...(source !== undefined && { source }),
      ...(stateArgs !== undefined && { stateArgs }),
    });
  }

  async updatePanelTitle(panelId: string, title: string): Promise<void> {
    if (this.explicitTitlePanelIds.has(panelId)) return;
    await this.shellCore.updateTitle(asPanelSlotId(panelId), title);
  }

  async updatePanelState(panelId: string, state: PanelNavigationState): Promise<void> {
    await this.shellCore.updatePanelState(asPanelSlotId(panelId), state);
  }

  /** Generic server RPC call — exposes server access without leaking serverClient reference. */
  callServer(service: string, method: string, args: unknown[]): Promise<unknown> {
    return this.serverClient.call(service, method, args);
  }

  // =========================================================================
  // Focus
  // =========================================================================

  async focusPanel(
    targetPanelId: string,
    opts: { loadIfNeeded?: boolean } = {}
  ): Promise<PanelFocusResult> {
    const panel = this.registry.getPanel(targetPanelId);
    if (!panel) {
      log.warn(`Cannot focus panel - not found: ${targetPanelId}`);
      return {
        panelId: targetPanelId,
        status: "missing",
        focused: false,
        loaded: false,
        message: `Panel not found: ${targetPanelId}`,
      };
    }

    // Capture the outgoing panel before focus moves. "Inactive" means "1h since
    // you last *viewed* it", so the panel we're leaving restarts its idle
    // countdown now. The newly focused panel needs no bump — while focused it's
    // protected by the sweep's protectedIds.
    const previousFocused = this.registry.getFocusedPanelId();

    this.registry.updateSelectedPath(targetPanelId);
    this.registry.notifyPanelTreeUpdate();

    if (previousFocused && previousFocused !== targetPanelId) {
      this.refreshPanelActivity(previousFocused);
    }

    // Persist focus to the server fire-and-forget: it's pure bookkeeping and
    // must not add an RPC round trip before an already-loaded view is shown.
    void this.shellCore.notifyFocused(asPanelSlotId(targetPanelId)).catch(() => {});

    const view = this.getPanelView();
    if (view?.hasView(targetPanelId)) {
      view.setViewVisible?.(targetPanelId, true);
      this.bumpViewRevision();
      this.sendPanelEvent(targetPanelId, { type: "focus" });
      this.eventService.emit("navigate-to-panel", { panelId: targetPanelId });
      return {
        panelId: targetPanelId,
        status: "loaded",
        focused: true,
        loaded: true,
      };
    }

    if (panel.artifacts.buildState === "error") {
      this.eventService.emit("navigate-to-panel", { panelId: targetPanelId });
      return {
        panelId: targetPanelId,
        status: "build_failed",
        focused: true,
        loaded: false,
        message: panel.artifacts.error ?? panel.artifacts.buildProgress ?? "Panel build failed",
      };
    }

    if (opts.loadIfNeeded) {
      try {
        await this.loadPanelIntoView(targetPanelId);
        const nextView = this.getPanelView();
        if (nextView?.hasView(targetPanelId)) {
          nextView.setViewVisible?.(targetPanelId, true);
          this.bumpViewRevision();
          this.sendPanelEvent(targetPanelId, { type: "focus" });
          this.eventService.emit("navigate-to-panel", { panelId: targetPanelId });
          return {
            panelId: targetPanelId,
            status: "loaded",
            focused: true,
            loaded: true,
          };
        }
        this.eventService.emit("navigate-to-panel", { panelId: targetPanelId });
        this.markPanelLoadError(targetPanelId, "Panel view was not created");
        return {
          panelId: targetPanelId,
          status: "view_creation_failed",
          focused: true,
          loaded: false,
          message: "Panel view was not created",
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const lease = this.registry.getRuntimeLease(targetPanelId);
        const isLeaseFailure = /running on|leased by/i.test(message);
        if (!isLeaseFailure) this.markPanelLoadError(targetPanelId, message);
        this.eventService.emit("navigate-to-panel", { panelId: targetPanelId });
        return {
          panelId: targetPanelId,
          status: isLeaseFailure ? "leased_elsewhere" : "view_creation_failed",
          focused: true,
          loaded: false,
          message,
          holderLabel: lease?.holderLabel,
        };
      }
    }

    this.eventService.emit("navigate-to-panel", { panelId: targetPanelId });
    return {
      panelId: targetPanelId,
      status: "focused",
      focused: true,
      loaded: false,
    };
  }

  async ensureLoaded(panelId: string): Promise<PanelFocusResult> {
    const panel = this.registry.getPanel(panelId);
    if (!panel) {
      return {
        panelId,
        status: "missing",
        focused: false,
        loaded: false,
        message: `Panel not found: ${panelId}`,
      };
    }

    const view = this.getPanelView();
    if (view?.hasView(panelId)) {
      return {
        panelId,
        status: "loaded",
        focused: false,
        loaded: true,
      };
    }

    if (panel.artifacts.buildState === "error") {
      return {
        panelId,
        status: "build_failed",
        focused: false,
        loaded: false,
        message: panel.artifacts.error ?? panel.artifacts.buildProgress ?? "Panel build failed",
      };
    }

    try {
      await this.loadPanelIntoView(panelId);
      const nextView = this.getPanelView();
      const loaded = Boolean(nextView?.hasView(panelId));
      if (!loaded) this.markPanelLoadError(panelId, "Panel view was not created");
      return {
        panelId,
        status: loaded ? "loaded" : "view_creation_failed",
        focused: false,
        loaded,
        ...(loaded ? {} : { message: "Panel view was not created" }),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const lease = this.registry.getRuntimeLease(panelId);
      const isLeaseFailure = /running on|leased by/i.test(message);
      if (!isLeaseFailure) this.markPanelLoadError(panelId, message);
      return {
        panelId,
        status: isLeaseFailure ? "leased_elsewhere" : "view_creation_failed",
        focused: false,
        loaded: false,
        message,
        holderLabel: lease?.holderLabel,
      };
    }
  }

  // =========================================================================
  // Tree initialization
  // =========================================================================

  async initializePanelTree(): Promise<void> {
    // The server is the sole tree authority and seeds initPanels server-side
    // (seedPanelTreeIfEmpty, awaited before the panelTree service is ready), so
    // loadTree() returns the seeded/persisted tree. The desktop never seeds:
    // it loads the authoritative tree and restores metadata. The hosted shell
    // chooses the visible panel and asks this local host to load it on focus.
    await this.shellCore.loadTree();
    await this.syncRuntimeLeaseSnapshot().catch((error: unknown) => {
      log.warn(
        `[initializePanelTree] Failed to sync runtime leases: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    });

    const roots = this.registry.getRootPanels();
    if (roots.length === 0) {
      // No roots yet (empty workspace, or the seed broadcast hasn't landed in
      // the mirror). Nothing to build imperatively — the panel-tree-updated
      // broadcast drives reactive rendering once roots appear.
      log.info(`[initializePanelTree] No roots in authoritative tree at init.`);
      this.registry.notifyPanelTreeUpdate();
      return;
    }

    // Mark restored panels as unloaded (they rebuild on focus)
    for (const entry of this.registry.listPanels()) {
      const panel = this.registry.getPanel(entry.panelId);
      if (panel) {
        const hasBuildArtifacts = Boolean(panel.artifacts?.htmlPath || panel.artifacts?.bundlePath);
        if (panel.artifacts?.buildState !== "pending" || hasBuildArtifacts) {
          this.registry.updateArtifacts(entry.panelId, {
            buildState: "pending",
            buildProgress: "Panel unloaded - will rebuild when focused",
          });
        }
      }
    }
    this.registry.notifyPanelTreeUpdate();
  }

  // =========================================================================
  // Theme
  // =========================================================================

  setCurrentTheme(theme: "light" | "dark"): void {
    this.currentTheme = theme;
    this.shellCore.setCurrentTheme(theme);
    this.registry.setCurrentTheme(theme);
  }

  setCurrentThemeConfig(config: ThemeConfig): void {
    this.currentThemeConfig = config;
  }

  getThemeConfig(): ThemeConfig {
    return this.currentThemeConfig;
  }

  broadcastTheme(theme: "light" | "dark"): void {
    // The theme identity rides on the same event so panels converge appearance
    // AND accent/radius in one push.
    for (const entry of this.registry.listPanels()) {
      if (this.getPanelView()?.hasView(entry.panelId)) {
        this.deps.sendPanelEvent(entry.panelId, "runtime:theme", {
          theme,
          config: this.currentThemeConfig,
        });
      }
    }
  }

  /** Re-broadcast the current appearance + the (just-updated) theme identity. */
  broadcastThemeConfig(): void {
    this.broadcastTheme(this.currentTheme);
  }

  // =========================================================================
  // Command palette contributions
  // =========================================================================

  /** Palette commands contributed by each panel, keyed by panel id (the same
   *  id `sendPanelEvent` dispatches to). Pruned lazily in `listPaletteCommands`
   *  when a contributing panel's view is gone. */
  private readonly paletteContributions = new Map<string, PaletteCommand[]>();

  registerPaletteCommands(panelId: string, commands: PaletteCommand[]): void {
    if (commands.length === 0) this.paletteContributions.delete(panelId);
    else this.paletteContributions.set(panelId, commands);
  }

  unregisterPaletteCommands(panelId: string): void {
    this.paletteContributions.delete(panelId);
  }

  listPaletteCommands(): Array<{ panelId: string; commands: PaletteCommand[] }> {
    const focused = this.registry.getFocusedPanelId();
    const out: Array<{ panelId: string; commands: PaletteCommand[] }> = [];
    for (const [panelId, commands] of this.paletteContributions) {
      if (this.getPanelView()?.hasView(panelId)) out.push({ panelId, commands });
      else this.paletteContributions.delete(panelId); // prune dead contributor
    }
    // Surface the focused panel's commands first.
    return out.sort((a, b) => (a.panelId === focused ? -1 : b.panelId === focused ? 1 : 0));
  }

  runPaletteCommand(panelId: string, commandId: string): void {
    if (this.getPanelView()?.hasView(panelId)) {
      this.deps.sendPanelEvent(panelId, "runtime:palette-run", { commandId });
    }
  }

  // =========================================================================
  // Queries
  // =========================================================================

  getInfo(panelId: string): unknown {
    return this.registry.getInfo(panelId);
  }

  listPanels() {
    return this.registry.listPanels();
  }

  // =========================================================================
  // Panel operations
  // =========================================================================

  async unloadPanel(
    panelId: string,
    transition: "unload" | "lease-transfer" = "unload"
  ): Promise<PanelLifecycleResult> {
    const panel = this.registry.getPanel(panelId);
    if (!panel) throw new Error(`Panel not found: ${panelId}`);

    this.unloadPanelTree(panelId, transition);
    this.registry.notifyPanelTreeUpdate();
    return this.lifecycleResult(
      panelId,
      "unload",
      transition === "unload" ? "unloaded" : "lease_transferred",
      {
        loaded: false,
      }
    );
  }

  private async unloadPanelIfPresent(
    panelId: string,
    transition: "unload" | "lease-transfer"
  ): Promise<void> {
    if (!this.registry.getPanel(panelId)) return;
    await this.unloadPanel(panelId, transition);
  }

  getRuntimeClientSessionId(): string {
    return this.runtimeClientSessionId;
  }

  get registration(): PanelHostRegistration {
    return createPanelHostRegistration({
      clientSessionId: this.runtimeClientSessionId,
      label: this.runtimeClientLabel,
      platform: this.runtimeClientPlatform,
      supportsCdp: this.runtimeClientSupportsCdp,
      loadOnLeaseAssignment: this.loadOnLeaseAssignment,
    });
  }

  async registerRuntimeClient(): Promise<void> {
    await this.ensureRuntimeClientRegistered();
    // Arm the client-side UI GC sweep (desktop only; null on headless, which
    // uses per-panel one-shot timers instead).
    this.startIdleSweep();
  }

  async unregisterRuntimeClient(): Promise<void> {
    this.stopIdleSweep();
    if (!this.runtimeClientRegistered) return;
    this.runtimeClientRegistered = false;
    await this.panelRuntime.unregisterClient(this.runtimeClientSessionId);
  }

  getFocusedPanelId(): string | null {
    return this.registry.getFocusedPanelId();
  }

  async getCurrentRuntimeEntityId(panelId: string): Promise<string> {
    return this.shellCore.getCurrentEntityId(asPanelSlotId(panelId));
  }

  async takeOverPanel(panelId: string): Promise<PanelFocusResult> {
    await this.loadPanelIntoView(panelId, "takeOver");
    return this.focusPanel(panelId);
  }

  async syncRuntimeLeaseSnapshot(): Promise<void> {
    const snapshot = await this.panelRuntime.getSnapshot();
    this.registry.applyRuntimeLeaseSnapshot(snapshot);
  }

  async applyServerPanelTreeSnapshot(snapshot: PanelTreeSnapshot): Promise<void> {
    if (snapshot.revision <= this.lastAppliedServerPanelTreeRevision) return;
    this.lastAppliedServerPanelTreeRevision = snapshot.revision;
    const rootPanels = this.preserveExplicitTitlesInSnapshot(snapshot.rootPanels);
    if (this.panelTreesMatchSemantically(this.registry.getRootPanels(), rootPanels)) {
      return;
    }
    if (this.panelTreesMatchIgnoringTitles(this.registry.getRootPanels(), rootPanels)) {
      this.applyPanelTitlesFromSnapshot(rootPanels);
      return;
    }
    const beforeIds = new Set(this.registry.listPanels().map((p) => p.panelId));
    // Capture hosted panel state so we can react to authoritative snapshot
    // changes from any client. The desktop is a view-host: it builds views on
    // lease assignment, reloads hosted views on navigate/history, pushes
    // state-args-only changes to the runtime, and destroys views on removal.
    const view = this.getPanelView();
    const hostedBefore = new Map<
      string,
      { source: string; contextId: string; stateArgsJson: string }
    >();
    if (view) {
      for (const { panelId } of this.registry.listPanels()) {
        if (!view.hasView(panelId)) continue;
        const panel = this.registry.getPanel(panelId);
        if (!panel) continue;
        const snap = getCurrentSnapshot(panel);
        hostedBefore.set(panelId, {
          source: snap.source,
          contextId: snap.contextId,
          stateArgsJson: JSON.stringify(snap.stateArgs ?? {}),
        });
      }
    }
    this.registry.repopulate(rootPanels);
    // Keep the panelManager's entity caches coherent with the authoritative tree
    // after EVERY broadcast (any client's mutation). The registry now carries the
    // new runtimeEntityIds; without this the desktop would resolve/lease retired
    // entities (stale getPanelInit, cross-client navigate). In-memory, no RPC.
    this.shellCore.syncEntityCachesFromRegistry();
    for (const panelId of beforeIds) {
      if (!this.registry.getPanel(panelId)) this.pruneRemovedPanelLocally(panelId);
    }
    // Drop pins for slot ids no longer in the tree. Main is the GC source of
    // truth; the shell atom is reconciled separately because named-panel slot
    // ids are reused after remove+recreate.
    this.deps.pinStore?.prune(this.registry.listPanels().map((p) => p.panelId));
    // Reactive navigate: reload the view of any still-hosted panel whose current
    // snapshot changed source/contextId (a navigate/history/replace by any client).
    // Entity caches were already refreshed above, so the lease targets the new entity.
    for (const [panelId, before] of hostedBefore) {
      const panel = this.registry.getPanel(panelId);
      if (!panel || !view?.hasView(panelId)) continue;
      const snap = getCurrentSnapshot(panel);
      const stateArgsJson = JSON.stringify(snap.stateArgs ?? {});
      if (stateArgsJson !== before.stateArgsJson) {
        this.deps.sendPanelEvent(panelId, "runtime:stateArgsChanged", snap.stateArgs ?? {});
      }
      if (snap.source === before.source && snap.contextId === before.contextId) continue;
      // Browser panels are driven by their own webContents (in-page navigation,
      // address-bar browserNavigate). Their source changes are *recorded* into
      // the tree after the view already navigated, so a server-driven reload here
      // would redundantly (and destructively) re-navigate the page. Skip them.
      if (snap.source.startsWith("browser:") || before.source.startsWith("browser:")) continue;
      this.explicitTitlePanelIds.delete(panelId);
      this.ensureStateArgsPush(panelId);
      await this.loadSnapshotIntoView(panelId, snap).catch((error: unknown) => {
        log.warn(
          `[applyServerPanelTreeSnapshot] view reload after navigate failed for ${panelId}: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      });
    }
    await this.syncRuntimeLeaseSnapshot().catch((error: unknown) => {
      log.warn(
        `[applyServerPanelTreeSnapshot] Failed to sync runtime leases: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    });
  }

  /** Local teardown for a panel the authoritative tree no longer contains. */
  private pruneRemovedPanelLocally(panelId: string): void {
    this.stateArgsPushUnsubs.get(panelId)?.();
    this.stateArgsPushUnsubs.delete(panelId);
    this.explicitTitlePanelIds.delete(panelId);
    this.releaseLocalPanelRuntime(panelId, "close");
  }

  applyServerPanelTitleUpdate(update: {
    panelId: string;
    title: string;
    explicit?: boolean;
  }): void {
    const panel = this.registry.getPanel(update.panelId);
    if (!panel) return;
    if (!update.explicit && this.explicitTitlePanelIds.has(update.panelId)) return;
    if (update.explicit) {
      this.explicitTitlePanelIds.add(update.panelId);
    }
    if (panel.title === update.title) return;
    this.registry.updateTitle(update.panelId, update.title);
  }

  private panelTreesMatchSemantically(
    current: readonly Panel[],
    incoming: readonly Panel[]
  ): boolean {
    if (current.length !== incoming.length) return false;
    return current.every((panel, index) =>
      this.panelsMatchSemantically(panel, assertPresent(incoming[index]))
    );
  }

  private panelsMatchSemantically(current: Panel, incoming: Panel): boolean {
    if (current.id !== incoming.id) return false;
    if (current.title !== incoming.title) return false;
    if ((current.positionId ?? null) !== (incoming.positionId ?? null)) return false;
    if ((current.selectedChildId ?? null) !== (incoming.selectedChildId ?? null)) return false;
    if (!this.panelSnapshotsMatchSemantically(current, incoming)) return false;
    return this.panelTreesMatchSemantically(current.children, incoming.children);
  }

  private panelTreesMatchIgnoringTitles(
    current: readonly Panel[],
    incoming: readonly Panel[]
  ): boolean {
    if (current.length !== incoming.length) return false;
    return current.every((panel, index) =>
      this.panelsMatchIgnoringTitle(panel, assertPresent(incoming[index]))
    );
  }

  private panelsMatchIgnoringTitle(current: Panel, incoming: Panel): boolean {
    if (current.id !== incoming.id) return false;
    if ((current.positionId ?? null) !== (incoming.positionId ?? null)) return false;
    if ((current.selectedChildId ?? null) !== (incoming.selectedChildId ?? null)) return false;
    if (!this.panelSnapshotsMatchSemantically(current, incoming)) return false;
    return this.panelTreesMatchIgnoringTitles(current.children, incoming.children);
  }

  private applyPanelTitlesFromSnapshot(panels: readonly Panel[]): void {
    for (const incoming of panels) {
      this.applyServerPanelTitleUpdate({ panelId: incoming.id, title: incoming.title });
      this.applyPanelTitlesFromSnapshot(incoming.children);
    }
  }

  private preserveExplicitTitlesInSnapshot(panels: readonly Panel[]): Panel[] {
    let changed = false;
    const preservePanel = (panel: Panel): Panel => {
      const children = panel.children.map(preservePanel);
      const childrenChanged = children.some((child, index) => child !== panel.children[index]);
      const currentPanel = this.explicitTitlePanelIds.has(panel.id)
        ? this.registry.getPanel(panel.id)
        : null;
      const title = currentPanel?.title ?? panel.title;
      if (!childrenChanged && title === panel.title) return panel;
      changed = true;
      return { ...panel, title, children };
    };
    const nextPanels = panels.map(preservePanel);
    return changed ? nextPanels : (panels as Panel[]);
  }

  private panelSnapshotsMatchSemantically(current: Panel, incoming: Panel): boolean {
    try {
      const currentSnapshot = getCurrentSnapshot(current);
      const incomingSnapshot = getCurrentSnapshot(incoming);
      return (
        currentSnapshot.source === incomingSnapshot.source &&
        currentSnapshot.contextId === incomingSnapshot.contextId &&
        currentSnapshot.options.ref === incomingSnapshot.options.ref &&
        JSON.stringify(currentSnapshot.stateArgs ?? null) ===
          JSON.stringify(incomingSnapshot.stateArgs ?? null)
      );
    } catch {
      return false;
    }
  }

  async recoverShellSnapshot(
    opts: { loadFocusedView?: boolean } = {}
  ): Promise<PanelRecoverySnapshot> {
    const { collapsedIds } = await this.shellCore.loadTree();
    await this.syncRuntimeLeaseSnapshot();

    const currentFocusedPanelId = this.registry.getFocusedPanelId();
    const roots = this.registry.getRootPanels();
    const focusedPanelId =
      currentFocusedPanelId && this.registry.getPanel(currentFocusedPanelId)
        ? currentFocusedPanelId
        : (roots[0]?.id ?? null);
    const shouldLoadFocusedView =
      opts.loadFocusedView ?? (this.restorePolicy === "focused" && Boolean(focusedPanelId));
    const focus = focusedPanelId
      ? await this.focusPanel(focusedPanelId, { loadIfNeeded: shouldLoadFocusedView })
      : undefined;

    const treeSnapshot = this.registry.getPanelTreeSnapshot();
    this.eventService.emit("panel:snapshot", {
      revision: treeSnapshot.revision,
      viewRevision: this.viewRevision,
      rootPanels: treeSnapshot.rootPanels,
      collapsedIds,
      focusedPanelId,
      focus,
    });
    return {
      revision: treeSnapshot.revision,
      viewRevision: this.viewRevision,
      rootPanels: treeSnapshot.rootPanels,
      collapsedIds,
      focusedPanelId,
      focus,
    };
  }

  async handleRuntimeLeaseChanged(event: PanelRuntimeLeaseChangedEvent): Promise<void> {
    const slotId = event.slotId;
    if (!slotId) return;
    this.registry.applyRuntimeLeaseChanged(event);
    this.eventService.emit("panel:runtimeLeaseChanged", event);
    const disposition = classifyRuntimeLeaseChange(this.runtimeClientSessionId, event);
    if (disposition.kind === "unassigned") {
      await this.unloadPanelIfPresent(slotId, "lease-transfer");
      return;
    }
    // Reactive view-host: build the native view whenever a lease lands on THIS
    // session. This is the sole desktop build path — the imperative panelTree
    // mutators only *acquire* the lease; the assigned-lease broadcast (this
    // handler) performs the build. Decoupled from `loadOnLeaseAssignment`,
    // which now governs only CDP-default-host candidacy server-side
    // (getDefaultCdpHostClient). The `view.hasView` guard keeps it idempotent
    // so a redundant snapshot/lease event never double-builds.
    if (disposition.kind === "assigned") {
      const lease = disposition.lease;
      const view = this.getPanelView();
      if (view && !view.hasView(slotId)) {
        try {
          const panel = this.registry.getPanel(slotId);
          if (panel) {
            this.viewBuildFailures.delete(slotId);
            await this.loadAssignedLeaseIntoView(slotId, getCurrentSnapshot(panel), lease);
            this.trackAssignedPanelResource(slotId);
            await this.enforceAssignedPanelResourceCap(slotId);
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          log.warn(
            `[handleRuntimeLeaseChanged] Failed to load assigned panel ${slotId}: ${message}`
          );
          // The reactive build failed — record it so the imperative creator that
          // acquired this lease (awaitViewBuilt) can surface the failure and roll
          // back, and free the now-viewless lease so it doesn't leak.
          this.viewBuildFailures.set(slotId, message);
          this.releaseLocalPanelRuntime(slotId, "unload");
          this.markPanelLoadError(slotId, message);
        }
      } else if (view?.hasView(slotId)) {
        this.runtimeConnectionBySlot.set(slotId, {
          runtimeEntityId: lease.runtimeEntityId,
          connectionId: lease.connectionId,
        });
        this.trackAssignedPanelResource(slotId);
      }
      return;
    }
  }

  // =========================================================================
  // WS event helpers
  // =========================================================================

  sendPanelEvent(panelId: string, payload: unknown): void {
    const data = payload as Record<string, unknown>;
    if (data["type"] === "focus") {
      this.deps.sendPanelEvent(panelId, "runtime:focus", null);
    } else if (data["type"] === "theme") {
      this.deps.sendPanelEvent(panelId, "runtime:theme", {
        theme: data["theme"],
        config: this.currentThemeConfig,
      });
    } else if (data["type"] === "child-created") {
      this.deps.sendPanelEvent(panelId, "runtime:child-created", {
        childId: data["childId"],
        url: data["url"],
      });
    } else if (data["type"] === "child-creation-error") {
      this.deps.sendPanelEvent(panelId, "runtime:child-creation-error", {
        url: data["url"],
        error: data["error"],
      });
    }
  }

  // =========================================================================
  // Persistence delegation (server-first)
  // =========================================================================

  async setCollapsed(panelId: string, collapsed: boolean): Promise<void> {
    await this.shellCore.setCollapsed(asPanelSlotId(panelId), collapsed);
  }

  async expandIds(panelIds: string[]): Promise<void> {
    await this.shellCore.expandIds(panelIds);
  }

  async getCollapsedIds(): Promise<string[]> {
    return this.shellCore.getCollapsedIds();
  }

  persistFocusedPath(panelId: string): void {
    void this.shellCore.notifyFocused(asPanelSlotId(panelId)).catch(() => {});
  }

  // =========================================================================
  // URL helpers
  // =========================================================================

  getPanelUrl(panelId: string): string | null {
    return this.getPanelUrlForId(panelId);
  }

  hasPanelView(panelId: string): boolean {
    return this.getPanelView()?.hasView(panelId) ?? false;
  }

  private getPanelUrlForId(panelId: string): string | null {
    const panel = this.registry.getPanel(panelId);
    if (!panel) return null;

    const source = getPanelSource(panel);
    if (source.startsWith("browser:")) {
      return source.slice("browser:".length);
    }

    return buildPanelUrl({
      source,
      contextId: getPanelContextId(panel),
      ref: getPanelRef(panel),
      gatewayPort: this.deps.gatewayPort,
      basePath: this.deps.gatewayBasePath,
    });
  }

  private async attachCreatedPanel(
    result: {
      panelId: string;
      title: string;
      contextId?: string;
      source?: string;
      options?: Record<string, unknown>;
    },
    opts: { focus?: boolean; browserUrl?: string } = {}
  ): Promise<void> {
    this.ensureStateArgsPush(result.panelId);
    const panel = this.registry.getPanel(result.panelId);
    const source = result.source ?? (panel ? getPanelSource(panel) : undefined);
    const view = this.getPanelView();

    if (opts.browserUrl) {
      // Acquire-only: the assigned-lease broadcast drives the native build via
      // handleRuntimeLeaseChanged → loadAssignedLeaseIntoView (reactive host).
      if (view?.createViewForBrowser && !view.hasView(result.panelId)) {
        try {
          await this.acquireRuntimeLease(result.panelId, "acquire");
          await this.awaitViewBuilt(result.panelId);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (!/running on|leased by/i.test(message))
            this.markPanelLoadError(result.panelId, message);
          this.releaseLocalPanelRuntime(result.panelId, "unload");
          throw error;
        }
      }
      this.registry.updateArtifacts(result.panelId, {
        htmlPath: opts.browserUrl,
        buildState: "ready",
        buildRevision: undefined,
      });
      this.registry.notifyPanelTreeUpdate();
      if (opts.focus) {
        await this.focusPanel(result.panelId);
      }
      return;
    }

    // Acquire-only: acquiring the lease triggers the reactive build. We resolve
    // the panel URL for the artifact record but no longer createView* directly.
    let panelUrl: string | null;
    try {
      panelUrl = await this.buildPanelLoadUrl(result.panelId);
      if (view && !view.hasView(result.panelId)) {
        await this.awaitViewBuilt(result.panelId);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/running on|leased by/i.test(message)) this.markPanelLoadError(result.panelId, message);
      this.releaseLocalPanelRuntime(result.panelId, "unload");
      throw error;
    }

    const ref =
      (result.options?.["ref"] as string | undefined) ??
      (panel ? (getCurrentSnapshot(panel).options.ref as string | undefined) : undefined);
    const buildCached = source ? (this.panelHttpServer?.hasBuild(source, ref) ?? false) : false;
    this.registry.updateArtifacts(result.panelId, {
      htmlPath: panelUrl ?? undefined,
      buildState: buildCached ? "ready" : "building",
      buildRevision: source ? this.getBuildRevision(source, ref) : undefined,
      buildProgress: buildCached ? undefined : "Waiting for build...",
    });
    this.registry.notifyPanelTreeUpdate();
    if (opts.focus) {
      await this.focusPanel(result.panelId);
    }
  }

  private ensureStateArgsPush(panelId: string): void {
    if (this.stateArgsPushUnsubs.has(panelId)) return;
    this.stateArgsPushUnsubs.set(
      panelId,
      this.shellCore.onStateArgsChanged(asPanelSlotId(panelId), (stateArgs) => {
        this.deps.sendPanelEvent(panelId, "runtime:stateArgsChanged", stateArgs);
      })
    );
  }

  private async loadPanelIntoView(
    panelId: string,
    leaseMode: "acquire" | "takeOver" = "acquire"
  ): Promise<void> {
    const panel = this.registry.getPanel(panelId);
    if (!panel) throw new Error(`Panel not found: ${panelId}`);
    await this.loadSnapshotIntoView(panelId, getCurrentSnapshot(panel), leaseMode);
  }

  private async buildPanelLoadUrl(
    panelId: string,
    leaseMode: "acquire" | "takeOver" = "acquire"
  ): Promise<string | null> {
    const panel = this.registry.getPanel(panelId);
    if (!panel) return null;

    const source = getPanelSource(panel);
    if (source.startsWith("browser:")) {
      return source.slice("browser:".length);
    }

    await this.acquireRuntimeLease(panelId, leaseMode);
    return buildPanelUrl({
      source,
      contextId: getPanelContextId(panel),
      ref: getPanelRef(panel),
      gatewayPort: this.deps.gatewayPort,
      basePath: this.deps.gatewayBasePath,
    });
  }

  private async loadSnapshotIntoView(
    panelId: string,
    snapshot: PanelSnapshot,
    leaseMode: "acquire" | "takeOver" = "acquire"
  ): Promise<void> {
    const view = this.getPanelView();
    if (!view) return;

    // Only tear the view down when its session partition must change
    // (workspace panel ↔ browser panel, or a different contextId). For a
    // plain URL change, createViewForPanel/Browser navigate the existing
    // renderer in place — destroy/recreate costs a full renderer restart.
    this.destroyViewIfPartitionChanged(view, panelId, snapshot);

    // Fresh build vs. navigate-in-place. A FRESH build (no view present after
    // the partition check) is acquire-driven: acquiring the lease triggers the
    // reactive host (handleRuntimeLeaseChanged → loadAssignedLeaseIntoView), so
    // we acquire then await the build instead of createView* directly. A view
    // that's still present is a navigate-in-place (same lease, new URL) — no
    // lease event fires, so we must navigate the existing renderer directly.
    const navigateInPlace = view.hasView(panelId);

    if (snapshot.source.startsWith("browser:")) {
      const url = snapshot.source.slice("browser:".length);
      await this.acquireRuntimeLease(panelId, leaseMode);
      if (navigateInPlace) {
        if (view.createViewForBrowser) {
          await view.createViewForBrowser(panelId, url, snapshot.contextId);
          this.bumpViewRevision();
        }
      } else {
        await this.awaitViewBuilt(panelId);
      }
      this.registry.updateArtifacts(panelId, { buildState: "ready", htmlPath: url });
      this.registry.notifyPanelTreeUpdate();
      return;
    }

    await this.acquireRuntimeLease(panelId, leaseMode);
    const panelUrl = buildPanelUrl({
      source: snapshot.source,
      contextId: snapshot.contextId,
      ref: snapshot.options.ref,
      gatewayPort: this.deps.gatewayPort,
      basePath: this.deps.gatewayBasePath,
    });
    if (navigateInPlace) {
      await view.createViewForPanel(panelId, panelUrl, snapshot.contextId);
      this.bumpViewRevision();
    } else {
      await this.awaitViewBuilt(panelId);
    }
    this.registry.updateArtifacts(panelId, {
      htmlPath: panelUrl,
      buildState: this.panelHttpServer?.hasBuild(snapshot.source, snapshot.options.ref)
        ? "ready"
        : "building",
      buildRevision: this.getBuildRevision(snapshot.source, snapshot.options.ref),
      buildProgress: this.panelHttpServer?.hasBuild(snapshot.source, snapshot.options.ref)
        ? undefined
        : "Waiting for build...",
    });
    this.registry.notifyPanelTreeUpdate();
  }

  private async loadAssignedLeaseIntoView(
    panelId: string,
    snapshot: PanelSnapshot,
    lease: PanelRuntimeLease
  ): Promise<void> {
    const view = this.getPanelView();
    if (!view) return;

    this.destroyViewIfPartitionChanged(view, panelId, snapshot);

    this.runtimeConnectionBySlot.set(panelId, {
      runtimeEntityId: lease.runtimeEntityId,
      connectionId: lease.connectionId,
    });

    if (snapshot.source.startsWith("browser:")) {
      const url = snapshot.source.slice("browser:".length);
      if (view.createViewForBrowser) {
        await view.createViewForBrowser(panelId, url, snapshot.contextId);
        this.bumpViewRevision();
      }
      this.registry.updateArtifacts(panelId, { buildState: "ready", htmlPath: url });
      this.registry.notifyPanelTreeUpdate();
      return;
    }

    const panelUrl = buildPanelUrl({
      source: snapshot.source,
      contextId: snapshot.contextId,
      ref: snapshot.options.ref,
      gatewayPort: this.deps.gatewayPort,
      basePath: this.deps.gatewayBasePath,
    });
    await view.createViewForPanel(panelId, panelUrl, snapshot.contextId);
    this.bumpViewRevision();
    this.registry.updateArtifacts(panelId, {
      htmlPath: panelUrl,
      buildState: this.panelHttpServer?.hasBuild(snapshot.source, snapshot.options.ref)
        ? "ready"
        : "building",
      buildRevision: this.getBuildRevision(snapshot.source, snapshot.options.ref),
      buildProgress: this.panelHttpServer?.hasBuild(snapshot.source, snapshot.options.ref)
        ? undefined
        : "Waiting for build...",
    });
    this.registry.notifyPanelTreeUpdate();
  }

  // =========================================================================
  // Private helpers
  // =========================================================================

  /**
   * Destroy an existing view only when the snapshot needs a different session
   * partition (workspace ↔ browser panel, or a contextId change). Same
   * partition means createViewForPanel/Browser can navigate the existing
   * renderer in place, avoiding a full renderer-process restart on every
   * managed navigation.
   */
  private destroyViewIfPartitionChanged(
    view: PanelViewLike,
    panelId: string,
    snapshot: PanelSnapshot
  ): void {
    if (!view.hasView(panelId)) return;
    const target = snapshot.source.startsWith("browser:")
      ? BROWSER_SESSION_PARTITION
      : snapshot.contextId
        ? contextIdToPartition(snapshot.contextId)
        : undefined;
    if (view.getViewPartition(panelId) === target) return;
    view.destroyView(panelId);
    this.bumpViewRevision();
  }

  private async ensureRuntimeClientRegistered(): Promise<void> {
    if (this.runtimeClientRegistered) return;
    await this.panelRuntime.registerClient(this.registration);
    this.runtimeClientRegistered = true;
  }

  private async acquireRuntimeLease(
    panelId: string,
    leaseMode: "acquire" | "takeOver"
  ): Promise<string> {
    await this.ensureRuntimeClientRegistered();
    const runtimeEntityId = await this.shellCore.getCurrentEntityId(asPanelSlotId(panelId));
    const connectionId = `${this.runtimeClientPlatform}-${panelId}-${randomUUID()}`;
    const lease = createPanelRuntimeLeaseRequest({
      slotId: panelId,
      clientSessionId: this.runtimeClientSessionId,
      connectionId,
    });
    const result = await (leaseMode === "acquire"
      ? this.panelRuntime.acquire(runtimeEntityId, lease)
      : this.panelRuntime.takeOver(runtimeEntityId, lease));
    if (!result.acquired) {
      throw new Error(formatPanelRuntimeLeaseDeniedMessage(panelId, result.lease));
    }
    this.runtimeConnectionBySlot.set(panelId, { runtimeEntityId, connectionId });
    return connectionId;
  }

  private getBuildRevision(source: string, ref?: string): number | undefined {
    return this.panelHttpServer?.getBuildRevision?.(source, ref);
  }

  private lifecycleResult(
    panelId: string,
    operation: PanelLifecycleResult["operation"],
    status: string,
    flags: Partial<Pick<PanelLifecycleResult, "loaded" | "rebuilt" | "reloaded">> = {}
  ): PanelLifecycleResult {
    const panel = this.registry.getPanel(panelId);
    const source = panel ? getPanelSource(panel) : undefined;
    const ref = panel ? getPanelRef(panel) : undefined;
    return {
      panelId,
      operation,
      status,
      loaded: flags.loaded ?? Boolean(this.getPanelView()?.hasView(panelId)),
      rebuilt: flags.rebuilt ?? false,
      reloaded: flags.reloaded ?? false,
      buildRevision: source ? this.getBuildRevision(source, ref) : undefined,
      effectiveVersion: panel?.effectiveVersion ?? null,
    };
  }

  private releaseLocalPanelRuntime(
    panelId: string,
    _transition: "close" | "invalidate" | "lease-transfer" | "unload"
  ): void {
    this.clearAssignedPanelResource(panelId);
    const lease = this.runtimeConnectionBySlot.get(panelId);
    this.runtimeConnectionBySlot.delete(panelId);
    if (lease) {
      void this.panelRuntime.release(lease.runtimeEntityId, lease.connectionId).catch(() => {});
    }
    // Close open file handles (skip for browser panels)
    // Note: FS handles are managed server-side, but local cleanup still needed

    // CDP cleanup
    this.cdpHost?.cleanupPanelAccess(panelId);
    this.cdpHost?.unregisterTarget?.(panelId);

    // Destroy view
    const view = this.getPanelView();
    if (view?.hasView(panelId)) {
      view.destroyView(panelId);
      this.bumpViewRevision();
    }
  }

  private bumpViewRevision(): number {
    this.viewRevision += 1;
    return this.viewRevision;
  }

  // ===========================================================================
  // Client-side UI garbage collection (idle sweep + pin-aware count cap)
  // ===========================================================================

  /**
   * Predicates shared by the idle sweep and the count cap. `isPinned` reads the
   * client-local pin store (absent on headless ⇒ always false); `isKeepLoaded`
   * reflects an active CDP/automation client on the lease.
   */
  private gcPredicates() {
    return {
      isPinned: (id: string) => this.deps.pinStore?.has(id) ?? false,
      isKeepLoaded: (id: string) => !!this.registry.getRuntimeLease(id)?.keepLoaded,
    };
  }

  private loadedSnapshots(): LoadedPanelSnapshot[] {
    return [...this.assignedPanelResources.entries()].map(([panelId, r]) => ({
      panelId,
      lastActive: r.lastUsedAt,
    }));
  }

  /**
   * Refresh the activity timestamp of an *already-tracked* panel. Never creates
   * an entry — only loaded panels are tracked, so this can't manufacture a
   * phantom resource for an unloaded panel.
   */
  private refreshPanelActivity(panelId: string): void {
    const entry = this.assignedPanelResources.get(panelId);
    if (!entry) return;
    entry.lastUsedAt = Date.now();
  }

  /**
   * Start the periodic idle GC sweep. The single idle mechanism for every host
   * (desktop 1h, headless 5m); idempotent; disabled when `uiIdleUnloadMs` is null.
   */
  private startIdleSweep(): void {
    if (this.uiIdleUnloadMs === null || this.idleSweepTimer) return;
    const idleMs = this.uiIdleUnloadMs;
    this.idleSweepTimer = setInterval(() => {
      const focused = this.registry.getFocusedPanelId();
      const victims = selectIdlePanelVictims(this.loadedSnapshots(), {
        now: Date.now(),
        idleMs,
        protectedIds: focused ? [focused] : [],
        ...this.gcPredicates(),
      });
      for (const id of victims) void this.unloadAssignedPanelResource(id, "idle-timeout");
    }, this.uiIdleSweepMs);
  }

  /** Stop the idle GC sweep (cleared from unregisterRuntimeClient). */
  private stopIdleSweep(): void {
    if (this.idleSweepTimer) {
      clearInterval(this.idleSweepTimer);
      this.idleSweepTimer = undefined;
    }
  }

  /** Toggle the client-local pin for a slot id; returns the new pinned state. */
  togglePanelPin(panelId: string): boolean {
    return this.deps.pinStore?.toggle(panelId) ?? false;
  }

  isPanelPinned(panelId: string): boolean {
    return this.deps.pinStore?.has(panelId) ?? false;
  }

  listPinnedPanelIds(): string[] {
    return this.deps.pinStore?.list() ?? [];
  }

  private trackAssignedPanelResource(panelId: string): void {
    if (!this.loadOnLeaseAssignment) return;
    // Record activity only — the idle sweep (not a per-panel timer) decides when
    // to unload, so every host shares one GC mechanism.
    this.assignedPanelResources.set(panelId, { lastUsedAt: Date.now() });
  }

  private clearAssignedPanelResource(panelId: string): void {
    this.assignedPanelResources.delete(panelId);
  }

  private async enforceAssignedPanelResourceCap(keepPanelId: string): Promise<void> {
    if (this.maxAssignedPanelViews === null || this.maxAssignedPanelViews <= 0) return;
    const focused = this.registry.getFocusedPanelId();
    const protectedIds = [keepPanelId, ...(focused ? [focused] : [])];
    const victims = selectCapEvictionVictims(this.loadedSnapshots(), {
      cap: this.maxAssignedPanelViews,
      protectedIds,
      ...this.gcPredicates(),
    });
    for (const id of victims) await this.unloadAssignedPanelResource(id, "resource-cap");
  }

  private async unloadAssignedPanelResource(
    panelId: string,
    reason: "idle-timeout" | "resource-cap"
  ): Promise<void> {
    if (!this.assignedPanelResources.has(panelId)) return;
    if (!this.registry.getPanel(panelId)) {
      this.clearAssignedPanelResource(panelId);
      return;
    }
    try {
      await this.unloadPanel(panelId, "unload");
    } catch (error) {
      log.warn(
        `[assignedPanelResource] Failed to unload ${panelId} after ${reason}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      this.clearAssignedPanelResource(panelId);
    }
  }

  private unloadPanelTree(
    panelId: string,
    transition: "lease-transfer" | "unload" = "unload"
  ): void {
    const panel = this.registry.getPanel(panelId);
    if (!panel) return;

    for (const child of panel.children) {
      this.unloadPanelTree(child.id, transition);
    }

    this.releaseLocalPanelRuntime(panelId, transition);

    const hasBuildArtifacts = Boolean(panel.artifacts?.htmlPath || panel.artifacts?.bundlePath);
    if (panel.artifacts?.buildState === "pending" && !hasBuildArtifacts) return;

    this.registry.updateArtifacts(panelId, {
      buildState: "pending",
      buildProgress: "Panel unloaded - will rebuild when focused",
    });
  }
}
