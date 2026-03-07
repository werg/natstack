/**
 * Shared service orchestration for Electron and headless entry points.
 *
 * Uses ServiceContainer for topological startup/shutdown ordering.
 * `startCoreServices` registers all core services, starts them in
 * dependency order, and returns a handle for accessing instances.
 */

import { ServiceContainer } from "./serviceContainer.js";
import {
  ManagedTokenService,
  ManagedDatabaseService,
  ManagedAgentDiscoveryService,
  ManagedAgentSettingsServiceWrapper,
  ManagedGitServerService,
  ManagedGitWatcherService,
  ManagedPubSubService,
  ManagedAgentHostService,
  ManagedAiService,
} from "./managedServices.js";
import type { TokenManager } from "./tokenManager.js";
import type { DatabaseManager } from "./db/databaseManager.js";
import type { Workspace } from "./workspace/types.js";
import type { GitServer } from "./gitServer.js";
import type { AIHandler } from "./ai/aiHandler.js";
import type { ContextFolderManager } from "./contextFolderManager.js";
import type { AgentDiscovery } from "./agentDiscovery.js";
import type { AgentSettingsService } from "./agentSettings.js";
import type { GitWatcher } from "./workspace/gitWatcher.js";

export interface CoreServicesHandle {
  aiHandler: AIHandler;
  gitServer: GitServer;
  gitWatcher: GitWatcher;
  pubsubPort: number;
  agentDiscovery: AgentDiscovery;
  agentSettingsService: AgentSettingsService;
  /** Stop core services in reverse dependency order. */
  shutdown(): Promise<void>;
}

export async function startCoreServices({
  workspace,
  gitServer,
  getBuild,
  contextFolderManager,
  tokenManager,
  databaseManager,
}: {
  workspace: Workspace;
  gitServer: GitServer;
  getBuild: (unitPath: string) => Promise<unknown>;
  contextFolderManager: ContextFolderManager;
  tokenManager: TokenManager;
  databaseManager: DatabaseManager;
}): Promise<CoreServicesHandle> {
  const container = new ServiceContainer();

  // Foundation (no deps — pre-created instances wrapped for container participation)
  container.register(new ManagedTokenService(tokenManager));
  container.register(new ManagedDatabaseService(databaseManager));
  container.register(new ManagedAgentDiscoveryService(workspace.path));
  container.register(new ManagedGitServerService(gitServer));

  // Infrastructure (depend on foundation)
  container.register(new ManagedAgentSettingsServiceWrapper(workspace.path));
  container.register(new ManagedGitWatcherService(workspace));
  container.register(new ManagedPubSubService());

  // Core services (depend on infrastructure)
  container.register(new ManagedAgentHostService({
    workspace,
    contextFolderManager,
    getBuild,
  }));
  container.register(new ManagedAiService(workspace.path));

  await container.startAll();

  return {
    aiHandler: container.get<AIHandler>("ai"),
    gitServer: container.get<GitServer>("gitServer"),
    gitWatcher: container.get<GitWatcher>("gitWatcher"),
    pubsubPort: container.get<{ port: number }>("pubsub").port,
    agentDiscovery: container.get<AgentDiscovery>("agentDiscovery"),
    agentSettingsService: container.get<AgentSettingsService>("agentSettings"),
    shutdown: () => container.stopAll(),
  };
}
