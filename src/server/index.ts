/**
 * natstack-server — Headless entry point for NatStack.
 *
 * Starts all headless-capable services (Verdaccio, Git, PubSub, RPC)
 * without Electron. The Electron app continues to work unchanged.
 *
 * Two-phase bootstrap: env vars are set synchronously first, then app
 * modules are loaded inside an async main() to avoid top-level await
 * (which conflicts with bundled CJS __dirname references in Node ≥25).
 */

import * as path from "path";
import * as fs from "fs";
import { randomBytes } from "crypto";

// =============================================================================
// Phase A: Synchronous preamble — parse CLI args, set env vars
// =============================================================================

interface CliArgs {
  workspace?: string;
  dataDir?: string;
  appRoot?: string;
  logLevel?: string;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {};
  const known = new Set(["workspace", "data-dir", "app-root", "log-level"]);

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    let key: string;
    let value: string | undefined;

    if (arg.startsWith("--")) {
      const eqIdx = arg.indexOf("=");
      if (eqIdx !== -1) {
        key = arg.slice(2, eqIdx);
        value = arg.slice(eqIdx + 1);
      } else {
        key = arg.slice(2);
        value = argv[i + 1];
        if (value !== undefined && !value.startsWith("--")) {
          i++;
        } else {
          console.error(`Missing value for --${key}`);
          process.exit(1);
        }
      }
    } else {
      console.error(`Unknown argument: ${arg}`);
      process.exit(1);
    }

    if (!known.has(key)) {
      console.error(`Unknown flag: --${key}`);
      process.exit(1);
    }

    switch (key) {
      case "workspace":
        args.workspace = value;
        break;
      case "data-dir":
        args.dataDir = value;
        break;
      case "app-root":
        args.appRoot = value;
        break;
      case "log-level":
        args.logLevel = value;
        break;
    }
  }

  return args;
}

const args = parseArgs(process.argv.slice(2));

// Set env vars BEFORE any app modules are loaded
if (args.dataDir) process.env["NATSTACK_USER_DATA_PATH"] = args.dataDir;
process.env["NATSTACK_APP_ROOT"] = args.appRoot ?? process.cwd();
if (args.logLevel) process.env["NATSTACK_LOG_LEVEL"] = args.logLevel;

// =============================================================================
// Phase B: Async main — load app modules, initialize services
// =============================================================================

async function main() {
  const { setUserDataPath, getUserDataPath } = await import("../main/envPaths.js");
  const { loadCentralEnv, discoverWorkspace, createWorkspace } = await import("../main/workspace/loader.js");
  const { setActiveWorkspace, getAppRoot } = await import("../main/paths.js");
  const { getMainCacheManager } = await import("../main/cacheManager.js");
  const { scheduleGC, shutdownPackageStore } = await import("../main/package-store/index.js");
  const { preloadNatstackTypesAsync } = await import("@natstack/typecheck");
  const { initAgentDiscovery, shutdownAgentDiscovery } = await import("../main/agentDiscovery.js");
  const { initAgentSettingsService, shutdownAgentSettingsService } = await import("../main/agentSettings.js");
  const { createVerdaccioServer } = await import("../main/verdaccioServer.js");
  const { getTypeDefinitionService } = await import("../main/typecheck/service.js");
  const { getNatstackPackageWatcher, shutdownNatstackWatcher } = await import("../main/natstackPackageWatcher.js");
  const { GitServer } = await import("../main/gitServer.js");
  const { createGitWatcher } = await import("../main/workspace/gitWatcher.js");
  const { getPubSubServer } = await import("../main/pubsubServer.js");
  const { initAgentHost, shutdownAgentHost, setAgentHostAiHandler } = await import("../main/agentHost.js");
  const { getTokenManager } = await import("../main/tokenManager.js");
  const { getServiceDispatcher } = await import("../main/serviceDispatcher.js");
  const { handleEventsService } = await import("../main/services/eventsService.js");
  const { handleAgentSettingsCall } = await import("../main/ipc/agentSettingsHandlers.js");
  const { getDatabaseManager } = await import("../main/db/databaseManager.js");
  const { handleDbCall } = await import("../main/ipc/dbHandlers.js");
  const { handleAiServiceCall } = await import("../main/ipc/aiHandlers.js");
  const { typeCheckRpcMethods } = await import("../main/typecheck/service.js");
  const { getDependencyGraph } = await import("../main/dependencyGraph.js");
  const { RpcServer } = await import("./rpcServer.js");

  if (args.dataDir) setUserDataPath(args.dataDir);
  loadCentralEnv();

  // ===========================================================================
  // Workspace resolution
  // ===========================================================================

  const workspacePath = discoverWorkspace(args.workspace);
  const configPath = path.join(workspacePath, "natstack.yml");
  if (!fs.existsSync(configPath)) {
    console.error(`Workspace config not found: ${configPath}`);
    process.exit(1);
  }
  const workspace = createWorkspace(workspacePath);
  setActiveWorkspace(workspace);

  // ===========================================================================
  // Singleton initialization
  // ===========================================================================

  const cacheManager = getMainCacheManager();
  await cacheManager.initialize();

  const cancelGC = scheduleGC(24 * 60 * 60 * 1000);

  const packagesDir = path.join(getAppRoot(), "packages");
  if (fs.existsSync(packagesDir)) {
    await preloadNatstackTypesAsync(packagesDir);
  }

  // ===========================================================================
  // Service initialization (mirrors index.ts order)
  // ===========================================================================

  // Step 1: Agent discovery + settings
  await initAgentDiscovery(workspace.path);
  await initAgentSettingsService();

  // Step 2: Verdaccio
  const verdaccioServer = createVerdaccioServer({
    workspaceRoot: getAppRoot(),
    storagePath: path.join(getUserDataPath(), "verdaccio-storage"),
  });
  verdaccioServer.setNatstackPublishHook(() => getTypeDefinitionService().invalidateNatstackTypes());
  await verdaccioServer.buildAllWorkspacePackages();
  const verdaccioPort = await verdaccioServer.start();
  await verdaccioServer.publishChangedPackages();

  // Step 3: NatstackPackageWatcher
  const natstackWatcher = getNatstackPackageWatcher(getAppRoot());
  await natstackWatcher.initialize((pkgPath, pkgName) =>
    verdaccioServer.republishPackage(pkgPath, pkgName)
  );

  // Step 4: Git server
  const githubConfig = workspace.config.git?.github;
  const gitServer = new GitServer({
    port: workspace.config.git?.port,
    reposPath: workspace.gitReposPath,
    github: {
      ...githubConfig,
      token: githubConfig?.token ?? process.env["GITHUB_TOKEN"],
    },
  });
  const gitPort = await gitServer.start();

  // Step 5: GitWatcher + subscriptions
  const gitWatcher = createGitWatcher(workspace);
  gitServer.subscribeToGitWatcher(gitWatcher);
  await verdaccioServer.subscribeToGitWatcher(gitWatcher, workspace.path);

  // Step 6: PubSub server
  const pubsubServer = getPubSubServer();
  const pubsubPort = await pubsubServer.start();

  // Step 7: AgentHost
  const agentHost = initAgentHost({
    workspaceRoot: workspace.path,
    pubsubUrl: `ws://127.0.0.1:${pubsubPort}`,
    messageStore: pubsubServer.getMessageStore(),
    createToken: (instanceId) => getTokenManager().createToken(instanceId, "worker"),
    revokeToken: (instanceId) => getTokenManager().revokeToken(instanceId),
  });
  await agentHost.initialize();
  pubsubServer.setAgentHost(agentHost);

  // Step 8: AI handler
  const { AIHandler } = await import("../main/ai/aiHandler.js");
  const aiHandler = new AIHandler();
  await aiHandler.initialize();
  setAgentHostAiHandler(aiHandler);

  // ===========================================================================
  // Service registration
  // ===========================================================================

  const dispatcher = getServiceDispatcher();

  dispatcher.register("events", handleEventsService);

  dispatcher.register("agentSettings", async (_ctx, method, serviceArgs) => {
    return handleAgentSettingsCall(method, serviceArgs as unknown[]);
  });

  dispatcher.register("db", async (ctx, method, serviceArgs) => {
    return handleDbCall(getDatabaseManager(), ctx.callerId, method, serviceArgs);
  });

  // Generate admin token and set on TokenManager BEFORE RPC server starts
  const adminToken = randomBytes(32).toString("hex");
  getTokenManager().setAdminToken(adminToken);

  const rpcServer = new RpcServer({
    tokenManager: getTokenManager(),
  });

  dispatcher.register("ai", async (ctx, method, serviceArgs) => {
    return handleAiServiceCall(aiHandler, method, serviceArgs, (handler, options, streamId) => {
      if (!ctx.wsClient) {
        throw new Error("AI streaming requires a WS connection");
      }
      const target = rpcServer.createWsStreamTarget(ctx.wsClient, streamId);
      handler.startTargetStream(target, options, streamId);
    });
  });

  dispatcher.register("typecheck", async (_ctx, method, serviceArgs) => {
    const a = serviceArgs as unknown[];
    switch (method) {
      case "getPackageTypes":
        return typeCheckRpcMethods["typecheck.getPackageTypes"](a[0] as string, a[1] as string);
      case "getPackageTypesBatch":
        return typeCheckRpcMethods["typecheck.getPackageTypesBatch"](a[0] as string, a[1] as string[]);
      case "check":
        return typeCheckRpcMethods["typecheck.check"](a[0] as string, a[1] as string | undefined, a[2] as string | undefined);
      case "getTypeInfo":
        return typeCheckRpcMethods["typecheck.getTypeInfo"](a[0] as string, a[1] as string, a[2] as number, a[3] as number, a[4] as string | undefined);
      case "getCompletions":
        return typeCheckRpcMethods["typecheck.getCompletions"](a[0] as string, a[1] as string, a[2] as number, a[3] as number, a[4] as string | undefined);
      default:
        throw new Error(`Unknown typecheck method: ${method}`);
    }
  });

  dispatcher.markInitialized();

  // ===========================================================================
  // RPC server startup
  // ===========================================================================

  const rpcPort = await rpcServer.start();

  console.log("natstack-server ready:");
  console.log(`  Verdaccio: http://127.0.0.1:${verdaccioPort}`);
  console.log(`  Git:       http://127.0.0.1:${gitPort}`);
  console.log(`  PubSub:    ws://127.0.0.1:${pubsubPort}`);
  console.log(`  RPC:       ws://127.0.0.1:${rpcPort}`);
  console.log(`  Admin token: ${adminToken}`);

  // ===========================================================================
  // Graceful shutdown
  // ===========================================================================

  let isShuttingDown = false;

  async function shutdown() {
    if (isShuttingDown) return;
    isShuttingDown = true;
    console.log("[Server] Shutting down...");

    // Synchronous shutdowns first (order matches index.ts)
    shutdownAgentSettingsService();
    shutdownAgentDiscovery();
    shutdownAgentHost();
    void shutdownNatstackWatcher();

    // Parallel async shutdowns
    const stops: Promise<void>[] = [];

    stops.push(
      rpcServer.stop().then(() => console.log("[Server] RPC stopped")).catch((e) => console.error("[Server] RPC stop error:", e))
    );
    stops.push(
      gitServer.stop().then(() => console.log("[Server] Git stopped")).catch((e) => console.error("[Server] Git stop error:", e))
    );
    stops.push(
      gitWatcher.close().then(() => console.log("[Server] GitWatcher stopped")).catch((e) => console.error("[Server] GitWatcher stop error:", e))
    );
    stops.push(
      pubsubServer.stop().then(() => console.log("[Server] PubSub stopped")).catch((e) => console.error("[Server] PubSub stop error:", e))
    );
    stops.push(
      verdaccioServer.stop().then(() => console.log("[Server] Verdaccio stopped")).catch((e) => console.error("[Server] Verdaccio stop error:", e))
    );
    stops.push(
      getDependencyGraph().then((g) => g.flush()).then(() => console.log("[Server] DependencyGraph flushed")).catch((e) => console.error("[Server] DependencyGraph error:", e))
    );

    try {
      shutdownPackageStore();
      console.log("[Server] PackageStore shutdown");
    } catch (e) {
      console.error("[Server] PackageStore error:", e);
    }

    cancelGC();

    const forceExit = setTimeout(() => {
      console.warn("[Server] Shutdown timeout — forcing exit");
      process.exit(1);
    }, 5000);

    await Promise.all(stops).finally(() => {
      clearTimeout(forceExit);
      console.log("[Server] Shutdown complete");
      process.exit(0);
    });
  }

  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
