import * as path from "path";
import { createDevLogger } from "@natstack/dev-log";
import type { PanelRegistry } from "../panelRegistry.js";
import type { Panel, ThemeAppearance } from "../types.js";
import type { PanelSearchIndex } from "../db/panelSearchIndex.js";
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
import { createSnapshot, getPanelContextId, getPanelSource, getPanelStateArgs } from "../panel/accessors.js";
import type { PanelStore } from "./panelStore.js";

const log = createDevLogger("PanelManager");

export interface TokenClient {
  ensurePanelToken(
    panelId: string,
    contextId: string,
    parentId: string | null,
    source?: string,
  ): Promise<{ token: string; gitToken: string }>;
  revokePanelToken(panelId: string): Promise<void>;
  updatePanelContext(panelId: string, contextId: string): Promise<void>;
  updatePanelParent(panelId: string, parentId: string | null): Promise<void>;
}

export interface PanelManagerServerInfo {
  protocol: "http" | "https";
  externalHost: string;
  gatewayPort: number;
  rpcPort: number;
  workerdPort: number;
  gitBaseUrl: string;
  rpcWsUrl: string;
  pubsubUrl: string;
}

export interface CreatePanelOptions {
  parentId?: string;
  name?: string;
  contextId?: string;
  env?: Record<string, string>;
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

export interface PanelManagerDeps {
  store: PanelStore;
  registry: PanelRegistry;
  tokenClient: TokenClient;
  serverInfo: PanelManagerServerInfo;
  workspacePath: string;
  searchIndex?: PanelSearchIndex | null;
  workspaceConfig?: WorkspaceConfig;
  allowMissingManifests?: boolean;
}

export class PanelManager {
  private readonly store: PanelStore;
  private readonly registry: PanelRegistry;
  private readonly tokenClient: TokenClient;
  private readonly serverInfo: PanelManagerServerInfo;
  private readonly workspacePath: string;
  private readonly searchIndex: PanelSearchIndex | null;
  private readonly workspaceConfig?: WorkspaceConfig;
  private readonly allowMissingManifests: boolean;
  private currentTheme: "light" | "dark" = "dark";

  constructor(deps: PanelManagerDeps) {
    this.store = deps.store;
    this.registry = deps.registry;
    this.tokenClient = deps.tokenClient;
    this.serverInfo = deps.serverInfo;
    this.workspacePath = deps.workspacePath;
    this.searchIndex = deps.searchIndex ?? null;
    this.workspaceConfig = deps.workspaceConfig;
    this.allowMissingManifests = deps.allowMissingManifests ?? false;
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

    const snapshot = createSnapshot(relativePath, contextId, { env: opts?.env }, validatedStateArgs);
    if (opts?.autoArchiveWhenEmpty || manifest.autoArchiveWhenEmpty) {
      snapshot.autoArchiveWhenEmpty = true;
    }

    let createdInStore = false;
    try {
      await this.store.createPanel({
        id: panelId,
        title: manifest.title,
        parentId: opts?.parentId ?? null,
        snapshot,
      });
      createdInStore = true;

      if (opts?.parentId) {
        await this.store.setSelectedChild(opts.parentId, panelId);
      }

      const panel = this.hydratePanel(panelId, manifest.title, snapshot);
      this.registry.addPanel(panel, opts?.parentId ?? null, { addAsRoot: opts?.addAsRoot });
      this.indexPanel(panelId, manifest.title, relativePath);

      return {
        panelId,
        contextId,
        source: relativePath,
        title: manifest.title,
        stateArgs: validatedStateArgs ?? {},
        options: { env: opts?.env ?? {} },
        autoArchiveWhenEmpty: snapshot.autoArchiveWhenEmpty,
      };
    } catch (error) {
      if (createdInStore) {
        await Promise.resolve(this.store.archivePanel(panelId)).catch(() => {});
      }
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
    let createdInStore = false;
    try {
      await this.store.createPanel({
        id: panelId,
        title: opts?.name ?? parsed.hostname,
        parentId,
        snapshot,
      });
      createdInStore = true;

      if (parentId) {
        await this.store.setSelectedChild(parentId, panelId);
      }

      const panel = this.hydratePanel(panelId, opts?.name ?? parsed.hostname, snapshot, {
        buildState: "ready",
        htmlPath: url,
      });
      this.registry.addPanel(panel, parentId, { addAsRoot: opts?.addAsRoot });

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
      if (createdInStore) {
        await Promise.resolve(this.store.archivePanel(panelId)).catch(() => {});
      }
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
    for (const id of closedIds) {
      await this.tokenClient.revokePanelToken(id);
      await this.store.archivePanel(id);
      this.registry.removePanel(id);
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

    const nextSnapshot = { ...panel.snapshot, stateArgs: validation.data };
    await this.store.updatePanel(panelId, { snapshot: nextSnapshot });
    this.registry.updateStateArgs(panelId, validation.data as Record<string, unknown>);
    return validation.data as Record<string, unknown>;
  }

  async updateContext(
    panelId: string,
    updates: { contextId?: string; source?: string; stateArgs?: Record<string, unknown> },
  ): Promise<void> {
    const panel = await this.requireStoredPanel(panelId);
    const nextSnapshot = { ...panel.snapshot };

    if (updates.contextId) nextSnapshot.contextId = updates.contextId;
    if (updates.source) {
      nextSnapshot.source = updates.source;
      const manifest = this.tryResolveManifestForSource(updates.source);
      if (manifest?.autoArchiveWhenEmpty) nextSnapshot.autoArchiveWhenEmpty = true;
      else delete nextSnapshot.autoArchiveWhenEmpty;
    }
    if (updates.stateArgs) nextSnapshot.stateArgs = updates.stateArgs;

    await this.store.updatePanel(panelId, { snapshot: nextSnapshot });
    const livePanel = this.registry.getPanel(panelId);
    if (livePanel) {
      livePanel.snapshot = nextSnapshot;
    }
    if (updates.contextId) {
      await this.tokenClient.updatePanelContext(panelId, updates.contextId);
    }
  }

  async updateTitle(panelId: string, title: string): Promise<void> {
    await this.store.setTitle(panelId, title);
    const livePanel = this.registry.getPanel(panelId);
    if (livePanel) {
      livePanel.title = title;
    }
    this.searchIndex?.updateTitle(panelId, title);
  }

  async movePanel(panelId: string, newParentId: string | null, targetPosition: number): Promise<void> {
    await this.store.movePanel(panelId, newParentId, targetPosition);
    this.registry.movePanel(panelId, newParentId, targetPosition);
    await this.tokenClient.updatePanelParent(panelId, newParentId);
  }

  async loadTree(): Promise<{ rootPanels: Panel[]; collapsedIds: string[] }> {
    const rootPanels = await this.store.getFullTree();
    await this.cleanupChildlessAutoArchivePanels(rootPanels);
    const activeRoots: Panel[] = [];
    for (const panel of rootPanels) {
      if (!await this.isAutoArchived(panel.id)) {
        activeRoots.push(panel);
      }
    }
    const collapsedIds = await this.store.getCollapsedIds();
    this.registry.repopulate(activeRoots, collapsedIds);
    return { rootPanels: activeRoots, collapsedIds };
  }

  async shutdownCleanup(livePanelIds: string[]): Promise<void> {
    const liveSet = new Set(livePanelIds);
    const visit = async (panels: Panel[]) => {
      for (const panel of panels) {
        if (!liveSet.has(panel.id)) {
          await this.store.archivePanel(panel.id);
        }
        if (panel.children.length > 0) {
          await visit(panel.children);
        }
      }
    };
    await visit(await this.store.getFullTree());
  }

  async setCollapsed(panelId: string, collapsed: boolean): Promise<void> {
    await this.store.setCollapsed(panelId, collapsed);
    this.registry.setCollapsed(panelId, collapsed);
  }

  async expandIds(panelIds: string[]): Promise<void> {
    await this.store.setCollapsedBatch(panelIds, false);
    this.registry.setCollapsedBatch(panelIds, false);
  }

  getCollapsedIds(): Promise<string[]> {
    return Promise.resolve(this.store.getCollapsedIds());
  }

  async notifyFocused(panelId: string): Promise<void> {
    await this.store.updateSelectedPath(panelId);
    this.registry.updateSelectedPath(panelId);
    this.searchIndex?.incrementAccessCount(panelId);
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
    const { token, gitToken } = await this.tokenClient.ensurePanelToken(
      panelId,
      getPanelContextId(panel),
      this.registry.findParentId(panelId) ?? await this.store.getParentId(panelId),
      getPanelSource(panel),
    );

    return buildBootstrapConfig({
      panelId,
      contextId: getPanelContextId(panel),
      parentId: this.registry.findParentId(panelId) ?? await this.store.getParentId(panelId),
      source: getPanelSource(panel),
      theme: this.currentTheme,
      rpcWsUrl: this.serverInfo.rpcWsUrl,
      rpcToken: token,
      gitToken,
      gitBaseUrl: this.serverInfo.gitBaseUrl,
      pubsubUrl: this.serverInfo.pubsubUrl,
      env: (panel.snapshot.options.env ?? {}) as Record<string, string>,
      stateArgs: (panel.snapshot.stateArgs ?? {}) as Record<string, unknown>,
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
      if (panel.snapshot.autoArchiveWhenEmpty && panel.children.length === 0) {
        await this.store.archivePanel(panel.id);
      }
    }
  }

  private async isAutoArchived(panelId: string): Promise<boolean> {
    try {
      return Boolean(await this.store.isArchived(panelId));
    } catch {
      return false;
    }
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
    snapshot: Panel["snapshot"],
    artifacts: Panel["artifacts"] = { buildState: "building", buildProgress: "Starting build..." },
  ): Panel {
    return {
      id: panelId,
      title,
      children: [],
      selectedChildId: null,
      snapshot,
      artifacts,
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
    const panel = await this.store.getPanel(panelId);
    if (!panel) throw new Error(`Panel not found: ${panelId}`);
    return panel;
  }

  private indexPanel(panelId: string, title: string, panelPath: string): void {
    if (!this.searchIndex) return;
    try {
      this.searchIndex.indexPanel({ id: panelId, title, path: panelPath });
    } catch (error) {
      log.warn(`Failed to index panel ${panelId}:`, error);
    }
  }
}
