import { Menu, type MenuItemConstructorOptions } from "electron";
import { z } from "zod";
import type { ServiceDefinition } from "../serviceDefinition.js";
import type { PanelManager } from "../panelManager.js";
import type { ViewManager } from "../viewManager.js";
import type { ServerClient } from "../serverClient.js";
import type { PanelContextMenuAction } from "../../shared/types.js";
import { buildHamburgerMenuTemplate } from "../menu.js";

export function createMenuService(deps: {
  panelManager: PanelManager;
  getViewManager: () => ViewManager;
  serverClient: ServerClient | null;
}): ServiceDefinition {
  return {
    name: "menu",
    description: "Native menus",
    policy: { allowed: ["shell"] },
    methods: {
      showHamburger: { args: z.tuple([z.object({ x: z.number(), y: z.number() })]) },
      showContext: { args: z.tuple([z.array(z.object({ id: z.string(), label: z.string() })), z.object({ x: z.number(), y: z.number() })]) },
      showPanelContext: { args: z.tuple([z.string(), z.object({ x: z.number(), y: z.number() })]) },
    },
    handler: async (_ctx, method, args) => {
      const vm = deps.getViewManager();
      const pm = deps.panelManager;

      switch (method) {
        case "showHamburger": {
          const position = args[0] as { x: number; y: number };
          const shellContents = vm.getShellWebContents();

          const clearBuildCache = async () => {
            if (deps.serverClient) {
              try { await deps.serverClient.call("build", "recompute", []); } catch {}
            }
            try {
              pm.invalidateReadyPanels();
            } catch (error) {
              console.warn("[App] Failed to invalidate panel states:", error);
            }
            console.log("[App] Build cache cleared via hamburger menu");
          };

          const template = buildHamburgerMenuTemplate(shellContents, clearBuildCache, {
            onHistoryBack: () => {
              const panelId = pm.getFocusedPanelId();
              if (!panelId || !pm.getPanel(panelId)) return;
              vm.getWebContents(panelId)?.goBack();
            },
            onHistoryForward: () => {
              const panelId = pm.getFocusedPanelId();
              if (!panelId || !pm.getPanel(panelId)) return;
              vm.getWebContents(panelId)?.goForward();
            },
          });
          const menu = Menu.buildFromTemplate(template);
          menu.popup({ window: vm.getWindow(), x: position.x, y: position.y });
          return;
        }

        case "showContext": {
          const [items, position] = args as [
            Array<{ id: string; label: string }>,
            { x: number; y: number },
          ];
          return new Promise<string | null>((resolve) => {
            const template: MenuItemConstructorOptions[] = items.map((item) => ({
              label: item.label,
              click: () => resolve(item.id),
            }));
            const menu = Menu.buildFromTemplate(template);
            menu.popup({
              window: vm.getWindow(),
              x: position.x,
              y: position.y,
              callback: () => resolve(null),
            });
          });
        }

        case "showPanelContext": {
          const [_panelId, position] = args as [string, { x: number; y: number }];

          return new Promise<PanelContextMenuAction | null>((resolve) => {
            const template: MenuItemConstructorOptions[] = [
              { label: "Reload", click: () => resolve("reload") },
              { type: "separator" },
              { label: "Unload", click: () => resolve("unload") },
              { type: "separator" },
              { label: "Archive", click: () => resolve("archive") },
            ];
            const menu = Menu.buildFromTemplate(template);
            menu.popup({
              window: vm.getWindow(),
              x: position.x,
              y: position.y,
              callback: () => resolve(null),
            });
          });
        }

        default:
          throw new Error(`Unknown menu method: ${method}`);
      }
    },
  };
}
