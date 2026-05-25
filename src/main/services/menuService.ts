import { Menu, type MenuItemConstructorOptions } from "electron";
import { z } from "zod";
import type { ServiceDefinition } from "@natstack/shared/serviceDefinition";
import type { PanelOrchestrator } from "../panelOrchestrator.js";
import type { PanelRegistry } from "@natstack/shared/panelRegistry";
import type { ViewManager } from "../viewManager.js";
import type { ServerClient } from "../serverClient.js";
import type { PanelContextMenuAction } from "@natstack/shared/types";
import { buildPanelChromeState } from "@natstack/shared/panelChrome";
import { getAvailablePanelCommands, type PanelCommandId } from "@natstack/shared/panelCommands";
import { getPanelSource } from "@natstack/shared/panel/accessors";
import { buildHamburgerMenuTemplate } from "../menu.js";

export function createMenuService(deps: {
  panelOrchestrator: PanelOrchestrator;
  panelRegistry: PanelRegistry;
  getViewManager: () => ViewManager;
  serverClient: ServerClient | null;
}): ServiceDefinition {
  return {
    name: "menu",
    description: "Native menus",
    policy: { allowed: ["shell"] },
    methods: {
      showHamburger: { args: z.tuple([z.object({ x: z.number(), y: z.number() })]) },
      showContext: {
        args: z.tuple([
          z.array(z.object({ id: z.string(), label: z.string() })),
          z.object({ x: z.number(), y: z.number() }),
        ]),
      },
      showPanelContext: { args: z.tuple([z.string(), z.object({ x: z.number(), y: z.number() })]) },
    },
    handler: async (_ctx, method, args) => {
      const vm = deps.getViewManager();
      const lifecycle = deps.panelOrchestrator;
      const registry = deps.panelRegistry;

      switch (method) {
        case "showHamburger": {
          const position = args[0] as { x: number; y: number };
          const shellContents = vm.getShellWebContents();

          const clearBuildCache = async () => {
            if (deps.serverClient) {
              try {
                await deps.serverClient.call("build", "recompute", []);
              } catch (e) {
                console.warn("[App] Build recompute failed:", e);
              }
            }
            try {
              lifecycle.invalidateReadyPanels();
            } catch (error) {
              console.warn("[App] Failed to invalidate panel states:", error);
            }
            console.log("[App] Build cache cleared via hamburger menu");
          };

          const template = buildHamburgerMenuTemplate(shellContents, clearBuildCache, {
            onHistoryBack: () => {
              const panelId = registry.getFocusedPanelId();
              const panel = panelId ? registry.getPanel(panelId) : null;
              if (!panelId || !panel) return;
              const contents = vm.getWebContents(panelId);
              if (getPanelSource(panel).startsWith("browser:") && contents?.canGoBack()) {
                contents.goBack();
                return;
              }
              void lifecycle.navigatePanelHistory(panelId, -1);
            },
            onHistoryForward: () => {
              const panelId = registry.getFocusedPanelId();
              const panel = panelId ? registry.getPanel(panelId) : null;
              if (!panelId || !panel) return;
              const contents = vm.getWebContents(panelId);
              if (getPanelSource(panel).startsWith("browser:") && contents?.canGoForward()) {
                contents.goForward();
                return;
              }
              void lifecycle.navigatePanelHistory(panelId, 1);
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
          const [panelId, position] = args as [string, { x: number; y: number }];
          const panel = registry.getPanel(panelId);
          const chrome = panel ? buildPanelChromeState({ panel }) : null;
          const commands = getAvailablePanelCommands({ chrome }, [
            "back",
            "forward",
            "reload-panel",
            "reload-view",
            "force-reload-view",
            "rebuild-panel",
            "stop",
            "copy-address",
            "copy-panel-id",
            "open-external",
            "duplicate",
            "add-child",
            "unload",
            "archive",
          ]);

          return new Promise<PanelContextMenuAction | null>((resolve) => {
            const addCommand = (id: PanelCommandId): MenuItemConstructorOptions | null => {
              const command = commands.find((candidate) => candidate.id === id);
              if (!command) return null;
              return { label: command.label, click: () => resolve(id as PanelContextMenuAction) };
            };
            const template: MenuItemConstructorOptions[] = [
              addCommand("back"),
              addCommand("forward"),
              { type: "separator" },
              addCommand("reload-panel"),
              addCommand("reload-view"),
              addCommand("force-reload-view"),
              addCommand("rebuild-panel"),
              addCommand("stop"),
              { type: "separator" },
              addCommand("copy-address"),
              addCommand("copy-panel-id"),
              addCommand("open-external"),
              addCommand("duplicate"),
              addCommand("add-child"),
              { type: "separator" },
              addCommand("unload"),
              { type: "separator" },
              addCommand("archive"),
            ].filter(Boolean) as MenuItemConstructorOptions[];
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
