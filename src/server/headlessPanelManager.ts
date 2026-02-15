/**
 * HeadlessPanelManager — Panel lifecycle management without Electron rendering.
 *
 * Manages the panel tree (create, close, tree traversal, state args) using the
 * same ID generation and context resolution as the Electron PanelManager, but
 * without creating WebContentsView instances. Panels are built by the build
 * system and their artifacts are stored in the PanelHttpServer for browser
 * access.
 *
 * Context Template Support:
 * Uses the same template resolution pipeline as Electron (resolver → specHash
 * → contextId) but delegates OPFS population to the browser via a bootstrap
 * script injected into panel HTML. Panels sharing a contextId are assigned
 * the same subdomain, giving them a shared browser origin and therefore
 * shared localStorage, IndexedDB, OPFS, cookies, and service workers.
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
import {
  resolveHeadlessContext,
  canResolveTemplates,
  type HeadlessResolvedContext,
} from "./contextTemplate/headlessResolver.js";

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
  /** Template spec hash (first 12 chars), if resolved from template */
  specHashShort: string | null;
  /** Full spec hash, if resolved from template */
  specHash: string | null;
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

  constructor(deps: CreatePanelDeps) {
    this.deps = deps;
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
   * get the same browser origin (= shared localStorage, IndexedDB, OPFS,
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
  // Panel creation
  // =========================================================================

  async createPanel(
    callerId: string,
    source: string,
    options?: CreateChildOptions,
    stateArgs?: Record<string, unknown>,
  ): Promise<ChildCreationResult> {
    const parent = callerId ? this.panels.get(callerId) : null;

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
    // Use the full template resolution pipeline when workspace is available,
    // falling back to the simplified scheme for stateless operation.
    let contextId: string;
    let specHashShort: string | null = null;
    let specHash: string | null = null;

    if (options?.contextId) {
      // Explicit context ID provided — use as-is (enables context sharing)
      contextId = options.contextId;
    } else if (canResolveTemplates()) {
      // Full template resolution available — use same pipeline as Electron
      const templateSpec = options?.templateSpec ?? "contexts/default";
      try {
        const resolved: HeadlessResolvedContext = await resolveHeadlessContext(panelId, templateSpec);
        contextId = resolved.contextId;
        specHashShort = resolved.specHashShort;
        specHash = resolved.specHash;
      } catch (err) {
        // Template resolution failed — fall back to simple scheme
        log.info(`[Panel] Template resolution failed for ${panelId}, using fallback: ${err}`);
        contextId = `headless_${panelId.replace(/\//g, "~")}_${Date.now().toString(36)}`;
      }
    } else {
      // No workspace — simplified context ID
      contextId = `headless_${panelId.replace(/\//g, "~")}_${Date.now().toString(36)}`;
    }

    // ── Subdomain assignment ──
    // Panels sharing a contextId share a subdomain (= same origin = shared storage)
    const subdomain = this.getOrCreateSubdomain(contextId, source);

    // Create RPC token for this panel
    const rpcToken = this.deps.createToken(panelId, "panel");

    const panel: HeadlessPanel = {
      id: panelId,
      parentId: parent?.id ?? null,
      source,
      type: "app",
      contextId,
      subdomain,
      specHashShort,
      specHash,
      title: source.split("/").pop() ?? source,
      stateArgs: stateArgs ?? {},
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

    log.info(`[Panel] Created: ${panelId} (${subdomain}.localhost, ctx=${contextId}, spec=${specHashShort ?? "none"})`);

    this.emitEvent({
      type: "panel:created",
      panelId,
      title: panel.title,
      subdomain,
      parentId: panel.parentId,
      source,
    });

    // Trigger async build + serve
    void this.buildAndServePanel(panel).catch((err) => {
      log.info(`[Panel] Build failed for ${panelId}: ${err}`);
    });

    return { id: panelId, type: "app" };
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

    // Revoke token
    if (panel.rpcToken) {
      this.deps.revokeToken(panelId);
    }

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
   * Build a panel and store its artifacts in the HTTP panel server.
   */
  private async buildAndServePanel(panel: HeadlessPanel): Promise<void> {
    panel.buildState = "building";

    try {
      const buildResult = await this.deps.getBuild(panel.source);

      panel.buildState = "built";
      panel.title = buildResult.metadata.name ?? panel.title;

      if (this.deps.panelHttpServer && buildResult.html && buildResult.bundle) {
        // Get git token for this panel
        const gitToken = this.deps.getGitTokenForPanel(panel.id);

        this.deps.panelHttpServer.storePanel(panel.id, buildResult, {
          panelId: panel.id,
          contextId: panel.contextId,
          subdomain: panel.subdomain,
          parentId: panel.parentId,
          rpcPort: this.deps.rpcPort,
          rpcToken: panel.rpcToken!,
          gitBaseUrl: this.deps.gitBaseUrl,
          gitToken,
          pubsubPort: this.deps.pubsubPort,
          stateArgs: panel.stateArgs,
          sourceRepo: panel.source,
          resolvedRepoArgs: panel.repoArgs ?? {},
          env: panel.env,
          theme: "dark",
          specHash: panel.specHash ?? undefined,
          specHashShort: panel.specHashShort ?? undefined,
        });

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
