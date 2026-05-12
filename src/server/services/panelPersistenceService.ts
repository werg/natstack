import { z } from "zod";
import type { ServiceDefinition } from "@natstack/shared/serviceDefinition";
import type { DODispatch } from "../doDispatch.js";
import { INTERNAL_DO_SOURCE } from "../internalDOs/internalDoLoader.js";

const ref = (workspaceId: string) => ({
  source: INTERNAL_DO_SOURCE,
  className: "PanelStoreDO",
  objectKey: workspaceId,
});

export function createPanelPersistenceService(deps: { doDispatch: DODispatch; workspaceId: string }): ServiceDefinition {
  const dispatch = (method: string, args: unknown[]) =>
    deps.doDispatch.dispatch(ref(deps.workspaceId), method, ...args);

  const anyArgs = { args: z.array(z.unknown()) };

  return {
    name: "panel-persistence",
    description: "Panel tree persistence backed by the internal PanelStoreDO",
    policy: { allowed: ["shell", "server"] },
    methods: {
      createPanel: anyArgs,
      getPanel: anyArgs,
      getRootPanels: anyArgs,
      getChildren: anyArgs,
      getSiblings: anyArgs,
      getAncestors: anyArgs,
      getPanelContext: anyArgs,
      panelExists: anyArgs,
      getPanelCount: anyArgs,
      updatePanel: anyArgs,
      pushHistorySnapshot: anyArgs,
      navigateHistory: anyArgs,
      setSelectedChild: anyArgs,
      updateSelectedPath: anyArgs,
      setTitle: anyArgs,
      movePanel: anyArgs,
      getChildrenPaginated: anyArgs,
      getRootPanelsPaginated: anyArgs,
      getFullTree: anyArgs,
      getParentId: anyArgs,
      getCollapsedIds: anyArgs,
      setCollapsed: anyArgs,
      setCollapsedBatch: anyArgs,
      archivePanel: anyArgs,
      unarchivePanel: anyArgs,
      isArchived: anyArgs,
      indexPanel: anyArgs,
      search: anyArgs,
      incrementAccessCount: anyArgs,
      updateSearchTitle: anyArgs,
      rebuildIndex: anyArgs,
    },
    handler: async (_ctx, method, args) => {
      return dispatch(method, args);
    },
  };
}
