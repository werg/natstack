import * as path from "path";
import { createDevLogger } from "@natstack/dev-log";
import type { PanelRegistry } from "../panelRegistry.js";
import type { Panel, PanelSnapshot, ThemeAppearance } from "../types.js";
import type {
  PanelSearchIndex,
  PanelSnapshotResult,
  PanelOpsSinceResult,
  SubmittedPanelOp,
} from "../panelOpsTypes.js";
import type { WorkspaceConfig } from "../workspace/types.js";
import { loadPanelManifest } from "../panelTypes.js";
import { validateStateArgs } from "../stateArgsValidator.js";
import { computePanelId } from "../panelIdUtils.js";
import {
  buildBootstrapConfig,
  browserSourceFromHostname,
  generateContextId,
  resolveSource,
} from "../panelFactory.js";
import { createSnapshot, getCurrentSnapshot, getPanelContextId, getPanelOptions, getPanelSource, getPanelStateArgs } from "../panel/accessors.js";
import { between as rankBetween, first as firstRank } from "../lexorank.js";

const log = createDevLogger("PanelManager");

export interface TokenClient {
  ensurePanelToken(
    panelId: string,
    contextId: string,
    parentId: string | null,
    source?: string,
  ): Promise<{ token: string }>;
  revokePanelToken(panelId: string): Promise<void>;
  updatePanelContext(panelId: string, contextId: string): Promise<void>;
  updatePanelParent(panelId: string, parentId: string | null): Promise<void>;
}

export interface PanelManagerServerInfo {
  gatewayConfig: { serverUrl: string; token?: string };
}

export interface CreatePanelOptions {
  parentId?: string;
  name?: string;
  contextId?: string;
  env?: Record<string, string>;
  ref?: string;
  stateArgs?: Record<string, unknown>;
  isRoot?: boolean;
  addAsRoot?: boolean;
  autoArchiveWhenEmpty?: boolean;
}

export interface CreatePanelResult {
  panelId: string;
  contextId: string;
  source: string;
  title: string;
  stateArgs: Record<string, unknown>;
  options: Record<string, unknown>;
  autoArchiveWhenEmpty?: boolean;
}

export interface NavigatePanelOptions {
  contextId?: string;
  env?: Record<string, string>;
  ref?: string;
  stateArgs?: Record<string, unknown>;
}

export interface PanelManagerDeps {
  registry: PanelRegistry;
  workspaceSync: WorkspaceSyncClient;
  activationClient?: ActivationClient;
  viewState?: LocalPanelViewStateStore;
  tokenClient: TokenClient;
  serverInfo: PanelManagerServerInfo;
  workspacePath: string;
  searchIndex?: PanelSearchIndex | null;
  workspaceConfig?: WorkspaceConfig;
  allowMissingManifests?: boolean;
}

export interface WorkspaceSyncClient {
  getSnapshot(): Promise<PanelSnapshotResult>;
  getOpsSince(baseRevision: number): Promise<PanelOpsSinceResult>;
  submitOps(baseRevision: number, ops: SubmittedPanelOp[]): Promise<{
    acceptedOps: string[];
    rejectedOps: Array<{ opId: string; reason: string }>;
    revision: number;
  }>;
}

export interface ActivationClient {
  markPanelActive(panelId: string): Promise<void>;
}

export interface LocalPanelViewState {
  collapsedIds: string[];
}

export interface LocalPanelViewStateStore {
  load(): Promise<LocalPanelViewState | null> | LocalPanelViewState | null;
  save(state: LocalPanelViewState): Promise<void> | void;
}

export class PanelManager {
  private readonly registry: PanelRegistry;
  private readonly workspaceSync: WorkspaceSyncClient;
  private readonly activationClient?: ActivationClient;
  private readonly viewState?: LocalPanelViewStateStore;
  private readonly tokenClient: TokenClient;
  private readonly serverInfo: PanelManagerServerInfo;
  private readonly workspacePath: string;
  private readonly searchIndex: PanelSearchIndex | null;
  private readonly workspaceConfig?: WorkspaceConfig;
  private readonly allowMissingManifests: boolean;
  private readonly collapsedIds = new Set<string>();
  private currentTheme: "light" | "dark" = "dark";
  private lastSeenRevision = 0;
  private viewStateLoaded = false;

  constructor(deps: PanelManagerDeps) {
    this.registry = deps.registry;
    this.workspaceSync = deps.workspaceSync;
    this.activationClient = deps.activationClient;
    this.viewState = deps.viewState;
    this.tokenClient = deps.tokenClient;
    this.serverInfo = deps.serverInfo;
    this.workspacePath = deps.workspacePath;
    this.searchIndex = deps.searchIndex ?? null;
    this.workspaceConfig = deps.workspaceConfig;
    this.allowMissingManifests = deps.allowMissingManifests ?? false;
  }

  getLastSeenRevision(): number {
    return this.lastSeenRevision;
  }

  async syncSnapshot(): Promise<{ rootPanels: Panel[]; revision: number }> {
    await this.ensureViewStateLoaded();
    const snapshot = await this.workspaceSync.getSnapshot();
    this.lastSeenRevision = snapshot.revision;
    this.registry.repopulate(snapshot.tree, [...this.collapsedIds]);
    return { rootPanels: snapshot.tree, revision: snapshot.revision };
  }

  async syncSince(baseRevision = this.lastSeenRevision): Promise<void> {
    const result = await this.workspaceSync.getOpsSince(baseRevision);
    if (result.snapshotRequired || result.ops.length > 0) {
      await this.syncSnapshot();
      return;
    }
    this.lastSeenRevision = result.revision;
  }

  async create(source: string, opts?: CreatePanelOptions): Promise<CreatePanelResult> {
    const { relativePath, absolutePath } = resolveSource(source, this.workspacePath);
    const allowMissing = Boolean(opts?.contextId) || this.allowMissingManifests;
    const manifest = this.resolveManifest(absolutePath, relativePath, allowMissing);
    const validatedStateArgs = this.validateManifestStateArgs(relativePath, manifest.stateArgs, opts?.stateArgs);
    const panelId = computePanelId({
      relativePath,
      parent: opts?.parentId ? { id: opts.parentId } : null,
      requestedId: opts?.name,
      isRoot: opts?.isRoot,
    });
    const contextId = opts?.contextId ?? generateContextId(panelId);

    await this.tokenClient.ensurePanelToken(panelId, contextId, opts?.parentId ?? null, relativePath);

    const snapshot = createSnapshot(relativePath, contextId, { env: opts?.env, ref: opts?.ref }, validatedStateArgs);
    if (opts?.autoArchiveWhenEmpty || manifest.autoArchiveWhenEmpty) {
      snapshot.autoArchiveWhenEmpty = true;
    }

    try {
      await this.submitWorkspaceOps([{
        opId: this.createOpId("panel.create", panelId),
        type: "panel.create",
        panelId,
        parentId: opts?.parentId ?? null,
        positionId: this.rankForPosition(opts?.parentId ?? null, opts?.addAsRoot ? this.registry.getRootPanels().length : 0),
        snapshot,
        title: manifest.title,
      }]);

      this.indexPanel(panelId, manifest.title, relativePath);

      return {
        panelId,
        contextId,
        source: relativePath,
        title: manifest.title,
        stateArgs: validatedStateArgs ?? {},
        options: { env: opts?.env ?? {}, ...(opts?.ref ? { ref: opts.ref } : {}) },
        autoArchiveWhenEmpty: snapshot.autoArchiveWhenEmpty,
      };
    } catch (error) {
      this.registry.removePanel(panelId);
      await Promise.resolve(this.tokenClient.revokePanelToken(panelId)).catch(() => {});
      throw error;
    }
  }

  async createBrowser(
    parentId: string | null,
    url: string,
    opts?: { name?: string; addAsRoot?: boolean },
  ): Promise<CreatePanelResult & { url: string }> {
    if (typeof url !== "string" || !/^https?:\/\//i.test(url)) {
      throw new Error(`Invalid browser panel URL (must be http/https string): ${String(url)}`);
    }
    const parsed = new URL(url);
    const normalizedSource = browserSourceFromHostname(parsed.hostname);
    const panelId = computePanelId({
      relativePath: normalizedSource,
      parent: parentId ? { id: parentId } : null,
      requestedId: opts?.name,
      isRoot: parentId == null,
    });
    const contextId = generateContextId(panelId);

    await this.tokenClient.ensurePanelToken(panelId, contextId, parentId, `browser:${url}`);

    const snapshot = createSnapshot(`browser:${url}`, contextId, {});
    try {
      await this.submitWorkspaceOps([{
        opId: this.createOpId("panel.create", panelId),
        type: "panel.create",
        panelId,
        parentId,
        positionId: this.rankForPosition(parentId, opts?.addAsRoot ? this.registry.getRootPanels().length : 0),
        snapshot,
        title: opts?.name ?? parsed.hostname,
      }]);

      return {
        panelId,
        contextId,
        source: `browser:${url}`,
        title: opts?.name ?? parsed.hostname,
        url,
        stateArgs: {},
        options: {},
      };
    } catch (error) {
      this.registry.removePanel(panelId);
      await Promise.resolve(this.tokenClient.revokePanelToken(panelId)).catch(() => {});
      throw error;
    }
  }

  async createFromSource(
    source: string,
    options?: { name?: string; stateArgs?: Record<string, unknown> },
  ): Promise<{ id: string; title: string }> {
    const result = await this.create(source, {
      name: options?.name,
      stateArgs: options?.stateArgs,
      isRoot: true,
      addAsRoot: true,
    });
    return { id: result.panelId, title: result.title };
  }

  async createAboutPanel(page: string): Promise<{ id: string; title: string }> {
    const result = await this.create(`about/${page}`, {
      name: `${page}~${Date.now().toString(36)}`,
      isRoot: true,
      addAsRoot: true,
    });
    return { id: result.panelId, title: result.title };
  }

  async close(panelId: string): Promise<{ closedIds: string[] }> {
    const closedIds = this.collectSubtree(panelId);
    await this.submitWorkspaceOps([{
      opId: this.createOpId("panel.archive", panelId),
      type: "panel.archive" as const,
      panelId,
    }]);
    for (const id of closedIds) this.registry.removePanel(id);
    for (const id of closedIds) {
      await this.tokenClient.revokePanelToken(id).catch((error: unknown) => {
        log.warn(`Failed to revoke panel token for ${id}: ${error instanceof Error ? error.message : String(error)}`);
      });
    }
    return { closedIds };
  }

  async closeChild(callerId: string, childId: string): Promise<void> {
    if (this.registry.findParentId(childId) !== callerId) {
      throw new Error(`Panel ${callerId} is not the parent of ${childId}`);
    }
    await this.close(childId);
  }

  getInfo(panelId: string): unknown {
    return this.registry.getInfo(panelId);
  }

  async updateStateArgs(panelId: string, updates: Record<string, unknown>): Promise<Record<string, unknown>> {
    const panel = await this.requireStoredPanel(panelId);
    const schema = this.loadPanelSchema(panel);
    const merged = { ...(getPanelStateArgs(panel) ?? {}), ...updates };
    for (const key of Object.keys(merged)) {
      if (merged[key] === null) delete merged[key];
    }

    const validation = validateStateArgs(merged, schema);
    if (!validation.success) {
      throw new Error(`Invalid stateArgs: ${validation.error}`);
    }

    const nextSnapshot = { ...getCurrentSnapshot(panel), stateArgs: validation.data };
    const nextHistory = this.replaceCurrentHistory(panel, nextSnapshot);
    await this.submitWorkspaceOps([{
      opId: this.createOpId("panel.setSnapshot", panelId),
      type: "panel.setSnapshot",
      panelId,
      snapshot: nextSnapshot,
      history: nextHistory,
    }]);
    if (this.registry.getPanel(panelId)) this.registry.replaceCurrentSnapshot(panelId, nextSnapshot, nextHistory);
    return validation.data as Record<string, unknown>;
  }

  async replaceCurrentSnapshot(
    panelId: string,
    updates: { contextId?: string; source?: string; stateArgs?: Record<string, unknown> },
  ): Promise<void> {
    const panel = await this.requireStoredPanel(panelId);
    const nextSnapshot = { ...getCurrentSnapshot(panel) };

    if (updates.contextId) nextSnapshot.contextId = updates.contextId;
    if (updates.source) {
      nextSnapshot.source = updates.source;
      const manifest = this.tryResolveManifestForSource(updates.source);
      if (manifest?.autoArchiveWhenEmpty) nextSnapshot.autoArchiveWhenEmpty = true;
      else delete nextSnapshot.autoArchiveWhenEmpty;
    }
    if (updates.stateArgs) nextSnapshot.stateArgs = updates.stateArgs;

    const nextHistory = this.replaceCurrentHistory(panel, nextSnapshot);
    await this.submitWorkspaceOps([{
      opId: this.createOpId("panel.setSnapshot", panelId),
      type: "panel.setSnapshot",
      panelId,
      snapshot: nextSnapshot,
      history: nextHistory,
    }]);
    if (this.registry.getPanel(panelId)) this.registry.replaceCurrentSnapshot(panelId, nextSnapshot, nextHistory);
    if (updates.contextId) {
      await this.tokenClient.updatePanelContext(panelId, updates.contextId);
    }
  }

  async navigate(panelId: string, source: string, opts?: NavigatePanelOptions): Promise<CreatePanelResult> {
    const panel = await this.requireStoredPanel(panelId);
    const nextSnapshot = this.createNavigationSnapshot(panel, source, opts);
    const manifest = this.tryResolveManifestForSource(nextSnapshot.source) ?? { title: path.basename(nextSnapshot.source) };

    const nextHistory = this.pushHistory(panel, nextSnapshot);
    await this.submitWorkspaceOps([
      {
        opId: this.createOpId("panel.setSnapshot", panelId),
        type: "panel.setSnapshot",
        panelId,
        snapshot: nextSnapshot,
        history: nextHistory,
      },
      {
        opId: this.createOpId("panel.setTitle", panelId),
        type: "panel.setTitle",
        panelId,
        title: manifest.title,
      },
    ]);

    const livePanel = this.registry.getPanel(panelId);
    if (livePanel) {
      livePanel.title = manifest.title;
      this.registry.replaceCurrentSnapshot(panelId, nextSnapshot, nextHistory);
    }

    if (nextSnapshot.contextId !== getPanelContextId(panel)) {
      await this.tokenClient.updatePanelContext(panelId, nextSnapshot.contextId);
    }
    this.indexPanel(panelId, manifest.title, nextSnapshot.source);

    return {
      panelId,
      contextId: nextSnapshot.contextId,
      source: nextSnapshot.source,
      title: manifest.title,
      stateArgs: (nextSnapshot.stateArgs ?? {}) as Record<string, unknown>,
      options: nextSnapshot.options,
      autoArchiveWhenEmpty: nextSnapshot.autoArchiveWhenEmpty,
    };
  }

  async navigateHistory(panelId: string, delta: -1 | 1): Promise<Panel | null> {
    const before = await this.requireStoredPanel(panelId);
    const nextHistory = this.navigateHistoryState(before, delta);
    const nextSnapshot = nextHistory.entries[nextHistory.index]!;
    await this.submitWorkspaceOps([{
      opId: this.createOpId("panel.setSnapshot", panelId),
      type: "panel.setSnapshot",
      panelId,
      snapshot: nextSnapshot,
      history: nextHistory,
    }]);
    const panel = await this.requireStoredPanel(panelId);

    const livePanel = this.registry.getPanel(panelId);
    if (livePanel) {
      livePanel.title = panel.title;
      this.registry.replaceCurrentSnapshot(panelId, getCurrentSnapshot(panel), panel.history);
    }
    if (getPanelContextId(panel) !== getPanelContextId(before)) {
      await this.tokenClient.updatePanelContext(panelId, getPanelContextId(panel));
    }
    return panel;
  }

  async updateTitle(panelId: string, title: string): Promise<void> {
    await this.submitWorkspaceOps([{
      opId: this.createOpId("panel.setTitle", panelId),
      type: "panel.setTitle",
      panelId,
      title,
    }]);
    const livePanel = this.registry.getPanel(panelId);
    if (livePanel) {
      livePanel.title = title;
    }
    this.searchIndex?.updateTitle(panelId, title);
  }

  async movePanel(panelId: string, newParentId: string | null, targetPosition: number): Promise<void> {
    await this.submitWorkspaceOps([{
      opId: this.createOpId("panel.move", panelId),
      type: "panel.move",
      panelId,
      parentId: newParentId,
      positionId: this.rankForPosition(newParentId, targetPosition, panelId),
    }]);
    this.registry.movePanel(panelId, newParentId, targetPosition);
    await this.tokenClient.updatePanelParent(panelId, newParentId);
  }

  async loadTree(): Promise<{ rootPanels: Panel[]; collapsedIds: string[] }> {
    await this.ensureViewStateLoaded();
    const snapshot = await this.workspaceSync.getSnapshot();
    this.lastSeenRevision = snapshot.revision;
    const rootPanels = snapshot.tree;
    await this.cleanupChildlessAutoArchivePanels(rootPanels);
    const activeRoots: Panel[] = [];
    for (const panel of rootPanels) {
      if (!await this.isAutoArchived(panel.id)) {
        activeRoots.push(panel);
      }
    }
    this.registry.repopulate(activeRoots, [...this.collapsedIds]);
    return { rootPanels: activeRoots, collapsedIds: [...this.collapsedIds] };
  }

  async shutdownCleanup(livePanelIds: string[]): Promise<void> {
    const liveSet = new Set(livePanelIds);
    const visit = async (panels: Panel[]) => {
      for (const panel of panels) {
        if (!liveSet.has(panel.id)) {
          await this.submitWorkspaceOps([{
            opId: this.createOpId("panel.archive", panel.id),
            type: "panel.archive",
            panelId: panel.id,
          }]);
          continue;
        }
        if (panel.children.length > 0) {
          await visit(panel.children);
        }
      }
    };
    const snapshot = await this.workspaceSync.getSnapshot();
    await visit(snapshot.tree);
  }

  async setCollapsed(panelId: string, collapsed: boolean): Promise<void> {
    await this.ensureViewStateLoaded();
    if (collapsed) this.collapsedIds.add(panelId);
    else this.collapsedIds.delete(panelId);
    this.registry.setCollapsed(panelId, collapsed);
    await this.persistViewState();
  }

  async expandIds(panelIds: string[]): Promise<void> {
    await this.ensureViewStateLoaded();
    for (const panelId of panelIds) this.collapsedIds.delete(panelId);
    this.registry.setCollapsedBatch(panelIds, false);
    await this.persistViewState();
  }

  async getCollapsedIds(): Promise<string[]> {
    await this.ensureViewStateLoaded();
    return [...this.collapsedIds];
  }

  async notifyFocused(panelId: string): Promise<void> {
    this.registry.updateSelectedPath(panelId);
    this.searchIndex?.incrementAccessCount(panelId);
    await this.activationClient?.markPanelActive(panelId).catch(() => {});
  }

  setCurrentTheme(theme: ThemeAppearance): void {
    const appearance = theme === "dark" ? "dark" : "light";
    this.currentTheme = appearance;
    this.registry.setCurrentTheme(appearance);
  }

  getCurrentTheme(): "light" | "dark" {
    return this.currentTheme;
  }

  getWorkspaceConfig(): WorkspaceConfig | undefined {
    return this.workspaceConfig;
  }

  listPanels() {
    return this.registry.listPanels();
  }

  async getPanelInit(panelId: string): Promise<unknown> {
    const panel = this.registry.getPanel(panelId) ?? await this.requireStoredPanel(panelId);
    const { token } = await this.tokenClient.ensurePanelToken(
      panelId,
      getPanelContextId(panel),
      this.registry.findParentId(panelId) ?? this.findParentIdInRegistry(panelId),
      getPanelSource(panel),
    );

    return buildBootstrapConfig({
      panelId,
      contextId: getPanelContextId(panel),
      parentId: this.registry.findParentId(panelId) ?? this.findParentIdInRegistry(panelId),
      source: getPanelSource(panel),
      theme: this.currentTheme,
      gatewayConfig: {
        serverUrl: this.serverInfo.gatewayConfig.serverUrl,
        token,
      },
      env: (getPanelOptions(panel).env ?? {}) as Record<string, string>,
      stateArgs: (getPanelStateArgs(panel) ?? {}) as Record<string, unknown>,
    });
  }

  private async cleanupChildlessAutoArchivePanels(panels: Panel[]): Promise<void> {
    for (const panel of panels) {
      if (panel.children.length > 0) {
        await this.cleanupChildlessAutoArchivePanels(panel.children);
        const nextChildren: Panel[] = [];
        for (const child of panel.children) {
          if (!await this.isAutoArchived(child.id)) {
            nextChildren.push(child);
          }
        }
        panel.children = nextChildren;
      }
      if (getCurrentSnapshot(panel).autoArchiveWhenEmpty && panel.children.length === 0) {
        await this.submitWorkspaceOps([{
          opId: this.createOpId("panel.archive", panel.id),
          type: "panel.archive",
          panelId: panel.id,
        }]);
      }
    }
  }

  private async ensureViewStateLoaded(): Promise<void> {
    if (this.viewStateLoaded) return;
    this.viewStateLoaded = true;
    const state = await Promise.resolve(this.viewState?.load()).catch(() => null);
    for (const panelId of state?.collapsedIds ?? []) {
      this.collapsedIds.add(panelId);
    }
  }

  private async persistViewState(): Promise<void> {
    await Promise.resolve(this.viewState?.save({ collapsedIds: [...this.collapsedIds] })).catch(() => {});
  }

  private async isAutoArchived(panelId: string): Promise<boolean> {
    void panelId;
    return false;
  }

  private collectSubtree(panelId: string): string[] {
    const panel = this.registry.getPanel(panelId);
    if (!panel) {
      throw new Error(`Panel not found: ${panelId}`);
    }
    const ids = [panelId];
    for (const child of panel.children) {
      ids.push(...this.collectSubtree(child.id));
    }
    return ids;
  }

  private hydratePanel(
    panelId: string,
    title: string,
    snapshot: PanelSnapshot,
    artifacts: Panel["artifacts"] = { buildState: "building", buildProgress: "Starting build..." },
  ): Panel {
    return {
      id: panelId,
      title,
      children: [],
      selectedChildId: null,
      snapshot,
      history: { entries: [snapshot], index: 0 },
      artifacts,
    };
  }

  private createNavigationSnapshot(panel: Panel, source: string, opts?: NavigatePanelOptions): PanelSnapshot {
    const { relativePath, absolutePath } = resolveSource(source, this.workspacePath);
    const manifest = this.resolveManifest(absolutePath, relativePath, this.allowMissingManifests);
    const validatedStateArgs = this.validateManifestStateArgs(relativePath, manifest.stateArgs, opts?.stateArgs);
    const currentSnapshot = getCurrentSnapshot(panel);
    const previousOptions = currentSnapshot.options;
    const snapshot = createSnapshot(
      relativePath,
      opts?.contextId ?? currentSnapshot.contextId,
      {
        env: opts?.env ?? previousOptions.env,
        ref: opts?.ref,
      },
      validatedStateArgs,
    );
    if (manifest.autoArchiveWhenEmpty) snapshot.autoArchiveWhenEmpty = true;
    return snapshot;
  }

  private pushHistory(panel: Panel, snapshot: PanelSnapshot): NonNullable<Panel["history"]> {
    const history = panel.history ?? { entries: [getCurrentSnapshot(panel)], index: 0 };
    const nextEntries = history.entries.slice(0, history.index + 1).concat(snapshot);
    return { entries: nextEntries, index: nextEntries.length - 1 };
  }

  private replaceCurrentHistory(panel: Panel, snapshot: PanelSnapshot): NonNullable<Panel["history"]> {
    const history = panel.history ?? { entries: [getCurrentSnapshot(panel)], index: 0 };
    const entries = history.entries.slice();
    entries[history.index] = snapshot;
    return { entries, index: history.index };
  }

  private navigateHistoryState(panel: Panel, delta: -1 | 1): NonNullable<Panel["history"]> {
    const history = panel.history ?? { entries: [getCurrentSnapshot(panel)], index: 0 };
    return {
      entries: history.entries,
      index: Math.max(0, Math.min(history.entries.length - 1, history.index + delta)),
    };
  }

  private resolveManifest(
    absolutePath: string,
    relativePath: string,
    allowMissing: boolean,
  ): { title: string; stateArgs?: unknown; autoArchiveWhenEmpty?: boolean } {
    try {
      return loadPanelManifest(absolutePath);
    } catch (error) {
      if (allowMissing) {
        return { title: path.basename(relativePath) };
      }
      throw new Error(
        `Failed to load manifest for ${relativePath}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private tryResolveManifestForSource(source: string) {
    try {
      const { absolutePath } = resolveSource(source, this.workspacePath);
      return loadPanelManifest(absolutePath);
    } catch {
      return null;
    }
  }

  private validateManifestStateArgs(
    source: string,
    schema: unknown,
    stateArgs?: Record<string, unknown>,
  ): Record<string, unknown> | undefined {
    if (!stateArgs && !schema) return undefined;
    const validation = validateStateArgs(stateArgs ?? {}, schema as never);
    if (!validation.success) {
      throw new Error(`Invalid stateArgs for ${source}: ${validation.error}`);
    }
    return validation.data as Record<string, unknown>;
  }

  private loadPanelSchema(panel: Panel) {
    try {
      const absolutePath = path.resolve(this.workspacePath, getPanelSource(panel));
      return loadPanelManifest(absolutePath).stateArgs;
    } catch {
      return undefined;
    }
  }

  private async requireStoredPanel(panelId: string): Promise<Panel> {
    let panel = this.registry.getPanel(panelId) ?? null;
    if (!panel) {
      await this.syncSnapshot();
      panel = this.registry.getPanel(panelId) ?? null;
    }
    if (!panel) throw new Error(`Panel not found: ${panelId}`);
    return panel;
  }

  private async submitWorkspaceOps(ops: SubmittedPanelOp[]): Promise<void> {
    const result = await this.workspaceSync.submitOps(this.lastSeenRevision, ops);
    const rejected = result.rejectedOps.filter((entry) => !result.acceptedOps.includes(entry.opId));
    this.lastSeenRevision = result.revision;
    if (rejected.length > 0) {
      throw new Error(`Workspace op rejected: ${rejected[0]!.reason}`);
    }
    await this.syncSnapshot();
  }

  private rankForPosition(parentId: string | null, targetPosition: number, excludePanelId?: string): string {
    const siblings = parentId
      ? (this.registry.getPanel(parentId)?.children ?? [])
      : this.registry.getRootPanels();
    const filtered = excludePanelId ? siblings.filter((panel) => panel.id !== excludePanelId) : siblings;
    const clamped = Math.max(0, Math.min(targetPosition, filtered.length));
    if (filtered.length === 0) return firstRank();
    return rankBetween(filtered[clamped - 1]?.positionId, filtered[clamped]?.positionId);
  }

  private findParentIdInRegistry(panelId: string): string | null {
    return this.registry.findParentId(panelId);
  }

  private createOpId(type: SubmittedPanelOp["type"], panelId: string): string {
    const random = globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2);
    return `${type}:${panelId}:${random}`;
  }

  private indexPanel(panelId: string, title: string, panelPath: string): void {
    if (!this.searchIndex) return;
    Promise.resolve(this.searchIndex.indexPanel({ id: panelId, title, path: panelPath })).catch((error) => {
      log.warn(`Failed to index panel ${panelId}:`, error);
    });
  }
}
