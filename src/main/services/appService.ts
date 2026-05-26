import { app, nativeTheme, shell } from "electron";
import { z } from "zod";
import type { ServiceDefinition } from "@natstack/shared/serviceDefinition";
import type { ThemeMode } from "@natstack/shared/types";
import type { PanelOrchestrator } from "../panelOrchestrator.js";
import type { ServerClient } from "../serverClient.js";
import type { ViewManager } from "../viewManager.js";
import type { AppOrchestrator } from "../appOrchestrator.js";
import { requireAppCapability } from "./appCapabilities.js";

export function createAppService(deps: {
  panelOrchestrator: PanelOrchestrator;
  serverClient: ServerClient | null;
  getViewManager: () => ViewManager;
  getAppOrchestrator?: () => AppOrchestrator | null;
  connectionMode: "local" | "remote";
  remoteHost?: string;
}): ServiceDefinition {
  return {
    name: "app",
    description: "App lifecycle, theme, devtools",
    policy: { allowed: ["shell", "app"] },
    methods: {
      getInfo: { args: z.tuple([]) },
      getSystemTheme: { args: z.tuple([]) },
      setThemeMode: { args: z.tuple([z.string()]) },
      openDevTools: { args: z.tuple([]) },
      openExternal: { args: z.tuple([z.string()]) },
      openWorkspacePath: { args: z.tuple([]) },
      clearBuildCache: { args: z.tuple([]) },
      getShellPages: { args: z.tuple([]) },
      applyUpdate: { args: z.tuple([z.string()]) },
      listPendingUpdates: { args: z.tuple([]) },
    },
    handler: async (ctx, method, args) => {
      switch (method) {
        case "getInfo":
          return {
            version: app.getVersion(),
            connectionMode: deps.connectionMode,
            remoteHost: deps.remoteHost,
            connectionStatus: deps.serverClient?.getConnectionStatus?.() ?? "connected",
          };

        case "getSystemTheme":
          return nativeTheme.shouldUseDarkColors ? "dark" : "light";

        case "setThemeMode": {
          requireAppCapability(ctx, deps.getViewManager(), "window-management", "app.setThemeMode");
          const mode = args[0] as ThemeMode;
          nativeTheme.themeSource = mode;
          return;
        }

        case "openDevTools": {
          const vm = deps.getViewManager();
          requireAppCapability(ctx, vm, "window-management", "app.openDevTools");
          vm.openDevTools(ctx.caller.runtime.kind === "app" ? ctx.caller.runtime.id : "shell");
          return;
        }

        case "openExternal": {
          requireAppCapability(ctx, deps.getViewManager(), "open-external", "app.openExternal");
          const url = args[0] as string;
          if (!/^https?:\/\//i.test(url))
            throw new Error("Only http(s) URLs can be opened externally");
          await shell.openExternal(url);
          return;
        }

        case "openWorkspacePath": {
          if (ctx.caller.runtime.kind !== "shell") {
            throw new Error("app.openWorkspacePath is shell-only");
          }
          const info = await deps.serverClient?.call("workspace", "getInfo", []);
          const workspacePath = (info as { path?: unknown } | undefined)?.path;
          if (typeof workspacePath !== "string" || workspacePath.length === 0) {
            throw new Error("Workspace path unavailable");
          }
          const error = await shell.openPath(workspacePath);
          if (error) throw new Error(error);
          return;
        }

        case "clearBuildCache": {
          requireAppCapability(ctx, deps.getViewManager(), "panel-hosting", "app.clearBuildCache");
          if (deps.serverClient) {
            try {
              await deps.serverClient.call("build", "recompute", []);
            } catch (e) {
              console.warn("[App] Build recompute failed:", e);
            }
          }
          try {
            deps.panelOrchestrator.invalidateReadyPanels();
          } catch (error) {
            console.warn("[App] Failed to invalidate panel states:", error);
          }
          return;
        }

        case "getShellPages":
          requireAppCapability(ctx, deps.getViewManager(), "panel-hosting", "app.getShellPages");
          if (deps.serverClient) {
            try {
              return await deps.serverClient.call("build", "getAboutPages", []);
            } catch (e) {
              console.warn("[App] Failed to fetch shell pages:", e);
            }
          }
          return [];

        case "applyUpdate": {
          requireShellOrPanelHostingApp(ctx, deps.getViewManager(), "app.applyUpdate");
          const appId = args[0] as string;
          return {
            applied: (await deps.getAppOrchestrator?.()?.applyPendingAppUpdate(appId)) ?? false,
          };
        }

        case "listPendingUpdates": {
          requireShellOrPanelHostingApp(ctx, deps.getViewManager(), "app.listPendingUpdates");
          return deps.getAppOrchestrator?.()?.listPendingAppUpdates() ?? [];
        }

        default:
          throw new Error(`Unknown app method: ${method}`);
      }
    },
  };
}

function requireShellOrPanelHostingApp(
  ctx: Parameters<ServiceDefinition["handler"]>[0],
  viewManager: ViewManager,
  operation: string
): void {
  if (ctx.caller.runtime.kind === "shell") return;
  requireAppCapability(ctx, viewManager, "panel-hosting", operation);
}
