import { z } from "zod";
import type { ServiceDefinition } from "../../shared/serviceDefinition.js";
import type { PanelOrchestrator } from "../panelOrchestrator.js";
import type { PanelRegistry } from "../../shared/panelRegistry.js";
import type { PanelView } from "../panelView.js";
import type { ViewManager } from "../viewManager.js";
import type { ThemeAppearance } from "../../shared/types.js";
import { createDevLogger } from "@natstack/dev-log";

const log = createDevLogger("PanelShellService");

export function createPanelShellService(deps: {
  panelOrchestrator: PanelOrchestrator;
  panelRegistry: PanelRegistry;
  panelView: PanelView;
  getViewManager: () => ViewManager;
}): ServiceDefinition {
  return {
    name: "panel",
    description: "Panel tree management, reload, close",
    policy: { allowed: ["shell"] },
    methods: {
      loadTree: { args: z.tuple([]) },
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
      create: { args: z.tuple([z.string(), z.object({ name: z.string().optional(), isRoot: z.boolean().optional() }).optional()]) },
      movePanel: { args: z.tuple([z.object({ panelId: z.string(), newParentId: z.string().nullable(), targetPosition: z.number() })]) },
      getChildrenPaginated: { args: z.tuple([z.object({ parentId: z.string(), offset: z.number(), limit: z.number() })]) },
      getRootPanelsPaginated: { args: z.tuple([z.object({ offset: z.number(), limit: z.number() })]) },
      getCollapsedIds: { args: z.tuple([]) },
      setCollapsed: { args: z.tuple([z.string(), z.boolean()]) },
      expandIds: { args: z.tuple([z.array(z.string())]) },
    },
    handler: async (_ctx, method, args) => {
      const lifecycle = deps.panelOrchestrator;
      const registry = deps.panelRegistry;
      const pv = deps.panelView;
      const vm = deps.getViewManager();

      switch (method) {
        case "loadTree":
          return {
            rootPanels: registry.getSerializablePanelTree(),
            collapsedIds: await lifecycle.getCollapsedIds(),
          };

        case "getTree":
          return registry.getSerializablePanelTree();

        case "notifyFocused": {
          const panelId = args[0] as string;
          try {
            // Orchestrator handles: registry.updateSelectedPath, server persist,
            // sendPanelEvent(focus), navigate-to-panel event
            lifecycle.focusPanel(panelId);
            vm.refreshVisiblePanel();
            void lifecycle.rebuildUnloadedPanel(panelId).catch((err: unknown) => console.warn(`[Panel] Rebuild failed for ${panelId}:`, err));
          } catch (error) {
            console.error(`[Panel] Failed to focus panel ${panelId}:`, error);
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

        case "create": {
          const source = args[0] as string;
          const opts = args[1] as { name?: string; isRoot?: boolean } | undefined;
          return lifecycle.createRootPanel(source, opts);
        }

        case "movePanel": {
          const { panelId, newParentId, targetPosition } = args[0] as {
            panelId: string;
            newParentId: string | null;
            targetPosition: number;
          };
          await lifecycle.movePanel(panelId, newParentId, targetPosition);
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
          return lifecycle.getCollapsedIds();

        case "setCollapsed": {
          const [panelId, collapsed] = args as [string, boolean];
          await lifecycle.setCollapsed(panelId, collapsed);
          return;
        }

        case "expandIds": {
          const [panelIds] = args as [string[]];
          await lifecycle.expandIds(panelIds);
          return;
        }

        default:
          throw new Error(`Unknown panel method: ${method}`);
      }
    },
  };
}
