import { z } from "zod";
import type { ServiceDefinition } from "../serviceDefinition.js";
import type { PanelManager } from "../panelManager.js";
import type { ViewManager } from "../viewManager.js";
import type { ThemeAppearance, ShellPage } from "../../shared/types.js";
import { getPanelPersistence } from "../db/panelPersistence.js";
import { getPanelSearchIndex } from "../db/panelSearchIndex.js";
import { createDevLogger } from "../devLog.js";

const log = createDevLogger("PanelShellService");

export function createPanelShellService(deps: {
  panelManager: PanelManager;
  getViewManager: () => ViewManager;
}): ServiceDefinition {
  return {
    name: "panel",
    description: "Panel tree management, reload, close",
    policy: { allowed: ["shell"] },
    methods: {
      getTree: { args: z.tuple([]) },
      notifyFocused: { args: z.tuple([z.string()]) },
      updateTheme: { args: z.tuple([z.unknown()]) },
      openDevTools: { args: z.tuple([z.string()]) },
      reload: { args: z.tuple([z.string()]) },
      unload: { args: z.tuple([z.string()]) },
      archive: { args: z.tuple([z.string()]) },
      retryDirtyBuild: { args: z.tuple([z.string()]) },
      initGitRepo: { args: z.tuple([z.string()]) },
      updatePanelState: { args: z.tuple([z.string(), z.record(z.unknown())]) },
      createAboutPanel: { args: z.tuple([z.unknown()]) },
      movePanel: { args: z.tuple([z.object({ panelId: z.string(), newParentId: z.string().nullable(), targetPosition: z.number() })]) },
      getChildrenPaginated: { args: z.tuple([z.object({ parentId: z.string(), offset: z.number(), limit: z.number() })]) },
      getRootPanelsPaginated: { args: z.tuple([z.object({ offset: z.number(), limit: z.number() })]) },
      getCollapsedIds: { args: z.tuple([]) },
      setCollapsed: { args: z.tuple([z.string(), z.boolean()]) },
      expandIds: { args: z.tuple([z.array(z.string())]) },
    },
    handler: async (_ctx, method, args) => {
      const pm = deps.panelManager;
      const vm = deps.getViewManager();

      switch (method) {
        case "getTree":
          return pm.getSerializablePanelTree();

        case "notifyFocused": {
          const panelId = args[0] as string;

          if (vm.hasView(panelId)) {
            pm.sendPanelEvent(panelId, { type: "focus" });
          }

          try {
            pm.updateSelectedPath(panelId);
            const persistence = getPanelPersistence();
            persistence.updateSelectedPath(panelId);
            getPanelSearchIndex().incrementAccessCount(panelId);
            pm.notifyPanelTreeUpdate();
            vm.refreshVisiblePanel();
            void pm.rebuildUnloadedPanel(panelId);
          } catch (error) {
            console.error(`[Panel] Failed to update selected path for ${panelId}:`, error);
          }
          return;
        }

        case "updateTheme": {
          const theme = args[0] as ThemeAppearance;
          pm.setCurrentTheme(theme);
          pm.broadcastTheme(theme);
          return;
        }

        case "openDevTools": {
          const panelId = args[0] as string;
          if (!vm.hasView(panelId)) {
            throw new Error(`No view found for panel ${panelId}`);
          }
          vm.openDevTools(panelId);
          return;
        }

        case "reload": {
          const panelId = args[0] as string;
          if (!vm.hasView(panelId)) {
            await pm.rebuildUnloadedPanel(panelId);
            return;
          }
          vm.reload(panelId);
          return;
        }

        case "unload": {
          const panelId = args[0] as string;
          log.verbose(` Unload requested for panel: ${panelId}`);
          await pm.unloadPanel(panelId);
          return;
        }

        case "archive": {
          const panelId = args[0] as string;
          await pm.closePanel(panelId);
          return;
        }

        case "retryDirtyBuild": {
          const panelId = args[0] as string;
          await pm.retryBuild(panelId);
          return;
        }

        case "initGitRepo": {
          const panelId = args[0] as string;
          await pm.initializeGitRepo(panelId);
          return;
        }

        case "updatePanelState": {
          const [panelId, state] = args as [string, {
            url?: string;
            pageTitle?: string;
            isLoading?: boolean;
            canGoBack?: boolean;
            canGoForward?: boolean;
          }];
          pm.updatePanelState(panelId, state);
          return;
        }

        case "createAboutPanel": {
          const page = args[0] as ShellPage;
          return pm.createAboutPanel(page);
        }

        case "movePanel": {
          const { panelId, newParentId, targetPosition } = args[0] as {
            panelId: string;
            newParentId: string | null;
            targetPosition: number;
          };
          pm.movePanel(panelId, newParentId, targetPosition);
          return;
        }

        case "getChildrenPaginated": {
          const { parentId, offset, limit } = args[0] as {
            parentId: string;
            offset: number;
            limit: number;
          };
          return pm.getChildrenPaginated(parentId, offset, limit);
        }

        case "getRootPanelsPaginated": {
          const { offset, limit } = args[0] as { offset: number; limit: number };
          return pm.getRootPanelsPaginated(offset, limit);
        }

        case "getCollapsedIds":
          return pm.getCollapsedIds();

        case "setCollapsed": {
          const [panelId, collapsed] = args as [string, boolean];
          pm.setCollapsed(panelId, collapsed);
          return;
        }

        case "expandIds": {
          const [panelIds] = args as [string[]];
          pm.expandIds(panelIds);
          return;
        }

        default:
          throw new Error(`Unknown panel method: ${method}`);
      }
    },
  };
}
