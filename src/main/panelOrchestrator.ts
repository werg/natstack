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
} from "@natstack/shared/types";
import type { PanelRegistry } from "@natstack/shared/panelRegistry";
import type { EventService } from "@natstack/shared/eventsService";
import type { ServerClient } from "./serverClient.js";
import type { PanelManager } from "@natstack/shared/shell/panelManager";
import type {
  PanelRuntimeLease,
  PanelRuntimeLeaseChangedEvent,
} from "@natstack/shared/panel/panelLease";
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
import { asPanelSlotId } from "@natstack/shared/panel/ids";
import {
  getCurrentSnapshot,
  getPanelSource,
  getPanelContextId,
  getPanelRef,
  getPanelStateArgs,
} from "@natstack/shared/panel/accessors";
import { assertPresent } from "../lintHelpers";

const log = createDevLogger("PanelOrchestrator");

export interface RuntimePanelCreateResult {
  id: string;
  kind: "workspace" | "browser";
  title: string;
}

interface PendingAgentCall {
  panelId: string;
  webContentsId: number;
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

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
  runtimeClient?: {
    clientSessionId?: string;
    label?: string;
    platform?: "desktop" | "headless" | "mobile";
    supportsCdp?: boolean;
    loadOnLeaseAssignment?: boolean;
    maxAssignedPanelViews?: number;
    assignedPanelIdleMs?: number;
    restorePolicy?: PanelRestorePolicy;
  };
}

export class PanelOrchestrator implements BridgePanelLifecycle {
  private readonly deps: PanelOrchestratorDeps;
  private currentTheme: "light" | "dark" = "dark";
  private readonly runtimeClientSessionId: string;
  private readonly runtimeClientLabel: string;
  private readonly runtimeClientPlatform: "desktop" | "headless" | "mobile";
  private readonly runtimeClientSupportsCdp: boolean;
  private readonly loadOnLeaseAssignment: boolean;
  private readonly maxAssignedPanelViews: number | null;
  private readonly assignedPanelIdleMs: number | null;
  private runtimeClientRegistered = false;
  private readonly runtimeConnectionBySlot = new Map<
    string,
    { runtimeEntityId: string; connectionId: string }
  >();
  private readonly assignedPanelResources = new Map<
    string,
    { lastUsedAt: number; idleTimer?: ReturnType<typeof setTimeout> }
  >();
  private readonly stateArgsUpdateQueues = new Map<string, Promise<unknown>>();
  private readonly pendingAgentCalls = new Map<number, PendingAgentCall>();
  private readonly stateArgsPushUnsubs = new Map<string, () => void>();
  private nextAgentRequestId = 1;
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
    this.maxAssignedPanelViews =
      deps.runtimeClient?.maxAssignedPanelViews ??
      (this.runtimeClientPlatform === "headless" && this.loadOnLeaseAssignment ? 8 : null);
    this.assignedPanelIdleMs =
      deps.runtimeClient?.assignedPanelIdleMs ??
      (this.runtimeClientPlatform === "headless" && this.loadOnLeaseAssignment
        ? 5 * 60 * 1000
        : null);
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
  private get workspaceConfig() {
    return this.deps.workspaceConfig;
  }

  // =========================================================================
  // Panel creation
  // =========================================================================

  async createPanel(
    callerId: string,
    source: string,
    options?: PanelCreateOptions,
    stateArgs?: Record<string, unknown>
  ): Promise<{ id: string; title: string }> {
    const caller = this.registry.getPanel(callerId);
    if (!caller) throw new Error(`Caller panel not found: ${callerId}`);

    const result = await this.shellCore.create(source, {
      parentId: asPanelSlotId(callerId),
      ...options,
      stateArgs,
    });

    try {
      await this.attachCreatedPanel(result, { focus: options?.focus });
      return { id: result.panelId, title: result.title };
    } catch (err) {
      await this.shellCore.close(result.panelId).catch(() => {});
      throw err;
    }
  }

  async navigatePanel(
    panelId: string,
    source: string,
    options?: {
      ref?: string;
      contextId?: string;
      env?: Record<string, string>;
      stateArgs?: Record<string, unknown>;
    }
  ): Promise<{ id: string; title: string }> {
    const result = await this.shellCore.navigate(asPanelSlotId(panelId), source, options);
    const panel = this.registry.getPanel(panelId);
    if (!panel) throw new Error(`Panel not found after navigation: ${panelId}`);
    await this.loadSnapshotIntoView(panelId, getCurrentSnapshot(panel));
    await this.focusPanel(panelId);
    return { id: result.panelId, title: result.title };
  }

  async navigatePanelHistory(
    panelId: string,
    delta: -1 | 1
  ): Promise<{ id: string; title: string } | null> {
    const panel = await this.shellCore.navigateHistory(asPanelSlotId(panelId), delta);
    if (!panel) return null;
    await this.loadSnapshotIntoView(panelId, getCurrentSnapshot(panel));
    await this.focusPanel(panelId);
    return { id: panel.id, title: panel.title };
  }

  /**
   * Create a root panel from an arbitrary source path.
   * Unlike createAboutPanel (which prefixes with "about/"), this method
   * uses the source string as-is, making it suitable for workspace apps
   * that need to create panels from any source.
   */
  async createRootPanel(
    source: string,
    options?: { name?: string; isRoot?: boolean; ref?: string }
  ): Promise<{ id: string; title: string }> {
    const name = options?.name ?? `${source.replace(/\//g, "-")}~${Date.now().toString(36)}`;

    const result = await this.shellCore.create(source, {
      name,
      ref: options?.ref,
      isRoot: options?.isRoot ?? true,
      addAsRoot: true,
    });
    try {
      await this.attachCreatedPanel(result, { focus: true });
      return { id: result.panelId, title: result.title };
    } catch (error) {
      await this.shellCore.close(result.panelId).catch(() => {});
      throw error;
    }
  }

  async createAboutPanel(page: string): Promise<{ id: string; title: string }> {
    const result = await this.shellCore.createAboutPanel(page);
    try {
      await this.attachCreatedPanel({ panelId: result.id, title: result.title }, { focus: true });
      return result;
    } catch (error) {
      await this.shellCore.close(asPanelSlotId(result.id)).catch(() => {});
      throw error;
    }
  }

  async createInitPanel(
    source: string,
    stateArgs?: Record<string, unknown>
  ): Promise<{ id: string; title: string }> {
    const result = await this.shellCore.create(source, {
      isRoot: true,
      addAsRoot: true,
      stateArgs,
    });
    try {
      await this.attachCreatedPanel(result);
      return { id: result.panelId, title: result.title };
    } catch (error) {
      await this.shellCore.close(result.panelId).catch(() => {});
      throw error;
    }
  }

  async createBrowserUrlPanel(
    callerId: string,
    url: string,
    options?: { name?: string; focus?: boolean }
  ): Promise<{ id: string; title: string }> {
    // Defensive: reject non-string or non-http(s) URLs early
    if (typeof url !== "string" || !/^https?:\/\//i.test(url)) {
      throw new Error(`Invalid browser panel URL (must be http/https string): ${String(url)}`);
    }

    const callerPanel = this.registry.getPanel(callerId);
    const parentId = callerPanel ? asPanelSlotId(callerId) : null;
    let createdPanelId: string | null = null;

    try {
      const result = await this.shellCore.createBrowser(parentId, url, {
        name: options?.name,
        addAsRoot: parentId == null,
      });
      createdPanelId = result.panelId;
      await this.attachCreatedPanel(result, { focus: options?.focus, browserUrl: url });
      return { id: result.panelId, title: result.title };
    } catch (err) {
      if (createdPanelId) {
        await this.shellCore.close(asPanelSlotId(createdPanelId)).catch(() => {});
      }
      throw err;
    }
  }

  async createRuntimePanel(
    callerId: string,
    source: string,
    options?: PanelCreateOptions & {
      name?: string;
      focus?: boolean;
      stateArgs?: Record<string, unknown>;
    }
  ): Promise<RuntimePanelCreateResult> {
    if (/^https?:\/\//i.test(source)) {
      const result = await this.createBrowserUrlPanel(callerId, source, {
        name: options?.name,
        focus: options?.focus,
      });
      return { ...result, kind: "browser" };
    }
    const result = await this.createPanel(callerId, source, options, options?.stateArgs);
    return { ...result, kind: "workspace" };
  }

  // =========================================================================
  // Panel destruction
  // =========================================================================

  async closePanel(panelId: string): Promise<PanelLifecycleResult> {
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

    // Server handles recursive close + resource cleanup
    const { closedIds } = await this.shellCore.close(asPanelSlotId(panelId));

    // Destroy views and remove from in-memory tree
    for (const id of closedIds) {
      this.rejectAgentCallsForPanel(id, new Error("panel-closed"));
      this.stateArgsPushUnsubs.get(id)?.();
      this.stateArgsPushUnsubs.delete(id);
      this.explicitTitlePanelIds.delete(id);
      this.releaseLocalPanelRuntime(id, "close");
      this.registry.removePanel(id);
    }

    if (siblingToFocus) {
      this.eventService.emit("navigate-to-panel", { panelId: siblingToFocus });
    }
    return result;
  }

  // =========================================================================
  // Build lifecycle
  // =========================================================================

  async reloadPanel(panelId: string): Promise<PanelLifecycleResult> {
    this.rejectAgentCallsForPanel(panelId, new Error("target-reloading"));
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

    // Browser panels: skip build
    if (getPanelSource(panel).startsWith("browser:")) {
      const url = getPanelSource(panel).slice("browser:".length);
      const view = this.getPanelView();
      if (view?.createViewForBrowser) {
        await view.createViewForBrowser(panelId, url, getPanelContextId(panel));
        this.bumpViewRevision();
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

    const panelUrl = await this.buildPanelLoadUrl(panelId);
    const view = this.getPanelView();
    if (panelUrl && view) {
      await view.createViewForPanel(panelId, panelUrl, getPanelContextId(panel));
      this.bumpViewRevision();
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

  // =========================================================================
  // State mutation
  // =========================================================================

  async handleSetStateArgs(panelId: string, updates: Record<string, unknown>): Promise<unknown> {
    this.ensureStateArgsPush(panelId);
    const previous = this.stateArgsUpdateQueues.get(panelId) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(async () => {
        const validated = await this.shellCore.updateStateArgs(asPanelSlotId(panelId), updates);
        this.registry.updateStateArgs(panelId, validated as Record<string, unknown>);
        return validated;
      });
    this.stateArgsUpdateQueues.set(panelId, next);
    try {
      return await next;
    } finally {
      if (this.stateArgsUpdateQueues.get(panelId) === next) {
        this.stateArgsUpdateQueues.delete(panelId);
      }
    }
  }

  getStateArgs(panelId: string): Record<string, unknown> {
    const panel = this.registry.getPanel(panelId);
    if (!panel) throw new Error(`Panel not found: ${panelId}`);
    return (getPanelStateArgs(panel) ?? {}) as Record<string, unknown>;
  }

  listRuntimePanels(parentId?: string | null) {
    return parentId ? this.registry.getChildren(parentId) : this.registry.listPanels();
  }

  async snapshot(panelId: string): Promise<unknown> {
    this.requirePanelLoadedForAgent(panelId);
    if (!this.cdpHost.getAccessibilityTree) {
      return this.callAgent(panelId, "_agent.snapshot", []);
    }
    const nodes = await this.cdpHost.getAccessibilityTree(panelId);
    return {
      kind: "ax",
      text: summarizeAxNodes(nodes),
      structure: nodes,
    };
  }

  async callAgent(
    panelId: string,
    method: string,
    args: unknown[] = [],
    options?: { timeoutMs?: number }
  ): Promise<unknown> {
    const wc = this.requirePanelLoadedForAgent(panelId) as
      | { id?: number; isDestroyed?: () => boolean; send(channel: string, payload: unknown): void }
      | null
      | undefined;
    if (!wc || wc.isDestroyed?.()) {
      throw new Error(`target-not-loaded: ${panelId}`);
    }
    if (typeof wc.id !== "number") {
      throw new Error(`target-not-loaded: ${panelId}`);
    }
    const webContentsId = wc.id;
    const requestId = this.nextAgentRequestId++;
    const timeoutMs = options?.timeoutMs ?? 5000;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingAgentCalls.delete(requestId);
        reject(new Error(`AgentCallTimeoutError: ${method} timed out for ${panelId}`));
        try {
          wc.send("natstack:panel.callAgent.request", { type: "cancel", requestId });
        } catch {
          // Ignore best-effort cancel failures.
        }
      }, timeoutMs);
      this.pendingAgentCalls.set(requestId, { panelId, webContentsId, resolve, reject, timer });
      wc.send("natstack:panel.callAgent.request", { requestId, method, args });
    });
  }

  resolveAgentCallResponse(
    requestId: number,
    senderWebContentsId: number,
    response: { ok: boolean; value?: unknown; error?: { code?: string; message?: string } }
  ): void {
    const pending = this.pendingAgentCalls.get(requestId);
    if (!pending) return;
    if (pending.webContentsId !== senderWebContentsId) return;
    clearTimeout(pending.timer);
    this.pendingAgentCalls.delete(requestId);
    if (response.ok) {
      pending.resolve(response.value);
    } else {
      pending.reject(new Error(response.error?.message ?? response.error?.code ?? "panel-error"));
    }
  }

  private rejectAgentCallsForPanel(panelId: string, error: Error): void {
    for (const [requestId, pending] of this.pendingAgentCalls) {
      if (pending.panelId !== panelId) continue;
      clearTimeout(pending.timer);
      this.pendingAgentCalls.delete(requestId);
      pending.reject(error);
    }
  }

  private requirePanelLoadedForAgent(panelId: string): unknown | null {
    const panel = this.registry.getPanel(panelId);
    if (!panel) throw new Error(`Panel not found: ${panelId}`);
    const view = this.getPanelView();
    const wc = view?.getWebContents(panelId) as { isDestroyed?: () => boolean } | null | undefined;
    if (wc && !wc.isDestroyed?.()) return wc;
    throw new Error(`target-not-loaded: ${panelId}`);
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

    this.registry.updateSelectedPath(targetPanelId);
    this.registry.notifyPanelTreeUpdate();

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
      return {
        panelId,
        status: nextView?.hasView(panelId) ? "loaded" : "view_creation_failed",
        focused: false,
        loaded: Boolean(nextView?.hasView(panelId)),
        ...(nextView?.hasView(panelId) ? {} : { message: "Panel view was not created" }),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const lease = this.registry.getRuntimeLease(panelId);
      const isLeaseFailure = /running on|leased by/i.test(message);
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
    await this.shellCore.loadTree();
    await this.syncRuntimeLeaseSnapshot().catch((error: unknown) => {
      log.warn(
        `[initializePanelTree] Failed to sync runtime leases: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    });

    const roots = this.registry.getRootPanels();
    if (roots.length > 0) {
      // Mark restored panels as unloaded (they rebuild on focus)
      for (const entry of this.registry.listPanels()) {
        const panel = this.registry.getPanel(entry.panelId);
        if (panel) {
          const hasBuildArtifacts = Boolean(
            panel.artifacts?.htmlPath || panel.artifacts?.bundlePath
          );
          if (panel.artifacts?.buildState !== "pending" || hasBuildArtifacts) {
            this.registry.updateArtifacts(entry.panelId, {
              buildState: "pending",
              buildProgress: "Panel unloaded - will rebuild when focused",
            });
          }
        }
      }
      this.registry.notifyPanelTreeUpdate();
      if (this.restorePolicy === "focused") {
        const focusedPanelId = this.registry.getFocusedPanelId() ?? roots[0]?.id;
        if (focusedPanelId) {
          await this.focusPanel(focusedPanelId, { loadIfNeeded: true });
        }
      }
    } else {
      const entries = this.workspaceConfig?.initPanels;
      log.info(
        `[initializePanelTree] No existing roots. initPanels config:`,
        JSON.stringify(entries)
      );
      if (entries && entries.length > 0) {
        for (const entry of entries) {
          try {
            log.info(`[initializePanelTree] Creating init panel: ${entry.source}`);
            await this.createInitPanel(entry.source, entry.stateArgs);
          } catch (err) {
            console.error(`[PanelOrchestrator] Failed to create init panel ${entry.source}:`, err);
          }
        }
      }
      const newRoots = this.registry.getRootPanels();
      if (newRoots.length > 0 && this.restorePolicy === "focused") {
        await this.focusPanel(assertPresent(newRoots[0]).id, { loadIfNeeded: true });
      }
      this.registry.notifyPanelTreeUpdate();
    }
  }

  // =========================================================================
  // Theme
  // =========================================================================

  setCurrentTheme(theme: "light" | "dark"): void {
    this.currentTheme = theme;
    this.shellCore.setCurrentTheme(theme);
    this.registry.setCurrentTheme(theme);
  }

  broadcastTheme(theme: "light" | "dark"): void {
    for (const entry of this.registry.listPanels()) {
      if (this.getPanelView()?.hasView(entry.panelId)) {
        this.deps.sendPanelEvent(entry.panelId, "runtime:theme", { theme });
      }
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

  async registerRuntimeClient(): Promise<void> {
    await this.ensureRuntimeClientRegistered();
  }

  async unregisterRuntimeClient(): Promise<void> {
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

  async takeOverPanel(panelId: string): Promise<void> {
    await this.loadPanelIntoView(panelId, "takeOver");
    await this.focusPanel(panelId);
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
    this.registry.repopulate(rootPanels);
    await this.syncRuntimeLeaseSnapshot().catch((error: unknown) => {
      log.warn(
        `[applyServerPanelTreeSnapshot] Failed to sync runtime leases: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    });
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

  async applyRuntimeLeaseChanged(event: PanelRuntimeLeaseChangedEvent): Promise<void> {
    const slotId = event.slotId;
    if (!slotId) return;
    this.registry.applyRuntimeLeaseChanged(event);
    this.eventService.emit("panel:runtimeLeaseChanged", event);
    if (event.next && event.next.clientSessionId !== this.runtimeClientSessionId) {
      await this.unloadPanelIfPresent(slotId, "lease-transfer");
      return;
    }
    if (event.next?.clientSessionId === this.runtimeClientSessionId && this.loadOnLeaseAssignment) {
      const view = this.getPanelView();
      if (view && !view.hasView(slotId)) {
        try {
          const panel = this.registry.getPanel(slotId);
          if (panel) {
            await this.loadAssignedLeaseIntoView(slotId, getCurrentSnapshot(panel), event.next);
            this.trackAssignedPanelResource(slotId);
            await this.enforceAssignedPanelResourceCap(slotId);
          }
        } catch (error) {
          log.warn(
            `[applyRuntimeLeaseChanged] Failed to load assigned panel ${slotId}: ${
              error instanceof Error ? error.message : String(error)
            }`
          );
        }
      } else if (view?.hasView(slotId)) {
        this.trackAssignedPanelResource(slotId);
      }
      return;
    }
    if (!event.next && event.previous?.clientSessionId === this.runtimeClientSessionId) {
      await this.unloadPanelIfPresent(slotId, "lease-transfer");
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
      this.deps.sendPanelEvent(panelId, "runtime:theme", { theme: data["theme"] });
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

  async movePanel(
    panelId: string,
    newParentId: string | null,
    targetPosition: number
  ): Promise<void> {
    await this.shellCore.movePanel(
      asPanelSlotId(panelId),
      newParentId ? asPanelSlotId(newParentId) : null,
      targetPosition
    );
  }

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
      externalHost: this.externalHost,
      protocol: this.deps.protocol,
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
    const contextId = result.contextId ?? (panel ? getPanelContextId(panel) : undefined);
    const source = result.source ?? (panel ? getPanelSource(panel) : undefined);
    const view = this.getPanelView();

    if (opts.browserUrl) {
      if (view?.createViewForBrowser) {
        await this.acquireRuntimeLease(result.panelId, "acquire");
        try {
          await view.createViewForBrowser(
            result.panelId,
            opts.browserUrl,
            assertPresent(contextId)
          );
          this.bumpViewRevision();
        } catch (error) {
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

    const panelUrl = await this.buildPanelLoadUrl(result.panelId);
    if (panelUrl && view) {
      await view.createViewForPanel(result.panelId, panelUrl, assertPresent(contextId));
      this.bumpViewRevision();
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
      externalHost: this.externalHost,
      protocol: this.deps.protocol,
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

    if (snapshot.source.startsWith("browser:")) {
      const url = snapshot.source.slice("browser:".length);
      await this.acquireRuntimeLease(panelId, leaseMode);
      if (view.createViewForBrowser) {
        await view.createViewForBrowser(panelId, url, snapshot.contextId);
        this.bumpViewRevision();
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
      externalHost: this.externalHost,
      protocol: this.deps.protocol,
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
      externalHost: this.externalHost,
      protocol: this.deps.protocol,
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
    await this.panelRuntime.registerClient({
      clientSessionId: this.runtimeClientSessionId,
      hostConnectionId: this.runtimeClientSessionId,
      label: this.runtimeClientLabel,
      platform: this.runtimeClientPlatform,
      supportsCdp: this.runtimeClientSupportsCdp,
      loadOnLeaseAssignment: this.loadOnLeaseAssignment,
    });
    this.runtimeClientRegistered = true;
  }

  private async acquireRuntimeLease(
    panelId: string,
    leaseMode: "acquire" | "takeOver"
  ): Promise<string> {
    await this.ensureRuntimeClientRegistered();
    const runtimeEntityId = await this.shellCore.getCurrentEntityId(asPanelSlotId(panelId));
    const connectionId = `${this.runtimeClientPlatform}-${panelId}-${randomUUID()}`;
    const lease = {
      slotId: panelId,
      clientSessionId: this.runtimeClientSessionId,
      connectionId,
    };
    const result = await (leaseMode === "acquire"
      ? this.panelRuntime.acquire(runtimeEntityId, lease)
      : this.panelRuntime.takeOver(runtimeEntityId, lease));
    if (!result.acquired) {
      throw new Error(
        `Panel ${panelId} is running on ${result.lease?.holderLabel ?? "another client"}`
      );
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

  private trackAssignedPanelResource(panelId: string): void {
    if (!this.loadOnLeaseAssignment) return;
    const previous = this.assignedPanelResources.get(panelId);
    if (previous?.idleTimer) clearTimeout(previous.idleTimer);
    const next: { lastUsedAt: number; idleTimer?: ReturnType<typeof setTimeout> } = {
      lastUsedAt: Date.now(),
    };
    if (this.assignedPanelIdleMs !== null && this.assignedPanelIdleMs > 0) {
      next.idleTimer = setTimeout(() => {
        void this.unloadAssignedPanelResource(panelId, "idle-timeout");
      }, this.assignedPanelIdleMs);
    }
    this.assignedPanelResources.set(panelId, next);
  }

  private clearAssignedPanelResource(panelId: string): void {
    const tracked = this.assignedPanelResources.get(panelId);
    if (tracked?.idleTimer) clearTimeout(tracked.idleTimer);
    this.assignedPanelResources.delete(panelId);
  }

  private async enforceAssignedPanelResourceCap(keepPanelId: string): Promise<void> {
    if (this.maxAssignedPanelViews === null || this.maxAssignedPanelViews <= 0) return;
    while (this.assignedPanelResources.size > this.maxAssignedPanelViews) {
      const oldest = [...this.assignedPanelResources.entries()]
        .filter(([panelId]) => panelId !== keepPanelId)
        .sort((a, b) => a[1].lastUsedAt - b[1].lastUsedAt)[0]?.[0];
      if (!oldest) return;
      await this.unloadAssignedPanelResource(oldest, "resource-cap");
    }
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

function summarizeAxNodes(nodes: unknown[]): string {
  const labels: string[] = [];
  for (const node of nodes.slice(0, 200)) {
    const record = node as {
      role?: { value?: unknown };
      name?: { value?: unknown };
      value?: { value?: unknown };
    };
    const role = typeof record.role?.value === "string" ? record.role.value : "";
    const name = typeof record.name?.value === "string" ? record.name.value : "";
    const value = typeof record.value?.value === "string" ? record.value.value : "";
    const line = [role, name || value].filter(Boolean).join(": ");
    if (line) labels.push(line);
  }
  return labels.join("\n");
}
