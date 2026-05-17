import type { PanelRegistry } from "@natstack/shared/panelRegistry";
import { PanelManager } from "@natstack/shared/shell/panelManager";
import { PanelStoreRpc } from "@natstack/shared/shell/panelStoreRpc";
import type { ServerClient } from "../serverClient.js";
import { createPanelPersistenceClient } from "../../server/services/panelPersistenceClient.js";

export function createElectronShellCore(deps: {
  statePath: string;
  workspaceId: string;
  workspacePath: string;
  allowMissingManifests?: boolean;
  registry: PanelRegistry;
  serverClient: ServerClient;
  gatewayConfig: { serverUrl: string };
  workspaceConfig?: import("@natstack/shared/workspace/types").WorkspaceConfig;
}) {
  const persistence = createPanelPersistenceClient(deps.serverClient);
  const searchIndex = persistence;
  const store = new PanelStoreRpc((method, args) =>
    deps.serverClient.call("panel-persistence", method, args)
  );
  const panelManager = new PanelManager({
    store,
    registry: deps.registry,
    workspacePath: deps.workspacePath,
    allowMissingManifests: deps.allowMissingManifests,
    searchIndex,
    workspaceConfig: deps.workspaceConfig,
    serverInfo: {
      gatewayConfig: deps.gatewayConfig,
    },
    tokenClient: {
      ensurePanelToken: (panelId, contextId, parentId, source) =>
        deps.serverClient.call("tokens", "ensurePanelToken", [
          panelId,
          contextId,
          parentId,
          source,
        ]) as Promise<{ token: string }>,
      revokePanelToken: (panelId) =>
        deps.serverClient.call("tokens", "revokePanelToken", [panelId]) as Promise<void>,
      updatePanelContext: (panelId, contextId) =>
        deps.serverClient.call("tokens", "updatePanelContext", [
          panelId,
          contextId,
        ]) as Promise<void>,
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
