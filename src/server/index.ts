/**
 * natstack-server — Headless and IPC entry point for NatStack.
 *
 * Starts all headless-capable services (Build V2, Git, PubSub, RPC).
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
  servePanels?: boolean;
  panelPort?: number;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {};
  const known = new Set(["workspace", "data-dir", "app-root", "log-level", "serve-panels", "panel-port"]);
  /** Flags that don't take a value */
  const booleanFlags = new Set(["serve-panels"]);

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
        if (booleanFlags.has(key)) {
          // Boolean flag: no value consumed
          value = undefined;
        } else {
          value = argv[i + 1];
          if (value !== undefined && !value.startsWith("--")) {
            i++;
          } else {
            console.error(`Missing value for --${key}`);
            process.exit(1);
          }
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
      case "serve-panels":
        args.servePanels = true;
        break;
      case "panel-port":
        args.panelPort = parseInt(value!, 10);
        if (isNaN(args.panelPort)) {
          console.error("--panel-port must be a number");
          process.exit(1);
        }
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
}

// =============================================================================
// Phase B: Async main — load app modules, initialize services
// =============================================================================

async function main() {
  const { setUserDataPath } = await import("../main/envPaths.js");
  const { loadCentralEnv, discoverWorkspace, createWorkspace } = await import("../main/workspace/loader.js");
  const { setActiveWorkspace } = await import("../main/paths.js");
  const { GitServer } = await import("../main/gitServer.js");
  const { getTokenManager } = await import("../main/tokenManager.js");
  const { getServiceDispatcher } = await import("../main/serviceDispatcher.js");
  const { handleEventsService } = await import("../main/services/eventsService.js");
  const { RpcServer } = await import("./rpcServer.js");
  const { startCoreServices } = await import("../main/coreServices.js");
  const { initBuildSystemV2, createBuildServiceHandler } = await import("./buildV2/index.js");

  // In IPC mode, dataDir comes from NATSTACK_USER_DATA_PATH env var
  const dataDir = args.dataDir ?? process.env["NATSTACK_USER_DATA_PATH"];
  if (dataDir) setUserDataPath(dataDir);
  loadCentralEnv();

  // ===========================================================================
  // Workspace resolution
  // ===========================================================================

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

  // ===========================================================================
  // Build System V2 (must init before core services — agents need build access)
  // ===========================================================================

  const buildSystem = await initBuildSystemV2(workspacePath, gitServer);

  const handle = await startCoreServices({
    workspace,
    gitServer,
    getBuild: (unitPath) => buildSystem.getBuild(unitPath),
  });

  // ===========================================================================
  // Service registration + RPC server
  // ===========================================================================

  const dispatcher = getServiceDispatcher();
  dispatcher.register("events", handleEventsService);

  // Build service
  dispatcher.register("build", createBuildServiceHandler(buildSystem));

  // Server-only services: tokens, git
  dispatcher.register("tokens", async (_ctx, method, serviceArgs) => {
    const tm = getTokenManager();
    const a = serviceArgs as unknown[];
    switch (method) {
      case "create": return tm.createToken(a[0] as string, a[1] as import("../main/serviceDispatcher.js").CallerKind);
      case "ensure": return tm.ensureToken(a[0] as string, a[1] as import("../main/serviceDispatcher.js").CallerKind);
      case "revoke": tm.revokeToken(a[0] as string); return;
      case "get": try { return tm.getToken(a[0] as string); } catch { return null; }
      default: throw new Error(`Unknown tokens method: ${method}`);
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

  const rpcPort = await rpcServer.start();

  // ===========================================================================
  // Headless panel management + HTTP panel serving (standalone mode only)
  // ===========================================================================

  let panelHttpPort: number | null = null;
  let panelHttpServerInstance: { stop(): Promise<void> } | null = null;

  if (!ipcChannel) {
    const { PanelHttpServer } = await import("./panelHttpServer.js");
    const { HeadlessPanelManager } = await import("./headlessPanelManager.js");
    const { handleHeadlessBridgeCall } = await import("./headlessBridge.js");

    // Start HTTP panel server if requested
    let panelHttpServer: InstanceType<typeof PanelHttpServer> | null = null;
    if (args.servePanels) {
      panelHttpServer = new PanelHttpServer("127.0.0.1");
      panelHttpPort = await panelHttpServer.start(args.panelPort ?? 0);
      panelHttpServerInstance = panelHttpServer;
    }

    const headlessPanelManager = new HeadlessPanelManager({
      getBuild: (unitPath) => buildSystem.getBuild(unitPath),
      createToken: (callerId, kind) => getTokenManager().createToken(callerId, kind),
      revokeToken: (callerId) => getTokenManager().revokeToken(callerId),
      panelHttpServer,
      rpcPort,
      gitBaseUrl: `http://127.0.0.1:${handle.gitServer.getPort()}`,
      getGitTokenForPanel: (panelId) => handle.gitServer.getTokenForPanel(panelId),
      pubsubPort: handle.pubsubPort,
      sendToClient: (callerId, msg) => rpcServer.sendToClient(callerId, msg),
    });

    // Register bridge service for headless panel lifecycle
    dispatcher.register("bridge", async (ctx, method, serviceArgs) => {
      return handleHeadlessBridgeCall(
        headlessPanelManager,
        ctx.callerId,
        method,
        serviceArgs as unknown[],
      );
    });
  }

  dispatcher.markInitialized();

  // ===========================================================================
  // Report ready
  // ===========================================================================

  if (ipcChannel) {
    ipcChannel.postMessage({
      type: "ready",
      rpcPort,
      gitPort: handle.gitServer.getPort(),
      pubsubPort: handle.pubsubPort,
      adminToken,
    });
  } else {
    console.log("natstack-server ready:");
    console.log(`  Git:       http://127.0.0.1:${handle.gitServer.getPort()}`);
    console.log(`  PubSub:    ws://127.0.0.1:${handle.pubsubPort}`);
    console.log(`  RPC:       ws://127.0.0.1:${rpcPort}`);
    if (panelHttpPort) {
      console.log(`  Panels:    http://127.0.0.1:${panelHttpPort}`);
    }
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

    const forceExit = setTimeout(() => {
      console.warn("[Server] Shutdown timeout — forcing exit");
      process.exit(1);
    }, 5000);

    const shutdownTasks = [
      buildSystem.shutdown().then(() => console.log("[Server] BuildV2 stopped")).catch((e) => console.error("[Server] BuildV2 stop error:", e)),
      handle.shutdown().catch((e) => console.error("[Server] Core shutdown error:", e)),
      rpcServer.stop().then(() => console.log("[Server] RPC stopped")).catch((e) => console.error("[Server] RPC stop error:", e)),
    ];
    if (panelHttpServerInstance) {
      shutdownTasks.push(
        panelHttpServerInstance.stop().then(() => console.log("[Server] Panel HTTP stopped")).catch((e) => console.error("[Server] Panel HTTP stop error:", e)),
      );
    }

    await Promise.all(shutdownTasks).finally(() => {
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
