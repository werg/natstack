/**
 * HeadlessPanelManager — Panel lifecycle management without Electron rendering.
 *
 * Manages the panel tree (create, close, tree traversal, state args) using the
 * same ID generation and context resolution as the Electron PanelManager, but
 * without creating WebContentsView instances. Panels are built by the build
 * system and their artifacts are stored in the PanelHttpServer for browser
 * access.
 *
 * Panels sharing a contextId are assigned the same subdomain, giving them a
 * shared browser origin and therefore shared localStorage, IndexedDB,
 * cookies, and service workers.
 *
 * Panel types use the canonical PanelType ("app" | "browser" | "shell") from
 * src/shared/types.ts. Only "app" panels are created in headless mode —
 * "browser" and "shell" are GUI-specific. Workers/agents are NOT panels; they
 * are managed separately by AgentHost with callerKind: "server" tokens.
 *
 * Persistence: The panel tree is in-memory only (v1). This is acceptable
 * because panels are cheap to recreate (build cache ensures fast rebuilds)
 * and browser clients reconnect on reload. SQLite persistence can be added
 * later using the same schema as src/main/db/panelPersistence.ts.
 */

import { randomBytes } from "crypto";
import type { PanelType, ChildCreationResult, CreateChildOptions, RepoArgSpec } from "../shared/types.js";
import type { BuildResult } from "./buildV2/buildStore.js";
import type { PanelHttpServer, PanelLifecycleEvent } from "./panelHttpServer.js";
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
  type: PanelType;
  contextId: string;
  /** Short DNS-safe label used as the *.localhost subdomain */
  subdomain: string;
  title: string;
  stateArgs: Record<string, unknown>;
  repoArgs?: Record<string, RepoArgSpec>;
  env: Record<string, string>;
  children: string[];
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
    type: PanelType;
    title: string;
    subdomain: string;
    childCount: number;
    buildState: string;
  }>;
  roots: string[];
}

interface CreatePanelDeps {
  /** Resolve a build for a panel source path */
  getBuild: (unitPath: string) => Promise<BuildResult>;
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
  /** Lifecycle event callback (panel created, built, closed, error) */
  onPanelEvent?: (event: PanelLifecycleEvent) => void;
}

// ---------------------------------------------------------------------------
// HeadlessPanelManager
// ---------------------------------------------------------------------------

export class HeadlessPanelManager {
  private panels = new Map<string, HeadlessPanel>();
  private activeSubdomains = new Set<string>();
  /** Reverse lookup: contextId → subdomain (for shared-context subdomain reuse) */
  private contextSubdomains = new Map<string, string>();
  private deps: CreatePanelDeps;
  private fsService: import("../main/fsService.js").FsService | null = null;
  private currentTheme: "light" | "dark" = "dark";

  constructor(deps: CreatePanelDeps) {
    this.deps = deps;
  }

  setFsService(service: import("../main/fsService.js").FsService): void {
    this.fsService = service;
  }

  setCurrentTheme(theme: "light" | "dark"): void {
    this.currentTheme = theme;

    // Update stored HTTP configs so page reloads pick up the new theme
    if (this.deps.panelHttpServer) {
      for (const [panelId, panel] of this.panels) {
        if (panel.buildState === "built") {
          this.deps.panelHttpServer.updatePanelConfig(panelId, this.buildPanelConfig(panel));
        }
      }
    }
  }

  /**
   * Generate a short, human-readable DNS subdomain slug for a panel.
   * Format: {name}-{hex3} (e.g., "editor-a4f", "chat-3b2")
   */
  private generateSubdomain(source: string): string {
    const baseName = (source.split("/").pop() ?? source)
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 50) || "panel";

    let slug: string;
    do {
      const suffix = randomBytes(2).toString("hex").slice(0, 3);
      slug = `${baseName}-${suffix}`;
    } while (this.activeSubdomains.has(slug));

    this.activeSubdomains.add(slug);
    return slug;
  }

  /**
   * Get or create a subdomain for a context ID.
   *
   * Panels sharing the same contextId MUST share the same subdomain so they
   * get the same browser origin (= shared localStorage, IndexedDB,
   * cookies, service workers). This mirrors Electron's persist:{contextId}
   * partition sharing.
   */
  private getOrCreateSubdomain(contextId: string, source: string): string {
    const existing = this.contextSubdomains.get(contextId);
    if (existing && this.activeSubdomains.has(existing)) {
      log.info(`[Context] Reusing subdomain "${existing}" for shared context ${contextId}`);
      return existing;
    }

    const subdomain = this.generateSubdomain(source);
    this.contextSubdomains.set(contextId, subdomain);
    return subdomain;
  }

  private emitEvent(event: PanelLifecycleEvent): void {
    this.deps.onPanelEvent?.(event);
  }

  // =========================================================================
  // On-demand panel creation (browser-driven)
  // =========================================================================

  /** In-flight on-demand creates, keyed by subdomain (prevents duplicate work) */
  private onDemandInFlight = new Map<string, Promise<string>>();

  /**
   * Create a panel on-demand when a browser visits a registered subdomain.
   *
   * Idempotent: if a panel already exists on this subdomain, returns its ID.
   * Concurrent calls for the same subdomain are coalesced into a single create.
   *
   * @param source  Workspace-relative panel source path (e.g., "panels/chat")
   * @param subdomain  The deterministic subdomain from the source registry
   * @returns The panel ID
   */
  async createPanelOnDemand(source: string, subdomain: string): Promise<string> {
    // Already running on this subdomain?
    for (const panel of this.panels.values()) {
      if (panel.subdomain === subdomain) return panel.id;
    }

    // Already being created?
    const inFlight = this.onDemandInFlight.get(subdomain);
    if (inFlight) return inFlight;

    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`On-demand panel creation timed out for ${subdomain}`)), 60_000);
    });

    const promise = Promise.race([
      this.createPanel("server", source, undefined, undefined, subdomain).then((result) => result.id),
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
    return promise;
  }

  // =========================================================================
  // Panel creation
  // =========================================================================

  async createPanel(
    callerId: string,
    source: string,
    options?: CreateChildOptions,
    stateArgs?: Record<string, unknown>,
    /** Use this subdomain instead of generating a random one (for on-demand creation) */
    subdomainOverride?: string,
  ): Promise<ChildCreationResult> {
    const parent = callerId ? this.panels.get(callerId) : null;

    // Guard: reject URL sources early — browser panels are not supported in headless mode.
    // In Electron, PanelManager detects URLs and creates browser panels; here we fail
    // with a clear error instead of a confusing build failure.
    if (/^https?:\/\//i.test(source)) {
      throw new Error(
        `Browser panels are not supported in headless mode (source: "${source}"). ` +
        "Use the Electron app for web browsing panels."
      );
    }

    // Generate panel ID using the shared utility (same scheme as PanelManager)
    const panelId = computePanelId({
      relativePath: source,
      parent,
      requestedId: options?.name,
      isRoot: !parent,
    });

    if (this.panels.has(panelId)) {
      throw new Error(`A panel with id "${panelId}" is already running`);
    }

    // ── Context resolution ──
    let contextId: string;

    if (options?.contextId) {
      // Explicit context ID provided — use as-is (enables context sharing)
      contextId = options.contextId;
    } else {
      contextId = `ctx_${panelId.replace(/[/:]/g, "~")}`;
    }

    // Register panel→context mapping for fs service routing
    this.fsService?.registerPanelContext(panelId, contextId);

    let rpcToken: string | null = null;
    let subdomain: string | null = null;
    try {
      // ── Subdomain assignment ──
      // On-demand creation provides a predetermined subdomain; otherwise generate one.
      // Panels sharing a contextId share a subdomain (= same origin = shared storage)
      if (subdomainOverride) {
        subdomain = subdomainOverride;
        this.activeSubdomains.add(subdomain);
        this.contextSubdomains.set(contextId, subdomain);
      } else {
        subdomain = this.getOrCreateSubdomain(contextId, source);
      }

      // Create RPC token for this panel
      rpcToken = this.deps.createToken(panelId, "panel");

      // ── StateArgs validation + defaults ──
      // Match Electron's creation-time behavior: validate against manifest
      // schema and apply defaults (e.g. boolean fields default to false).
      // Only the manifest load is in a try-catch (expected to fail for dynamic
      // sources); validation errors always propagate.
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
        parentId: parent?.id ?? null,
        source,
        type: "app",
        contextId,
        subdomain,
        title: source.split("/").pop() ?? source,
        stateArgs: validatedStateArgs,
        repoArgs: options?.repoArgs,
        env: options?.env ?? {},
        children: [],
        rpcToken,
        buildState: "pending",
        createdAt: Date.now(),
      };

      this.panels.set(panelId, panel);

      // Register as child of parent
      if (parent) {
        parent.children.push(panelId);
      }

      // ── Early registration for pre-warming ──
      // Register the subdomain in PanelHttpServer BEFORE the build starts
      // so the extension can open /__init__ immediately for context bootstrap.
      let initToken: string | undefined;
      if (this.deps.panelHttpServer) {
        initToken = this.deps.panelHttpServer.registerPendingPanel(panelId, this.buildPanelConfig(panel));
      }

      log.info(`[Panel] Created: ${panelId} (${subdomain}.localhost, ctx=${contextId})`);

      this.emitEvent({
        type: "panel:created",
        panelId,
        title: panel.title,
        subdomain,
        contextId,
        initToken,
        parentId: panel.parentId,
        source,
      });

      // Trigger async build + serve
      void this.buildAndServePanel(panel).catch((err) => {
        log.info(`[Panel] Build failed for ${panelId}: ${err}`);
      });

      return { id: panelId, type: "app" };
    } catch (err) {
      // Rollback: unregister context mapping, revoke token, release subdomain on failure
      this.fsService?.unregisterPanelContext(panelId);
      if (rpcToken) {
        this.deps.revokeToken(panelId);
      }
      if (subdomain) {
        // Release subdomain only if no other panel already uses this context
        const otherPanelsWithContext = Array.from(this.panels.values()).some(
          (p) => p.contextId === contextId,
        );
        if (!otherPanelsWithContext) {
          this.activeSubdomains.delete(subdomain);
          this.contextSubdomains.delete(contextId);
        }
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

    // Close children first (depth-first)
    for (const childId of [...panel.children]) {
      this.closePanel(childId);
    }

    // Remove from parent's children list
    if (panel.parentId) {
      const parent = this.panels.get(panel.parentId);
      if (parent) {
        parent.children = parent.children.filter((id) => id !== panelId);
      }
    }

    // Close open file handles and unregister panel→context mapping
    this.fsService?.closeHandlesForPanel(panelId);
    this.fsService?.unregisterPanelContext(panelId);

    // Revoke tokens (RPC + git)
    if (panel.rpcToken) {
      this.deps.revokeToken(panelId);
    }
    this.deps.revokeGitToken?.(panelId);

    // Remove from HTTP server
    if (this.deps.panelHttpServer) {
      this.deps.panelHttpServer.removePanel(panelId);
    }

    // Release subdomain only if no other panels use this context
    const otherPanelsWithContext = Array.from(this.panels.values()).some(
      (p) => p.id !== panelId && p.contextId === panel.contextId,
    );
    if (!otherPanelsWithContext) {
      this.activeSubdomains.delete(panel.subdomain);
      this.contextSubdomains.delete(panel.contextId);
    }

    this.emitEvent({
      type: "panel:closed",
      panelId,
      title: panel.title,
      subdomain: panel.subdomain,
      parentId: panel.parentId,
      source: panel.source,
    });

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

  findParentId(childId: string): string | null {
    return this.panels.get(childId)?.parentId ?? null;
  }

  isDescendantOf(childId: string, ancestorId: string): boolean {
    let current = childId;
    const visited = new Set<string>();
    while (current) {
      if (visited.has(current)) return false;
      visited.add(current);
      const panel = this.panels.get(current);
      if (!panel?.parentId) return false;
      if (panel.parentId === ancestorId) return true;
      current = panel.parentId;
    }
    return false;
  }

  getSerializablePanelTree(): HeadlessPanelTree {
    const roots: string[] = [];
    const panels: HeadlessPanelTree["panels"] = [];

    for (const [id, panel] of this.panels) {
      panels.push({
        id,
        parentId: panel.parentId,
        source: panel.source,
        type: panel.type,
        title: panel.title,
        subdomain: panel.subdomain,
        childCount: panel.children.length,
        buildState: panel.buildState,
      });
      if (!panel.parentId) {
        roots.push(id);
      }
    }

    return { panels, roots };
  }

  getChildPanels(
    parentId: string,
    _options?: { includeStateArgs?: boolean },
  ): Array<{ id: string; source: string; type: PanelType; title: string }> {
    const parent = this.panels.get(parentId);
    if (!parent) return [];

    return parent.children
      .map((childId) => this.panels.get(childId))
      .filter((p): p is HeadlessPanel => p !== undefined)
      .map((p) => ({
        id: p.id,
        source: p.source,
        type: p.type,
        title: p.title,
      }));
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

    // Update stored config in HTTP server so page reloads get fresh stateArgs
    if (this.deps.panelHttpServer) {
      this.deps.panelHttpServer.updatePanelConfig(panelId, this.buildPanelConfig(panel));
    }

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
  // Internals
  // =========================================================================

  /**
   * Build a PanelConfig from a HeadlessPanel.
   * Called during both early registration and final storePanel.
   */
  private buildPanelConfig(panel: HeadlessPanel): import("./panelHttpServer.js").PanelConfig {
    return {
      panelId: panel.id,
      contextId: panel.contextId,
      subdomain: panel.subdomain,
      parentId: panel.parentId,
      rpcPort: this.deps.rpcPort,
      rpcToken: panel.rpcToken!,
      gitBaseUrl: this.deps.gitBaseUrl,
      gitToken: this.deps.getGitTokenForPanel(panel.id),
      pubsubPort: this.deps.pubsubPort,
      pubsubToken: panel.rpcToken!,
      title: panel.title,
      stateArgs: panel.stateArgs,
      sourceRepo: panel.source,
      resolvedRepoArgs: panel.repoArgs ?? {},
      env: panel.env,
      theme: this.currentTheme,
    };
  }

  /**
   * Build a panel and store its artifacts in the HTTP panel server.
   */
  private async buildAndServePanel(panel: HeadlessPanel): Promise<void> {
    panel.buildState = "building";

    try {
      const buildResult = await this.deps.getBuild(panel.source);

      // Guard against build-close race: if the panel was closed (or closed
      // and recreated with the same deterministic ID) while the build was
      // in-flight, don't apply stale results. Object identity (===) catches
      // both "closed" and "closed+reopened" — the latter puts a new object
      // in the map under the same key.
      if (this.panels.get(panel.id) !== panel) {
        log.info(`[Panel] Build completed for ${panel.id} but panel was closed or replaced — discarding`);
        return;
      }

      panel.buildState = "built";
      panel.title = buildResult.metadata.name ?? panel.title;

      if (this.deps.panelHttpServer && buildResult.html && buildResult.bundle) {
        this.deps.panelHttpServer.storePanel(panel.id, buildResult, this.buildPanelConfig(panel));

        const panelUrl = this.deps.panelHttpServer.getPanelUrl(panel.id);
        this.emitEvent({
          type: "panel:built",
          panelId: panel.id,
          title: panel.title,
          subdomain: panel.subdomain,
          url: panelUrl ?? undefined,
          source: panel.source,
          parentId: panel.parentId,
        });

        log.info(`[Panel] Built and served: ${panel.id}`);
      } else {
        log.info(`[Panel] Built (no HTTP serving): ${panel.id}`);
      }
    } catch (err) {
      // Don't emit errors for panels closed (or replaced) during build
      if (this.panels.get(panel.id) !== panel) {
        log.info(`[Panel] Build failed for ${panel.id} but panel was closed or replaced — suppressing`);
        return;
      }

      panel.buildState = "failed";
      panel.buildError = err instanceof Error ? err.message : String(err);

      this.emitEvent({
        type: "panel:build-error",
        panelId: panel.id,
        title: panel.title,
        subdomain: panel.subdomain,
        error: panel.buildError,
        source: panel.source,
        parentId: panel.parentId,
      });

      throw err;
    }
  }
}
