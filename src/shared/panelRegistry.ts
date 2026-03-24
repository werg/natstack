/**
 * PanelRegistry — Authoritative data store for panel tree state.
 *
 * Owns:
 * - The in-memory panel map and root panel list
 * - Tree relationships (parent/child, selectedChildId)
 * - Persistence to SQLite (when available)
 * - Search indexing
 * - Debounced tree-update notifications via EventService
 *
 * Does NOT own:
 * - Electron views, tokens, build orchestration (PanelView / PanelLifecycle)
 * - State-arg validation against manifests (PanelLifecycle)
 */

import { createDevLogger } from "@natstack/dev-log";
import type { Panel, PanelArtifacts, PanelInfo, PanelSummary } from "./types.js";
import { getCurrentSnapshot, getPanelSource, getPanelContextId } from "./panel/accessors.js";
import { contextIdToSubdomain } from "./panelIdUtils.js";
import type { PanelPersistence } from "./db/panelPersistence.js";
import type { PanelSearchIndex } from "./db/panelSearchIndex.js";
import type { EventService } from "./eventsService.js";
import type { Workspace } from "./workspace/types.js";
import type { PanelRelationshipProvider } from "./panelInterfaces.js";

const log = createDevLogger("PanelRegistry");

// ============================================================================
// Types
// ============================================================================

export interface PanelListItem {
  panelId: string;
  title: string;
  subdomain: string;
  source: string;
  parentId: string | null;
  contextId: string;
}

export interface PanelRegistryOptions {
  workspace: Workspace | null;
  eventService: EventService;
  persistence?: PanelPersistence;
  searchIndex?: PanelSearchIndex;
}

// ============================================================================
// PanelRegistry
// ============================================================================

export class PanelRegistry implements PanelRelationshipProvider {
  private panels: Map<string, Panel> = new Map();
  private rootPanels: Panel[] = [];
  private focusedPanelId: string | null = null;
  private reservedPanelIds: Set<string> = new Set();
  private currentTheme: "light" | "dark" = "light";

  // Debounce state for panel tree update notifications
  private treeUpdatePending = false;
  private treeUpdateTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly TREE_UPDATE_DEBOUNCE_MS = 16; // ~1 frame at 60fps

  private readonly workspace: Workspace | null;
  private readonly eventService: EventService;
  private readonly persistence: PanelPersistence | null;
  private readonly searchIndex: PanelSearchIndex | null;

  constructor(opts: PanelRegistryOptions) {
    this.workspace = opts.workspace;
    this.eventService = opts.eventService;
    this.persistence = opts.persistence ?? null;
    this.searchIndex = opts.searchIndex ?? null;
  }

  // ==========================================================================
  // Queries
  // ==========================================================================

  getPanel(id: string): Panel | undefined {
    return this.panels.get(id);
  }

  getRootPanels(): Panel[] {
    return this.rootPanels;
  }

  getSerializablePanelTree(): Panel[] {
    return this.rootPanels.map((panel) => this.serializePanel(panel));
  }

  /**
   * Find the parent panel ID for a given child panel ID.
   * Returns null if the panel is a root panel or not found.
   */
  findParentId(childId: string): string | null {
    for (const panel of this.panels.values()) {
      if (panel.children.some((c) => c.id === childId)) {
        return panel.id;
      }
    }
    return null;
  }

  /**
   * Check if a panel is a descendant of another panel.
   */
  isDescendantOf(panelId: string, ancestorId: string): boolean {
    const visited = new Set<string>();
    const MAX_DEPTH = 100;
    let depth = 0;

    let currentId: string | null = panelId;
    while (currentId && depth < MAX_DEPTH) {
      if (visited.has(currentId)) {
        console.error(`[PanelRegistry] Cycle detected at ${currentId}`);
        return false;
      }
      visited.add(currentId);

      const parentId = this.findParentId(currentId);
      if (!parentId) return false;
      if (parentId === ancestorId) return true;

      currentId = parentId;
      depth++;
    }

    return false;
  }

  getInfo(panelId: string): PanelInfo {
    const panel = this.panels.get(panelId);
    if (!panel) {
      throw new Error(`Panel not found: ${panelId}`);
    }
    const contextId = getPanelContextId(panel);
    return {
      panelId: panel.id,
      partition: contextId,
      contextId,
    };
  }

  /**
   * List all panels with metadata.
   */
  listPanels(): PanelListItem[] {
    return [...this.panels.values()].map((panel) => ({
      panelId: panel.id,
      title: panel.title,
      subdomain: contextIdToSubdomain(getPanelContextId(panel)),
      source: getPanelSource(panel),
      parentId: this.findParentId(panel.id),
      contextId: getPanelContextId(panel),
    }));
  }

  getFocusedPanelId(): string | null {
    return this.focusedPanelId;
  }

  /**
   * Find a panel by its context ID.
   */
  findPanelByContextId(contextId: string): Panel | undefined {
    for (const panel of this.panels.values()) {
      if (getPanelContextId(panel) === contextId) {
        return panel;
      }
    }
    return undefined;
  }

  /**
   * Get children with pagination, enriched with runtime buildState.
   * When persistence is available, queries the DB; otherwise uses in-memory data.
   */
  getChildrenPaginated(
    parentId: string,
    offset: number,
    limit: number,
  ): { children: PanelSummary[]; total: number; hasMore: boolean } {
    if (this.persistence) {
      const result = this.persistence.getChildrenPaginated(parentId, offset, limit);
      const enrichedChildren = result.children.map((summary) => {
        const panel = this.panels.get(summary.id);
        return {
          ...summary,
          buildState: panel?.artifacts?.buildState,
        };
      });
      return { ...result, children: enrichedChildren };
    }

    // In-memory fallback (headless mode)
    const parent = this.panels.get(parentId);
    if (!parent) return { children: [], total: 0, hasMore: false };

    const allChildren = parent.children;
    const total = allChildren.length;
    const sliced = allChildren.slice(offset, offset + limit);

    return {
      children: sliced.map((child, idx) => ({
        id: child.id,
        title: child.title,
        childCount: child.children.length,
        position: offset + idx,
        buildState: child.artifacts?.buildState,
      })),
      total,
      hasMore: offset + sliced.length < total,
    };
  }

  /**
   * Get root panels with pagination, enriched with runtime buildState.
   * When persistence is available, queries the DB; otherwise uses in-memory data.
   */
  getRootPanelsPaginated(
    offset: number,
    limit: number,
  ): { panels: PanelSummary[]; total: number; hasMore: boolean } {
    if (this.persistence) {
      const result = this.persistence.getRootPanelsPaginated(offset, limit);
      const enrichedPanels = result.panels.map((summary) => {
        const panel = this.panels.get(summary.id);
        return {
          ...summary,
          buildState: panel?.artifacts?.buildState,
        };
      });
      return { ...result, panels: enrichedPanels };
    }

    // In-memory fallback (headless mode)
    const total = this.rootPanels.length;
    const sliced = this.rootPanels.slice(offset, offset + limit);

    return {
      panels: sliced.map((p, idx) => ({
        id: p.id,
        title: p.title,
        childCount: p.children.length,
        position: offset + idx,
        buildState: p.artifacts?.buildState,
      })),
      total,
      hasMore: offset + sliced.length < total,
    };
  }

  /**
   * Get all collapsed panel IDs for the current workspace.
   */
  getCollapsedIds(): string[] {
    if (!this.persistence) return [];
    return this.persistence.getCollapsedIds();
  }

  // ==========================================================================
  // Mutations
  // ==========================================================================

  /**
   * Add a panel to the registry.
   *
   * @param panel - The panel to add
   * @param parentId - Parent panel ID, or null for root placement
   * @param opts.addAsRoot - If true and parentId is null, prepend to rootPanels
   *   without clearing the existing tree. When false (default) and parentId is
   *   null, the tree is replaced with this single panel.
   */
  addPanel(
    panel: Panel,
    parentId: string | null,
    opts?: { addAsRoot?: boolean },
  ): void {
    if (parentId) {
      const parent = this.panels.get(parentId);
      if (!parent) {
        throw new Error(`Parent panel not found: ${parentId}`);
      }
      parent.children.unshift(panel);
      parent.selectedChildId = panel.id;
      this.panels.set(panel.id, panel);
    } else if (opts?.addAsRoot) {
      this.rootPanels.unshift(panel);
      this.panels.set(panel.id, panel);
    } else {
      // Replace tree with single root
      this.rootPanels = [panel];
      this.panels = new Map([[panel.id, panel]]);
    }

    this.persistPanel(panel, parentId);
    this.notifyPanelTreeUpdate();
  }

  /**
   * Remove a panel from the tree (in-memory only — caller handles archiving).
   */
  removePanel(panelId: string): void {
    const parentId = this.findParentId(panelId);

    if (parentId) {
      const parent = this.panels.get(parentId);
      if (parent) {
        parent.children = parent.children.filter((c) => c.id !== panelId);
        if (parent.selectedChildId === panelId) {
          // Auto-select the next remaining child (or null if none left)
          const nextChild = parent.children.length > 0 ? parent.children[parent.children.length - 1]!.id : null;
          parent.selectedChildId = nextChild;
          this.persistence?.setSelectedChild(parent.id, nextChild);
        }
      }
    } else {
      this.rootPanels = this.rootPanels.filter((p) => p.id !== panelId);
    }

    this.panels.delete(panelId);
    this.notifyPanelTreeUpdate();
  }

  /**
   * Archive a panel in the persistence layer (soft delete).
   */
  archivePanel(panelId: string): void {
    this.persistence?.archivePanel(panelId);
  }

  /**
   * Move a panel to a new parent at a specific position.
   * Used for drag-and-drop reordering and reparenting.
   */
  movePanel(panelId: string, newParentId: string | null, targetPosition: number): void {
    const panel = this.panels.get(panelId);
    if (!panel) {
      throw new Error(`Panel not found: ${panelId}`);
    }

    // Validate: can't move panel into its own descendants
    if (newParentId && this.isDescendantOf(newParentId, panelId)) {
      throw new Error("Cannot move panel into its own subtree");
    }

    // Validate newParentId exists BEFORE modifying the tree
    let newParent: Panel | undefined;
    if (newParentId) {
      newParent = this.panels.get(newParentId);
      if (!newParent) {
        throw new Error(`New parent panel not found: ${newParentId}`);
      }
    }

    // Remove from current parent's children array
    const currentParentId = this.findParentId(panelId);
    if (currentParentId) {
      const currentParent = this.panels.get(currentParentId);
      if (currentParent) {
        const idx = currentParent.children.findIndex((c) => c.id === panelId);
        if (idx >= 0) {
          currentParent.children.splice(idx, 1);
        }
        if (currentParent.selectedChildId === panelId) {
          currentParent.selectedChildId = null;
        }
      }
    } else {
      // It's a root panel — remove from rootPanels
      const idx = this.rootPanels.findIndex((p) => p.id === panelId);
      if (idx >= 0) {
        this.rootPanels.splice(idx, 1);
      }
    }

    // Add to new parent at target position
    if (newParent) {
      const clampedPosition = Math.max(0, Math.min(targetPosition, newParent.children.length));
      newParent.children.splice(clampedPosition, 0, panel);
    } else {
      const clampedPosition = Math.max(0, Math.min(targetPosition, this.rootPanels.length));
      this.rootPanels.splice(clampedPosition, 0, panel);
    }

    // Persist to database
    this.persistence?.movePanel(panelId, newParentId, targetPosition);

    this.notifyPanelTreeUpdate();
  }

  /**
   * Update the selected path in the in-memory tree when a panel is focused.
   * Walks up from the focused panel and sets each ancestor's selectedChildId.
   */
  updateSelectedPath(focusedPanelId: string): void {
    this.focusedPanelId = focusedPanelId;
    const visited = new Set<string>();
    const MAX_DEPTH = 100;
    let currentId: string | null = focusedPanelId;
    let depth = 0;

    while (currentId && depth < MAX_DEPTH) {
      if (visited.has(currentId)) {
        console.error(`[PanelRegistry] Cycle detected in panel tree at ${currentId}`);
        break;
      }
      visited.add(currentId);

      const parentId = this.findParentId(currentId);
      if (!parentId) break;

      const parent = this.panels.get(parentId);
      if (parent) {
        parent.selectedChildId = currentId;
      }

      currentId = parentId;
      depth++;
    }

    if (depth >= MAX_DEPTH) {
      console.error(`[PanelRegistry] Max depth exceeded in updateSelectedPath`);
    }
  }

  /**
   * Set collapse state for a single panel.
   */
  setCollapsed(panelId: string, collapsed: boolean): void {
    this.persistence?.setCollapsed(panelId, collapsed);
  }

  /**
   * Expand multiple panels (set collapsed = false).
   */
  expandIds(panelIds: string[]): void {
    this.persistence?.setCollapsedBatch(panelIds, false);
  }

  /**
   * Update raw state args on a panel (no manifest validation — that's PanelLifecycle's job).
   */
  updateStateArgs(panelId: string, stateArgs: Record<string, unknown>): void {
    const panel = this.panels.get(panelId);
    if (!panel) {
      throw new Error(`Panel not found: ${panelId}`);
    }
    panel.snapshot.stateArgs = stateArgs;
    this.persistPanel(panel, this.findParentId(panelId));
  }

  /**
   * Update artifacts on a panel.
   */
  updateArtifacts(panelId: string, artifacts: PanelArtifacts): void {
    const panel = this.panels.get(panelId);
    if (!panel) {
      throw new Error(`Panel not found: ${panelId}`);
    }
    panel.artifacts = artifacts;
    // Artifacts are runtime-only — not persisted to DB
  }

  setCurrentTheme(theme: "light" | "dark"): void {
    this.currentTheme = theme;
  }

  getCurrentTheme(): "light" | "dark" {
    return this.currentTheme;
  }

  setFocusedPanelId(panelId: string): void {
    this.focusedPanelId = panelId;
  }

  /**
   * Reserve a panel ID to prevent concurrent creation of the same panel.
   * Returns false if the ID is already reserved or a panel with that ID exists.
   */
  reservePanelId(panelId: string): boolean {
    if (this.panels.has(panelId) || this.reservedPanelIds.has(panelId)) {
      return false;
    }
    this.reservedPanelIds.add(panelId);
    return true;
  }

  releasePanelId(panelId: string): void {
    this.reservedPanelIds.delete(panelId);
  }

  // ==========================================================================
  // Lifecycle
  // ==========================================================================

  /**
   * Notify renderer of panel tree changes.
   * Debounced to batch rapid updates (~16ms / 1 frame at 60fps).
   */
  notifyPanelTreeUpdate(): void {
    this.treeUpdatePending = true;

    if (this.treeUpdateTimer) {
      return;
    }

    this.treeUpdateTimer = setTimeout(() => {
      this.treeUpdateTimer = null;
      if (this.treeUpdatePending) {
        this.treeUpdatePending = false;
        const tree = this.getSerializablePanelTree();
        this.eventService.emit("panel-tree-updated", tree);
      }
    }, this.TREE_UPDATE_DEBOUNCE_MS);
  }

  /**
   * Load the panel tree from persistence (DB) into memory.
   * Call on startup when persistence is available.
   */
  async loadTree(): Promise<void> {
    if (!this.persistence) return;

    const existingPanels = this.persistence.getFullTree();
    if (existingPanels.length === 0) return;

    // Clean up childless shell panels from previous session
    this.cleanupChildlessAutoArchivePanels(existingPanels, this.persistence);

    // Filter out panels that were archived during cleanup
    const remaining = existingPanels.filter((p) => !this.persistence!.isArchived(p.id));
    if (remaining.length === 0) return;

    log.verbose(` Restoring ${remaining.length} root panel(s) from database`);
    this.rootPanels = remaining;

    // Rebuild the panels map
    const buildMap = (panels: Panel[]) => {
      for (const panel of panels) {
        this.panels.set(panel.id, panel);
        if (panel.children.length > 0) {
          buildMap(panel.children);
        }
      }
    };
    buildMap(remaining);
  }

  /**
   * Run shutdown cleanup: archive childless shell panels so they don't
   * clutter the tree on next startup.
   */
  runShutdownCleanup(): void {
    if (!this.persistence) return;
    log.verbose(` Running shutdown cleanup`);
    this.cleanupChildlessAutoArchivePanels(this.rootPanels, this.persistence);
  }

  /**
   * Persist a panel to the database and index for search.
   */
  persistPanel(panel: Panel, parentId: string | null): void {
    if (!this.persistence) return;

    try {
      const persistence = this.persistence;
      const currentSnapshot = getCurrentSnapshot(panel);

      // Check if panel already exists
      const existingPanel = persistence.getPanel(panel.id);

      // If the panel exists but is archived, unarchive it and update
      if (existingPanel && persistence.isArchived(panel.id)) {
        persistence.unarchivePanel(panel.id);
        persistence.updatePanel(panel.id, {
          parentId,
          snapshot: panel.snapshot,
        });
        if (parentId) {
          persistence.setSelectedChild(parentId, panel.id);
        }
        return;
      }

      if (!existingPanel) {
        persistence.createPanel({
          id: panel.id,
          title: panel.title,
          parentId,
          snapshot: currentSnapshot,
        });

        if (parentId) {
          persistence.setSelectedChild(parentId, panel.id);
          const inMemoryParent = this.panels.get(parentId);
          if (inMemoryParent) {
            inMemoryParent.selectedChildId = panel.id;
          }
        }
      } else {
        persistence.updatePanel(panel.id, {
          parentId,
          snapshot: currentSnapshot,
        });
      }

      // Index panel for search
      if (this.searchIndex) {
        try {
          const source = currentSnapshot.source;
          this.searchIndex.indexPanel({
            id: panel.id,
            title: panel.title,
            path: source,
          });
        } catch (indexError) {
          console.error(`[PanelRegistry] Failed to index panel ${panel.id}:`, indexError);
        }
      }
    } catch (error) {
      console.error(`[PanelRegistry] Failed to persist panel ${panel.id}:`, error);
    }
  }

  // ==========================================================================
  // Private helpers
  // ==========================================================================

  private serializePanel(panel: Panel): Panel {
    return {
      ...panel,
      children: panel.children.map((child) => this.serializePanel(child)),
    };
  }

  /**
   * Archive panels with autoArchiveWhenEmpty that have no children.
   * These are typically launcher UIs — a childless launcher was never used.
   */
  private cleanupChildlessAutoArchivePanels(
    panels: Panel[],
    persistence: PanelPersistence,
  ): void {
    for (const panel of panels) {
      if (panel.children.length > 0) {
        this.cleanupChildlessAutoArchivePanels(panel.children, persistence);
        panel.children = panel.children.filter((c) => !persistence.isArchived(c.id));
      }

      if (panel.snapshot.autoArchiveWhenEmpty && panel.children.length === 0) {
        log.verbose(` Archiving childless auto-archive panel: ${panel.id}`);
        try {
          persistence.archivePanel(panel.id);
        } catch (e) {
          console.error(`[PanelRegistry] Failed to archive panel ${panel.id}:`, e);
        }
      }
    }
  }
}
