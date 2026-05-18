import { PanelRegistry } from "@natstack/shared/panelRegistry";
import { PanelManager } from "@natstack/shared/shell/panelManager";
import type { MobileTransport } from "../services/mobileTransport";
import { parseHostConfig } from "../services/panelUrls";
import { enqueueWorkspaceRpcMutation } from "../services/backgroundActionQueue";
import { createMobileLocalViewStateStore } from "./localViewState";

export function createMobileShellCore(deps: {
    workspaceId: string;
    serverUrl: string;
    transport: MobileTransport;
    onTreeUpdated?: (tree: import("@natstack/shared/types").Panel[]) => void;
}) {
    const registry = new PanelRegistry({ onTreeUpdated: deps.onTreeUpdated });
    const host = parseHostConfig(deps.serverUrl);
    const hostWithPort = `${host.host}${host.port ? `:${host.port}` : ""}`;
    const panelManager = new PanelManager({
        registry,
        workspaceSync: {
            getSnapshot: () => deps.transport.call("main", "workspace-sync.getSnapshot", []),
            getOpsSince: (baseRevision) => deps.transport.call("main", "workspace-sync.getOpsSince", [baseRevision]),
            submitOps: async (baseRevision, ops) => {
                try {
                    return await deps.transport.call("main", "workspace-sync.submitOps", [baseRevision, ops]);
                }
                catch (error) {
                    if (deps.transport.status !== "connected") {
                        await enqueueWorkspaceRpcMutation({
                            service: "workspace-sync",
                            method: "submitOps",
                            args: [baseRevision, ops],
                        });
                    }
                    throw error;
                }
            },
        },
        activationClient: {
            markPanelActive: (panelId) => deps.transport.call("main", "presence.markPanelActive", [panelId]) as Promise<void>,
        },
        viewState: createMobileLocalViewStateStore(deps.workspaceId),
        workspacePath: "",
        allowMissingManifests: true,
        serverInfo: {
            gatewayConfig: { serverUrl: `${host.protocol}://${hostWithPort}` },
        },
        tokenClient: {
            ensurePanelToken: (panelId, contextId, parentId) => deps.transport.call("main", "tokens.ensurePanelToken", [panelId, contextId, parentId]) as Promise<{
                token: string;
            }>,
            revokePanelToken: (panelId) => deps.transport.call("main", "tokens.revokePanelToken", [panelId]) as Promise<void>,
            updatePanelContext: (panelId, contextId) => deps.transport.call("main", "tokens.updatePanelContext", [panelId, contextId]) as Promise<void>,
            updatePanelParent: (panelId, parentId) => deps.transport.call("main", "tokens.updatePanelParent", [panelId, parentId]) as Promise<void>,
        },
    });
    return {
        registry,
        panelManager,
    };
}
