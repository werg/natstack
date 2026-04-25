import { z } from "zod";
import type { ServiceDefinition } from "@natstack/shared/serviceDefinition";
import type { CdpServer } from "../cdpServer.js";
import type { ViewManager } from "../viewManager.js";
import type { PanelRegistry } from "@natstack/shared/panelRegistry";

export function getCdpEndpointForCaller(cdpServer: CdpServer, browserId: string, callerId: string): string {
  const endpoint = cdpServer.getCdpEndpoint(browserId, callerId);
  if (!endpoint) {
    throw new Error("Access denied: you do not own this browser panel");
  }
  return endpoint;
}

export function createBrowserService(deps: {
  cdpServer: CdpServer;
  getViewManager: () => ViewManager;
  panelRegistry: PanelRegistry;
}): ServiceDefinition {
  return {
    name: "browser",
    description: "CDP/browser automation",
    policy: { allowed: ["shell", "panel", "server", "worker"] },
    methods: {
      getCdpEndpoint: { args: z.tuple([z.string()]) },
      navigate: { args: z.tuple([z.string(), z.string()]) },
      goBack: { args: z.tuple([z.string()]) },
      goForward: { args: z.tuple([z.string()]) },
      reload: { args: z.tuple([z.string()]) },
      stop: { args: z.tuple([z.string()]) },
    },
    handler: async (ctx, method, args) => {
      const [browserId] = args as [string];
      const cdpServer = deps.cdpServer;
      const viewManager = deps.getViewManager();

      const assertOwner = () => {
        if (!cdpServer.panelOwnsBrowser(ctx.callerId, browserId)) {
          throw new Error("Access denied: you do not own this browser panel");
        }
      };

      const getContents = () => {
        const wc = viewManager.getWebContents(browserId);
        if (!wc) throw new Error(`Browser webContents not found for ${browserId}`);
        return wc;
      };

      switch (method) {
        case "getCdpEndpoint":
          return getCdpEndpointForCaller(cdpServer, browserId, ctx.callerId);

        case "navigate": {
          const [, url] = args as [string, string];
          assertOwner();
          const wc = getContents();
          try {
            await wc.loadURL(url);
          } catch (err) {
            const error = err as { code?: string; errno?: number };
            if (error.errno === -3 || error.code === "ERR_ABORTED") return;
            throw err;
          }
          return;
        }

        case "goBack":
          assertOwner();
          getContents().goBack();
          return;

        case "goForward":
          assertOwner();
          getContents().goForward();
          return;

        case "reload":
          assertOwner();
          getContents().reload();
          return;

        case "stop":
          assertOwner();
          getContents().stop();
          return;

        default:
          throw new Error(`Unknown browser method: ${method}`);
      }
    },
  };
}
