import { z } from "zod";
import type { ServiceDefinition } from "@natstack/shared/serviceDefinition";
import type { ViewManager } from "../viewManager.js";
import { assertHttpUrl } from "../utils.js";

export function createViewService(deps: { getViewManager: () => ViewManager }): ServiceDefinition {
  /**
   * Ownership invariant for cross-view methods (audit finding #9).
   *
   * The full workspace shell now runs as an app target. It gets cross-view
   * authority by declaring `panel-hosting`; ordinary app callers can only
   * reach self-targeted methods if this policy is expanded later.
   */
  const hasViewHostAuthority = (vm: ViewManager, callerId: string, callerKind: string): boolean => {
    if (callerKind === "shell") return true;
    const viewInfo = vm.getViewInfo(callerId);
    return viewInfo?.type === "app" && viewInfo.capabilities.includes("panel-hosting");
  };

  const assertViewHost = (
    vm: ViewManager,
    callerId: string,
    callerKind: string,
    method: string
  ): void => {
    if (hasViewHostAuthority(vm, callerId, callerKind)) return;
    throw new Error(`view.${method}: caller '${callerId}' cannot host workspace views`);
  };

  const assertOwnsOrViewHost = (
    vm: ViewManager,
    callerId: string,
    callerKind: string,
    targetId: string,
    method: string
  ): void => {
    if (hasViewHostAuthority(vm, callerId, callerKind)) return;
    if (callerId === targetId) return;
    throw new Error(`view.${method}: caller '${callerId}' does not own target view '${targetId}'`);
  };

  return {
    name: "view",
    description: "View bounds, visibility, theme CSS",
    policy: { allowed: ["shell", "app"] },
    methods: {
      setBounds: {
        args: z.tuple([
          z.string(),
          z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }),
        ]),
      },
      setVisible: { args: z.tuple([z.string(), z.boolean()]) },
      forwardMouseClick: {
        args: z.tuple([z.string(), z.object({ x: z.number(), y: z.number() })]),
      },
      setThemeCss: { args: z.tuple([z.string()]) },
      updateLayout: {
        args: z.tuple([
          z.object({
            titleBarHeight: z.number().optional(),
            sidebarVisible: z.boolean().optional(),
            sidebarWidth: z.number().optional(),
            saveBarHeight: z.number().optional(),
            notificationBarHeight: z.number().optional(),
            consentBarHeight: z.number().optional(),
          }),
        ]),
      },
      setShellOverlay: { args: z.tuple([z.boolean()]) },
      showNativeShellOverlay: {
        args: z.tuple([
          z.object({
            id: z.string(),
            html: z.string(),
            bounds: z.object({
              x: z.number(),
              y: z.number(),
              width: z.number(),
              height: z.number(),
            }),
            focus: z.boolean().optional(),
          }),
        ]),
      },
      updateNativeShellOverlay: {
        args: z.tuple([
          z.object({
            id: z.string().optional(),
            html: z.string().optional(),
            bounds: z
              .object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() })
              .optional(),
            focus: z.boolean().optional(),
          }),
        ]),
      },
      hideNativeShellOverlay: { args: z.union([z.tuple([]), z.tuple([z.string().optional()])]) },
      browserNavigate: { args: z.tuple([z.string(), z.string()]) },
      browserGoBack: { args: z.tuple([z.string()]) },
      browserGoForward: { args: z.tuple([z.string()]) },
      browserReload: { args: z.tuple([z.string()]) },
      browserForceReload: { args: z.tuple([z.string()]) },
      browserStop: { args: z.tuple([z.string()]) },
    },
    handler: async (ctx, method, args) => {
      const vm = deps.getViewManager();

      switch (method) {
        case "setBounds": {
          const [viewId, bounds] = args as [
            string,
            { x: number; y: number; width: number; height: number },
          ];
          assertOwnsOrViewHost(
            vm,
            ctx.caller.runtime.id,
            ctx.caller.runtime.kind,
            viewId,
            "setBounds"
          );
          vm.setViewBounds(viewId, bounds);
          return;
        }
        case "setVisible": {
          const [viewId, visible] = args as [string, boolean];
          assertOwnsOrViewHost(
            vm,
            ctx.caller.runtime.id,
            ctx.caller.runtime.kind,
            viewId,
            "setVisible"
          );
          vm.setViewVisible(viewId, visible);
          return;
        }
        case "forwardMouseClick": {
          const [viewId, point] = args as [string, { x: number; y: number }];
          assertViewHost(vm, ctx.caller.runtime.id, ctx.caller.runtime.kind, "forwardMouseClick");
          return vm.forwardMouseClick(viewId, point);
        }
        case "setThemeCss": {
          assertViewHost(vm, ctx.caller.runtime.id, ctx.caller.runtime.kind, "setThemeCss");
          const css = args[0] as string;
          vm.setThemeCss(css);
          return;
        }
        case "updateLayout": {
          assertViewHost(vm, ctx.caller.runtime.id, ctx.caller.runtime.kind, "updateLayout");
          const layoutUpdate = args[0] as {
            titleBarHeight?: number;
            sidebarVisible?: boolean;
            sidebarWidth?: number;
            saveBarHeight?: number;
            notificationBarHeight?: number;
            consentBarHeight?: number;
          };
          vm.updateLayout(layoutUpdate);
          return;
        }
        case "setShellOverlay": {
          assertViewHost(vm, ctx.caller.runtime.id, ctx.caller.runtime.kind, "setShellOverlay");
          const active = args[0] as boolean;
          vm.setShellOverlayActive(active);
          return;
        }
        case "showNativeShellOverlay": {
          assertViewHost(
            vm,
            ctx.caller.runtime.id,
            ctx.caller.runtime.kind,
            "showNativeShellOverlay"
          );
          const [options] = args as [
            {
              id: string;
              html: string;
              bounds: { x: number; y: number; width: number; height: number };
              focus?: boolean;
            },
          ];
          vm.showNativeShellOverlay(options);
          return;
        }
        case "updateNativeShellOverlay": {
          assertViewHost(
            vm,
            ctx.caller.runtime.id,
            ctx.caller.runtime.kind,
            "updateNativeShellOverlay"
          );
          const [options] = args as [
            {
              id?: string;
              html?: string;
              bounds?: { x: number; y: number; width: number; height: number };
              focus?: boolean;
            },
          ];
          vm.updateNativeShellOverlay(options);
          return;
        }
        case "hideNativeShellOverlay": {
          assertViewHost(
            vm,
            ctx.caller.runtime.id,
            ctx.caller.runtime.kind,
            "hideNativeShellOverlay"
          );
          vm.hideNativeShellOverlay(args[0] as string | undefined);
          return;
        }
        case "browserNavigate": {
          const [browserId, url] = args as [string, string];
          assertOwnsOrViewHost(
            vm,
            ctx.caller.runtime.id,
            ctx.caller.runtime.kind,
            browserId,
            "browserNavigate"
          );
          assertHttpUrl(url);
          await vm.navigateView(browserId, url);
          return;
        }
        case "browserGoBack": {
          const browserId = args[0] as string;
          assertOwnsOrViewHost(
            vm,
            ctx.caller.runtime.id,
            ctx.caller.runtime.kind,
            browserId,
            "browserGoBack"
          );
          vm.getWebContents(browserId)?.goBack();
          return;
        }
        case "browserGoForward": {
          const browserId = args[0] as string;
          assertOwnsOrViewHost(
            vm,
            ctx.caller.runtime.id,
            ctx.caller.runtime.kind,
            browserId,
            "browserGoForward"
          );
          vm.getWebContents(browserId)?.goForward();
          return;
        }
        case "browserReload": {
          const browserId = args[0] as string;
          assertOwnsOrViewHost(
            vm,
            ctx.caller.runtime.id,
            ctx.caller.runtime.kind,
            browserId,
            "browserReload"
          );
          vm.reload(browserId);
          return;
        }
        case "browserForceReload": {
          const browserId = args[0] as string;
          assertOwnsOrViewHost(
            vm,
            ctx.caller.runtime.id,
            ctx.caller.runtime.kind,
            browserId,
            "browserForceReload"
          );
          vm.forceReload(browserId);
          return;
        }
        case "browserStop": {
          const browserId = args[0] as string;
          assertOwnsOrViewHost(
            vm,
            ctx.caller.runtime.id,
            ctx.caller.runtime.kind,
            browserId,
            "browserStop"
          );
          vm.stop(browserId);
          return;
        }
        default:
          throw new Error(`Unknown view method: ${method}`);
      }
    },
  };
}
