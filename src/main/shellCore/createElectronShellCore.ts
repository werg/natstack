import { createPanelPersistence } from "@natstack/shared/db/panelPersistence";
import { createPanelSearchIndex } from "@natstack/shared/db/panelSearchIndex";
import type { PanelRegistry } from "@natstack/shared/panelRegistry";
import { PanelManager } from "@natstack/shared/shell/panelManager";
import type { ServerClient } from "../serverClient.js";
import { PanelStoreSqlite } from "./panelStoreSqlite.js";

export function createElectronShellCore(deps: {
  statePath: string;
  workspaceId: string;
  workspacePath: string;
  allowMissingManifests?: boolean;
  registry: PanelRegistry;
  serverClient: ServerClient;
  protocol: "http" | "https";
  externalHost: string;
  gatewayPort: number;
  rpcPort: number;
  workerdPort: number;
  gitBaseUrl: string;
  rpcWsUrl: string;
  pubsubUrl: string;
  workspaceConfig?: import("@natstack/shared/workspace/types").WorkspaceConfig;
}) {
  const persistence = createPanelPersistence({
    statePath: deps.statePath,
    workspaceId: deps.workspaceId,
  });
  const searchIndex = createPanelSearchIndex(persistence);
  const store = new PanelStoreSqlite(persistence);
  const panelManager = new PanelManager({
    store,
    registry: deps.registry,
    workspacePath: deps.workspacePath,
    allowMissingManifests: deps.allowMissingManifests,
    searchIndex,
    workspaceConfig: deps.workspaceConfig,
    serverInfo: {
      protocol: deps.protocol,
      externalHost: deps.externalHost,
      gatewayPort: deps.gatewayPort,
      rpcPort: deps.rpcPort,
      workerdPort: deps.workerdPort,
      gitBaseUrl: deps.gitBaseUrl,
      rpcWsUrl: deps.rpcWsUrl,
      pubsubUrl: deps.pubsubUrl,
    },
    tokenClient: {
      ensurePanelToken: (panelId, contextId, parentId, source) =>
        deps.serverClient.call("tokens", "ensurePanelToken", [panelId, contextId, parentId, source]) as Promise<{ token: string; gitToken: string }>,
      revokePanelToken: (panelId) =>
        deps.serverClient.call("tokens", "revokePanelToken", [panelId]) as Promise<void>,
      updatePanelContext: (panelId, contextId) =>
        deps.serverClient.call("tokens", "updatePanelContext", [panelId, contextId]) as Promise<void>,
      updatePanelParent: (panelId, parentId) =>
        deps.serverClient.call("tokens", "updatePanelParent", [panelId, parentId]) as Promise<void>,
    },
  });

  return {
    panelManager,
    persistence,
    searchIndex,
    shutdown: () => store.close?.(),
  };
}
