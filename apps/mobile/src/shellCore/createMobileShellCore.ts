import { PanelRegistry } from "@natstack/shared/panelRegistry";
import { PanelManager } from "@natstack/shared/shell/panelManager";
import type { MobileTransport } from "../services/mobileTransport";
import { parseHostConfig } from "../services/panelUrls";
import { PanelStoreAsync } from "./panelStoreAsync";

export function createMobileShellCore(deps: {
  workspaceId: string;
  serverUrl: string;
  transport: MobileTransport;
  onTreeUpdated?: (tree: import("@natstack/shared/types").Panel[]) => void;
}) {
  const registry = new PanelRegistry({ onTreeUpdated: deps.onTreeUpdated });
  const store = new PanelStoreAsync(deps.workspaceId);
  const host = parseHostConfig(deps.serverUrl);
  const gatewayPort = host.port ? Number(host.port) : host.protocol === "https" ? 443 : 80;
  const wsProtocol = host.protocol === "https" ? "wss" : "ws";
  const hostWithPort = `${host.host}${host.port ? `:${host.port}` : ""}`;

  const panelManager = new PanelManager({
    store,
    registry,
    workspacePath: "",
    allowMissingManifests: true,
    serverInfo: {
      protocol: host.protocol as "http" | "https",
      externalHost: host.host,
      gatewayPort,
      rpcPort: gatewayPort,
      workerdPort: gatewayPort,
      gitBaseUrl: `${host.protocol}://${hostWithPort}/_git`,
      rpcWsUrl: `${wsProtocol}://${hostWithPort}/rpc`,
      pubsubUrl: `${wsProtocol}://${hostWithPort}/_w/workers/pubsub-channel/PubSubChannel`,
    },
    tokenClient: {
      ensurePanelToken: (panelId, contextId, parentId) =>
        deps.transport.call("main", "tokens.ensurePanelToken", panelId, contextId, parentId) as Promise<{ token: string; gitToken: string }>,
      revokePanelToken: (panelId) =>
        deps.transport.call("main", "tokens.revokePanelToken", panelId) as Promise<void>,
      updatePanelContext: (panelId, contextId) =>
        deps.transport.call("main", "tokens.updatePanelContext", panelId, contextId) as Promise<void>,
      updatePanelParent: (panelId, parentId) =>
        deps.transport.call("main", "tokens.updatePanelParent", panelId, parentId) as Promise<void>,
    },
  });

  return {
    registry,
    panelManager,
  };
}
