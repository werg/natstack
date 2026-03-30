import { dialog } from "electron";
import type { ServiceDefinition } from "@natstack/shared/serviceDefinition";
import type { PanelOrchestrator } from "../panelOrchestrator.js";
import type { CdpServer } from "../cdpServer.js";
import type { ViewManager } from "../viewManager.js";
import type { ServerInfo } from "../serverInfo.js";
import { handleCommonBridgeMethod } from "@natstack/shared/bridgeHandlersCommon";
import { BRIDGE_METHOD_SCHEMAS } from "@natstack/shared/bridgeMethodSchemas";

export function createBridgeService(deps: {
  panelOrchestrator: PanelOrchestrator;
  cdpServer: CdpServer;
  getViewManager: () => ViewManager;
  serverInfo: ServerInfo;
}): ServiceDefinition {
  return {
    name: "bridge",
    description: "Panel lifecycle (createPanel, close, navigation)",
    policy: { allowed: ["panel", "shell", "server"] },
    methods: BRIDGE_METHOD_SCHEMAS,
    handler: async (ctx, method, args) => {
      const lifecycle = deps.panelOrchestrator;
      const callerId = ctx.callerId;

      // Try common handlers first (shared with headless mode)
      const common = await handleCommonBridgeMethod(lifecycle, callerId, method, args as unknown[], deps.serverInfo);
      if (common.handled) return common.result;

      // Electron-specific handlers
      switch (method) {
        case "openFolderDialog": {
          const [options] = (args ?? []) as [{ title?: string }?];
          const result = await dialog.showOpenDialog({
            properties: ["openDirectory", "createDirectory"],
            title: options?.title ?? "Select Folder",
          });
          return result.canceled ? null : result.filePaths[0] ?? null;
        }

        case "createRepo": {
          const [repoPath] = args as [string];
          // Delegate to server git service
          await deps.panelOrchestrator.callServer("git", "createRepo", [repoPath]);
          return;
        }

        case "openDevtools": {
          const vm = deps.getViewManager();
          vm.openDevTools(callerId);
          return;
        }

        case "createBrowserPanel": {
          const [url, opts] = args as [string, { name?: string; focus?: boolean }?];
          return lifecycle.createBrowserPanel(callerId, url, opts);
        }

        case "openExternal": {
          const [url] = args as [string];
          if (!/^https?:\/\//i.test(url)) {
            throw new Error("openExternal only supports http/https URLs");
          }
          const { shell } = await import("electron");
          await shell.openExternal(url);
          return;
        }

        default:
          throw new Error(`Unknown bridge method: ${method}`);
      }
    },
  };
}
