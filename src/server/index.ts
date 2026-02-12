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
  const { setUserDataPath } = await import("../main/envPaths.js");
  const { loadCentralEnv, discoverWorkspace, createWorkspace } = await import("../main/workspace/loader.js");
  const { setActiveWorkspace, getAppRoot } = await import("../main/paths.js");
  const { getMainCacheManager } = await import("../main/cacheManager.js");
  const { scheduleGC, shutdownPackageStore } = await import("../main/package-store/index.js");
  const { preloadNatstackTypesAsync } = await import("@natstack/typecheck");
  const { GitServer } = await import("../main/gitServer.js");
  const { getTokenManager } = await import("../main/tokenManager.js");
  const { getServiceDispatcher } = await import("../main/serviceDispatcher.js");
  const { handleEventsService } = await import("../main/services/eventsService.js");
  const { getDependencyGraph } = await import("../main/dependencyGraph.js");
  const { RpcServer } = await import("./rpcServer.js");
  const { startCoreServices } = await import("../main/coreServices.js");

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
  // Service initialization
  // ===========================================================================

  const githubConfig = workspace.config.git?.github;
  const gitServer = new GitServer({
    port: workspace.config.git?.port,
    reposPath: workspace.gitReposPath,
    github: {
      ...githubConfig,
      token: githubConfig?.token ?? process.env["GITHUB_TOKEN"],
    },
  });

  const handle = await startCoreServices({ workspace, gitServer });

  // ===========================================================================
  // Service registration + RPC server
  // ===========================================================================

  const dispatcher = getServiceDispatcher();
  dispatcher.register("events", handleEventsService);

  // Generate admin token and set on TokenManager BEFORE RPC server starts
  const adminToken = randomBytes(32).toString("hex");
  getTokenManager().setAdminToken(adminToken);

  const rpcServer = new RpcServer({
    tokenManager: getTokenManager(),
  });

  handle.registerAiService(rpcServer);
  dispatcher.markInitialized();

  const rpcPort = await rpcServer.start();

  console.log("natstack-server ready:");
  console.log(`  Verdaccio: http://127.0.0.1:${handle.verdaccioServer.getPort()}`);
  console.log(`  Git:       http://127.0.0.1:${handle.gitServer.getPort()}`);
  console.log(`  PubSub:    ws://127.0.0.1:${handle.pubsubPort}`);
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

    // Global singletons (always run, even if core shutdown fails)
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

    await Promise.all([
      handle.shutdown().catch((e) => console.error("[Server] Core shutdown error:", e)),
      rpcServer.stop().then(() => console.log("[Server] RPC stopped")).catch((e) => console.error("[Server] RPC stop error:", e)),
      getDependencyGraph().then((g) => g.flush()).then(() => console.log("[Server] DependencyGraph flushed")).catch((e) => console.error("[Server] DependencyGraph error:", e)),
    ]).finally(() => {
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
