/**
 * natstack-server — Headless and IPC entry point for NatStack.
 *
 * Starts all headless-capable services (Verdaccio, Git, PubSub, RPC).
 *
 * Two runtime modes:
 * - **IPC mode** (utilityProcess or child_process.fork): receives config via
 *   env vars set by parent, reports ready via postMessage, listens for
 *   shutdown via postMessage.
 * - **Standalone mode**: parses CLI args, reports ready to stdout, listens
 *   for SIGTERM/SIGINT.
 *
 * Two-phase bootstrap: env vars are set synchronously first, then app
 * modules are loaded inside an async main() to avoid top-level await
 * (which conflicts with bundled CJS __dirname references in Node ≥25).
 */

import * as path from "path";
import * as fs from "fs";
import { randomBytes } from "crypto";

// =============================================================================
// IPC channel detection (synchronous — must run before main())
// =============================================================================

interface IpcChannel {
  postMessage(msg: unknown): void;
  on(event: string, handler: (msg: unknown) => void): void;
}

function detectServerIpcChannel(): IpcChannel | null {
  // Electron utilityProcess: process.parentPort exists
  const parentPort = (process as any).parentPort;
  if (parentPort) {
    return {
      postMessage: (msg: unknown) => parentPort.postMessage(msg),
      on: (_event: string, handler: (msg: unknown) => void) => {
        parentPort.on("message", (envelope: any) => {
          handler(envelope?.data ?? envelope);
        });
      },
    };
  }
  // Node.js fork: process.send exists
  if (typeof process.send === "function") {
    return {
      postMessage: (msg: unknown) => process.send!(msg),
      on: (_event: string, handler: (msg: unknown) => void) => {
        process.on("message", handler);
      },
    };
  }
  return null;
}

const ipcChannel = detectServerIpcChannel();

// =============================================================================
// Phase A: Synchronous preamble — parse CLI args OR inherit env vars
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

let args: CliArgs = {};

if (!ipcChannel) {
  // Standalone mode: parse CLI args, set env vars
  args = parseArgs(process.argv.slice(2));
  if (args.dataDir) process.env["NATSTACK_USER_DATA_PATH"] = args.dataDir;
  process.env["NATSTACK_APP_ROOT"] = args.appRoot ?? process.cwd();
  if (args.logLevel) process.env["NATSTACK_LOG_LEVEL"] = args.logLevel;
} else {
  // IPC mode: env vars already set by parent via fork({ env: {...} })
  // NATSTACK_WORKSPACE, NATSTACK_USER_DATA_PATH, NATSTACK_APP_ROOT, NATSTACK_LOG_LEVEL
}

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

  // In IPC mode, dataDir comes from NATSTACK_USER_DATA_PATH env var
  const dataDir = args.dataDir ?? process.env["NATSTACK_USER_DATA_PATH"];
  if (dataDir) setUserDataPath(dataDir);
  loadCentralEnv();

  // ===========================================================================
  // Workspace resolution
  // ===========================================================================

  // In IPC mode, workspace path comes from NATSTACK_WORKSPACE env var
  const workspaceArg = args.workspace ?? process.env["NATSTACK_WORKSPACE"];
  const workspacePath = discoverWorkspace(workspaceArg);
  const configPath = path.join(workspacePath, "natstack.yml");
  if (!fs.existsSync(configPath)) {
    const msg = `Workspace config not found: ${configPath}`;
    if (ipcChannel) {
      ipcChannel.postMessage({ type: "error", message: msg });
      process.exit(1);
    }
    console.error(msg);
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

  // Server-only services: tokens, verdaccio, git
  dispatcher.register("tokens", async (_ctx, method, serviceArgs) => {
    const tm = getTokenManager();
    const a = serviceArgs as unknown[];
    switch (method) {
      case "create": return tm.createToken(a[0] as string, a[1] as import("../main/serviceDispatcher.js").CallerKind);
      case "revoke": tm.revokeToken(a[0] as string); return;
      case "get": try { return tm.getToken(a[0] as string); } catch { return null; }
      default: throw new Error(`Unknown tokens method: ${method}`);
    }
  });

  dispatcher.register("verdaccio", async (_ctx, method, serviceArgs) => {
    const v = handle.verdaccioServer;
    const a = serviceArgs as unknown[];
    switch (method) {
      case "getPackageVersion": return await v.getPackageVersion(a[0] as string) ?? null;
      case "getBaseUrl": return v.getBaseUrl();
      case "clearCaches": v.clearAllInMemoryCaches(); return;
      case "ensureRunning": return await v.ensureRunning();
      default: throw new Error(`Unknown verdaccio method: ${method}`);
    }
  });

  dispatcher.register("git", async (_ctx, method, serviceArgs) => {
    const g = handle.gitServer;
    const a = serviceArgs as unknown[];
    switch (method) {
      case "getWorkspaceTree": return g.getWorkspaceTree();
      case "listBranches": return g.listBranches(a[0] as string);
      case "listCommits": return g.listCommits(a[0] as string, a[1] as string, a[2] as number);
      case "getBaseUrl": return g.getBaseUrl();
      case "getTokenForPanel": return g.getTokenForPanel(a[0] as string);
      case "revokeTokenForPanel": g.revokeTokenForPanel(a[0] as string); return;
      case "resolveRef": return g.resolveRef(a[0] as string, a[1] as string);
      default: throw new Error(`Unknown git method: ${method}`);
    }
  });

  // Generate admin token and set on TokenManager BEFORE RPC server starts
  const adminToken = randomBytes(32).toString("hex");
  getTokenManager().setAdminToken(adminToken);

  const rpcServer = new RpcServer({
    tokenManager: getTokenManager(),
  });

  handle.registerAiService(rpcServer);
  dispatcher.markInitialized();

  const rpcPort = await rpcServer.start();

  // ===========================================================================
  // Report ready
  // ===========================================================================

  if (ipcChannel) {
    ipcChannel.postMessage({
      type: "ready",
      rpcPort,
      verdaccioPort: handle.verdaccioServer.getPort(),
      gitPort: handle.gitServer.getPort(),
      pubsubPort: handle.pubsubPort,
      adminToken,
    });
  } else {
    console.log("natstack-server ready:");
    console.log(`  Verdaccio: http://127.0.0.1:${handle.verdaccioServer.getPort()}`);
    console.log(`  Git:       http://127.0.0.1:${handle.gitServer.getPort()}`);
    console.log(`  PubSub:    ws://127.0.0.1:${handle.pubsubPort}`);
    console.log(`  RPC:       ws://127.0.0.1:${rpcPort}`);
    console.log(`  Admin token: ${adminToken}`);
  }

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

  if (ipcChannel) {
    ipcChannel.on("message", (msg: any) => {
      if (msg?.type === "shutdown") void shutdown();
    });
  } else {
    process.on("SIGTERM", () => void shutdown());
    process.on("SIGINT", () => void shutdown());
  }
}

main().catch((err) => {
  if (ipcChannel) {
    ipcChannel.postMessage({ type: "error", message: String(err) });
  }
  console.error("Fatal:", err);
  process.exit(1);
});
