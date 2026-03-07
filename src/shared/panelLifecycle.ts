/**
 * PanelLifecycle — Orchestrates multi-step panel creation and destruction.
 *
 * Owns only the workflow coordination:
 * - Panel data lives in PanelRegistry
 * - Electron views go through PanelViewLike (optional, absent in headless)
 * - Token management through TokenManager + ServerInfoLike
 * - FS context registration through FsService
 *
 * Works in both Electron and headless modes. No Electron imports.
 */

import * as path from "path";
import { createDevLogger } from "./devLog.js";
import type {
  Panel,
  PanelManifest,
  PanelSnapshot,
  ShellPage,
  PanelArtifacts,
} from "./types.js";
import type { StateArgsValue } from "./stateArgs.js";
import {
  getCurrentSnapshot,
  getPanelSource,
  getPanelContextId,
  getPanelStateArgs,
  createSnapshot,
} from "./panel/accessors.js";
import { loadPanelManifest } from "./panelTypes.js";
import { validateStateArgs } from "./stateArgsValidator.js";
import { computePanelId } from "./panelIdUtils.js";
import { contextIdToSubdomain } from "./panelIdUtils.js";
import { normalizeRelativePanelPath } from "../main/pathUtils.js";
import type { PanelRegistry } from "./panelRegistry.js";
import type { TokenManager } from "./tokenManager.js";
import type { FsService } from "./fsService.js";
import type { EventService } from "./eventsService.js";
import type { BridgePanelManager } from "./panelManagerInterface.js";

const log = createDevLogger("PanelLifecycle");

// =============================================================================
// Narrow interfaces for optional dependencies
// =============================================================================

/**
 * Server interaction abstraction — works for both Electron (ServerInfo over
 * IPC) and headless (in-process token maps).
 */
export interface ServerInfoLike {
  rpcPort: number;
  gitBaseUrl: string;
  pubsubUrl: string;
  createPanelToken(panelId: string, kind: string): Promise<string> | string;
  ensurePanelToken(panelId: string, kind: string): Promise<string> | string;
  revokePanelToken(panelId: string): Promise<void> | void;
  getPanelToken(panelId: string): Promise<string | null> | string | null;
  getGitTokenForPanel(panelId: string): Promise<string> | string;
  revokeGitToken(panelId: string): Promise<void> | void;
  call?(service: string, method: string, args: unknown[]): Promise<unknown>;
}

/**
 * View management abstraction — Electron ViewManager behind a narrow interface.
 * Absent in headless mode.
 */
export interface PanelViewLike {
  createViewForPanel(panelId: string, url: string, contextId?: string): Promise<void>;
  hasView(panelId: string): boolean;
  destroyView(panelId: string): void;
  reloadView(panelId: string): boolean;
  navigateView(panelId: string, url: string): Promise<void>;
  getWebContents(panelId: string): unknown | null;
  findViewIdByWebContentsId(senderId: number): string | null;
  setProtectedViews(lineage: Set<string>): void;
}

/**
 * HTTP panel server abstraction — optional in both modes.
 */
export interface PanelHttpServerLike {
  ensureSubdomainSession(subdomain: string): string;
  clearSubdomainSessions(subdomain: string): void;
  hasBuild(source: string): boolean;
  invalidateBuild(source: string): void;
  getPort?(): number;
}

// =============================================================================
// Panel creation options
// =============================================================================

export type PanelCreateOptions = {
  name?: string;
  env?: Record<string, string>;
  /**
   * Explicit context ID for storage partition sharing.
   * If provided, the panel will use this context ID instead of generating one.
   */
  contextId?: string;
  /** If true, immediately focus the new panel after creation */
  focus?: boolean;
};

// =============================================================================
// Dependencies
// =============================================================================

export interface PanelLifecycleDeps {
  registry: PanelRegistry;
  tokenManager: TokenManager;
  fsService: FsService | null;
  eventService: EventService;
  panelsRoot: string;

  // Server interaction (works for both Electron and headless)
  serverInfo: ServerInfoLike;

  // Optional Electron-only deps (absent in headless)
  panelView?: PanelViewLike | null;
  cdpServer?: { revokeTokenForPanel(panelId: string): void } | null;
  ccConversationManager?: { endPanelConversations(panelId: string): void } | null;
  panelHttpServer?: PanelHttpServerLike | null;
  panelHttpPort?: number;

  // For sending WS events to panels (stateArgs:updated, panel:event)
  sendToClient?: (callerId: string, msg: unknown) => void;
}

// =============================================================================
// PanelLifecycle
// =============================================================================

export class PanelLifecycle implements BridgePanelManager {
  private readonly registry: PanelRegistry;
  private readonly tokenManager: TokenManager;
  private readonly fsService: FsService | null;
  private readonly eventService: EventService;
  private readonly panelsRoot: string;
  private readonly serverInfo: ServerInfoLike;

  private panelView: PanelViewLike | null;
  private cdpServer: { revokeTokenForPanel(panelId: string): void } | null;
  private ccConversationManager: { endPanelConversations(panelId: string): void } | null;
  private panelHttpServer: PanelHttpServerLike | null;
  private panelHttpPort: number | undefined;
  private sendToClient: ((callerId: string, msg: unknown) => void) | undefined;

  private currentTheme: "light" | "dark" = "dark";

  /** In-flight on-demand creates, keyed by subdomain (prevents duplicate work) */
  private onDemandInFlight = new Map<string, Promise<string>>();

  constructor(deps: PanelLifecycleDeps) {
    this.registry = deps.registry;
    this.tokenManager = deps.tokenManager;
    this.fsService = deps.fsService;
    this.eventService = deps.eventService;
    this.panelsRoot = deps.panelsRoot;
    this.serverInfo = deps.serverInfo;
    this.panelView = deps.panelView ?? null;
    this.cdpServer = deps.cdpServer ?? null;
    this.ccConversationManager = deps.ccConversationManager ?? null;
    this.panelHttpServer = deps.panelHttpServer ?? null;
    this.panelHttpPort = deps.panelHttpPort;
    this.sendToClient = deps.sendToClient;
  }

  // =========================================================================
  // Setters for late-bound dependencies
  // =========================================================================

  setPanelView(view: PanelViewLike): void {
    this.panelView = view;
  }

  setSendToClient(fn: (callerId: string, msg: unknown) => void): void {
    this.sendToClient = fn;
  }

  setPanelHttpServer(server: PanelHttpServerLike, port: number): void {
    this.panelHttpServer = server;
    this.panelHttpPort = port;
  }

  // =========================================================================
  // Panel creation — public API
  // =========================================================================

  /**
   * Create a child panel under the caller.
   * Source can be a workspace-relative path or an "about/{page}" shell page.
   */
  async createPanel(
    callerId: string,
    source: string,
    options?: PanelCreateOptions,
    stateArgs?: Record<string, unknown>,
  ): Promise<{ id: string; title: string }> {
    const caller = this.registry.getPanel(callerId);
    if (!caller) {
      throw new Error(`Caller panel not found: ${callerId}`);
    }

    const parent: Panel = caller;

    // Shell pages (about/*) use minimal manifests
    if (source.startsWith("about/")) {
      const page = source.slice(6);
      const manifest: PanelManifest = { title: page };
      return this.createPanelFromManifest({
        manifest,
        relativePath: source,
        parent,
        options: options ?? {},
        stateArgs,
      });
    }

    const { relativePath, absolutePath } = normalizeRelativePanelPath(source, this.panelsRoot);

    let manifest: PanelManifest;
    try {
      manifest = loadPanelManifest(absolutePath);
    } catch (error) {
      if (options?.contextId) {
        // Programmatic launch: workspace dir may not have files yet
        manifest = { title: path.basename(relativePath) };
      } else {
        throw new Error(
          `Failed to load manifest for ${source}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    return this.createPanelFromManifest({
      manifest,
      relativePath,
      parent,
      options: options ?? {},
      stateArgs,
    });
  }

  /**
   * Create a shell panel for system pages (about/new, about/about, etc.).
   * Most pages are singletons; "new" supports multiple instances.
   */
  async createAboutPanel(page: ShellPage): Promise<{ id: string; title: string }> {
    const isMultiInstance = page === "new";

    if (!isMultiInstance) {
      const panelId = `about/${page}`;
      const existing = this.registry.getPanel(panelId);
      if (existing) {
        this.focusPanel(existing.id);
        return { id: existing.id, title: existing.title };
      }
    }

    const source = `about/${page}`;
    const manifest: PanelManifest = { title: page };
    const name = isMultiInstance ? `about/${page}~${Date.now().toString(36)}` : undefined;

    return this.createPanelFromManifest({
      manifest,
      relativePath: source,
      parent: null,
      options: { name, focus: true },
      isRoot: true,
      addAsRoot: true,
    });
  }

  /**
   * Create an initialization panel as a root panel.
   * Used for workspace config's initPanels array on first startup.
   */
  async createInitPanel(source: string): Promise<{ id: string; title: string }> {
    const { relativePath, absolutePath } = normalizeRelativePanelPath(source, this.panelsRoot);

    let manifest: PanelManifest;
    try {
      manifest = loadPanelManifest(absolutePath);
    } catch (error) {
      throw new Error(
        `Failed to load manifest for init panel ${source}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    return this.createPanelFromManifest({
      manifest,
      relativePath,
      parent: null,
      options: {},
      isRoot: true,
      addAsRoot: true,
    });
  }

  /**
   * Create a panel on-demand when a browser visits a registered subdomain.
   * Idempotent: returns existing panel data if one already exists.
   * Concurrent calls for the same subdomain are coalesced.
   */
  async createPanelOnDemand(source: string, subdomain: string): Promise<string> {
    // Already running on this subdomain?
    const panels = this.registry.listPanels();
    for (const p of panels) {
      if (p.source === source && contextIdToSubdomain(p.contextId) === subdomain) {
        return p.panelId;
      }
    }

    // Already being created? (coalescing for concurrent requests)
    const inFlight = this.onDemandInFlight.get(subdomain);
    if (inFlight) {
      return inFlight;
    }

    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`On-demand panel creation timed out for ${subdomain}`)),
        60_000,
      );
    });

    const promise = Promise.race([
      this.createOnDemandInternal(source, subdomain),
      timeout,
    ])
      .then((id) => {
        clearTimeout(timer!);
        this.onDemandInFlight.delete(subdomain);
        return id;
      })
      .catch((err) => {
        clearTimeout(timer!);
        this.onDemandInFlight.delete(subdomain);
        throw err;
      });

    this.onDemandInFlight.set(subdomain, promise);
    return promise;
  }

  private async createOnDemandInternal(source: string, subdomain: string): Promise<string> {
    const { relativePath, absolutePath } = normalizeRelativePanelPath(source, this.panelsRoot);
    const manifest = loadPanelManifest(absolutePath);

    const result = await this.createPanelFromManifest({
      manifest,
      relativePath,
      parent: null,
      options: { contextId: subdomain },
      isRoot: true,
      addAsRoot: true,
    });

    return result.id;
  }

  // =========================================================================
  // Core creation logic
  // =========================================================================

  /**
   * Shared creation path for root and child panels.
   * Handles: stateArgs validation, ID computation, context resolution,
   * token creation, env building, registry addition, view creation.
   */
  private async createPanelFromManifest(params: {
    manifest: PanelManifest;
    relativePath: string;
    parent: Panel | null;
    options: PanelCreateOptions;
    isRoot?: boolean;
    addAsRoot?: boolean;
    stateArgs?: Record<string, unknown>;
  }): Promise<{ id: string; title: string }> {
    const { manifest, relativePath, parent, options, isRoot, addAsRoot, stateArgs } = params;

    // Validate stateArgs against manifest schema (applies defaults)
    let validatedStateArgs: StateArgsValue | undefined;
    if (stateArgs || manifest.stateArgs) {
      const validation = validateStateArgs(stateArgs ?? {}, manifest.stateArgs);
      if (!validation.success) {
        throw new Error(`Invalid stateArgs for ${relativePath}: ${validation.error}`);
      }
      validatedStateArgs = validation.data;
    }

    const panelId = computePanelId({
      relativePath,
      parent: parent ? { id: parent.id } : null,
      requestedId: options?.name,
      isRoot,
    });

    if (!this.registry.reservePanelId(panelId)) {
      throw new Error(`A panel with id "${panelId}" is already running`);
    }

    // Create auth tokens
    this.tokenManager.createToken(panelId, "panel");

    try {
      await this.serverInfo.createPanelToken(panelId, "panel");

      // Resolve context ID
      const contextId =
        options.contextId ??
        `ctx-${panelId
          .replace(/[^a-z0-9]/gi, "-")
          .replace(/-+/g, "-")
          .replace(/^-|-$/g, "")
          .toLowerCase()
          .slice(0, 59)}`;

      // Register panel -> context mapping for FS routing
      this.fsService?.registerPanelContext(panelId, contextId);

      const panelEnv = await this.buildPanelEnv(panelId, options?.env, {
        sourceRepo: relativePath,
      });

      const initialSnapshot = createSnapshot(
        relativePath,
        contextId,
        { env: panelEnv },
        validatedStateArgs,
      );

      const panel: Panel = {
        id: panelId,
        title: manifest.title,
        children: [],
        selectedChildId: null,
        snapshot: initialSnapshot,
        artifacts: {
          buildState: "building",
          buildProgress: "Starting build...",
        },
      };

      // Add to registry (handles tree placement and persistence)
      if (isRoot) {
        this.registry.addPanel(panel, null, { addAsRoot: addAsRoot ?? false });
      } else {
        this.registry.addPanel(panel, parent?.id ?? null);
      }

      // Focus if requested
      if (options?.focus) {
        this.focusPanel(panel.id);
      }

      // Create view if PanelView is available (Electron mode)
      const panelUrl = this.getPanelUrl(panel.id);
      if (panelUrl && this.panelView) {
        await this.panelView.createViewForPanel(panel.id, panelUrl, contextId);
      }

      // Update build state based on cache
      const buildCached = this.panelHttpServer?.hasBuild(relativePath) ?? false;
      this.registry.updateArtifacts(panelId, {
        htmlPath: panelUrl ?? undefined,
        buildState: buildCached ? "ready" : "building",
        buildProgress: buildCached ? undefined : "Waiting for build...",
      });
      this.registry.notifyPanelTreeUpdate();

      return { id: panel.id, title: panel.title };
    } catch (err) {
      // Rollback on failure
      this.tokenManager.revokeToken(panelId);
      void this.serverInfo.revokePanelToken(panelId);
      this.fsService?.unregisterPanelContext(panelId);
      throw err;
    } finally {
      this.registry.releasePanelId(panelId);
    }
  }

  // =========================================================================
  // Panel destruction
  // =========================================================================

  /**
   * Close a panel and remove it from the tree.
   * Children are closed recursively first.
   */
  async closePanel(panelId: string): Promise<void> {
    const panel = this.registry.getPanel(panelId);
    if (!panel) {
      throw new Error(`Panel not found: ${panelId}`);
    }

    // Close children first (copy to avoid mutation during iteration)
    const childrenToClose = [...panel.children];
    for (const child of childrenToClose) {
      await this.closePanel(child.id);
    }

    // Release resources (tokens, FS, CDP, CC, subdomain, view)
    this.unloadPanelResources(panelId);

    // Unregister FS context mapping (permanent removal)
    this.fsService?.unregisterPanelContext(panelId);

    // Destroy view
    this.panelView?.destroyView(panelId);

    // Remove from registry and archive in DB
    this.registry.removePanel(panelId);
    this.registry.archivePanel(panelId);
  }

  /**
   * Unload a panel and its descendants: release resources but keep in tree.
   * The panel stays in the database and rebuilds when focused.
   */
  async unloadPanel(panelId: string): Promise<void> {
    const panel = this.registry.getPanel(panelId);
    if (!panel) {
      throw new Error(`Panel not found: ${panelId}`);
    }

    this.unloadPanelTree(panelId);
    this.registry.notifyPanelTreeUpdate();
  }

  /**
   * Recursively unload a panel tree — releases resources and resets artifacts.
   */
  private unloadPanelTree(panelId: string): void {
    const panel = this.registry.getPanel(panelId);
    if (!panel) return;

    // Recursively unload children first
    for (const child of panel.children) {
      this.unloadPanelTree(child.id);
    }

    this.unloadPanelResources(panelId);

    // Skip if already pending without build artifacts
    const hasBuildArtifacts = Boolean(panel.artifacts?.htmlPath || panel.artifacts?.bundlePath);
    if (panel.artifacts?.buildState === "pending" && !hasBuildArtifacts) {
      return;
    }

    this.registry.updateArtifacts(panelId, {
      buildState: "pending",
      buildProgress: "Panel unloaded - will rebuild when focused",
    });
  }

  /**
   * Release panel resources without removing from tree.
   * Handles: tokens, FS handles, CDP, CC conversations, subdomain sessions, view.
   */
  private unloadPanelResources(panelId: string): void {
    const panel = this.registry.getPanel(panelId);
    if (!panel) return;

    // Close open file handles
    this.fsService?.closeHandlesForPanel(panelId);

    // Revoke local auth token
    this.tokenManager.revokeToken(panelId);

    // Revoke server-side tokens (fire-and-forget)
    void this.serverInfo.revokePanelToken(panelId);
    void this.serverInfo.revokeGitToken(panelId);

    // CDP cleanup
    this.cdpServer?.revokeTokenForPanel(panelId);

    // Claude Code conversation cleanup
    this.ccConversationManager?.endPanelConversations(panelId);

    // Clear subdomain sessions if no panels remain on this subdomain
    if (this.panelHttpServer) {
      const contextId = getPanelContextId(panel);
      const subdomain = contextIdToSubdomain(contextId);
      const allPanels = this.registry.listPanels();
      const remainingOnSubdomain = allPanels.some(
        (p) => p.panelId !== panelId && contextIdToSubdomain(p.contextId) === subdomain,
      );
      if (!remainingOnSubdomain) {
        this.panelHttpServer.clearSubdomainSessions(subdomain);
      }
    }

    // Destroy view (but keep panel in tree)
    if (this.panelView?.hasView(panelId)) {
      this.panelView.destroyView(panelId);
    }
  }

  // =========================================================================
  // Build lifecycle
  // =========================================================================

  /**
   * Reload a panel: if view exists, reload it; otherwise rebuild.
   */
  async reloadPanel(panelId: string): Promise<void> {
    if (this.panelView?.hasView(panelId)) {
      this.panelView.reloadView(panelId);
    } else {
      await this.rebuildUnloadedPanel(panelId);
    }
  }

  /**
   * Rebuild a panel that was previously unloaded (pending state).
   * Ensures auth tokens exist and triggers build via HTTP server.
   */
  async rebuildUnloadedPanel(panelId: string): Promise<void> {
    const panel = this.registry.getPanel(panelId);
    if (!panel) {
      throw new Error(`Panel not found: ${panelId}`);
    }

    if (panel.artifacts?.buildState !== "pending") {
      return;
    }

    // Ensure auth tokens exist (they don't persist across restarts)
    this.tokenManager.ensureToken(panelId, "panel");
    await this.serverInfo.ensurePanelToken(panelId, "panel");

    // Set building state
    this.registry.updateArtifacts(panelId, {
      buildState: "building",
      buildProgress: "Rebuilding panel...",
    });
    this.registry.notifyPanelTreeUpdate();

    // Invalidate cached build and create/refresh view
    const source = getPanelSource(panel);
    this.panelHttpServer?.invalidateBuild(source);

    const panelUrl = this.getPanelUrl(panelId);
    if (panelUrl && this.panelView) {
      await this.panelView.createViewForPanel(panelId, panelUrl, getPanelContextId(panel));
    }
  }

  /**
   * Invalidate all ready/error panels: reset to pending and unload resources.
   * Called when build cache is cleared.
   */
  invalidateReadyPanels(): void {
    const focusedPanelId = this.registry.getFocusedPanelId();
    let focusedWasReset = false;

    const allPanels = this.registry.listPanels();
    for (const entry of allPanels) {
      const panel = this.registry.getPanel(entry.panelId);
      if (!panel) continue;

      const buildState = panel.artifacts?.buildState;
      if (buildState === "ready" || buildState === "error") {
        const source = getPanelSource(panel);
        this.panelHttpServer?.invalidateBuild(source);
        this.unloadPanelResources(entry.panelId);
        this.registry.updateArtifacts(entry.panelId, {
          buildState: "pending",
          buildProgress: "Build cache cleared - will rebuild when focused",
        });
        if (entry.panelId === focusedPanelId) focusedWasReset = true;
      }
    }

    this.registry.notifyPanelTreeUpdate();

    if (focusedWasReset && focusedPanelId) {
      void this.rebuildUnloadedPanel(focusedPanelId);
    }
  }

  /**
   * Retry a build for a panel blocked by dirty worktree.
   */
  async retryBuild(panelId: string): Promise<void> {
    await this.rebuildUnloadedPanel(panelId);
  }

  /**
   * Initialize git repo and rebuild panel.
   */
  async initializeGitRepo(panelId: string): Promise<void> {
    await this.rebuildUnloadedPanel(panelId);
  }

  // =========================================================================
  // Bootstrap config
  // =========================================================================

  /**
   * Return bootstrap config for a panel, delivered via RPC.
   * Works in both Electron and headless modes.
   */
  async getBootstrapConfig(callerId: string): Promise<unknown> {
    const panel = this.registry.getPanel(callerId);
    if (!panel) throw new Error(`Panel not found: ${callerId}`);

    const contextId = getPanelContextId(panel);
    const subdomain = contextIdToSubdomain(contextId);
    const parentId = this.registry.findParentId(panel.id);
    const rpcToken = this.tokenManager.ensureToken(panel.id, "panel");
    const gitToken = await this.serverInfo.getGitTokenForPanel(panel.id);
    const snapshot = getCurrentSnapshot(panel);
    const env = snapshot.options.env ?? {};
    const stateArgs = getPanelStateArgs(panel) ?? {};
    const pubsubPort = parseInt(new URL(this.serverInfo.pubsubUrl).port, 10);

    const serverRpcToken =
      (await this.serverInfo.getPanelToken(panel.id)) ??
      (await this.serverInfo.ensurePanelToken(panel.id, "panel"));

    const gitConfig = {
      serverUrl: this.serverInfo.gitBaseUrl,
      token: gitToken,
      sourceRepo: getPanelSource(panel),
    };
    const pubsubConfig = {
      serverUrl: `ws://${subdomain}.localhost:${pubsubPort}`,
      token: serverRpcToken,
    };

    return {
      panelId: panel.id,
      contextId,
      parentId,
      theme: this.currentTheme,
      rpcPort: this.serverInfo.rpcPort,
      rpcToken,
      serverRpcPort: this.serverInfo.rpcPort,
      serverRpcToken,
      gitConfig,
      pubsubConfig,
      env: {
        ...env,
        PARENT_ID: parentId ?? "",
        __GIT_CONFIG: JSON.stringify(gitConfig),
        __PUBSUB_CONFIG: JSON.stringify(pubsubConfig),
      },
      stateArgs,
    };
  }

  // =========================================================================
  // State mutation
  // =========================================================================

  /**
   * Update state args for a panel.
   * Validates merged args against manifest schema, persists, and broadcasts.
   */
  async handleSetStateArgs(
    panelId: string,
    updates: Record<string, unknown>,
  ): Promise<unknown> {
    const panel = this.registry.getPanel(panelId);
    if (!panel) throw new Error(`Panel not found: ${panelId}`);

    // Load manifest for schema validation
    const panelSource = getPanelSource(panel);
    let schema;
    try {
      const absolutePath = path.resolve(this.panelsRoot, panelSource);
      const manifest = loadPanelManifest(absolutePath);
      schema = manifest.stateArgs;
    } catch {
      // If manifest can't be loaded (dynamic source), skip validation
    }

    const currentArgs = getPanelStateArgs(panel) ?? {};
    const merged = { ...currentArgs, ...updates };

    const validation = validateStateArgs(merged, schema);
    if (!validation.success) {
      throw new Error(`Invalid stateArgs: ${validation.error}`);
    }

    // Update in registry (handles persistence)
    this.registry.updateStateArgs(panelId, validation.data! as Record<string, unknown>);

    // Broadcast to panel for reactive update (no reload needed)
    if (this.sendToClient) {
      this.sendToClient(panelId, {
        type: "ws:event",
        event: "stateArgs:updated",
        payload: validation.data,
      });
    }

    return validation.data;
  }

  // =========================================================================
  // Focus
  // =========================================================================

  /**
   * Focus a panel: update selected path, emit events.
   */
  focusPanel(targetPanelId: string): void {
    const panel = this.registry.getPanel(targetPanelId);
    if (!panel) {
      log.warn(`Cannot focus panel - not found: ${targetPanelId}`);
      return;
    }

    this.registry.updateSelectedPath(targetPanelId);
    this.registry.notifyPanelTreeUpdate();

    // Emit focus event to the panel only if it has a view
    if (this.panelView?.hasView(targetPanelId)) {
      this.sendPanelEvent(targetPanelId, { type: "focus" });
    }

    // Notify shell to navigate to this panel
    this.eventService.emit("navigate-to-panel", { panelId: targetPanelId });
  }

  // =========================================================================
  // Tree initialization (Electron mode)
  // =========================================================================

  /**
   * Initialize the panel tree: load from DB, create views, run init panels.
   * In headless mode, this is effectively a no-op since there's no persistence.
   */
  async initializePanelTree(): Promise<void> {
    // Load tree from registry's persistence layer
    await this.registry.loadTree();

    const roots = this.registry.getRootPanels();
    if (roots.length > 0) {
      // Register FS context mappings for restored panels
      if (this.fsService) {
        const allPanels = this.registry.listPanels();
        for (const entry of allPanels) {
          const panel = this.registry.getPanel(entry.panelId);
          if (panel) {
            const ctxId = getPanelContextId(panel);
            if (ctxId) {
              this.fsService.registerPanelContext(panel.id, ctxId);
            }
          }
        }
      }

      // Mark restored panels as unloaded (they rebuild on focus)
      for (const entry of this.registry.listPanels()) {
        const panel = this.registry.getPanel(entry.panelId);
        if (panel) {
          const hasBuildArtifacts = Boolean(
            panel.artifacts?.htmlPath || panel.artifacts?.bundlePath,
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
    }
    // If no panels loaded, the caller (e.g. Electron main) can decide
    // whether to create init panels or a launcher.
  }

  // =========================================================================
  // Theme
  // =========================================================================

  setCurrentTheme(theme: "light" | "dark"): void {
    this.currentTheme = theme;
    this.registry.setCurrentTheme(theme);
  }

  broadcastTheme(theme: "light" | "dark"): void {
    const allPanels = this.registry.listPanels();
    for (const entry of allPanels) {
      if (this.panelView?.hasView(entry.panelId)) {
        this.sendPanelEvent(entry.panelId, { type: "theme", theme });
      }
    }
  }

  // =========================================================================
  // Queries (delegate to registry)
  // =========================================================================

  getInfo(panelId: string): unknown {
    return this.registry.getInfo(panelId);
  }

  listPanels() {
    return this.registry.listPanels();
  }

  // =========================================================================
  // WS event helpers
  // =========================================================================

  sendPanelEvent(panelId: string, payload: unknown): void {
    if (!this.sendToClient) return;
    this.sendToClient(panelId, {
      type: "ws:event",
      event: "panel:event",
      payload: { panelId, ...payload as Record<string, unknown> },
    });
  }

  // =========================================================================
  // URL helpers
  // =========================================================================

  /**
   * Compute the HTTP URL for a panel.
   */
  getPanelUrl(panelId: string): string | null {
    const panel = this.registry.getPanel(panelId);
    if (!panel) return null;

    const port = this.panelHttpPort ?? (this.panelHttpServer as any)?.getPort?.();
    if (!port) return null;

    const subdomain = contextIdToSubdomain(getPanelContextId(panel));
    const source = getPanelSource(panel);
    return `http://${subdomain}.localhost:${port}/${source}/`;
  }

  // =========================================================================
  // Private helpers
  // =========================================================================

  /**
   * Build env for a panel, merging base env with system env.
   */
  private async buildPanelEnv(
    panelId: string,
    baseEnv: Record<string, string> | null | undefined,
    gitInfo?: { sourceRepo: string },
  ): Promise<Record<string, string> | undefined> {
    const gitToken = await this.serverInfo.getGitTokenForPanel(panelId);
    const serverUrl = this.serverInfo.gitBaseUrl;

    const gitConfig = gitInfo
      ? JSON.stringify({
          serverUrl,
          token: gitToken,
          sourceRepo: gitInfo.sourceRepo,
        })
      : "";

    const serverToken = await this.serverInfo.getPanelToken(panelId);
    const pubsubConfig = this.serverInfo.pubsubUrl
      ? JSON.stringify({
          serverUrl: this.serverInfo.pubsubUrl,
          token: serverToken,
        })
      : "";

    // Pass critical environment variables that Node.js APIs depend on
    const criticalEnv: Record<string, string> = {};
    for (const key of [
      "HOME",
      "USER",
      "PATH",
      "TMPDIR",
      "TEMP",
      "TMP",
      "SHELL",
      "XDG_CONFIG_HOME",
      "XDG_DATA_HOME",
      "XDG_CACHE_HOME",
      "XDG_STATE_HOME",
      "XDG_RUNTIME_DIR",
    ]) {
      if (process.env[key]) {
        criticalEnv[key] = process.env[key]!;
      }
    }

    return {
      ...criticalEnv,
      ...baseEnv,
      __GIT_SERVER_URL: serverUrl,
      __GIT_TOKEN: gitToken,
      __GIT_CONFIG: gitConfig,
      __PUBSUB_CONFIG: pubsubConfig,
    };
  }
}
