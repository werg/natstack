import type { PanelRegistry } from "@natstack/shared/panelRegistry";
import { PanelManager } from "@natstack/shared/shell/panelManager";
import type { ServerClient } from "../serverClient.js";
import type {
  AppendPanelOpsResult,
  PanelOpsSinceResult,
  PanelSnapshotResult,
  SubmittedPanelOp,
} from "@natstack/shared/panelOpsTypes";
import { createElectronLocalViewStateStore } from "./localViewState.js";

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
  const panelManager = new PanelManager({
    registry: deps.registry,
    workspaceSync: {
      getSnapshot: () =>
        deps.serverClient.call("workspace-sync", "getSnapshot", []) as Promise<PanelSnapshotResult>,
      getOpsSince: (baseRevision) =>
        deps.serverClient.call("workspace-sync", "getOpsSince", [
          baseRevision,
        ]) as Promise<PanelOpsSinceResult>,
      submitOps: (baseRevision, ops: SubmittedPanelOp[]) =>
        deps.serverClient.call("workspace-sync", "submitOps", [
          baseRevision,
          ops,
        ]) as Promise<AppendPanelOpsResult>,
    },
    activationClient: {
      markPanelActive: (panelId) =>
        deps.serverClient.call("presence", "markPanelActive", [panelId]) as Promise<void>,
    },
    viewState: createElectronLocalViewStateStore(deps.statePath),
    workspacePath: deps.workspacePath,
    allowMissingManifests: deps.allowMissingManifests,
    searchIndex: null,
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
    shutdown: () => {},
  };
}
