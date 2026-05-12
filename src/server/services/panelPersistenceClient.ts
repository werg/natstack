import type {
  CreatePanelInput,
  IndexablePanel,
  PanelPersistence,
  PanelSearchIndex,
  UpdatePanelInput,
} from "@natstack/shared/panelPersistenceTypes";

interface RpcLike {
  call(service: string, method: string, args: unknown[]): Promise<unknown>;
}

export function createPanelPersistenceClient(rpc: RpcLike): PanelPersistence & PanelSearchIndex {
  const call = <T>(method: string, ...args: unknown[]) =>
    rpc.call("panel-persistence", method, args) as Promise<T>;

  return {
    createPanel: (input: CreatePanelInput) => call("createPanel", input),
    getPanel: (panelId: string) => call("getPanel", panelId),
    getRootPanels: () => call("getRootPanels"),
    getChildren: (parentId: string) => call("getChildren", parentId),
    getSiblings: (panelId: string) => call("getSiblings", panelId),
    getAncestors: (panelId: string) => call("getAncestors", panelId),
    getPanelContext: (panelId: string) => call("getPanelContext", panelId),
    panelExists: (panelId: string) => call("panelExists", panelId),
    getPanelCount: () => call("getPanelCount"),
    updatePanel: (panelId: string, input: UpdatePanelInput) => call("updatePanel", panelId, input),
    pushHistorySnapshot: (panelId: string, snapshot) => call("pushHistorySnapshot", panelId, snapshot),
    navigateHistory: (panelId: string, delta: -1 | 1) => call("navigateHistory", panelId, delta),
    setSelectedChild: (panelId: string, childId: string | null) => call("setSelectedChild", panelId, childId),
    updateSelectedPath: (focusedPanelId: string) => call("updateSelectedPath", focusedPanelId),
    setTitle: (panelId: string, title: string) => call("setTitle", panelId, title),
    movePanel: (panelId: string, newParentId: string | null, targetPosition: number) => call("movePanel", panelId, newParentId, targetPosition),
    getChildrenPaginated: (parentId: string, offset: number, limit: number) => call("getChildrenPaginated", parentId, offset, limit),
    getRootPanelsPaginated: (offset: number, limit: number) => call("getRootPanelsPaginated", offset, limit),
    getFullTree: () => call("getFullTree"),
    getParentId: (panelId: string) => call("getParentId", panelId),
    getCollapsedIds: () => call("getCollapsedIds"),
    setCollapsed: (panelId: string, collapsed: boolean) => call("setCollapsed", panelId, collapsed),
    setCollapsedBatch: (panelIds: string[], collapsed: boolean) => call("setCollapsedBatch", panelIds, collapsed),
    archivePanel: (panelId: string) => call("archivePanel", panelId),
    unarchivePanel: (panelId: string) => call("unarchivePanel", panelId),
    isArchived: (panelId: string) => call("isArchived", panelId),
    close: () => undefined,
    indexPanel: (panel: IndexablePanel) => call("indexPanel", panel),
    search: (query: string, limit?: number) => call("search", query, limit),
    incrementAccessCount: (panelId: string) => call("incrementAccessCount", panelId),
    updateTitle: (panelId: string, title: string) => call("updateSearchTitle", panelId, title),
    rebuildIndex: () => call("rebuildIndex"),
  };
}
