import type { PanelManager } from "@natstack/shared/shell/panelManager";
import type { PanelRegistry } from "@natstack/shared/panelRegistry";
import { getCurrentSnapshot } from "@natstack/shared/panel/accessors";
import { asPanelSlotId } from "@natstack/shared/panel/ids";
import type { OpenExternalOptions } from "@natstack/shared/externalOpen";
import { externalOpenMethods } from "@natstack/shared/serviceSchemas/externalOpen";
import { createTypedServiceClient } from "@natstack/shared/typedServiceClient";
import type { MobileRpcClient } from "./mobileTransport";

export interface BridgeAdapterCallbacks {
  navigateToPanel(panelId: string): void;
}

export interface MobilePanelRuntimeHost {
  ensureLoaded(panelId: string): Promise<void>;
  snapshot(panelId: string): Promise<unknown>;
  callAgent(panelId: string, method: string, args: unknown[]): Promise<unknown>;
  reload(panelId: string): Promise<void>;
}

function chooseNextPanel(registry: PanelRegistry, closingPanelId: string): string | null {
  const parentId = registry.findParentId(closingPanelId);
  const parent = parentId ? registry.getPanel(parentId) : null;
  if (parent) {
    const siblings = parent.children.filter((child) => child.id !== closingPanelId);
    const previousSibling = siblings[siblings.length - 1];
    return previousSibling ? previousSibling.id : parentId;
  }
  const roots = registry.getRootPanels().filter((panel) => panel.id !== closingPanelId);
  return roots[0]?.id ?? null;
}
export function createBridgeAdapter(deps: {
  panelManager: PanelManager;
  registry: PanelRegistry;
  transport: MobileRpcClient;
  callbacks: BridgeAdapterCallbacks;
}) {
  let runtimeHost: MobilePanelRuntimeHost | null = null;
  const requireRuntimeHost = () => {
    if (!runtimeHost) throw new Error("Mobile panel runtime host is not attached");
    return runtimeHost;
  };
  // Tree mutations from hosted webviews route through the single server
  // authority (panelTree); the mirror updates reactively via the broadcast.
  const callPanelTree = <T = unknown>(method: string, callArgs: unknown[]): Promise<T> =>
    deps.transport.call("main", `panelTree.${method}`, callArgs) as Promise<T>;
  return {
    setRuntimeHost(host: MobilePanelRuntimeHost | null): void {
      runtimeHost = host;
    },
    async handle(panelId: string, method: string, args: unknown[]): Promise<unknown> {
      const slotId = asPanelSlotId(panelId);
      switch (method) {
        case "getPanelInit":
          return deps.panelManager.getPanelInit(slotId);
        case "getInfo":
          return deps.panelManager.getInfo(slotId);
        case "setStateArgs":
          return callPanelTree("setStateArgs", [
            panelId,
            (args[0] ?? {}) as Record<string, unknown>,
          ]);
        case "panel.close": {
          const targetId = args[0] as string;
          const nextPanelId = chooseNextPanel(deps.registry, targetId);
          await callPanelTree("archive", [targetId]);
          if (nextPanelId) deps.callbacks.navigateToPanel(nextPanelId);
          return;
        }
        case "panel.reload":
          return requireRuntimeHost().reload(args[0] as string);
        case "panel.getStateArgs": {
          const targetId = args[0] as string;
          const panel = deps.registry.getPanel(targetId);
          return panel ? (getCurrentSnapshot(panel).stateArgs ?? {}) : {};
        }
        case "panel.setStateArgs": {
          const targetId = args[0] as string;
          const updates = (args[1] ?? {}) as Record<string, unknown>;
          return callPanelTree("setStateArgs", [targetId, updates]);
        }
        case "panel.list": {
          const parentId = args[0] as string | null | undefined;
          return parentId ? deps.registry.getChildren(parentId) : deps.registry.listPanels();
        }
        case "focusPanel": {
          const targetId = args[0] as string;
          await deps.panelManager.notifyFocused(asPanelSlotId(targetId));
          deps.callbacks.navigateToPanel(targetId);
          return;
        }
        case "panel.create": {
          const [source, options] = args as [
            string,
            {
              name?: string;
              focus?: boolean;
              stateArgs?: Record<string, unknown>;
            }?,
          ];
          // The server bridge detects http(s) sources and routes to the
          // browser-create path; parentId scopes the new child.
          const created = await callPanelTree<{ id: string; title: string; kind: string }>(
            "create",
            [source, { parentId: panelId, name: options?.name, stateArgs: options?.stateArgs }]
          );
          if (options?.focus !== false) {
            deps.callbacks.navigateToPanel(created.id);
          }
          return { id: created.id, title: created.title, kind: created.kind };
        }
        case "panel.snapshot":
          return requireRuntimeHost().snapshot(args[0] as string);
        case "panel.callAgent":
          return requireRuntimeHost().callAgent(
            args[0] as string,
            args[1] as string,
            (args[2] ?? []) as unknown[]
          );
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
        case "reload":
          return requireRuntimeHost().reload(args[0] as string);
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
