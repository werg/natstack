import type { PanelManager } from "@natstack/shared/shell/panelManager";
import type { PanelRegistry } from "@natstack/shared/panelRegistry";
import { getCurrentSnapshot } from "@natstack/shared/panel/accessors";
import { asPanelSlotId } from "@natstack/shared/panel/ids";
import type { MobileTransport } from "./mobileTransport";
import { Platform } from "react-native";

export interface BridgeAdapterCallbacks {
    navigateToPanel(panelId: string): void;
}

export interface MobilePanelRuntimeHost {
    ensureLoaded(panelId: string): Promise<void>;
    snapshot(panelId: string): Promise<unknown>;
    callAgent(panelId: string, method: string, args: unknown[]): Promise<unknown>;
    navigate(panelId: string, url: string): Promise<void>;
    goBack(panelId: string): Promise<void>;
    goForward(panelId: string): Promise<void>;
    reload(panelId: string): Promise<void>;
    stop(panelId: string): Promise<void>;
    getCdpEndpoint(panelId: string): Promise<{ wsEndpoint: string; token?: string }>;
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
    transport: MobileTransport;
    callbacks: BridgeAdapterCallbacks;
}) {
    let runtimeHost: MobilePanelRuntimeHost | null = null;
    const requireRuntimeHost = () => {
        if (!runtimeHost) throw new Error("Mobile panel runtime host is not attached");
        return runtimeHost;
    };
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
                    return deps.panelManager.updateStateArgs(slotId, (args[0] ?? {}) as Record<string, unknown>);
                case "panel.close": {
                    const targetId = args[0] as string;
                    const nextPanelId = chooseNextPanel(deps.registry, targetId);
                    await deps.panelManager.close(asPanelSlotId(targetId));
                    if (nextPanelId)
                        deps.callbacks.navigateToPanel(nextPanelId);
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
                    return deps.panelManager.updateStateArgs(asPanelSlotId(targetId), updates);
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
                        }?
                    ];
                    const isBrowser = /^https?:\/\//i.test(source);
                    const created = isBrowser
                        ? await deps.panelManager.createBrowser(slotId, source, { name: options?.name })
                        : await deps.panelManager.create(source, {
                            parentId: slotId,
                            name: options?.name,
                            stateArgs: options?.stateArgs,
                        });
                    if (options?.focus !== false) {
                        deps.callbacks.navigateToPanel(created.panelId);
                    }
                    return { id: created.panelId, title: created.title, kind: isBrowser ? "browser" : "workspace" };
                }
                case "panel.snapshot":
                    return requireRuntimeHost().snapshot(args[0] as string);
                case "panel.callAgent":
                    return requireRuntimeHost().callAgent(
                        args[0] as string,
                        args[1] as string,
                        (args[2] ?? []) as unknown[],
                    );
                case "openExternal": {
                    const [url, options] = args as [
                        string,
                        unknown?
                    ];
                    await deps.transport.call("main", "externalOpen.openExternalForCaller", [{
                            callerId: panelId,
                            callerKind: "panel",
                            url,
                            options,
                        }]);
                    return;
                }
                case "getCdpEndpoint":
                    if (Platform.OS === "android")
                        return requireRuntimeHost().getCdpEndpoint(args[0] as string);
                    throw new Error("CDP is not available on iOS WebView");
                case "navigate":
                    return requireRuntimeHost().navigate(args[0] as string, args[1] as string);
                case "goBack":
                    return requireRuntimeHost().goBack(args[0] as string);
                case "goForward":
                    return requireRuntimeHost().goForward(args[0] as string);
                case "reload":
                    return requireRuntimeHost().reload(args[0] as string);
                case "stop":
                    return requireRuntimeHost().stop(args[0] as string);
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
