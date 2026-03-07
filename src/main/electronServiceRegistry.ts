/**
 * Electron Service Registry — registers all Electron-main-owned services on a dispatcher.
 *
 * Called from src/main/index.ts after all Electron infrastructure is initialized.
 */

import type { ServiceDispatcher } from "./serviceDispatcher.js";
import type { PanelManager } from "./panelManager.js";
import type { CdpServer } from "./cdpServer.js";
import type { FsService } from "./fsService.js";
import type { EventService } from "./services/eventsService.js";
import type { ServerClient } from "./serverClient.js";
import type { ViewManager } from "./viewManager.js";
import type { CentralDataManager } from "./centralData.js";
import type { AdBlockManager } from "./adblock/index.js";
import type { Workspace } from "./workspace/types.js";
import { createEventsServiceDefinition } from "../server/services/eventsServiceDef.js";

import { createAppService } from "./services/appService.js";
import { createPanelShellService } from "./services/panelShellService.js";
import { createViewService } from "./services/viewService.js";
import { createMenuService } from "./services/menuService.js";
import { createWorkspaceService } from "./services/workspaceService.js";
import { createCentralService } from "./services/centralService.js";
import { createSettingsService } from "./services/settingsService.js";
import { createAdblockService } from "./services/adblockService.js";
import { createBridgeService } from "./services/bridgeService.js";
import { createBrowserService } from "./services/browserService.js";
import { createFsServiceDefinition } from "./services/fsServiceDef.js";
import { createGitLocalService } from "./services/gitLocalService.js";

export function registerElectronServices(
  dispatcher: ServiceDispatcher,
  deps: {
    panelManager: PanelManager;
    cdpServer: CdpServer;
    fsService: FsService;
    eventService: EventService;
    serverClient: ServerClient | null;
    getViewManager: () => ViewManager;
    centralData: CentralDataManager;
    adBlockManager: AdBlockManager;
    workspace: Workspace | null;
  },
): void {
  // Shell-only services
  dispatcher.registerService(createAppService({
    panelManager: deps.panelManager,
    serverClient: deps.serverClient,
    getViewManager: deps.getViewManager,
  }));
  dispatcher.registerService(createPanelShellService({
    panelManager: deps.panelManager,
    getViewManager: deps.getViewManager,
  }));
  dispatcher.registerService(createViewService({
    getViewManager: deps.getViewManager,
  }));
  dispatcher.registerService(createMenuService({
    panelManager: deps.panelManager,
    getViewManager: deps.getViewManager,
    serverClient: deps.serverClient,
  }));
  dispatcher.registerService(createWorkspaceService({ centralData: deps.centralData }));
  dispatcher.registerService(createCentralService({ centralData: deps.centralData }));
  dispatcher.registerService(createSettingsService({
    serverClient: deps.serverClient,
  }));
  dispatcher.registerService(createAdblockService({ adBlockManager: deps.adBlockManager }));

  // Locally-hosted services (depend on main-process objects)
  dispatcher.registerService(createBridgeService({
    panelManager: deps.panelManager,
    cdpServer: deps.cdpServer,
    getViewManager: deps.getViewManager,
    workspace: deps.workspace,
  }));
  dispatcher.registerService(createBrowserService({
    cdpServer: deps.cdpServer,
    getViewManager: deps.getViewManager,
    panelManager: deps.panelManager,
  }));
  dispatcher.registerService(createFsServiceDefinition({
    fsService: deps.fsService,
  }));
  dispatcher.registerService(createGitLocalService());

  // Events service (same instance as server — shared emitter)
  dispatcher.registerService(createEventsServiceDefinition(deps.eventService));
}
