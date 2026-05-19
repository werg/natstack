import * as path from "path";
import { randomBytes } from "crypto";
import { createDevLogger } from "@natstack/dev-log";
import type { PanelRegistry } from "../panelRegistry.js";
import type { Panel, PanelSnapshot, ThemeAppearance } from "../types.js";
import type { PanelSearchIndex } from "../panelSearchTypes.js";
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
import {
  createSnapshot,
  getCurrentSnapshot,
  getPanelContextId,
  getPanelOptions,
  getPanelSource,
  getPanelStateArgs,
} from "../panel/accessors.js";
import { between as rankBetween, first as firstRank } from "../lexorank.js";
import { canonicalEntityId } from "../runtime/entitySpec.js";
import type {
  RuntimeClient,
  SlotHistoryEntryInput,
  SlotHistoryRow,
  SlotRow,
  WorkspaceStateClient,
} from "./workspaceStateClient.js";

const log = createDevLogger("PanelManager");

// =============================================================================
// Public API surfaces
// =============================================================================

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

export interface PanelManagerDeps {
  registry: PanelRegistry;
  workspaceState: WorkspaceStateClient;
  runtime: RuntimeClient;
  activationClient?: ActivationClient;
  viewState?: LocalPanelViewStateStore;
  serverInfo: PanelManagerServerInfo;
  workspacePath: string;
  searchIndex?: PanelSearchIndex | null;
  workspaceConfig?: WorkspaceConfig;
  allowMissingManifests?: boolean;
  /**
   * Optional token issuer used to obtain a per-panel WS auth token when
   * building the bootstrap config delivered to a freshly mounted view.
   * Implementations should call into the shell's auth service.
   */
  grantConnection?(panelId: string): Promise<{ token: string }>;
}

// =============================================================================
// Helpers
// =============================================================================

function mintHistoryEntryKey(): string {
  return `nav-${randomBytes(8).toString("hex")}`;
}

interface LocalSlotEntry {
  entryKey: string;
  entityId: string;
  source: string;
  contextId: string;
  options: PanelSnapshot["options"];
  stateArgs?: Record<string, unknown>;
  autoArchiveWhenEmpty?: boolean;
}

// =============================================================================
// PanelManager
// =============================================================================

export class PanelManager {
  private readonly registry: PanelRegistry;
  private readonly workspaceState: WorkspaceStateClient;
  private readonly runtime: RuntimeClient;
  private readonly activationClient?: ActivationClient;
  private readonly viewState?: LocalPanelViewStateStore;
  private readonly serverInfo: PanelManagerServerInfo;
  private readonly workspacePath: string;
  private readonly searchIndex: PanelSearchIndex | null;
  private readonly workspaceConfig?: WorkspaceConfig;
  private readonly allowMissingManifests: boolean;
  private readonly grantConnectionImpl?: (panelId: string) => Promise<{ token: string }>;

  private readonly collapsedIds = new Set<string>();
  private currentTheme: "light" | "dark" = "dark";
  private viewStateLoaded = false;
  /**
   * Mirrors the slot's current panelEntityId by slotId. Tracks the *currently
   * active* panel entity per slot — what gets retired on the next navigation.
   * Kept in sync with the local registry after every navigation / sync.
   */
  private readonly currentEntityBySlot = new Map<string, string>();
  /**
   * Per-slot navigation history of {entryKey -> options} so back/forward
   * navigation can reconstruct snapshots with their original options. The
   * server stores source/contextId/stateArgs; options.env/ref are local-shell
   * detail (matches the prior op-log behaviour, which never persisted them
   * across restart either).
   */
  private readonly slotOptionsByEntryKey = new Map<
    string,
    Map<string, PanelSnapshot["options"]>
  >();

  constructor(deps: PanelManagerDeps) {
    this.registry = deps.registry;
    this.workspaceState = deps.workspaceState;
    this.runtime = deps.runtime;
    this.activationClient = deps.activationClient;
    this.viewState = deps.viewState;
    this.serverInfo = deps.serverInfo;
    this.workspacePath = deps.workspacePath;
    this.searchIndex = deps.searchIndex ?? null;
    this.workspaceConfig = deps.workspaceConfig;
    this.allowMissingManifests = deps.allowMissingManifests ?? false;
    this.grantConnectionImpl = deps.grantConnection;
  }

  // ===========================================================================
  // Sync
  // ===========================================================================

  /**
   * Pull the current slot tree from the server, fetch each slot's history and
   * current entity, and repopulate the local panel registry. Called at boot
   * and after any operation that wants a fresh view.
   */
  async syncSnapshot(): Promise<{ rootPanels: Panel[] }> {
    await this.ensureViewStateLoaded();
    const tree = await this.fetchPanelTree();
    this.registry.repopulate(tree, [...this.collapsedIds]);
    return { rootPanels: tree };
  }

  async loadTree(): Promise<{ rootPanels: Panel[]; collapsedIds: string[] }> {
    await this.ensureViewStateLoaded();
    const tree = await this.fetchPanelTree();
    this.registry.repopulate(tree, [...this.collapsedIds]);
    return { rootPanels: tree, collapsedIds: [...this.collapsedIds] };
  }

  // ===========================================================================
  // Create
  // ===========================================================================

  async create(source: string, opts?: CreatePanelOptions): Promise<CreatePanelResult> {
    const { relativePath, absolutePath } = resolveSource(source, this.workspacePath);
    const allowMissing = Boolean(opts?.contextId) || this.allowMissingManifests;
    const manifest = this.resolveManifest(absolutePath, relativePath, allowMissing);
    const validatedStateArgs = this.validateManifestStateArgs(
      relativePath,
      manifest.stateArgs,
      opts?.stateArgs,
    );

    const slotId = computePanelId({
      relativePath,
      parent: opts?.parentId ? { id: opts.parentId } : null,
      requestedId: opts?.name,
      isRoot: opts?.isRoot,
    });
    const contextId = opts?.contextId ?? generateContextId(slotId);
    const historyEntryKey = mintHistoryEntryKey();
    const stateArgsPayload = validatedStateArgs ?? {};
    const positionId = this.rankForPosition(
      opts?.parentId ?? null,
      opts?.addAsRoot ? this.registry.getRootPanels().length : 0,
    );

    const snapshot = createSnapshot(
      relativePath,
      contextId,
      { env: opts?.env, ref: opts?.ref },
      validatedStateArgs,
    );
    if (opts?.autoArchiveWhenEmpty || manifest.autoArchiveWhenEmpty) {
      snapshot.autoArchiveWhenEmpty = true;
    }

    const handle = await this.runtime.createEntity({
      kind: "panel",
      source: relativePath,
      key: historyEntryKey,
      contextId,
      stateArgs: stateArgsPayload,
    });

    try {
      await this.workspaceState.createSlot({
        slotId,
        parentSlotId: opts?.parentId ?? null,
        positionId,
        initialEntry: {
          entryKey: historyEntryKey,
          entityId: handle.id,
          source: relativePath,
          contextId,
          stateArgs: stateArgsPayload,
        },
      });
    } catch (error) {
      // Best-effort cleanup of the durable entity row.
      await this.runtime.retireEntity(handle.id).catch(() => {});
      throw error;
    }

    this.recordOptionsForEntry(slotId, historyEntryKey, snapshot.options);
    this.currentEntityBySlot.set(slotId, handle.id);

    const panel: Panel = {
      id: slotId,
      title: manifest.title,
      children: [],
      positionId,
      snapshot,
      history: { entries: [snapshot], index: 0 },
      artifacts: { buildState: "building", buildProgress: "Starting build..." },
    };
    this.registry.addPanel(panel, opts?.parentId ?? null, { addAsRoot: opts?.addAsRoot });

    this.indexPanel(slotId, manifest.title, relativePath);

    return {
      panelId: slotId,
      contextId,
      source: relativePath,
      title: manifest.title,
      stateArgs: stateArgsPayload,
      options: { env: opts?.env ?? {}, ...(opts?.ref ? { ref: opts.ref } : {}) },
      autoArchiveWhenEmpty: snapshot.autoArchiveWhenEmpty,
    };
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
    const slotId = computePanelId({
      relativePath: normalizedSource,
      parent: parentId ? { id: parentId } : null,
      requestedId: opts?.name,
      isRoot: parentId == null,
    });
    const contextId = generateContextId(slotId);
    const historyEntryKey = mintHistoryEntryKey();
    const browserSource = `browser:${url}`;
    const positionId = this.rankForPosition(
      parentId,
      opts?.addAsRoot ? this.registry.getRootPanels().length : 0,
    );

    const snapshot = createSnapshot(browserSource, contextId, {});

    const handle = await this.runtime.createEntity({
      kind: "panel",
      source: browserSource,
      key: historyEntryKey,
      contextId,
    });

    try {
      await this.workspaceState.createSlot({
        slotId,
        parentSlotId: parentId,
        positionId,
        initialEntry: {
          entryKey: historyEntryKey,
          entityId: handle.id,
          source: browserSource,
          contextId,
          stateArgs: {},
        },
      });
    } catch (error) {
      await this.runtime.retireEntity(handle.id).catch(() => {});
      throw error;
    }

    this.recordOptionsForEntry(slotId, historyEntryKey, snapshot.options);
    this.currentEntityBySlot.set(slotId, handle.id);

    const title = opts?.name ?? parsed.hostname;
    const panel: Panel = {
      id: slotId,
      title,
      children: [],
      positionId,
      snapshot,
      history: { entries: [snapshot], index: 0 },
      artifacts: { buildState: "ready", htmlPath: url },
    };
    this.registry.addPanel(panel, parentId, { addAsRoot: opts?.addAsRoot });

    return {
      panelId: slotId,
      contextId,
      source: browserSource,
      title,
      url,
      stateArgs: {},
      options: {},
    };
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

  // ===========================================================================
  // Close
  // ===========================================================================

  async close(slotId: string): Promise<{ closedIds: string[] }> {
    const closedIds = this.collectSubtree(slotId);

    // Retire each current panel entity (deepest-first to match cleanup ordering).
    for (let i = closedIds.length - 1; i >= 0; i--) {
      const id = closedIds[i]!;
      const entityId = this.currentEntityBySlot.get(id);
      if (entityId) {
        await this.runtime.retireEntity(entityId).catch((error: unknown) => {
          log.warn(
            `Failed to retire panel entity ${entityId} for slot ${id}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        });
      }
    }

    await this.workspaceState.closeSlot(slotId).catch((error: unknown) => {
      log.warn(
        `Failed to close slot ${slotId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    });

    for (const id of closedIds) {
      this.registry.removePanel(id);
      this.currentEntityBySlot.delete(id);
      this.slotOptionsByEntryKey.delete(id);
    }
    return { closedIds };
  }

  async closeChild(callerId: string, childId: string): Promise<void> {
    if (this.registry.findParentId(childId) !== callerId) {
      throw new Error(`Panel ${callerId} is not the parent of ${childId}`);
    }
    await this.close(childId);
  }

  // ===========================================================================
  // Mutate (state-args / snapshot / navigate / history)
  // ===========================================================================

  getInfo(slotId: string): unknown {
    return this.registry.getInfo(slotId);
  }

  async updateStateArgs(
    slotId: string,
    updates: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const panel = await this.requireStoredPanel(slotId);
    const schema = this.loadPanelSchema(panel);
    const merged = { ...(getPanelStateArgs(panel) ?? {}), ...updates };
    for (const key of Object.keys(merged)) {
      if (merged[key] === null) delete merged[key];
    }
    const validation = validateStateArgs(merged, schema);
    if (!validation.success) {
      throw new Error(`Invalid stateArgs: ${validation.error}`);
    }
    const nextStateArgs = validation.data as Record<string, unknown>;
    await this.workspaceState.updateCurrentStateArgs(slotId, nextStateArgs);
    const livePanel = this.registry.getPanel(slotId);
    if (livePanel) {
      const currentSnapshot = getCurrentSnapshot(livePanel);
      const nextSnapshot: PanelSnapshot = {
        ...currentSnapshot,
        stateArgs: nextStateArgs,
      };
      const history = livePanel.history ?? { entries: [currentSnapshot], index: 0 };
      const entries = history.entries.slice();
      entries[history.index] = nextSnapshot;
      this.registry.replaceCurrentSnapshot(slotId, nextSnapshot, {
        entries,
        index: history.index,
      });
    }
    return nextStateArgs;
  }

  /**
   * Identity is immutable: mint a new historyEntryKey, retire the old panel
   * entity, create a new one, and replace the current cursor's history entry
   * in-place (overwrite, do not append).
   */
  async replaceCurrentSnapshot(
    slotId: string,
    updates: { contextId?: string; source?: string; stateArgs?: Record<string, unknown> },
  ): Promise<void> {
    const panel = await this.requireStoredPanel(slotId);
    const currentSnapshot = getCurrentSnapshot(panel);
    const nextSource = updates.source ?? currentSnapshot.source;
    const nextContextId = updates.contextId ?? currentSnapshot.contextId;
    const nextStateArgs =
      updates.stateArgs !== undefined
        ? updates.stateArgs
        : ((currentSnapshot.stateArgs ?? {}) as Record<string, unknown>);

    const nextSnapshot: PanelSnapshot = {
      ...currentSnapshot,
      source: nextSource,
      contextId: nextContextId,
      stateArgs: nextStateArgs,
    };
    if (updates.source) {
      const manifest = this.tryResolveManifestForSource(updates.source);
      if (manifest?.autoArchiveWhenEmpty) nextSnapshot.autoArchiveWhenEmpty = true;
      else delete nextSnapshot.autoArchiveWhenEmpty;
    }

    await this.replaceHistoryAtCurrent(slotId, panel, nextSnapshot);
  }

  async navigate(
    slotId: string,
    source: string,
    opts?: NavigatePanelOptions,
  ): Promise<CreatePanelResult> {
    const panel = await this.requireStoredPanel(slotId);
    const nextSnapshot = this.createNavigationSnapshot(panel, source, opts);
    const manifest =
      this.tryResolveManifestForSource(nextSnapshot.source) ?? {
        title: path.basename(nextSnapshot.source),
      };

    const currentEntityId =
      this.currentEntityBySlot.get(slotId) ?? this.deriveEntityIdFromPanel(panel);
    if (currentEntityId) {
      await this.runtime.retireEntity(currentEntityId).catch((error: unknown) => {
        log.warn(
          `Failed to retire panel entity ${currentEntityId} on navigate: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });
    }

    const historyEntryKey = mintHistoryEntryKey();
    const stateArgsPayload = (nextSnapshot.stateArgs ?? {}) as Record<string, unknown>;
    const handle = await this.runtime.createEntity({
      kind: "panel",
      source: nextSnapshot.source,
      key: historyEntryKey,
      contextId: nextSnapshot.contextId,
      stateArgs: stateArgsPayload,
      ref: nextSnapshot.options.ref,
    });

    await this.workspaceState.appendSlotHistory(slotId, {
      entryKey: historyEntryKey,
      entityId: handle.id,
      source: nextSnapshot.source,
      contextId: nextSnapshot.contextId,
      stateArgs: stateArgsPayload,
    });
    await this.workspaceState.setSlotCurrent(slotId, historyEntryKey);

    this.recordOptionsForEntry(slotId, historyEntryKey, nextSnapshot.options);
    this.currentEntityBySlot.set(slotId, handle.id);

    const livePanel = this.registry.getPanel(slotId);
    const nextHistory = this.pushHistory(panel, nextSnapshot);
    if (livePanel) {
      livePanel.title = manifest.title;
      this.registry.replaceCurrentSnapshot(slotId, nextSnapshot, nextHistory);
    }

    this.indexPanel(slotId, manifest.title, nextSnapshot.source);

    return {
      panelId: slotId,
      contextId: nextSnapshot.contextId,
      source: nextSnapshot.source,
      title: manifest.title,
      stateArgs: stateArgsPayload,
      options: nextSnapshot.options,
      autoArchiveWhenEmpty: nextSnapshot.autoArchiveWhenEmpty,
    };
  }

  async navigateHistory(slotId: string, delta: -1 | 1): Promise<Panel | null> {
    const before = await this.requireStoredPanel(slotId);
    const history = before.history;
    if (!history) return before;
    const targetIndex = Math.max(
      0,
      Math.min(history.entries.length - 1, history.index + delta),
    );
    if (targetIndex === history.index) return before;
    const targetSnapshot = history.entries[targetIndex]!;

    const slotHistory = await this.workspaceState.getSlotHistory(slotId);
    // Server history is recorded in append order; align by source+context+cursor.
    const targetEntryKey =
      slotHistory[targetIndex]?.entry_key ?? this.findEntryKeyForSnapshot(slotHistory, targetSnapshot);
    if (!targetEntryKey) {
      throw new Error(
        `Slot ${slotId} history has no entry at cursor ${targetIndex} matching local snapshot`,
      );
    }
    const targetEntityId =
      slotHistory[targetIndex]?.entity_id ??
      canonicalEntityId({ kind: "panel", key: targetEntryKey });
    const currentEntityId =
      this.currentEntityBySlot.get(slotId) ?? this.deriveEntityIdFromPanel(before);
    if (currentEntityId && currentEntityId !== targetEntityId) {
      await this.runtime.retireEntity(currentEntityId).catch((error: unknown) => {
        log.warn(
          `Failed to retire panel entity ${currentEntityId} on history navigate: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });
    }

    // Reactivate (or no-op for the same identity).
    const stateArgsPayload = (targetSnapshot.stateArgs ?? {}) as Record<string, unknown>;
    const handle = await this.runtime.createEntity({
      kind: "panel",
      source: targetSnapshot.source,
      key: targetEntryKey,
      contextId: targetSnapshot.contextId,
      stateArgs: stateArgsPayload,
      ref: targetSnapshot.options.ref,
    });
    await this.workspaceState.setSlotCurrent(slotId, targetEntryKey);
    this.currentEntityBySlot.set(slotId, handle.id);

    const livePanel = this.registry.getPanel(slotId);
    const nextHistoryState = {
      entries: history.entries,
      index: targetIndex,
    };
    if (livePanel) {
      this.registry.replaceCurrentSnapshot(slotId, targetSnapshot, nextHistoryState);
    }
    return this.registry.getPanel(slotId) ?? null;
  }

  async updateTitle(slotId: string, title: string): Promise<void> {
    const livePanel = this.registry.getPanel(slotId);
    if (livePanel) livePanel.title = title;
    this.searchIndex?.updateTitle(slotId, title);
    this.registry.notifyPanelTreeUpdate();
  }

  async movePanel(
    slotId: string,
    newParentId: string | null,
    targetPosition: number,
  ): Promise<void> {
    const positionId = this.rankForPosition(newParentId, targetPosition, slotId);
    await this.workspaceState.moveSlot(slotId, newParentId, positionId);
    this.registry.movePanel(slotId, newParentId, targetPosition);
  }

  // ===========================================================================
  // Lifecycle / shutdown
  // ===========================================================================

  /**
   * Sweep any slot whose `slotId` is missing from `livePanelIds`. Used at
   * server shutdown to clean up panels that died with the shell. The new
   * model: close the slot via workspace-state and let cleanup hooks fire.
   */
  async shutdownCleanup(livePanelIds: string[]): Promise<void> {
    const liveSet = new Set(livePanelIds);
    const slots = await this.workspaceState.listSlots();
    for (const slot of slots) {
      if (slot.closed_at != null) continue;
      if (liveSet.has(slot.slot_id)) continue;
      const entityId = slot.current_entity_id;
      if (entityId) {
        await this.runtime.retireEntity(entityId).catch(() => {});
      }
      await this.workspaceState.closeSlot(slot.slot_id).catch(() => {});
    }
  }

  async setCollapsed(slotId: string, collapsed: boolean): Promise<void> {
    await this.ensureViewStateLoaded();
    if (collapsed) this.collapsedIds.add(slotId);
    else this.collapsedIds.delete(slotId);
    this.registry.setCollapsed(slotId, collapsed);
    await this.persistViewState();
  }

  async expandIds(slotIds: string[]): Promise<void> {
    await this.ensureViewStateLoaded();
    for (const slotId of slotIds) this.collapsedIds.delete(slotId);
    this.registry.setCollapsedBatch(slotIds, false);
    await this.persistViewState();
  }

  async getCollapsedIds(): Promise<string[]> {
    await this.ensureViewStateLoaded();
    return [...this.collapsedIds];
  }

  async notifyFocused(slotId: string): Promise<void> {
    this.registry.updateSelectedPath(slotId);
    this.searchIndex?.incrementAccessCount(slotId);
    await this.activationClient?.markPanelActive(slotId).catch(() => {});
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

  async getPanelInit(slotId: string): Promise<unknown> {
    const panel = this.registry.getPanel(slotId) ?? (await this.requireStoredPanel(slotId));
    const parentId = this.registry.findParentId(slotId) ?? this.findParentIdInRegistry(slotId);
    // The grant is bound to the panel's current ENTITY id (panel:<historyEntryKey>),
    // not the slotId — that's what `connectionGrants` validates against the
    // entity cache, and what the panel uses as its RPC `caller.runtime.id`.
    const entityId = this.currentEntityBySlot.get(slotId)
      ?? (await this.resolveCurrentEntityIdForSlot(slotId));
    const token = this.grantConnectionImpl
      ? (await this.grantConnectionImpl(entityId)).token
      : (this.serverInfo.gatewayConfig.token ?? "");

    return buildBootstrapConfig({
      entityId,
      slotId,
      contextId: getPanelContextId(panel),
      parentId,
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

  async getCurrentEntityId(slotId: string): Promise<string> {
    return this.resolveCurrentEntityIdForSlot(slotId);
  }

  // ===========================================================================
  // Private — tree reconstruction
  // ===========================================================================

  private async fetchPanelTree(): Promise<Panel[]> {
    const slots = await this.workspaceState.listSlots();
    const openSlots = slots.filter((s) => s.closed_at == null);
    const histories = new Map<string, SlotHistoryRow[]>();
    for (const slot of openSlots) {
      const rows = await this.workspaceState.getSlotHistory(slot.slot_id);
      histories.set(slot.slot_id, rows);
    }

    const slotById = new Map(openSlots.map((slot) => [slot.slot_id, slot]));

    const buildPanel = (slot: SlotRow): Panel | null => {
      const history = histories.get(slot.slot_id) ?? [];
      if (history.length === 0) return null;
      const entries: PanelSnapshot[] = history.map((row) =>
        this.snapshotFromHistoryRow(slot.slot_id, row),
      );
      const cursor = this.resolveCursor(history, slot.current_entry_key) ?? entries.length - 1;
      const snapshot = entries[cursor]!;
      const currentEntityId = slot.current_entity_id ?? history[cursor]?.entity_id ?? null;
      if (currentEntityId) {
        this.currentEntityBySlot.set(slot.slot_id, currentEntityId);
      }
      const title = this.titleFor(slot.slot_id, snapshot.source);
      return {
        id: slot.slot_id,
        title,
        children: [],
        positionId: slot.position_id,
        snapshot,
        history: { entries, index: cursor },
        artifacts: { buildState: "building", buildProgress: "Restoring..." },
      };
    };

    // Build all panels then attach children by parent_slot_id.
    const panels = new Map<string, Panel>();
    for (const slot of openSlots) {
      const panel = buildPanel(slot);
      if (panel) panels.set(slot.slot_id, panel);
    }
    const roots: Panel[] = [];
    for (const slot of openSlots) {
      const panel = panels.get(slot.slot_id);
      if (!panel) continue;
      if (slot.parent_slot_id && panels.has(slot.parent_slot_id)) {
        panels.get(slot.parent_slot_id)!.children.push(panel);
      } else {
        roots.push(panel);
      }
    }
    const byPosition = (a: Panel, b: Panel) =>
      (a.positionId ?? "").localeCompare(b.positionId ?? "");
    const sortRecursive = (items: Panel[]) => {
      items.sort(byPosition);
      for (const item of items) sortRecursive(item.children);
    };
    sortRecursive(roots);
    void slotById;
    return roots;
  }

  private snapshotFromHistoryRow(slotId: string, row: SlotHistoryRow): PanelSnapshot {
    const stateArgs = row.state_args ? this.safeParseJson(row.state_args) : undefined;
    const options = this.optionsForEntry(slotId, row.entry_key) ?? {};
    return {
      source: row.source,
      contextId: row.context_id,
      options,
      stateArgs: stateArgs as PanelSnapshot["stateArgs"],
    };
  }

  private safeParseJson(value: string): unknown {
    try {
      return JSON.parse(value);
    } catch {
      return undefined;
    }
  }

  private resolveCursor(history: SlotHistoryRow[], currentEntryKey: string | null): number | null {
    if (!currentEntryKey) return history.length > 0 ? history.length - 1 : null;
    const idx = history.findIndex((row) => row.entry_key === currentEntryKey);
    return idx >= 0 ? idx : null;
  }

  private titleFor(slotId: string, source: string): string {
    const manifest = this.tryResolveManifestForSource(source);
    if (manifest?.title) return manifest.title;
    if (source.startsWith("browser:")) {
      try {
        return new URL(source.slice("browser:".length)).hostname;
      } catch {
        return path.basename(source);
      }
    }
    return path.basename(source) || slotId;
  }

  private recordOptionsForEntry(
    slotId: string,
    entryKey: string,
    options: PanelSnapshot["options"],
  ): void {
    let map = this.slotOptionsByEntryKey.get(slotId);
    if (!map) {
      map = new Map();
      this.slotOptionsByEntryKey.set(slotId, map);
    }
    map.set(entryKey, options);
  }

  private optionsForEntry(slotId: string, entryKey: string): PanelSnapshot["options"] | undefined {
    return this.slotOptionsByEntryKey.get(slotId)?.get(entryKey);
  }

  private findEntryKeyForSnapshot(
    rows: SlotHistoryRow[],
    snapshot: PanelSnapshot,
  ): string | null {
    for (const row of rows) {
      if (row.source === snapshot.source && row.context_id === snapshot.contextId) {
        return row.entry_key;
      }
    }
    return null;
  }

  private deriveEntityIdFromPanel(panel: Panel): string | null {
    const tracked = this.currentEntityBySlot.get(panel.id);
    if (tracked) return tracked;
    return null;
  }

  private async replaceHistoryAtCurrent(
    slotId: string,
    panel: Panel,
    nextSnapshot: PanelSnapshot,
  ): Promise<void> {
    const currentEntityId = this.currentEntityBySlot.get(slotId);
    if (currentEntityId) {
      await this.runtime.retireEntity(currentEntityId).catch(() => {});
    }
    const newEntryKey = mintHistoryEntryKey();
    const stateArgsPayload = (nextSnapshot.stateArgs ?? {}) as Record<string, unknown>;
    const handle = await this.runtime.createEntity({
      kind: "panel",
      source: nextSnapshot.source,
      key: newEntryKey,
      contextId: nextSnapshot.contextId,
      stateArgs: stateArgsPayload,
      ref: nextSnapshot.options.ref,
    });

    // Replace history at the current cursor (overwrite, not append).
    const existing = await this.workspaceState.getSlotHistory(slotId);
    const cursor = panel.history?.index ?? Math.max(0, existing.length - 1);
    const nextEntries: SlotHistoryEntryInput[] = existing.map((row, idx) =>
      idx === cursor
        ? {
            entryKey: newEntryKey,
            entityId: handle.id,
            source: nextSnapshot.source,
            contextId: nextSnapshot.contextId,
            stateArgs: stateArgsPayload,
          }
        : {
            entryKey: row.entry_key,
            entityId: row.entity_id,
            source: row.source,
            contextId: row.context_id,
            stateArgs: row.state_args ? this.safeParseJson(row.state_args) : undefined,
          },
    );
    if (nextEntries.length === 0) {
      nextEntries.push({
        entryKey: newEntryKey,
        entityId: handle.id,
        source: nextSnapshot.source,
        contextId: nextSnapshot.contextId,
        stateArgs: stateArgsPayload,
      });
    }
    await this.workspaceState.replaceSlotHistory(slotId, nextEntries, cursor);

    this.recordOptionsForEntry(slotId, newEntryKey, nextSnapshot.options);
    this.currentEntityBySlot.set(slotId, handle.id);

    const livePanel = this.registry.getPanel(slotId);
    if (livePanel) {
      const history = panel.history ?? { entries: [getCurrentSnapshot(panel)], index: 0 };
      const entries = history.entries.slice();
      entries[history.index] = nextSnapshot;
      this.registry.replaceCurrentSnapshot(slotId, nextSnapshot, {
        entries,
        index: history.index,
      });
    }
  }

  // ===========================================================================
  // Private — manifest / validation
  // ===========================================================================

  private createNavigationSnapshot(
    panel: Panel,
    source: string,
    opts?: NavigatePanelOptions,
  ): PanelSnapshot {
    const { relativePath, absolutePath } = resolveSource(source, this.workspacePath);
    const manifest = this.resolveManifest(absolutePath, relativePath, this.allowMissingManifests);
    const validatedStateArgs = this.validateManifestStateArgs(
      relativePath,
      manifest.stateArgs,
      opts?.stateArgs,
    );
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
        `Failed to load manifest for ${relativePath}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  private tryResolveManifestForSource(source: string) {
    if (source.startsWith("browser:")) return null;
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

  private async requireStoredPanel(slotId: string): Promise<Panel> {
    let panel = this.registry.getPanel(slotId) ?? null;
    if (!panel) {
      await this.syncSnapshot();
      panel = this.registry.getPanel(slotId) ?? null;
    }
    if (!panel) throw new Error(`Panel not found: ${slotId}`);
    return panel;
  }

  /**
   * Resolve the canonical entity id (`panel:<historyEntryKey>`) for a slot.
   * Used at panel-init time when the local `currentEntityBySlot` cache hasn't
   * been populated yet — e.g. just after a fresh app boot, before
   * `syncSnapshot` runs.
   */
  private async resolveCurrentEntityIdForSlot(slotId: string): Promise<string> {
    const fromCache = this.currentEntityBySlot.get(slotId);
    if (fromCache) return fromCache;
    const slot = await this.workspaceState.getSlot(slotId);
    if (!slot?.current_entity_id) {
      throw new Error(`Slot ${slotId} has no current panel entity`);
    }
    this.currentEntityBySlot.set(slotId, slot.current_entity_id);
    return slot.current_entity_id;
  }

  private collectSubtree(slotId: string): string[] {
    const panel = this.registry.getPanel(slotId);
    if (!panel) {
      throw new Error(`Panel not found: ${slotId}`);
    }
    const ids = [slotId];
    for (const child of panel.children) {
      ids.push(...this.collectSubtree(child.id));
    }
    return ids;
  }

  private async ensureViewStateLoaded(): Promise<void> {
    if (this.viewStateLoaded) return;
    this.viewStateLoaded = true;
    const state = await Promise.resolve(this.viewState?.load()).catch(() => null);
    for (const slotId of state?.collapsedIds ?? []) {
      this.collapsedIds.add(slotId);
    }
  }

  private async persistViewState(): Promise<void> {
    await Promise.resolve(this.viewState?.save({ collapsedIds: [...this.collapsedIds] })).catch(
      () => {},
    );
  }

  private rankForPosition(
    parentId: string | null,
    targetPosition: number,
    excludeSlotId?: string,
  ): string {
    const siblings = parentId
      ? this.registry.getPanel(parentId)?.children ?? []
      : this.registry.getRootPanels();
    const filtered = excludeSlotId
      ? siblings.filter((panel) => panel.id !== excludeSlotId)
      : siblings;
    const clamped = Math.max(0, Math.min(targetPosition, filtered.length));
    if (filtered.length === 0) return firstRank();
    return rankBetween(filtered[clamped - 1]?.positionId, filtered[clamped]?.positionId);
  }

  private findParentIdInRegistry(slotId: string): string | null {
    return this.registry.findParentId(slotId);
  }

  private indexPanel(slotId: string, title: string, panelPath: string): void {
    if (!this.searchIndex) return;
    Promise.resolve(this.searchIndex.indexPanel({ id: slotId, title, path: panelPath })).catch(
      (error) => {
        log.warn(`Failed to index panel ${slotId}:`, error);
      },
    );
  }
}
