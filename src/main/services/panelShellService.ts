import { z } from "zod";
import type { ServiceDefinition } from "../../shared/serviceDefinition.js";
import type { PanelLifecycle } from "../../shared/panelLifecycle.js";
import type { PanelRegistry } from "../../shared/panelRegistry.js";
import type { PanelView } from "../panelView.js";
import type { ViewManager } from "../viewManager.js";
import type { ThemeAppearance } from "../../shared/types.js";
import { getPanelPersistence } from "../../shared/db/panelPersistence.js";
import { getPanelSearchIndex } from "../../shared/db/panelSearchIndex.js";
import { createDevLogger } from "../../shared/devLog.js";

const log = createDevLogger("PanelShellService");

export function createPanelShellService(deps: {
  panelLifecycle: PanelLifecycle;
  panelRegistry: PanelRegistry;
  panelView: PanelView;
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
      const lifecycle = deps.panelLifecycle;
      const registry = deps.panelRegistry;
      const pv = deps.panelView;
      const vm = deps.getViewManager();

      switch (method) {
        case "getTree":
          return registry.getSerializablePanelTree();

        case "notifyFocused": {
          const panelId = args[0] as string;

          if (pv.hasView(panelId)) {
            lifecycle.sendPanelEvent(panelId, { type: "focus" });
          }

          try {
            registry.updateSelectedPath(panelId);
            const persistence = getPanelPersistence();
            persistence.updateSelectedPath(panelId);
            getPanelSearchIndex().incrementAccessCount(panelId);
            registry.notifyPanelTreeUpdate();
            vm.refreshVisiblePanel();
            void lifecycle.rebuildUnloadedPanel(panelId);
          } catch (error) {
            console.error(`[Panel] Failed to update selected path for ${panelId}:`, error);
          }
          return;
        }

        case "updateTheme": {
          const theme = args[0] as ThemeAppearance;
          lifecycle.setCurrentTheme(theme);
          lifecycle.broadcastTheme(theme);
          return;
        }

        case "openDevTools": {
          const panelId = args[0] as string;
          if (!pv.hasView(panelId)) {
            throw new Error(`No view found for panel ${panelId}`);
          }
          pv.openDevTools(panelId);
          return;
        }

        case "reload": {
          const panelId = args[0] as string;
          if (!pv.hasView(panelId)) {
            await lifecycle.rebuildUnloadedPanel(panelId);
            return;
          }
          vm.reload(panelId);
          return;
        }

        case "unload": {
          const panelId = args[0] as string;
          log.verbose(` Unload requested for panel: ${panelId}`);
          await lifecycle.unloadPanel(panelId);
          return;
        }

        case "archive": {
          const panelId = args[0] as string;
          await lifecycle.closePanel(panelId);
          return;
        }

        case "retryDirtyBuild": {
          const panelId = args[0] as string;
          await lifecycle.retryBuild(panelId);
          return;
        }

        case "initGitRepo": {
          const panelId = args[0] as string;
          await lifecycle.initializeGitRepo(panelId);
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
          // updatePanelState is handled by PanelView's browser state tracking
          // This was a method on PanelManager that's now in PanelView
          // For now, delegate to the panel view
          void state;
          void panelId;
          return;
        }

        case "createAboutPanel": {
          const page = args[0] as string;
          return lifecycle.createAboutPanel(page);
        }

        case "movePanel": {
          const { panelId, newParentId, targetPosition } = args[0] as {
            panelId: string;
            newParentId: string | null;
            targetPosition: number;
          };
          registry.movePanel(panelId, newParentId, targetPosition);
          return;
        }

        case "getChildrenPaginated": {
          const { parentId, offset, limit } = args[0] as {
            parentId: string;
            offset: number;
            limit: number;
          };
          return registry.getChildrenPaginated(parentId, offset, limit);
        }

        case "getRootPanelsPaginated": {
          const { offset, limit } = args[0] as { offset: number; limit: number };
          return registry.getRootPanelsPaginated(offset, limit);
        }

        case "getCollapsedIds":
          return registry.getCollapsedIds();

        case "setCollapsed": {
          const [panelId, collapsed] = args as [string, boolean];
          registry.setCollapsed(panelId, collapsed);
          return;
        }

        case "expandIds": {
          const [panelIds] = args as [string[]];
          registry.expandIds(panelIds);
          return;
        }

        default:
          throw new Error(`Unknown panel method: ${method}`);
      }
    },
  };
}
