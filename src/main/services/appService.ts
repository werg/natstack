import * as path from "path";
import { app, nativeTheme } from "electron";
import { z } from "zod";
import type { ServiceDefinition } from "../../shared/serviceDefinition.js";
import type { ThemeMode } from "../../shared/types.js";
import type { PanelLifecycle } from "../../shared/panelLifecycle.js";
import type { ServerClient } from "../serverClient.js";
import type { ViewManager } from "../viewManager.js";

export function createAppService(deps: {
  panelLifecycle: PanelLifecycle;
  serverClient: ServerClient | null;
  getViewManager: () => ViewManager;
}): ServiceDefinition {
  return {
    name: "app",
    description: "App lifecycle, theme, devtools",
    policy: { allowed: ["shell"] },
    methods: {
      getInfo: { args: z.tuple([]) },
      getSystemTheme: { args: z.tuple([]) },
      setThemeMode: { args: z.tuple([z.string()]) },
      openDevTools: { args: z.tuple([]) },
      getPanelPreloadPath: { args: z.tuple([]) },
      clearBuildCache: { args: z.tuple([]) },
      getShellPages: { args: z.tuple([]) },
    },
    handler: async (_ctx, method, args) => {
      switch (method) {
        case "getInfo":
          return { version: app.getVersion() };

        case "getSystemTheme":
          return nativeTheme.shouldUseDarkColors ? "dark" : "light";

        case "setThemeMode": {
          const mode = args[0] as ThemeMode;
          nativeTheme.themeSource = mode;
          return;
        }

        case "openDevTools": {
          const vm = deps.getViewManager();
          vm.openDevTools("shell");
          return;
        }

        case "getPanelPreloadPath":
          return path.join(__dirname, "..", "panelPreload.cjs");

        case "clearBuildCache": {
          if (deps.serverClient) {
            try { await deps.serverClient.call("build", "recompute", []); } catch {}
          }
          try {
            deps.panelLifecycle.invalidateReadyPanels();
          } catch (error) {
            console.warn("[App] Failed to invalidate panel states:", error);
          }
          return;
        }

        case "getShellPages":
          if (deps.serverClient) {
            try { return await deps.serverClient.call("build", "getAboutPages", []); } catch {}
          }
          return [];

        default:
          throw new Error(`Unknown app method: ${method}`);
      }
    },
  };
}
