/**
 * Server Service Registry — registers all server-owned services on a dispatcher.
 *
 * Called from src/server/index.ts after infrastructure is initialized.
 * AI service is registered separately (deferred until RpcServer exists).
 */

import type { ServiceDispatcher } from "../shared/serviceDispatcher.js";
import type { BuildSystemV2 } from "./buildV2/index.js";
import type { GitServer } from "../shared/gitServer.js";
import type { TokenManager } from "../shared/tokenManager.js";
import type { ContextFolderManager } from "../shared/contextFolderManager.js";
import type { EventService } from "../shared/eventsService.js";
import type { DatabaseManager } from "../shared/db/databaseManager.js";
import type { AgentSettingsService } from "../shared/agentSettings.js";
import type { AgentDiscovery } from "../shared/agentDiscovery.js";

import { createBuildService } from "./services/buildService.js";
import { createTokensService } from "./services/tokensService.js";
import { createGitService } from "./services/gitService.js";
import { createTestService } from "./services/testService.js";
import { createProjectService } from "./services/projectService.js";
import { createAgentSettingsService } from "./services/agentSettingsService.js";
import { createDbService } from "./services/dbService.js";
import { createTypecheckService } from "./services/typecheckService.js";
import { createEventsServiceDefinition } from "../shared/eventsService.js";

export function registerServerServices(
  dispatcher: ServiceDispatcher,
  deps: {
    buildSystem: BuildSystemV2;
    gitServer: GitServer;
    tokenManager: TokenManager;
    contextFolderManager: ContextFolderManager;
    eventService: EventService;
    databaseManager: DatabaseManager;
    agentSettingsService: AgentSettingsService;
    agentDiscovery: AgentDiscovery | null;
    workspacePath: string;
    panelTestSetupPath: string;
  },
): void {
  dispatcher.registerService(createBuildService({ buildSystem: deps.buildSystem }));
  dispatcher.registerService(createTokensService({ tokenManager: deps.tokenManager }));
  dispatcher.registerService(createGitService({
    gitServer: deps.gitServer,
    tokenManager: deps.tokenManager,
    contextFolderManager: deps.contextFolderManager,
  }));
  dispatcher.registerService(createTestService({
    contextFolderManager: deps.contextFolderManager,
    workspacePath: deps.workspacePath,
    panelTestSetupPath: deps.panelTestSetupPath,
  }));
  dispatcher.registerService(createProjectService({
    contextFolderManager: deps.contextFolderManager,
    gitServer: deps.gitServer,
    tokenManager: deps.tokenManager,
  }));
  dispatcher.registerService(createAgentSettingsService({
    agentSettingsService: deps.agentSettingsService,
    agentDiscovery: deps.agentDiscovery,
  }));
  dispatcher.registerService(createDbService({ databaseManager: deps.databaseManager }));
  dispatcher.registerService(createTypecheckService({
    contextFolderManager: deps.contextFolderManager,
  }));
  dispatcher.registerService(createEventsServiceDefinition(deps.eventService));
}
