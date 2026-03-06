/**
 * Electron Service Registry — registers all Electron-main-owned services on a dispatcher.
 *
 * Called from src/main/index.ts after all Electron infrastructure is initialized.
 */

import { z } from "zod";
import type { ServiceDispatcher } from "./serviceDispatcher.js";
import type { ServiceDefinition } from "./serviceDefinition.js";
import type { PanelManager } from "./panelManager.js";
import type { CdpServer } from "./cdpServer.js";
import type { FsService } from "./fsService.js";
import type { EventService } from "./services/eventsService.js";
import type { ServerClient } from "./serverClient.js";
import { createEventsServiceDefinition } from "../server/services/eventsServiceDef.js";

import {
  handleAppService,
  handlePanelService,
  handleViewService,
  handleMenuService,
  handleWorkspaceService,
  handleCentralService,
  handleSettingsService,
} from "./ipc/shellServices.js";
import { handleBridgeCall } from "./ipc/bridgeHandlers.js";
import { handleBrowserCall } from "./ipc/browserHandlers.js";
import { handleAdBlockServiceCall } from "./ipc/adblockHandlers.js";
import { handleGitServiceCall } from "./ipc/gitServiceHandler.js";
import { handleFsCall } from "./fsService.js";
import { handleEventsService } from "./services/eventsService.js";

function shellOnlyService(name: string, description: string, handler: ServiceDefinition["handler"]): ServiceDefinition {
  return {
    name,
    description,
    policy: { allowed: ["shell"] },
    methods: {},
    handler,
  };
}

export function registerElectronServices(
  dispatcher: ServiceDispatcher,
  deps: {
    panelManager: PanelManager;
    cdpServer: CdpServer;
    fsService: FsService;
    eventService: EventService;
    getViewManager: () => import("./viewManager.js").ViewManager;
  },
): void {
  // Shell-only services
  dispatcher.registerService(shellOnlyService("app", "App lifecycle, theme, devtools", handleAppService));
  dispatcher.registerService(shellOnlyService("panel", "Panel tree management", handlePanelService));
  dispatcher.registerService(shellOnlyService("view", "View bounds, visibility", handleViewService));
  dispatcher.registerService(shellOnlyService("menu", "Native menus", handleMenuService));
  dispatcher.registerService(shellOnlyService("workspace", "Workspace CRUD", handleWorkspaceService));
  dispatcher.registerService(shellOnlyService("central", "Central data store", handleCentralService));
  dispatcher.registerService(shellOnlyService("settings", "Settings management", handleSettingsService));
  dispatcher.registerService(shellOnlyService("adblock", "Ad blocking", async (_ctx, method, args) => {
    return handleAdBlockServiceCall(method, args as unknown[]);
  }));

  // Locally-hosted services (depend on main-process objects)
  dispatcher.registerService({
    name: "bridge",
    description: "Panel lifecycle (createPanel, close, navigation)",
    policy: { allowed: ["panel", "shell", "server"] },
    methods: {},
    handler: async (ctx, method, args) => {
      return handleBridgeCall(deps.panelManager, deps.cdpServer, ctx.callerId, method, args);
    },
  });

  dispatcher.registerService({
    name: "browser",
    description: "CDP/browser automation",
    policy: { allowed: ["shell", "panel", "server"] },
    methods: {},
    handler: async (ctx, method, args) => {
      return handleBrowserCall(
        deps.cdpServer,
        deps.getViewManager(),
        deps.panelManager,
        ctx.callerId,
        ctx.callerKind,
        method,
        args,
      );
    },
  });

  dispatcher.registerService({
    name: "fs",
    description: "Per-context filesystem operations",
    policy: { allowed: ["panel", "server"] },
    methods: {},
    handler: async (ctx, method, args) => {
      return handleFsCall(deps.fsService, ctx, method, args as unknown[]);
    },
  });

  dispatcher.registerService({
    name: "git",
    description: "Local git+fs for shell about-pages",
    policy: { allowed: ["shell", "panel", "server"] },
    methods: {},
    handler: async (ctx, method, args) => {
      return handleGitServiceCall(ctx, method, args as unknown[]);
    },
  });

  // Events service (same instance as server — shared emitter)
  dispatcher.registerService(createEventsServiceDefinition(deps.eventService));
}
