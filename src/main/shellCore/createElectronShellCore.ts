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
    identityClient: {
      register: (panelId, contextId, parentId, source) =>
        deps.serverClient.call("principals", "register", [
          panelId,
          "panel",
          { contextId, parentId, source },
        ]) as Promise<void>,
      unregister: (panelId) =>
        deps.serverClient.call("principals", "unregister", [panelId]) as Promise<void>,
      bindContext: (panelId, contextId) =>
        deps.serverClient.call("principals", "bindContext", [panelId, contextId]) as Promise<void>,
      setParent: (panelId, parentId) =>
        deps.serverClient.call("principals", "setParent", [panelId, parentId]) as Promise<void>,
      grantConnection: (panelId) =>
        deps.serverClient.call("auth", "grantConnection", [panelId]) as Promise<{ token: string }>,
    },
  });

  return {
    panelManager,
    persistence,
    searchIndex,
    shutdown: () => store.close?.(),
  };
}
