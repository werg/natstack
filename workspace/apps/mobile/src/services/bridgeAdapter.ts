import type { PanelManager } from "@natstack/shared/shell/panelManager";
import { asPanelSlotId } from "@natstack/shared/panel/ids";
import type { OpenExternalOptions } from "@natstack/shared/externalOpen";
import { externalOpenMethods } from "@natstack/shared/serviceSchemas/externalOpen";
import { createTypedServiceClient } from "@natstack/shared/typedServiceClient";
import type { MobileRpcClient } from "./mobileTransport";

export interface BridgeAdapterCallbacks {
  navigateToPanel(panelId: string): void;
}

export function createBridgeAdapter(deps: {
  panelManager: PanelManager;
  transport: MobileRpcClient;
  callbacks: BridgeAdapterCallbacks;
  getPanelInit?: (panelId: string) => Promise<unknown>;
}) {
  // Tree mutations from hosted webviews route through the single server
  // authority (panelTree); the mirror updates reactively via the broadcast.
  const callPanelTree = <T = unknown>(method: string, callArgs: unknown[]): Promise<T> =>
    deps.transport.call("main", `panelTree.${method}`, callArgs) as Promise<T>;
  return {
    async handle(panelId: string, method: string, args: unknown[]): Promise<unknown> {
      const slotId = asPanelSlotId(panelId);
      switch (method) {
        case "getPanelInit":
          if (deps.getPanelInit) return deps.getPanelInit(panelId);
          return deps.panelManager.getPanelInit(slotId);
        case "getInfo":
          return deps.panelManager.getInfo(slotId);
        case "focusPanel": {
          const targetId = args[0] as string;
          await deps.panelManager.notifyFocused(asPanelSlotId(targetId));
          deps.callbacks.navigateToPanel(targetId);
          return;
        }
        case "openPanelChild": {
          const [source, options] = args as [
            string,
            {
              name?: string;
              focus?: boolean;
              stateArgs?: Record<string, unknown>;
            }?,
          ];
          const created = await callPanelTree<{ id: string; title: string; kind: string }>(
            "create",
            [source, { parentId: panelId, name: options?.name, stateArgs: options?.stateArgs }]
          );
          if (options?.focus !== false) {
            deps.callbacks.navigateToPanel(created.id);
          }
          return { id: created.id, title: created.title, kind: created.kind };
        }
        case "openExternal": {
          const [url, options] = args as [string, OpenExternalOptions?];
          const externalOpen = createTypedServiceClient(
            "externalOpen",
            externalOpenMethods,
            (svc, method, callArgs) => deps.transport.call("main", `${svc}.${method}`, callArgs)
          );
          await externalOpen.openExternal(url, options);
          return;
        }
        case "getCdpEndpoint":
        case "navigate":
        case "goBack":
        case "goForward":
        case "stop":
          throw new Error(
            "CDP automation is routed through the server broker and is not available for mobile-held WebViews"
          );
        case "openDevtools":
          return;
        case "openFolderDialog":
          return null;
        default:
          throw new Error(`Unknown mobile bridge method: ${method}`);
      }
    },
  };
}
