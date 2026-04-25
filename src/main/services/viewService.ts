import { z } from "zod";
import type { ServiceDefinition } from "@natstack/shared/serviceDefinition";
import type { ViewManager } from "../viewManager.js";

export function createViewService(deps: {
  getViewManager: () => ViewManager;
}): ServiceDefinition {
  /**
   * Ownership invariant for cross-view methods (audit finding #9).
   *
   * The caller must EITHER be the shell, OR be the target view itself.
   * This is defense-in-depth: the service-level policy is already
   * `{ allowed: ["shell"] }`, but if that policy is ever loosened (e.g.,
   * to permit panels to drive their own viewport via `setBounds(self,…)`)
   * the per-method check still prevents one panel from steering another.
   *
   * Note: today this service is shell-only at the policy layer, so a panel
   * can never reach this code. The check exists so that any future policy
   * relaxation does not silently regress into "any panel can resize / hide
   * / repaint any other panel".
   */
  const assertOwnsOrShell = (callerId: string, targetId: string, method: string): void => {
    if (callerId === "shell") return;
    if (callerId === targetId) return;
    throw new Error(
      `view.${method}: caller '${callerId}' does not own target view '${targetId}'`,
    );
  };

  return {
    name: "view",
    description: "View bounds, visibility, theme CSS",
    policy: { allowed: ["shell"] },
    methods: {
      setBounds: { args: z.tuple([z.string(), z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() })]) },
      setVisible: { args: z.tuple([z.string(), z.boolean()]) },
      setThemeCss: { args: z.tuple([z.string()]) },
      updateLayout: { args: z.tuple([z.object({ titleBarHeight: z.number().optional(), sidebarVisible: z.boolean().optional(), sidebarWidth: z.number().optional(), saveBarHeight: z.number().optional(), notificationBarHeight: z.number().optional(), consentBarHeight: z.number().optional() })]) },
      setShellOverlay: { args: z.tuple([z.boolean()]) },
      browserNavigate: { args: z.tuple([z.string(), z.string()]) },
      browserGoBack: { args: z.tuple([z.string()]) },
      browserGoForward: { args: z.tuple([z.string()]) },
      browserReload: { args: z.tuple([z.string()]) },
      browserStop: { args: z.tuple([z.string()]) },
    },
    handler: async (ctx, method, args) => {
      const vm = deps.getViewManager();

      switch (method) {
        case "setBounds": {
          const [viewId, bounds] = args as [string, { x: number; y: number; width: number; height: number }];
          assertOwnsOrShell(ctx.callerId, viewId, "setBounds");
          vm.setViewBounds(viewId, bounds);
          return;
        }
        case "setVisible": {
          const [viewId, visible] = args as [string, boolean];
          assertOwnsOrShell(ctx.callerId, viewId, "setVisible");
          vm.setViewVisible(viewId, visible);
          return;
        }
        case "setThemeCss": {
          // Theme CSS is process-wide; restrict to shell only as defense in
          // depth. (Service policy is already shell-only.)
          if (ctx.callerId !== "shell") {
            throw new Error("view.setThemeCss: shell-only");
          }
          const css = args[0] as string;
          vm.setThemeCss(css);
          return;
        }
        case "updateLayout": {
          if (ctx.callerId !== "shell") {
            throw new Error("view.updateLayout: shell-only");
          }
          const layoutUpdate = args[0] as { titleBarHeight?: number; sidebarVisible?: boolean; sidebarWidth?: number; saveBarHeight?: number; notificationBarHeight?: number; consentBarHeight?: number };
          vm.updateLayout(layoutUpdate);
          return;
        }
        case "setShellOverlay": {
          if (ctx.callerId !== "shell") {
            throw new Error("view.setShellOverlay: shell-only");
          }
          const active = args[0] as boolean;
          vm.setShellOverlayActive(active);
          return;
        }
        case "browserNavigate": {
          const [browserId, url] = args as [string, string];
          assertOwnsOrShell(ctx.callerId, browserId, "browserNavigate");
          await vm.navigateView(browserId, url);
          return;
        }
        case "browserGoBack": {
          const browserId = args[0] as string;
          assertOwnsOrShell(ctx.callerId, browserId, "browserGoBack");
          vm.getWebContents(browserId)?.goBack();
          return;
        }
        case "browserGoForward": {
          const browserId = args[0] as string;
          assertOwnsOrShell(ctx.callerId, browserId, "browserGoForward");
          vm.getWebContents(browserId)?.goForward();
          return;
        }
        case "browserReload": {
          const browserId = args[0] as string;
          assertOwnsOrShell(ctx.callerId, browserId, "browserReload");
          vm.reload(browserId);
          return;
        }
        case "browserStop": {
          const browserId = args[0] as string;
          assertOwnsOrShell(ctx.callerId, browserId, "browserStop");
          vm.stop(browserId);
          return;
        }
        default:
          throw new Error(`Unknown view method: ${method}`);
      }
    },
  };
}
