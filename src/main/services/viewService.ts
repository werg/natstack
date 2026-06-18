import type { ServiceDefinition } from "@natstack/shared/serviceDefinition";
import { viewMethods } from "@natstack/shared/serviceSchemas/view";
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

  const assertNativePanelSlotHost = (
    vm: ViewManager,
    callerId: string,
    callerKind: string,
    method: string
  ): void => {
    const viewInfo = vm.getViewInfo(callerId);
    if (
      callerKind === "app" &&
      viewInfo?.type === "app" &&
      viewInfo.capabilities.includes("panel-hosting")
    ) {
      return;
    }
    throw new Error(`view.${method}: caller '${callerId}' cannot place native panel slots`);
  };

  const assertLegacyShellLayoutHost = (
    callerId: string,
    callerKind: string,
    method: string
  ): void => {
    if (callerKind === "shell") return;
    throw new Error(`view.${method}: hosted apps must place panels with native panel slots`);
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
    methods: viewMethods,
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
          const targetInfo = vm.getViewInfo(viewId);
          if (
            ctx.caller.runtime.kind === "app" &&
            ctx.caller.runtime.id !== viewId &&
            targetInfo?.type === "panel"
          ) {
            throw new Error(
              `view.setVisible: hosted apps must place panel views with native panel slots`
            );
          }
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
          assertLegacyShellLayoutHost(
            ctx.caller.runtime.id,
            ctx.caller.runtime.kind,
            "updateLayout"
          );
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
        case "updatePanelViewportBounds": {
          assertLegacyShellLayoutHost(
            ctx.caller.runtime.id,
            ctx.caller.runtime.kind,
            "updatePanelViewportBounds"
          );
          const bounds = args[0] as { x: number; y: number; width: number; height: number } | null;
          vm.setPanelViewportBounds(bounds);
          return;
        }
        case "bindNativePanelSlot": {
          assertNativePanelSlotHost(
            vm,
            ctx.caller.runtime.id,
            ctx.caller.runtime.kind,
            "bindNativePanelSlot"
          );
          const [request] = args as [
            {
              nativeSlotId: string;
              panelId: string;
              bounds: { x: number; y: number; width: number; height: number };
              focused?: boolean;
            },
          ];
          vm.bindPanelSlot(ctx.caller.runtime.id, request);
          return { status: "bound" };
        }
        case "updateNativePanelSlot": {
          assertNativePanelSlotHost(
            vm,
            ctx.caller.runtime.id,
            ctx.caller.runtime.kind,
            "updateNativePanelSlot"
          );
          const [request] = args as [
            {
              nativeSlotId: string;
              bounds?: { x: number; y: number; width: number; height: number };
              focused?: boolean;
            },
          ];
          return vm.updatePanelSlot(ctx.caller.runtime.id, request);
        }
        case "clearNativePanelSlot": {
          assertNativePanelSlotHost(
            vm,
            ctx.caller.runtime.id,
            ctx.caller.runtime.kind,
            "clearNativePanelSlot"
          );
          const [request] = args as [{ nativeSlotId: string }];
          vm.clearPanelSlot(ctx.caller.runtime.id, request.nativeSlotId);
          return;
        }
        case "setHostedShellReady": {
          assertNativePanelSlotHost(
            vm,
            ctx.caller.runtime.id,
            ctx.caller.runtime.kind,
            "setHostedShellReady"
          );
          const [request] = args as [{ ready: boolean }];
          vm.setHostedShellReady(ctx.caller.runtime.id, request.ready);
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
              rows: import("../shellOverlayView.js").ShellOverlayRow[];
              empty: string;
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
              rows?: import("../shellOverlayView.js").ShellOverlayRow[];
              empty?: string;
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
          vm.getWebContents(browserId)?.navigationHistory.goBack();
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
          vm.getWebContents(browserId)?.navigationHistory.goForward();
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
