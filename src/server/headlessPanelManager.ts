/**
 * HeadlessPanelManager — Panel lifecycle management without Electron rendering.
 *
 * Manages panels (create, close, state args) using the same ID generation and
 * context resolution as the Electron PanelManager, but without creating
 * WebContentsView instances. Panels are flat (no parent/child tree). They are
 * registered in the PanelHttpServer, which handles build-on-demand and serving.
 *
 * Subdomain = contextIdToSubdomain(contextId). Panels sharing a contextId get
 * the same subdomain (= shared browser origin = shared localStorage, IndexedDB,
 * cookies, service workers). URL path = source (e.g., panels/my-app).
 *
 * All panels are type "app". Workers/agents are NOT panels; they
 * are managed separately by AgentHost with callerKind: "server" tokens.
 *
 * Persistence: The panel tree is in-memory only (v1). This is acceptable
 * because panels are cheap to recreate (build cache ensures fast rebuilds)
 * and browser clients reconnect on reload. SQLite persistence can be added
 * later using the same schema as src/main/db/panelPersistence.ts.
 */

import type { ChildCreationResult, CreateChildOptions } from "../shared/types.js";
import type { PanelHttpServer } from "./panelHttpServer.js";
import { contextIdToSubdomain } from "./panelHttpServer.js";
import type { WsServerMessage } from "../shared/ws/protocol.js";
import { computePanelId } from "../shared/panelIdUtils.js";
import { loadPanelManifest } from "../main/panelTypes.js";
import { validateStateArgs } from "../main/stateArgsValidator.js";
import { createDevLogger } from "../main/devLog.js";

const log = createDevLogger("HeadlessPanelManager");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface HeadlessPanel {
  id: string;
  parentId: string | null;
  source: string;
  contextId: string;
  /** Short DNS-safe label used as the *.localhost subdomain */
  subdomain: string;
  title: string;
  stateArgs: Record<string, unknown>;
  env: Record<string, string>;
  /** RPC auth token for this panel */
  rpcToken: string | null;
  /** Build state */
  buildState: "pending" | "building" | "built" | "failed";
  buildError?: string;
  createdAt: number;
}

export interface HeadlessPanelTree {
  panels: Array<{
    id: string;
    parentId: string | null;
    source: string;
    title: string;
    subdomain: string;
    buildState: string;
  }>;
  roots: string[];
}

interface CreatePanelDeps {
  /** Create an RPC auth token for a panel */
  createToken: (callerId: string, kind: "panel") => string;
  /** Revoke an RPC auth token */
  revokeToken: (callerId: string) => void;
  /** HTTP panel server (if panel serving is enabled) */
  panelHttpServer: PanelHttpServer | null;
  /** RPC server port for transport config */
  rpcPort: number;
  /** Git server base URL */
  gitBaseUrl: string;
  /** Get a git token scoped to a panel */
  getGitTokenForPanel: (panelId: string) => string;
  /** Revoke a git token when a panel is closed */
  revokeGitToken?: (panelId: string) => void;
  /** PubSub server port */
  pubsubPort: number;
  /** Send a WS event to a connected panel (for reactive updates) */
  sendToClient?: (callerId: string, msg: WsServerMessage) => void;
}

// ---------------------------------------------------------------------------
// HeadlessPanelManager
// ---------------------------------------------------------------------------

export class HeadlessPanelManager {
  private panels = new Map<string, HeadlessPanel>();
  private deps: CreatePanelDeps;
  private fsService: import("../main/fsService.js").FsService | null = null;
  private currentTheme: "light" | "dark" = "dark";

  constructor(deps: CreatePanelDeps) {
    this.deps = deps;
    // Build and panel callbacks are wired via panelHttpServer.setCallbacks() in index.ts.
  }

  setFsService(service: import("../main/fsService.js").FsService): void {
    this.fsService = service;
  }

  setCurrentTheme(theme: "light" | "dark"): void {
    this.currentTheme = theme;
    // Theme changes are picked up via getBootstrapConfig RPC on next load.
    // No per-panel HTTP server state to update.
  }

  // =========================================================================
  // On-demand panel creation (browser-driven)
  // =========================================================================

  /** In-flight on-demand creates, keyed by subdomain (prevents duplicate work) */
  private onDemandInFlight = new Map<string, Promise<string>>();

  /**
   * Create a panel on-demand when a browser visits a registered subdomain.
   *
   * Idempotent: if a panel already exists on this subdomain, returns its data.
   * Concurrent calls for the same subdomain are coalesced into a single create.
   *
   * @param source  Workspace-relative panel source path (e.g., "panels/chat")
   * @param subdomain  The deterministic subdomain from the source registry
   * @returns Bootstrap credentials for the panel
   */
  async createPanelOnDemand(source: string, subdomain: string): Promise<{
    panelId: string;
    rpcPort: number;
    rpcToken: string;
    serverRpcPort: number;
    serverRpcToken: string;
  }> {
    // Already running on this subdomain?
    for (const panel of this.panels.values()) {
      if (panel.subdomain === subdomain) {
        return { panelId: panel.id, rpcPort: this.deps.rpcPort, rpcToken: panel.rpcToken!, serverRpcPort: this.deps.rpcPort, serverRpcToken: panel.rpcToken! };
      }
    }

    // Already being created?
    const inFlight = this.onDemandInFlight.get(subdomain);
    if (inFlight) {
      const id = await inFlight;
      const panel = this.panels.get(id);
      return { panelId: id, rpcPort: this.deps.rpcPort, rpcToken: panel?.rpcToken ?? "", serverRpcPort: this.deps.rpcPort, serverRpcToken: panel?.rpcToken ?? "" };
    }

    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`On-demand panel creation timed out for ${subdomain}`)), 60_000);
    });

    const promise = Promise.race([
      this.createPanel("server", source, {}, undefined, subdomain).then((result) => result.id),
      timeout,
    ])
      .then((id) => {
        clearTimeout(timer);
        this.onDemandInFlight.delete(subdomain);
        return id;
      })
      .catch((err) => {
        clearTimeout(timer);
        this.onDemandInFlight.delete(subdomain);
        throw err;
      });

    this.onDemandInFlight.set(subdomain, promise);
    const id = await promise;
    const panel = this.panels.get(id);
    return { panelId: id, rpcPort: this.deps.rpcPort, rpcToken: panel?.rpcToken ?? "", serverRpcPort: this.deps.rpcPort, serverRpcToken: panel?.rpcToken ?? "" };
  }

  // =========================================================================
  // Panel creation
  // =========================================================================

  async createPanel(
    callerId: string,
    source: string,
    options?: CreateChildOptions,
    stateArgs?: Record<string, unknown>,
    /** Use this subdomain instead of deriving from contextId (for on-demand creation) */
    subdomainOverride?: string,
  ): Promise<ChildCreationResult> {
    // Guard: reject URL sources early — browser panels are not supported in headless mode.
    if (/^https?:\/\//i.test(source)) {
      throw new Error(
        `Browser panels are not supported in headless mode (source: "${source}"). ` +
        "Use the Electron app for web browsing panels."
      );
    }

    // Generate panel ID using the shared utility (same scheme as PanelManager)
    const panelId = computePanelId({
      relativePath: source,
      requestedId: options?.name,
      isRoot: true,
    });

    if (this.panels.has(panelId)) {
      throw new Error(`A panel with id "${panelId}" is already running`);
    }

    // ── Context resolution ──
    let contextId: string;
    if (options?.contextId) {
      contextId = options.contextId;
    } else {
      contextId = `ctx-${panelId.replace(/[^a-z0-9]/gi, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").toLowerCase().slice(0, 59)}`;
    }

    // Register panel→context mapping for fs service routing
    this.fsService?.registerPanelContext(panelId, contextId);

    let rpcToken: string | null = null;
    try {
      // ── Subdomain assignment ──
      // Derive from contextId (deterministic). On-demand creation provides override.
      const subdomain = subdomainOverride ?? contextIdToSubdomain(contextId);

      // Create RPC token for this panel
      rpcToken = this.deps.createToken(panelId, "panel");

      // ── StateArgs validation + defaults ──
      let validatedStateArgs: Record<string, unknown> = stateArgs ?? {};
      let manifest;
      try {
        manifest = loadPanelManifest(source);
      } catch {
        // Manifest not loadable (dynamic source) — skip validation
      }
      if (manifest && (stateArgs || manifest.stateArgs)) {
        const validation = validateStateArgs(stateArgs ?? {}, manifest.stateArgs);
        if (!validation.success) {
          throw new Error(`Invalid stateArgs for ${source}: ${validation.error}`);
        }
        validatedStateArgs = validation.data!;
      }

      const panel: HeadlessPanel = {
        id: panelId,
        parentId: null,
        source,
        contextId,
        subdomain,
        title: source.split("/").pop() ?? source,
        stateArgs: validatedStateArgs,
        env: options?.env ?? {},
        rpcToken,
        buildState: "pending",
        createdAt: Date.now(),
      };

      this.panels.set(panelId, panel);

      log.info(`[Panel] Created: ${panelId} (${subdomain}.localhost/${source}, ctx=${contextId})`);

      // Update build state once HTTP server has the build cached
      // (the HTTP server triggers the build on-demand when a request arrives)
      panel.buildState = "built";

      return { id: panelId };
    } catch (err) {
      // Rollback: unregister context mapping, revoke token on failure
      this.fsService?.unregisterPanelContext(panelId);
      if (rpcToken) {
        this.deps.revokeToken(panelId);
      }
      throw err;
    }
  }

  // =========================================================================
  // Panel closing
  // =========================================================================

  closePanel(panelId: string): void {
    const panel = this.panels.get(panelId);
    if (!panel) return;

    // Close open file handles and unregister panel→context mapping
    this.fsService?.closeHandlesForPanel(panelId);
    this.fsService?.unregisterPanelContext(panelId);

    // Revoke tokens (RPC + git)
    if (panel.rpcToken) {
      this.deps.revokeToken(panelId);
    }
    this.deps.revokeGitToken?.(panelId);

    // Clear subdomain sessions if no panels remain on this subdomain
    if (this.deps.panelHttpServer) {
      const remainingOnSubdomain = [...this.panels.values()].some(
        p => p.id !== panelId && p.subdomain === panel.subdomain,
      );
      if (!remainingOnSubdomain) {
        this.deps.panelHttpServer.clearSubdomainSessions(panel.subdomain);
      }
    }

    this.panels.delete(panelId);
    log.info(`[Panel] Closed: ${panelId}`);
  }

  // =========================================================================
  // Panel queries
  // =========================================================================

  getPanel(panelId: string): HeadlessPanel | undefined {
    return this.panels.get(panelId);
  }

  getInfo(panelId: string): { panelId: string; partition: string; contextId: string } {
    const panel = this.panels.get(panelId);
    if (!panel) throw new Error(`Panel not found: ${panelId}`);
    return {
      panelId: panel.id,
      partition: panel.contextId,
      contextId: panel.contextId,
    };
  }

  /** No child management — always returns null. Kept for PanelManagerLike interface. */
  findParentId(_childId: string): string | null {
    return null;
  }

  /** No child management — always returns false. Kept for PanelManagerLike interface. */
  isDescendantOf(_childId: string, _ancestorId: string): boolean {
    return false;
  }

  getSerializablePanelTree(): HeadlessPanelTree {
    const panels: HeadlessPanelTree["panels"] = [];
    const roots: string[] = [];

    for (const [id, panel] of this.panels) {
      panels.push({
        id,
        parentId: null,
        source: panel.source,
        title: panel.title,
        subdomain: panel.subdomain,
        buildState: panel.buildState,
      });
      roots.push(id);
    }

    return { panels, roots };
  }

  /**
   * Find a panel by its context ID.
   * Used by context transfer API to locate panels for snapshot operations.
   */
  findPanelByContextId(contextId: string): HeadlessPanel | undefined {
    for (const panel of this.panels.values()) {
      if (panel.contextId === contextId) return panel;
    }
    return undefined;
  }

  /** No child management — always returns false. */
  canAccessPanel(_requestingPanelId: string, _targetPanelId: string): boolean {
    return false;
  }

  /** No child management — always returns false. */
  panelOwnsBrowser(_requestingPanelId: string, _targetPanelId: string): boolean {
    return false;
  }

  // =========================================================================
  // State args
  // =========================================================================

  async handleSetStateArgs(panelId: string, updates: Record<string, unknown>): Promise<Record<string, unknown>> {
    const panel = this.panels.get(panelId);
    if (!panel) throw new Error(`Panel not found: ${panelId}`);

    // Load manifest to get stateArgs schema (matches Electron behavior)
    let schema;
    try {
      const manifest = loadPanelManifest(panel.source);
      schema = manifest.stateArgs;
    } catch {
      // If manifest can't be loaded (e.g. dynamic source), skip validation
    }

    const merged = { ...panel.stateArgs, ...updates };

    // Validate merged args against schema
    const validation = validateStateArgs(merged, schema);
    if (!validation.success) {
      throw new Error(`Invalid stateArgs: ${validation.error}`);
    }

    panel.stateArgs = validation.data!;

    // StateArgs changes are picked up via getBootstrapConfig RPC on next load.
    // No per-panel HTTP server state to update.

    // Broadcast to panel for reactive update (mirrors Electron's sendToClient)
    if (this.deps.sendToClient) {
      this.deps.sendToClient(panelId, {
        type: "ws:event",
        event: "stateArgs:updated",
        payload: validation.data,
      });
    }

    return validation.data!;
  }

  // =========================================================================
  // Callback interface methods (used by PanelHttpCallbacks)
  // =========================================================================

  /**
   * List all panels for the management API.
   */
  listPanels(): Array<{
    panelId: string;
    title: string;
    subdomain: string;
    source: string;
    parentId: string | null;
    contextId: string;
  }> {
    return [...this.panels.values()].map(p => ({
      panelId: p.id,
      title: p.title,
      subdomain: p.subdomain,
      source: p.source,
      parentId: p.parentId,
      contextId: p.contextId,
    }));
  }

  /**
   * Get the HTTP URL for a panel.
   * Computes from panel data + known HTTP port.
   */
  getPanelUrl(panelId: string): string | null {
    const panel = this.panels.get(panelId);
    if (!panel || !this.deps.panelHttpServer?.getPort()) return null;
    return `http://${panel.subdomain}.localhost:${this.deps.panelHttpServer.getPort()}/${panel.source}/`;
  }

  // =========================================================================
  // Bootstrap config (RPC delivery)
  // =========================================================================

  /**
   * Return bootstrap config for a panel, delivered via RPC.
   * Called by bridge.getBootstrapConfig handler.
   */
  getBootstrapConfig(callerId: string): unknown {
    const panel = this.panels.get(callerId);
    if (!panel) throw new Error(`Panel not found: ${callerId}`);

    const gitBaseUrl = this.deps.gitBaseUrl;
    const gitToken = this.deps.getGitTokenForPanel(panel.id);
    const pubsubUrl = `ws://${panel.subdomain}.localhost:${this.deps.pubsubPort}`;

    const gitConfig = { serverUrl: gitBaseUrl, token: gitToken, sourceRepo: panel.source };
    const pubsubConfig = { serverUrl: pubsubUrl, token: panel.rpcToken! };

    return {
      panelId: panel.id,
      contextId: panel.contextId,
      parentId: panel.parentId,
      theme: this.currentTheme,
      rpcPort: this.deps.rpcPort,
      rpcToken: panel.rpcToken!,
      // In headless mode, server services live on the same RPC port
      serverRpcPort: this.deps.rpcPort,
      serverRpcToken: panel.rpcToken!,
      gitConfig,
      pubsubConfig,
      env: {
        ...panel.env,
        PARENT_ID: panel.parentId ?? "",
        __GIT_CONFIG: JSON.stringify(gitConfig),
        __PUBSUB_CONFIG: JSON.stringify(pubsubConfig),
      },
      stateArgs: panel.stateArgs,
    };
  }
}
