/**
 * Electron Service Registry — registers all Electron-main-owned services on a dispatcher.
 *
 * Called from src/main/index.ts after all Electron infrastructure is initialized.
 */

import type { ServiceDispatcher } from "../shared/serviceDispatcher.js";
import type { PanelLifecycle } from "../shared/panelLifecycle.js";
import type { PanelRegistry } from "../shared/panelRegistry.js";
import type { PanelView } from "./panelView.js";
import type { CdpServer } from "./cdpServer.js";
import type { FsService } from "../shared/fsService.js";
import type { EventService } from "../shared/eventsService.js";
import type { ServerClient } from "./serverClient.js";
import type { ViewManager } from "./viewManager.js";
import type { CentralDataManager } from "./centralData.js";
import type { AdBlockManager } from "./adblock/index.js";
import type { Workspace } from "../shared/workspace/types.js";
import type { ServerInfo } from "./serverInfo.js";
import { createEventsServiceDefinition } from "../shared/eventsService.js";

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
    panelLifecycle: PanelLifecycle;
    panelRegistry: PanelRegistry;
    panelView: PanelView;
    cdpServer: CdpServer;
    fsService: FsService;
    eventService: EventService;
    serverClient: ServerClient | null;
    serverInfo: ServerInfo;
    getViewManager: () => ViewManager;
    centralData: CentralDataManager;
    adBlockManager: AdBlockManager;
    workspace: Workspace | null;
  },
): void {
  // Shell-only services
  dispatcher.registerService(createAppService({
    panelLifecycle: deps.panelLifecycle,
    serverClient: deps.serverClient,
    getViewManager: deps.getViewManager,
  }));
  dispatcher.registerService(createPanelShellService({
    panelLifecycle: deps.panelLifecycle,
    panelRegistry: deps.panelRegistry,
    panelView: deps.panelView,
    getViewManager: deps.getViewManager,
  }));
  dispatcher.registerService(createViewService({
    getViewManager: deps.getViewManager,
  }));
  dispatcher.registerService(createMenuService({
    panelLifecycle: deps.panelLifecycle,
    panelRegistry: deps.panelRegistry,
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
    panelLifecycle: deps.panelLifecycle,
    cdpServer: deps.cdpServer,
    getViewManager: deps.getViewManager,
    workspace: deps.workspace,
    serverInfo: deps.serverInfo,
  }));
  dispatcher.registerService(createBrowserService({
    cdpServer: deps.cdpServer,
    getViewManager: deps.getViewManager,
    panelRegistry: deps.panelRegistry,
  }));
  dispatcher.registerService(createFsServiceDefinition({
    fsService: deps.fsService,
  }));
  dispatcher.registerService(createGitLocalService());

  // Events service (same instance as server — shared emitter)
  dispatcher.registerService(createEventsServiceDefinition(deps.eventService));
}
