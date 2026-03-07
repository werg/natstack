/**
 * ManagedService wrappers for core infrastructure.
 *
 * Each wrapper implements the ManagedService interface, declaring dependencies
 * and handling start/stop lifecycle. Used by ServiceContainer for topological
 * startup/shutdown ordering.
 */

import type { ManagedService } from "./managedService.js";
import { createDevLogger } from "./devLog.js";
import type { Workspace } from "./workspace/types.js";
import type { TokenManager } from "./tokenManager.js";
import type { DatabaseManager } from "./db/databaseManager.js";
import type { GitServer } from "./gitServer.js";
import type { ContextFolderManager } from "./contextFolderManager.js";
import type { AgentDiscovery } from "./agentDiscovery.js";
import type { AgentSettingsService } from "./agentSettings.js";
import type { GitWatcher } from "./workspace/gitWatcher.js";
import type { AgentHost } from "./agentHost.js";
import type { AIHandler } from "./ai/aiHandler.js";
import type { PubSubServer } from "./pubsubServer.js";

const log = createDevLogger("CoreServices");

// =============================================================================
// Token Manager (pre-created, just wraps for container participation)
// =============================================================================

export class ManagedTokenService implements ManagedService<TokenManager> {
  readonly name = "tokenManager";
  private tokenManager: TokenManager;

  constructor(tokenManager: TokenManager) {
    this.tokenManager = tokenManager;
  }

  async start(): Promise<TokenManager> {
    return this.tokenManager;
  }
}

// =============================================================================
// Database Manager (pre-created, just wraps for container participation)
// =============================================================================

export class ManagedDatabaseService implements ManagedService<DatabaseManager> {
  readonly name = "databaseManager";
  private databaseManager: DatabaseManager;

  constructor(databaseManager: DatabaseManager) {
    this.databaseManager = databaseManager;
  }

  async start(): Promise<DatabaseManager> {
    return this.databaseManager;
  }
}

// =============================================================================
// Agent Discovery
// =============================================================================

export class ManagedAgentDiscoveryService implements ManagedService<AgentDiscovery> {
  readonly name = "agentDiscovery";
  private workspacePath: string;
  private instance: AgentDiscovery | null = null;

  constructor(workspacePath: string) {
    this.workspacePath = workspacePath;
  }

  async start(): Promise<AgentDiscovery> {
    const { initAgentDiscovery } = await import("./agentDiscovery.js");
    this.instance = await initAgentDiscovery(this.workspacePath);
    log.info("[AgentDiscovery] Initialized");
    return this.instance;
  }

  async stop(): Promise<void> {
    this.instance?.stopWatching();
  }
}

// =============================================================================
// Agent Settings
// =============================================================================

export class ManagedAgentSettingsServiceWrapper implements ManagedService<AgentSettingsService> {
  readonly name = "agentSettings";
  readonly dependencies = ["agentDiscovery"];
  private workspacePath: string;
  private instance: AgentSettingsService | null = null;

  constructor(workspacePath: string) {
    this.workspacePath = workspacePath;
  }

  async start(resolve: <D>(name: string) => D): Promise<AgentSettingsService> {
    const { AgentSettingsService } = await import("./agentSettings.js");
    const agentDiscovery = resolve<AgentDiscovery>("agentDiscovery");
    this.instance = new AgentSettingsService();
    await this.instance.initialize(this.workspacePath, agentDiscovery);
    log.info("[AgentSettingsService] Initialized");
    return this.instance;
  }

  async stop(): Promise<void> {
    this.instance?.shutdown();
  }
}

// =============================================================================
// Git Server
// =============================================================================

export class ManagedGitServerService implements ManagedService<GitServer> {
  readonly name = "gitServer";
  private gitServer: GitServer;

  constructor(gitServer: GitServer) {
    this.gitServer = gitServer;
  }

  async start(): Promise<GitServer> {
    await this.gitServer.start();
    log.info(`[Git] Server started on port ${this.gitServer.getPort()}`);
    return this.gitServer;
  }

  async stop(): Promise<void> {
    await this.gitServer.stop();
    log.info("[Git] Server stopped");
  }
}

// =============================================================================
// Git Watcher
// =============================================================================

export class ManagedGitWatcherService implements ManagedService<GitWatcher> {
  readonly name = "gitWatcher";
  readonly dependencies = ["gitServer"];
  private workspace: Workspace;
  private instance: GitWatcher | null = null;

  constructor(workspace: Workspace) {
    this.workspace = workspace;
  }

  async start(resolve: <D>(name: string) => D): Promise<GitWatcher> {
    const { createGitWatcher } = await import("./workspace/gitWatcher.js");
    const gitServer = resolve<GitServer>("gitServer");
    this.instance = createGitWatcher(this.workspace);
    gitServer.subscribeToGitWatcher(this.instance);
    log.info("[GitWatcher] Started watching workspace for git changes");
    return this.instance;
  }

  async stop(): Promise<void> {
    await this.instance?.close();
    log.info("[GitWatcher] Stopped");
  }
}

// =============================================================================
// PubSub Server
// =============================================================================

export class ManagedPubSubService implements ManagedService<{ server: PubSubServer; port: number }> {
  readonly name = "pubsub";
  readonly dependencies = ["tokenManager", "databaseManager"];
  private server: PubSubServer | null = null;

  async start(resolve: <D>(name: string) => D): Promise<{ server: PubSubServer; port: number }> {
    const { PubSubServer, SqliteMessageStore } = await import("./pubsubServer.js");
    const tokenManager = resolve<TokenManager>("tokenManager");
    const databaseManager = resolve<DatabaseManager>("databaseManager");
    this.server = new PubSubServer({
      tokenValidator: tokenManager,
      messageStore: new SqliteMessageStore(databaseManager),
    });
    const port = await this.server.start();
    log.info(`[PubSub] Server started on port ${port}`);
    return { server: this.server, port };
  }

  async stop(): Promise<void> {
    await this.server?.stop();
    log.info("[PubSub] Server stopped");
  }
}

// =============================================================================
// Agent Host
// =============================================================================

export class ManagedAgentHostService implements ManagedService<AgentHost> {
  readonly name = "agentHost";
  readonly dependencies = ["pubsub", "agentDiscovery", "tokenManager", "databaseManager"];
  private workspace: Workspace;
  private contextFolderManager: ContextFolderManager;
  private getBuild: (unitPath: string) => Promise<unknown>;
  private instance: AgentHost | null = null;

  constructor(opts: {
    workspace: Workspace;
    contextFolderManager: ContextFolderManager;
    getBuild: (unitPath: string) => Promise<unknown>;
  }) {
    this.workspace = opts.workspace;
    this.contextFolderManager = opts.contextFolderManager;
    this.getBuild = opts.getBuild;
  }

  async start(resolve: <D>(name: string) => D): Promise<AgentHost> {
    const { AgentHost } = await import("./agentHost.js");
    const { server: pubsubServer, port: pubsubPort } = resolve<{ server: PubSubServer; port: number }>("pubsub");
    const agentDiscovery = resolve<AgentDiscovery>("agentDiscovery");
    const tokenManager = resolve<TokenManager>("tokenManager");
    const databaseManager = resolve<DatabaseManager>("databaseManager");

    this.instance = new AgentHost({
      workspaceRoot: this.workspace.path,
      pubsubUrl: `ws://127.0.0.1:${pubsubPort}`,
      messageStore: pubsubServer.getMessageStore(),
      createToken: (instanceId) => tokenManager.createToken(instanceId, "server"),
      revokeToken: (instanceId) => tokenManager.revokeToken(instanceId),
      getBuild: this.getBuild as (unitPath: string) => Promise<{ bundlePath: string; dir: string; metadata: { kind: string; name: string } }>,
      contextFolderManager: this.contextFolderManager,
      databaseManager,
      agentDiscovery,
    });

    await this.instance.initialize();
    pubsubServer.setAgentHost(this.instance);
    pubsubServer.setContextFolderManager(this.contextFolderManager);
    log.info("[AgentHost] Initialized");
    return this.instance;
  }

  async stop(): Promise<void> {
    this.instance?.shutdown();
  }
}

// =============================================================================
// AI Handler
// =============================================================================

export class ManagedAiService implements ManagedService<AIHandler> {
  readonly name = "ai";
  readonly dependencies = ["agentHost"];
  private workspacePath: string;
  private instance: AIHandler | null = null;

  constructor(workspacePath: string) {
    this.workspacePath = workspacePath;
  }

  async start(resolve: <D>(name: string) => D): Promise<AIHandler> {
    const { AIHandler: AIHandlerClass } = await import("./ai/aiHandler.js");
    const agentHost = resolve<AgentHost>("agentHost");

    this.instance = new AIHandlerClass(this.workspacePath);
    await this.instance.initialize();
    agentHost.setAiHandler(this.instance);
    log.info("[AI] Handler initialized");
    return this.instance;
  }
}
