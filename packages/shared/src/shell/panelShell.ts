/**
 * PanelShell - Shared panel tree management for shell clients.
 *
 * Owns a PanelRegistry (in-memory cache) and RPC bridge for mutations.
 * Data queries read from the local registry (instant, no network).
 * Lifecycle mutations go through RPC to the server, then resync the cache.
 *
 * Electron renderer: init() fetches tree via RPC, resync() after mutations.
 *   No periodic sync needed since panel-tree-updated events keep state fresh.
 * Mobile: init() + startPeriodicSync() to catch external mutations.
 */

import type { RpcBridge } from "@natstack/rpc";
import { PanelRegistry } from "../panelRegistry.js";
import type { Panel, PaginatedChildren, PaginatedRootPanels } from "../types.js";

export class PanelShell {
  readonly registry: PanelRegistry;
  private rpc: RpcBridge;
  private initialized = false;

  private stopSync?: () => void;

  constructor(rpc: RpcBridge, onTreeUpdated?: (tree: Panel[]) => void) {
    this.rpc = rpc;
    this.registry = new PanelRegistry({ onTreeUpdated });
  }

  // === Initialization ===
  async init(): Promise<void> {
    const { rootPanels, collapsedIds } = await this.rpc.call<{ rootPanels: Panel[]; collapsedIds: string[] }>(
      "main", "panel.loadTree"
    );
    this.registry.populateFromServer(rootPanels, collapsedIds);
    this.initialized = true;
  }

  // === Data queries (local registry -- instant, no network) ===
  getTree(): Panel[] {
    return this.registry.getSerializablePanelTree();
  }

  getChildrenPaginated(
    parentId: string,
    offset: number,
    limit: number,
  ): PaginatedChildren {
    return this.registry.getChildrenPaginated(parentId, offset, limit);
  }

  getRootPanelsPaginated(
    offset: number,
    limit: number,
  ): PaginatedRootPanels {
    return this.registry.getRootPanelsPaginated(offset, limit);
  }

  getCollapsedIds(): string[] {
    return this.registry.getCollapsedIds();
  }

  // === Lifecycle ops (server RPC + cache refresh) ===
  async archive(panelId: string): Promise<void> {
    await this.rpc.call("main", "panel.archive", panelId);
    this.resync();
  }

  async movePanel(panelId: string, newParentId: string | null, targetPosition: number): Promise<void> {
    await this.rpc.call("main", "panel.movePanel", { panelId, newParentId, targetPosition });
    this.resync();
  }

  async createAboutPanel(page: string): Promise<{ id: string; title: string }> {
    const result = await this.rpc.call<{ id: string; title: string }>("main", "panel.createAboutPanel", page);
    this.resync();
    return result;
  }

  async setCollapsed(panelId: string, collapsed: boolean): Promise<void> {
    await this.rpc.call("main", "panel.setCollapsed", panelId, collapsed);
    this.resync();
  }

  async expandIds(panelIds: string[]): Promise<void> {
    await this.rpc.call("main", "panel.expandIds", panelIds);
    this.resync();
  }

  async notifyFocused(panelId: string): Promise<void> {
    await this.rpc.call("main", "panel.notifyFocused", panelId);
    this.resync();
  }

  // === Credentials ===
  async getCredentials(panelId: string): Promise<{ rpcToken: string; rpcPort: number }> {
    const creds = await this.rpc.call<{ serverRpcToken: string; rpcPort: number }>(
      "main", "panel.getCredentials", panelId
    );
    return { rpcToken: creds.serverRpcToken, rpcPort: creds.rpcPort };
  }

  // === View management (pass-through to server, no cache impact) ===
  async unload(panelId: string): Promise<void> {
    await this.rpc.call("main", "panel.unload", panelId);
  }

  async updateTheme(theme: unknown): Promise<void> {
    await this.rpc.call("main", "panel.updateTheme", theme);
  }

  // === Public cache refresh ===
  /** Refresh the local cache from the server. Unlike resync(), this is public and awaitable. */
  async refresh(): Promise<void> {
    const { rootPanels, collapsedIds } = await this.rpc.call<{ rootPanels: Panel[]; collapsedIds: string[] }>(
      "main", "panel.loadTree"
    );
    this.registry.repopulate(rootPanels, collapsedIds);
  }

  // === Cache sync ===
  private resync(): void {
    // Skip resync if init() was never called -- avoids wasteful round-trips
    // when PanelShell is used only for RPC method routing (e.g. Electron renderer).
    if (!this.initialized) return;
    // Best-effort: don't block mutations on cache refresh.
    this.rpc.call<{ rootPanels: Panel[]; collapsedIds: string[] }>("main", "panel.loadTree")
      .then(({ rootPanels, collapsedIds }) => {
        this.registry.repopulate(rootPanels, collapsedIds);
      })
      .catch(() => { /* offline -- cache stays stale */ });
  }

  // === Periodic sync (catches external mutations from panels) ===
  startPeriodicSync(intervalMs = 30_000): void {
    this.stopPeriodicSync();
    const timer = setInterval(() => this.resync(), intervalMs);
    this.stopSync = () => clearInterval(timer);
  }

  stopPeriodicSync(): void {
    this.stopSync?.();
    this.stopSync = undefined;
  }

  dispose(): void {
    this.stopPeriodicSync();
  }
}
