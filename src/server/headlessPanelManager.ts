/**
 * HeadlessPanelManager — Panel lifecycle management without Electron rendering.
 *
 * Manages the panel tree (create, close, tree traversal, state args) using the
 * same ID generation and context resolution as the Electron PanelManager, but
 * without creating WebContentsView instances. Panels are built by the build
 * system and their artifacts are stored in the PanelHttpServer for browser
 * access.
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

import type { PanelType, ChildCreationResult, CreateChildOptions, RepoArgSpec } from "../shared/types.js";
import type { BuildResult } from "./buildV2/buildStore.js";
import type { PanelHttpServer } from "./panelHttpServer.js";
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
}

// ---------------------------------------------------------------------------
// HeadlessPanelManager
// ---------------------------------------------------------------------------

export class HeadlessPanelManager {
  private panels = new Map<string, HeadlessPanel>();
  private deps: CreatePanelDeps;

  constructor(deps: CreatePanelDeps) {
    this.deps = deps;
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

    // Generate context ID (simplified — does not do full template resolution
    // since that requires the workspace git repos; use provided contextId or
    // generate a basic one)
    const contextId =
      options?.contextId ??
      `headless_${panelId.replace(/\//g, "~")}_${Date.now().toString(36)}`;

    // Create RPC token for this panel
    const rpcToken = this.deps.createToken(panelId, "panel");

    const panel: HeadlessPanel = {
      id: panelId,
      parentId: parent?.id ?? null,
      source,
      type: "app",
      contextId,
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

    log.info(`[Panel] Created: ${panelId} (source: ${source})`);

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
        });

        log.info(`[Panel] Built and served: ${panel.id}`);
      } else {
        log.info(`[Panel] Built (no HTTP serving): ${panel.id}`);
      }
    } catch (err) {
      panel.buildState = "failed";
      panel.buildError = err instanceof Error ? err.message : String(err);
      throw err;
    }
  }
}
