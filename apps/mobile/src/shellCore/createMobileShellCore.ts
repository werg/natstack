import { PanelRegistry } from "@natstack/shared/panelRegistry";
import { PanelManager } from "@natstack/shared/shell/panelManager";
import { PanelStoreRpc } from "@natstack/shared/shell/panelStoreRpc";
import type { MobileTransport } from "../services/mobileTransport";
import { parseHostConfig } from "../services/panelUrls";

export function createMobileShellCore(deps: {
  workspaceId: string;
  serverUrl: string;
  transport: MobileTransport;
  onTreeUpdated?: (tree: import("@natstack/shared/types").Panel[]) => void;
}) {
  const registry = new PanelRegistry({ onTreeUpdated: deps.onTreeUpdated });
  // Server-backed panel store via `panel-persistence` service (same backend
  // Electron uses). Mobile no longer keeps a device-local panel-tree cache,
  // so wiping the server's user-data directory now also wipes panel tree
  // state as the user expects.
  const store = new PanelStoreRpc((method, args) =>
    deps.transport.call("main", `panel-persistence.${method}`, ...args),
  );
  const host = parseHostConfig(deps.serverUrl);
  const hostWithPort = `${host.host}${host.port ? `:${host.port}` : ""}`;

  const panelManager = new PanelManager({
    store,
    registry,
    workspacePath: "",
    allowMissingManifests: true,
    serverInfo: {
      gatewayConfig: { serverUrl: `${host.protocol}://${hostWithPort}` },
    },
    identityClient: {
      register: (panelId, contextId, parentId, source) =>
        deps.transport.call("main", "principals.register", panelId, "panel", {
          contextId,
          parentId,
          source,
        }) as Promise<void>,
      unregister: (panelId) =>
        deps.transport.call("main", "principals.unregister", panelId) as Promise<void>,
      bindContext: (panelId, contextId) =>
        deps.transport.call("main", "principals.bindContext", panelId, contextId) as Promise<void>,
      setParent: (panelId, parentId) =>
        deps.transport.call("main", "principals.setParent", panelId, parentId) as Promise<void>,
      grantConnection: (panelId) =>
        deps.transport.call("main", "auth.grantConnection", panelId) as Promise<{ token: string }>,
    },
  });

  return {
    registry,
    panelManager,
  };
}
