import { z } from "zod";
import type { ServiceDefinition } from "../serviceDefinition.js";
import type { ViewManager } from "../viewManager.js";

export function createViewService(deps: {
  getViewManager: () => ViewManager;
}): ServiceDefinition {
  return {
    name: "view",
    description: "View bounds, visibility, theme CSS",
    policy: { allowed: ["shell"] },
    methods: {
      setBounds: { args: z.tuple([z.string(), z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() })]) },
      setVisible: { args: z.tuple([z.string(), z.boolean()]) },
      setThemeCss: { args: z.tuple([z.string()]) },
      updateLayout: { args: z.tuple([z.object({ titleBarHeight: z.number().optional(), sidebarVisible: z.boolean().optional(), sidebarWidth: z.number().optional() })]) },
      browserNavigate: { args: z.tuple([z.string(), z.string()]) },
      browserGoBack: { args: z.tuple([z.string()]) },
      browserGoForward: { args: z.tuple([z.string()]) },
      browserReload: { args: z.tuple([z.string()]) },
      browserStop: { args: z.tuple([z.string()]) },
    },
    handler: async (_ctx, method, args) => {
      const vm = deps.getViewManager();

      switch (method) {
        case "setBounds": {
          const [viewId, bounds] = args as [string, { x: number; y: number; width: number; height: number }];
          vm.setViewBounds(viewId, bounds);
          return;
        }
        case "setVisible": {
          const [viewId, visible] = args as [string, boolean];
          vm.setViewVisible(viewId, visible);
          return;
        }
        case "setThemeCss": {
          const css = args[0] as string;
          vm.setThemeCss(css);
          return;
        }
        case "updateLayout": {
          const layoutUpdate = args[0] as { titleBarHeight?: number; sidebarVisible?: boolean; sidebarWidth?: number };
          vm.updateLayout(layoutUpdate);
          return;
        }
        case "browserNavigate": {
          const [browserId, url] = args as [string, string];
          await vm.navigateView(browserId, url);
          return;
        }
        case "browserGoBack": {
          const browserId = args[0] as string;
          vm.getWebContents(browserId)?.goBack();
          return;
        }
        case "browserGoForward": {
          const browserId = args[0] as string;
          vm.getWebContents(browserId)?.goForward();
          return;
        }
        case "browserReload": {
          const browserId = args[0] as string;
          vm.reload(browserId);
          return;
        }
        case "browserStop": {
          const browserId = args[0] as string;
          vm.stop(browserId);
          return;
        }
        default:
          throw new Error(`Unknown view method: ${method}`);
      }
    },
  };
}
