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
// __filename is available natively in CJS and via the esbuild banner shim in ESM.
declare const __filename: string;

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
  workspaceDir?: string;
  dataDir?: string;
  appRoot?: string;
  logLevel?: string;
  servePanels?: boolean;
  panelPort?: number;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {};
  const known = new Set(["workspace", "workspace-dir", "data-dir", "app-root", "log-level", "serve-panels", "panel-port"]);
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
      case "workspace-dir":
        args.workspaceDir = value;
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
  if (args.workspaceDir) process.env["NATSTACK_WORKSPACE_DIR"] = args.workspaceDir;
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
  const { setUserDataPath, getUserDataPath } = await import("@natstack/env-paths");
  const { loadCentralEnv, loadWorkspaceConfig } = await import("../shared/workspace/loader.js");
  const { GitServer } = await import("@natstack/git-server");
  const { TokenManager } = await import("../shared/tokenManager.js");
  const { z } = await import("zod");
  const { ServiceDispatcher } = await import("../shared/serviceDispatcher.js");
  const { EventService, createEventsServiceDefinition } = await import("../shared/eventsService.js");
  const eventService = new EventService();
  const { RpcServer } = await import("./rpcServer.js");
  const { ServiceContainer } = await import("../shared/serviceContainer.js");
  const { rpcService } = await import("../shared/managedService.js");
  const { initBuildSystemV2 } = await import("./buildV2/index.js");
  const { DatabaseManager } = await import("../shared/db/databaseManager.js");

  // In IPC mode, dataDir comes from NATSTACK_USER_DATA_PATH env var
  const dataDir = args.dataDir ?? process.env["NATSTACK_USER_DATA_PATH"];
  if (dataDir) setUserDataPath(dataDir);
  loadCentralEnv();

  // ===========================================================================
  // Workspace resolution
  // ===========================================================================

  const workspacePath = args.workspaceDir ?? process.env["NATSTACK_WORKSPACE_DIR"];
  if (!workspacePath) {
    const msg = "No workspace directory specified (set NATSTACK_WORKSPACE_DIR or --workspace-dir)";
    if (ipcChannel) {
      ipcChannel.postMessage({ type: "error", message: msg });
      process.exit(1);
    }
    console.error(msg);
    process.exit(1);
  }
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
  const workspaceConfig = loadWorkspaceConfig(workspacePath);

  // State path: where databases, caches, and Electron artifacts live.
  // In IPC mode: NATSTACK_USER_DATA_PATH (= workspace state/ dir, set by parent).
  // In standalone mode: getUserDataPath() (= platform default after setUserDataPath).
  // Both are set before this point via setUserDataPath(dataDir).
  const statePath = getUserDataPath();
  const workspace: import("../shared/workspace/types.js").Workspace = {
    path: workspacePath,
    statePath,
    config: workspaceConfig,
    panelsPath: path.join(workspacePath, "panels"),
    packagesPath: path.join(workspacePath, "packages"),
    contextsPath: path.join(statePath, ".contexts"),
    gitReposPath: workspacePath,
    cachePath: path.join(statePath, ".cache"),
    agentsPath: path.join(workspacePath, "agents"),
  };

  // ===========================================================================
  // App node_modules resolution (for @natstack/* platform packages)
  // ===========================================================================

  const appRoot = process.env["NATSTACK_APP_ROOT"] ?? process.cwd();
  // In production, esbuild (native binary) can't read from .asar — use .asar.unpacked
  const appNodeModulesCandidates = [
    path.join(appRoot, "node_modules"),
    path.join(appRoot.replace(/\.asar$/, ".asar.unpacked"), "node_modules"),
  ];
  const appNodeModules = appNodeModulesCandidates.find((p) => fs.existsSync(p));
  if (!appNodeModules) {
    console.warn("[Server] Could not find app node_modules — panel builds may fail");
  }

  // ===========================================================================
  // Service initialization
  // ===========================================================================

  const githubConfig = workspaceConfig.git?.github;
  const tokenManager = new TokenManager();

  const gitServer = new GitServer(tokenManager, {
    port: workspaceConfig.git?.port,
    reposPath: workspacePath,
    github: {
      ...githubConfig,
      token: githubConfig?.token ?? process.env["GITHUB_TOKEN"],
    },
  });

  // Create ContextFolderManager before core services
  const { ContextFolderManager } = await import("../shared/contextFolderManager.js");
  const contextFolderManager = new ContextFolderManager({
    sourcePath: workspacePath,
    contextsRoot: path.join(statePath, ".contexts"),
    getWorkspaceTree: () => gitServer.getWorkspaceTree(),
  });

  const databaseManager = new DatabaseManager(statePath);

  // ===========================================================================
  // Unified ServiceContainer — lifecycle + RPC services in one container
  // ===========================================================================

  const dispatcher = new ServiceDispatcher();
  const container = new ServiceContainer(dispatcher);

  // ── Lifecycle services ──

  // Foundation: pre-created instances wrapped for container participation
  container.register({
    name: "tokenManager",
    async start() { return tokenManager; },
  });
  container.register({
    name: "databaseManager",
    async start() { return databaseManager; },
  });
  container.register({
    name: "gitServer",
    async start() {
      await gitServer.start();
      return gitServer;
    },
    async stop() { await gitServer.stop(); },
  });

  // Build system
  container.register({
    name: "buildSystem",
    async start() {
      return await initBuildSystemV2(workspacePath, gitServer, appNodeModules ?? path.join(appRoot, "node_modules"));
    },
    async stop(instance: import("./buildV2/index.js").BuildSystemV2) { await instance?.shutdown(); },
  });

  // Git watcher
  container.register({
    name: "gitWatcher",
    dependencies: ["gitServer"],
    async start() {
      const { createGitWatcher } = await import("../shared/workspace/gitWatcher.js");
      const watcher = createGitWatcher(workspace);
      gitServer.subscribeToGitWatcher(watcher);
      return watcher;
    },
    async stop(instance: import("../shared/workspace/gitWatcher.js").GitWatcher) { await instance?.close(); },
  });

  // AI handler (lifecycle only — RPC registered separately because it needs rpcServer)
  container.register({
    name: "ai",
    async start() {
      const { AIHandler: AIHandlerClass } = await import("../shared/ai/aiHandler.js");
      const aiHandler = new AIHandlerClass(workspacePath);
      await aiHandler.initialize();
      return aiHandler;
    },
  });

  // ── RPC-only services (replacing serverServiceRegistry.ts) ──

  const { createBuildService } = await import("./services/buildService.js");
  const { createWorkerdService } = await import("./services/workerdService.js");
  const { createTokensService } = await import("./services/tokensService.js");
  const { createGitService } = await import("./services/gitService.js");
  const { createTestService } = await import("./services/testService.js");
  const { createDbService } = await import("./services/dbService.js");
  const { createTypecheckService } = await import("./services/typecheckService.js");
  const { createHarnessService } = await import("./services/harnessService.js");
  const { createWorkerService } = await import("./services/workerService.js");

  // Resolve testSetup.ts relative to this module's location
  const serverDir = path.dirname(__filename);
  const setupCandidates = [
    path.resolve(serverDir, "../main/services/testSetup.ts"),
    path.resolve(serverDir, "../src/main/services/testSetup.ts"),
  ];
  const panelTestSetupPath: string = setupCandidates.find(p => fs.existsSync(p)) ?? setupCandidates[0]!;

  {
    let buildSystemInstance: import("./buildV2/index.js").BuildSystemV2 | null = null;
    container.register({
      name: "build",
      dependencies: ["buildSystem"],
      start: async (resolve) => {
        buildSystemInstance = resolve<import("./buildV2/index.js").BuildSystemV2>("buildSystem")!;
      },
      getServiceDefinition() {
        return createBuildService({ buildSystem: buildSystemInstance! });
      },
    });
  }
  container.register(rpcService(createTokensService({ tokenManager }), ["tokenManager"]));
  container.register(rpcService(createGitService({ gitServer, tokenManager }), ["gitServer"]));
  container.register(rpcService(createTestService({ contextFolderManager, workspacePath, panelTestSetupPath })));
  container.register(rpcService(createDbService({ databaseManager }), ["databaseManager"]));
  container.register(rpcService(createTypecheckService({ contextFolderManager })));
  container.register(rpcService(createEventsServiceDefinition(eventService)));

  // ── Notification service ──
  const { createNotificationService } = await import("./services/notificationService.js");
  const notificationResult = createNotificationService({ eventService });
  const notificationInternal = notificationResult.internal;
  container.register(rpcService(notificationResult.definition));

  // ── OAuth service (works in both Electron and standalone modes) ──
  {
    const { OAuthManager } = await import("../shared/oauth/oauthManager.js");
    const { createOAuthService } = await import("./services/oauthService.js");
    let oauthManager: InstanceType<typeof OAuthManager>;
    container.register({
      name: "oauth",
      dependencies: ["databaseManager"],
      optionalDependencies: ["panelRegistry"],
      async start() {
        const nangoUrl = workspace.config.oauth?.nangoUrl ?? process.env["NANGO_URL"] ?? "https://api.nango.dev";
        const nangoSecret = process.env["NANGO_SECRET_KEY"] ?? "";
        oauthManager = new OAuthManager({
          nangoUrl,
          nangoSecretKey: nangoSecret,
          databaseManager,
        });
      },
      async stop() {
        oauthManager?.close();
      },
      getServiceDefinition() {
        let panelRegistry: import("../shared/panelRegistry.js").PanelRegistry | undefined;
        try { panelRegistry = container.get<import("../shared/panelRegistry.js").PanelRegistry>("panelRegistry"); } catch { /* not available in Electron mode */ }

        const syncCookiesToSession = async (domain: string) => {
          try {
            return await dispatcher.dispatch(
              { callerId: "oauth-service", callerKind: "server" },
              "browser-data",
              "syncCookiesToSession",
              [domain],
            ) as { synced: number; failed: number };
          } catch { /* non-fatal: browser-data service may not be registered */ }
          return { synced: 0, failed: 0 };
        };

        return createOAuthService({
          oauthManager,
          panelRegistry,
          notificationService: notificationInternal,
          syncCookiesToSession,
        });
      },
    });
  }

  // ── DODispatch (source-scoped HTTP dispatch to Durable Objects) ──

  container.register({
    name: "doDispatch",
    dependencies: ["workerdManager"],
    async start(resolve) {
      const { DODispatch } = await import("./doDispatch.js");
      const doDispatch = new DODispatch();

      // Dispatch DO method calls via HTTP POST to the workerd /_w/ URL scheme.
      const workerdManager = resolve<import("./workerdManager.js").WorkerdManager>("workerdManager")!;
      doDispatch.setDispatcher(async (urlPath, args) => {
        const port = workerdManager.getPort();
        if (!port) {
          throw new Error(`workerd not running — cannot dispatch to ${urlPath}`);
        }
        const url = `http://127.0.0.1:${port}${urlPath}`;
        const resp = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(args),
        });
        if (!resp.ok) {
          const body = await resp.text();
          throw new Error(`DO dispatch failed (${resp.status}): ${body}`);
        }
        return await resp.json();
      });

      // Wire per-instance identity tokens into DO dispatch.
      doDispatch.setTokenManager(tokenManager);
      doDispatch.setGetWorkerdUrl(() => {
        const port = workerdManager.getPort();
        if (!port) {
          throw new Error("workerd not running — cannot build workerd URL");
        }
        return `http://127.0.0.1:${port}`;
      });

      return doDispatch;
    },
  });

  // Admin token: use NATSTACK_ADMIN_TOKEN env var if set, otherwise generate random.
  const adminToken = process.env["NATSTACK_ADMIN_TOKEN"] || randomBytes(32).toString("hex");
  tokenManager.setAdminToken(adminToken);

  // ── RPC server (always present) ──

  container.register({
    name: "rpcServer",
    dependencies: ["tokenManager"],
    async start() {
      const server = new RpcServer({ tokenManager, dispatcher });
      const port = await server.start();
      return { server, port };
    },
    async stop(instance: { server: import("./rpcServer.js").RpcServer; port: number }) {
      await instance?.server?.stop();
    },
  });

  // ── HarnessManager (harness process lifecycle) ──

  container.register({
    name: "harnessManager",
    dependencies: ["rpcServer", "doDispatch"],
    async start(resolve) {
      const { HarnessManager } = await import("./harnessManager.js");
      const { server: rpcServer, port: rpcPort } = resolve<{ server: import("./rpcServer.js").RpcServer; port: number }>("rpcServer")!;
      const doDispatch = resolve<import("./doDispatch.js").DODispatch>("doDispatch")!;

      const manager = new HarnessManager({
        getRpcWsUrl: () => `ws://127.0.0.1:${rpcPort}`,
        createToken: (callerId, callerKind) => tokenManager.createToken(callerId, callerKind),
        revokeToken: (callerId) => tokenManager.revokeToken(callerId),
        getClientBridge: (callerId) => rpcServer.getClientBridge(callerId),
        onCrash: (harnessId) => {
          // Notify the owning DO of the crash via DODispatch.
          // The DO handles all recovery internally (respawn, channel cleanup, etc.)
          const doRef = manager.getDOForHarness(harnessId);
          if (!doRef) {
            console.error(`[HarnessManager] onCrash: no DO registration for harness ${harnessId}`);
            return;
          }

          void (async () => {
            try {
              await doDispatch.dispatch(
                doRef, "onHarnessEvent", harnessId,
                { type: "error", error: "harness process crashed" },
              );
            } catch (err) {
              console.error(`[HarnessManager] onCrash: crash notification failed for ${harnessId}:`, err);
            }
          })();
        },
        log: {
          info: (...args) => console.log("[HarnessManager]", ...args),
          error: (...args) => console.error("[HarnessManager]", ...args),
          warn: (...args) => console.warn("[HarnessManager]", ...args),
        },
      });

      // Wire RPC auth callback so HarnessManager resolves pending bridge waiters
      rpcServer.setOnClientAuthenticate((callerId, callerKind) => {
        if (callerKind === "harness") {
          manager.notifyAuthenticated(callerId);
        }
      });

      return manager;
    },
    async stop(instance: import("./harnessManager.js").HarnessManager) { await instance?.stopAll(); },
  });


  // ── Harness RPC service ──

  {
    let harnessServiceDef: import("../shared/serviceDefinition.js").ServiceDefinition;
    container.register({
      name: "harnessRpc",
      dependencies: ["doDispatch", "harnessManager"],
      async start(resolve) {
        const doDispatch = resolve<import("./doDispatch.js").DODispatch>("doDispatch")!;
        const harnessManagerInst = resolve<import("./harnessManager.js").HarnessManager>("harnessManager")!;

        harnessServiceDef = createHarnessService({
          doDispatch,
          harnessManager: harnessManagerInst,
          contextFolderManager,
        });
      },
      getServiceDefinition() {
        return harnessServiceDef;
      },
    });
  }

  // ── Workers RPC service ──

  {
    let workerServiceDef: import("../shared/serviceDefinition.js").ServiceDefinition;
    container.register({
      name: "workersRpc",
      dependencies: ["doDispatch", "buildSystem"],
      async start(resolve) {
        const doDispatch = resolve<import("./doDispatch.js").DODispatch>("doDispatch")!;
        const buildSystemInst = resolve<import("./buildV2/index.js").BuildSystemV2>("buildSystem")!;
        workerServiceDef = createWorkerService({
          doDispatch,
          buildSystem: buildSystemInst,
        });
      },
      getServiceDefinition() {
        return workerServiceDef;
      },
    });
  }

  // ── AI RPC (depends on rpcServer + ai) ──

  const { createAiService } = await import("./services/aiService.js");
  {
    let aiServiceDef: import("../shared/serviceDefinition.js").ServiceDefinition;
    container.register({
      name: "aiRpc",
      dependencies: ["rpcServer", "ai"],
      async start(resolve) {
        const { server: rpcServer } = resolve<{ server: import("./rpcServer.js").RpcServer; port: number }>("rpcServer")!;
        const aiHandler = resolve<import("../shared/ai/aiHandler.js").AIHandler>("ai")!;
        aiServiceDef = createAiService({ aiHandler, rpcServer, contextFolderManager });
      },
      getServiceDefinition() {
        return aiServiceDef;
      },
    });
  }

  // ===========================================================================
  // Shared services needed in both standalone and Electron modes
  // ===========================================================================

  // Filesystem service (used internally by workerdManager; in Electron mode
  // the main process has its OWN FsService for panel-facing FS RPC)
  {
    const { FsService } = await import("../shared/fsService.js");
    container.register({
      name: "fsService",
      async start() {
        return new FsService(contextFolderManager);
      },
    });
  }

  // WorkerdManager — manages workerd process and worker instances
  {
    let workerdManagerInstance: import("./workerdManager.js").WorkerdManager | null = null;
    let buildSystemForWorkerd: import("./buildV2/index.js").BuildSystemV2 | null = null;
    container.register({
      name: "workerdManager",
      dependencies: ["buildSystem", "rpcServer", "fsService"],
      async start(resolve) {
        const { WorkerdManager } = await import("./workerdManager.js");
        buildSystemForWorkerd = resolve<import("./buildV2/index.js").BuildSystemV2>("buildSystem")!;
        const { port: rpcPort } = resolve<{ port: number }>("rpcServer")!;
        const fsServiceInst = resolve<import("../shared/fsService.js").FsService>("fsService")!;

        workerdManagerInstance = new WorkerdManager({
          tokenManager,
          fsService: fsServiceInst,
          rpcPort,
          getBuild: (unitPath, ref) => buildSystemForWorkerd!.getBuild(unitPath, ref),
          workspacePath,
          statePath,
        });

        // Wire push trigger to restart workers on source rebuild
        buildSystemForWorkerd.onPushBuild((source) => {
          // Check if the rebuilt source has DO classes (from the current graph)
          const node = buildSystemForWorkerd?.getGraph().allNodes().find(n => n.relativePath === source);
          const manifest = node?.manifest as Record<string, unknown> | undefined;
          const durable = manifest?.["durable"] as { classes?: Array<{ className: string }> } | undefined;
          const doClasses = durable?.classes;

          workerdManagerInstance?.onSourceRebuilt(source, doClasses).catch((err) => {
            console.error(`[WorkerdManager] Failed to handle rebuilt source ${source}:`, err);
          });
        });

        // Pre-register all DO classes from the build graph so they're available
        // before any panel connects or agent subscribes. Single workerd restart.
        {
          const graph = buildSystemForWorkerd.getGraph();
          const doClasses: Array<{ source: string; className: string }> = [];
          for (const node of graph.allNodes()) {
            if (node.kind !== "worker") continue;
            const manifest = node.manifest as Record<string, unknown>;
            const durable = manifest["durable"] as { classes?: Array<{ className: string }> } | undefined;
            if (durable?.classes) {
              for (const cls of durable.classes) {
                doClasses.push({ source: node.relativePath, className: cls.className });
              }
            }
          }
          if (doClasses.length > 0) {
            console.log(`[WorkerdManager] Pre-registering DO classes:`, doClasses.map(c => `${c.source}:${c.className}`).join(", "));
            await workerdManagerInstance.registerAllDOClasses(doClasses);
          }
        }

        return workerdManagerInstance;
      },
      async stop(instance: import("./workerdManager.js").WorkerdManager | null) {
        await instance?.shutdown();
      },
      getServiceDefinition() {
        if (!workerdManagerInstance || !buildSystemForWorkerd) return undefined as any;
        return createWorkerdService({ workerdManager: workerdManagerInstance, buildSystem: buildSystemForWorkerd });
      },
    });
  }

  // ===========================================================================
  // Standalone-mode services (conditionally registered)
  // ===========================================================================

  if (!ipcChannel) {
    const { handleHeadlessBridgeCall } = await import("./headlessBridge.js");

    // PanelHttpServer (optional — only when --serve-panels)
    if (args.servePanels) {
      const { PanelHttpServer } = await import("./panelHttpServer.js");
      container.register({
        name: "panelHttpServer",
        async start() {
          const server = new PanelHttpServer("127.0.0.1", adminToken);
          let envPanelPort: number | undefined;
          if (process.env["NATSTACK_PANEL_PORT"]) {
            envPanelPort = parseInt(process.env["NATSTACK_PANEL_PORT"], 10);
            if (isNaN(envPanelPort)) {
              console.warn("[Server] NATSTACK_PANEL_PORT is not a valid number, ignoring");
              envPanelPort = undefined;
            }
          }
          const port = await server.start(args.panelPort ?? envPanelPort ?? 0);
          return { server, port };
        },
        async stop(instance: { server: import("./panelHttpServer.js").PanelHttpServer; port: number }) {
          await instance?.server?.stop();
        },
      });
    }

    // PanelRegistry (no persistence in headless mode)
    const { PanelRegistry } = await import("../shared/panelRegistry.js");
    container.register({
      name: "panelRegistry",
      async start() {
        return new PanelRegistry({ workspace, eventService });
      },
    });

    // PanelLifecycle
    const { PanelLifecycle } = await import("../shared/panelLifecycle.js");
    container.register({
      name: "panelLifecycle",
      dependencies: ["panelRegistry", "fsService", "rpcServer"],
      optionalDependencies: ["panelHttpServer", "harnessManager"],
      async start(resolve) {
        const registry = resolve<import("../shared/panelRegistry.js").PanelRegistry>("panelRegistry")!;
        const fsService = resolve<import("../shared/fsService.js").FsService>("fsService")!;
        const { server: rpcServer, port: rpcPort } = resolve<{ server: import("./rpcServer.js").RpcServer; port: number }>("rpcServer")!;
        const httpResult = resolve<{ server: import("./panelHttpServer.js").PanelHttpServer; port: number }>("panelHttpServer", true);

        const lifecycle = new PanelLifecycle({
          registry,
          tokenManager,
          fsService,
          eventService,
          panelsRoot: workspacePath,
          serverInfo: {
            rpcPort,
            gitBaseUrl: `http://127.0.0.1:${gitServer.getPort()}`,
            workerdPort: resolve<import("./workerdManager.js").WorkerdManager>("workerdManager")?.getPort() ?? 0,
            createPanelToken: (panelId, kind) => tokenManager.createToken(panelId, kind as import("../shared/serviceDispatcher.js").CallerKind),
            ensurePanelToken: (panelId, kind) => tokenManager.ensureToken(panelId, kind as import("../shared/serviceDispatcher.js").CallerKind),
            revokePanelToken: (panelId) => { tokenManager.revokeToken(panelId); },
            getPanelToken: (panelId) => { try { return tokenManager.getToken(panelId); } catch { return null; } },
            getGitTokenForPanel: (panelId) => gitServer.getTokenForPanel(panelId),
            revokeGitToken: (panelId) => { gitServer.revokeTokenForPanel(panelId); },
          },
          panelHttpServer: httpResult?.server as import("../shared/panelInterfaces.js").PanelHttpServerLike | null ?? null,
          panelHttpPort: httpResult?.port,
          sendToClient: (callerId, msg) => rpcServer.sendToClient(callerId, msg as import("../shared/ws/protocol.js").WsServerMessage),
        });

        // Wire disconnect handler: panelLifecycle (high-level) subscribes to
        // rpcServer (low-level) events — dependency flows in the right direction.
        const harnessManagerInst = resolve<import("./harnessManager.js").HarnessManager>("harnessManager", true);
        rpcServer.setOnClientDisconnect((callerId, callerKind) => {
          const handleKey = callerKind === "panel" || callerKind === "worker" ? callerId : `server:${callerId}`;
          fsService.closeHandlesForCaller(handleKey);
          if (callerKind === "panel") {
            lifecycle.closePanel(callerId);
          } else if (callerKind === "harness") {
            harnessManagerInst?.notifyDisconnected(callerId);
          }
        });

        return lifecycle;
      },
    });

    // Bridge RPC service
    {
      let bridgeDeps: Parameters<typeof handleHeadlessBridgeCall>[0];
      container.register({
        name: "bridge",
        dependencies: ["panelLifecycle"],
        optionalDependencies: ["panelServing"],
        async start(resolve) {
          const lifecycle = resolve<import("../shared/panelLifecycle.js").PanelLifecycle>("panelLifecycle")!;
          const panelServingResult = resolve<{ cdpBridge: import("./cdpBridge.js").CdpBridge }>("panelServing", true);
          const cdpBridge = panelServingResult?.cdpBridge ?? null;
          bridgeDeps = { pm: lifecycle, gitServer, cdpBridge };
        },
        getServiceDefinition() {
          return {
            name: "bridge",
            description: "Panel lifecycle (headless mode)",
            policy: { allowed: ["panel", "shell", "server"] },
            methods: {
              closeSelf: { args: z.tuple([]) },
              getInfo: { args: z.tuple([]) },
              setStateArgs: { args: z.tuple([z.record(z.unknown())]) },
              focusPanel: { args: z.tuple([z.string().optional()]) },
              getBootstrapConfig: { args: z.tuple([]) },
              getWorkspaceTree: { args: z.tuple([]) },
              listBranches: { args: z.tuple([z.string()]) },
              listCommits: { args: z.tuple([z.string(), z.string().optional(), z.number().optional()]) },
              openDevtools: { args: z.tuple([]) },
              openFolderDialog: { args: z.tuple([z.object({ title: z.string().optional() }).optional()]) },
              createBrowserPanel: { args: z.tuple([z.string(), z.object({ name: z.string().optional(), focus: z.boolean().optional() }).optional()]) },
              closeChild: { args: z.tuple([z.string()]) },
              openExternal: { args: z.tuple([z.string()]) },
            },
            handler: async (ctx, method, serviceArgs) => {
              return handleHeadlessBridgeCall(bridgeDeps, ctx.callerId, method, serviceArgs as unknown[]);
            },
          };
        },
      });
    }

    // On-demand panel wiring + CDP bridge + browser service (when --serve-panels)
    if (args.servePanels) {
      let panelServingCdpBridge: import("./cdpBridge.js").CdpBridge;
      container.register({
        name: "panelServing",
        dependencies: ["panelHttpServer", "panelLifecycle", "panelRegistry", "buildSystem"],
        async start(resolve) {
          const { server: panelHttpServer, port: panelHttpPort } = resolve<{ server: import("./panelHttpServer.js").PanelHttpServer; port: number }>("panelHttpServer")!;
          const lifecycle = resolve<import("../shared/panelLifecycle.js").PanelLifecycle>("panelLifecycle")!;
          const registry = resolve<import("../shared/panelRegistry.js").PanelRegistry>("panelRegistry")!;
          const buildSystem = resolve<import("./buildV2/index.js").BuildSystemV2>("buildSystem")!;
          const { server: rpcServer, port: rpcPort } = resolve<{ server: import("./rpcServer.js").RpcServer; port: number }>("rpcServer")!;

          // Compute deterministic subdomains
          const graph = buildSystem.getGraph();
          const panelNodes = graph.allNodes().filter((n) => n.kind === "panel");
          const sanitize = (s: string) =>
            s.toLowerCase().replace(/[^a-z0-9]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
          const rawEntries = panelNodes.map((n) => ({
            subdomain: sanitize(n.relativePath.split("/").pop() ?? n.relativePath) || "panel",
            source: n.relativePath,
            name: n.manifest.title ?? n.name,
          }));
          const counts = new Map<string, number>();
          for (const e of rawEntries) counts.set(e.subdomain, (counts.get(e.subdomain) ?? 0) + 1);
          for (const e of rawEntries) {
            if ((counts.get(e.subdomain) ?? 0) > 1) e.subdomain = sanitize(e.source);
          }
          const assigned = new Set<string>();
          for (const e of rawEntries) {
            let candidate = e.subdomain.slice(0, 63).replace(/-$/, "");
            let suffix = 1;
            while (assigned.has(candidate)) {
              const tag = `-${suffix}`;
              candidate = e.subdomain.slice(0, 63 - tag.length).replace(/-$/, "") + tag;
              suffix++;
            }
            e.subdomain = candidate;
            assigned.add(candidate);
          }
          panelHttpServer.populateSourceRegistry(rawEntries);

          panelHttpServer.setCallbacks({
            onDemandCreate: async (source, subdomain) => {
              const panelId = await lifecycle.createPanelOnDemand(source, subdomain);
              const rpcToken = tokenManager.ensureToken(panelId, "panel");
              return { panelId, rpcPort, rpcToken, serverRpcPort: rpcPort, serverRpcToken: rpcToken };
            },
            listPanels: () => lifecycle.listPanels(),
            getBuild: (source, ref) => buildSystem.getBuild(source, ref),
          });

          buildSystem.onPushBuild((source) => { panelHttpServer.invalidateBuild(source); });
          console.log(`  On-demand panels: ${rawEntries.map((e) => e.subdomain).join(", ") || "(none)"}`);

          // CDP bridge
          const { CdpBridge } = await import("./cdpBridge.js");
          const cdpBridge = new CdpBridge({
            tokenManager,
            adminToken,
            canAccessBrowser: (requestingPanelId, browserId) =>
              registry.isDescendantOf(browserId, requestingPanelId) ||
              registry.isDescendantOf(requestingPanelId, browserId),
            panelOwnsBrowser: (requestingPanelId, browserId) =>
              registry.findParentId(browserId) === requestingPanelId,
            isPanelKnown: (browserId) => registry.getPanel(browserId) != null,
            port: panelHttpPort,
          });
          panelHttpServer.setCdpBridge(cdpBridge);
          panelServingCdpBridge = cdpBridge;

          return { cdpBridge };
        },
        async stop(instance: { cdpBridge: { stop(): Promise<void> } } | undefined) {
          await instance?.cdpBridge?.stop();
        },
        getServiceDefinition() {
          return {
            name: "browser",
            description: "CDP/browser automation (headless mode)",
            policy: { allowed: ["shell", "panel", "server"] },
            methods: {
              getCdpEndpoint: { args: z.tuple([z.string()]) },
              navigate: { args: z.tuple([z.string(), z.string()]) },
              goBack: { args: z.tuple([z.string()]) },
              goForward: { args: z.tuple([z.string()]) },
              reload: { args: z.tuple([z.string()]) },
              stop: { args: z.tuple([z.string()]) },
            },
            handler: async (ctx, method, serviceArgs) => {
              const a = serviceArgs as unknown[];
              switch (method) {
                case "getCdpEndpoint": {
                  const endpoint = panelServingCdpBridge.getCdpEndpoint(a[0] as string, ctx.callerId);
                  if (!endpoint) throw new Error(`Access denied or browser not found: ${a[0]}`);
                  return endpoint;
                }
                case "navigate": case "goBack": case "goForward": case "reload": case "stop":
                  return panelServingCdpBridge.sendBrowserCommand(a[0] as string, ctx.callerId, method, a.slice(1));
                default: throw new Error(`Unknown browser method: ${method}`);
              }
            },
          };
        },
      });
    } else {
      // Stub browser service when --serve-panels is off
      container.register({
        name: "browserStub",
        getServiceDefinition() {
          return {
            name: "browser",
            description: "CDP/browser automation (headless mode - unavailable)",
            policy: { allowed: ["shell", "panel", "server"] },
            methods: {},
            handler: async () => { throw new Error("browser service requires --serve-panels mode"); },
          };
        },
      });
    }

    // FS RPC service (standalone only — Electron main process provides its own fs service)
    const { handleFsCall } = await import("../shared/fsService.js");
    {
      let fsServiceInstance: import("../shared/fsService.js").FsService;
      container.register({
        name: "fsRpc",
        dependencies: ["fsService"],
        async start(resolve) {
          fsServiceInstance = resolve<import("../shared/fsService.js").FsService>("fsService")!;
        },
        getServiceDefinition() {
          const fsMethodSchema = { args: z.tuple([z.string()]).rest(z.unknown()) };
          return {
            name: "fs",
            description: "Per-context filesystem operations (sandboxed to context folder)",
            policy: { allowed: ["panel", "server", "worker"] },
            methods: {
              readFile: fsMethodSchema, writeFile: fsMethodSchema,
              readdir: fsMethodSchema, mkdir: fsMethodSchema,
              stat: fsMethodSchema, open: fsMethodSchema,
              close: fsMethodSchema, read: fsMethodSchema, write: fsMethodSchema,
            },
            handler: async (ctx, method, serviceArgs) => {
              return handleFsCall(fsServiceInstance, ctx, method, serviceArgs as unknown[]);
            },
          };
        },
      });
    }

  }

  // ── Start all services in dependency order ──
  await container.startAll();

  // Wire DODispatch to workerdManager for restart recovery
  const workerdManager = container.get<import("./workerdManager.js").WorkerdManager>("workerdManager");
  const doDispatchInst = container.get<import("./doDispatch.js").DODispatch>("doDispatch");

  doDispatchInst.setEnsureDO((source, className, objectKey) => workerdManager.ensureDO(source, className, objectKey));

  // Wire workerdUrl into rpcServer for HTTP relay to workers/DOs
  const rpcServerInstance = container.get<{ server: import("./rpcServer.js").RpcServer; port: number }>("rpcServer").server;
  const workerdPort = workerdManager.getPort();
  if (workerdPort) {
    rpcServerInstance.setWorkerdUrl(`http://127.0.0.1:${workerdPort}`);
  }

  dispatcher.markInitialized();

  // Validate that SERVER_SERVICE_NAMES covers all server-side services.
  // This catches drift where a new service is added to the server but not
  // to the shared constant (which would cause silent misrouting in Electron mode).
  {
    const { SERVER_SERVICE_NAMES } = await import("@natstack/rpc");
    const sharedSet = new Set<string>(SERVER_SERVICE_NAMES);
    // Services that intentionally live on both Electron and server (not routed via SERVER_SERVICE_NAMES)
    const dualHosted = new Set(["events", "bridge", "browser", "fs", "workerd"]);
    for (const name of dispatcher.getServices()) {
      if (!sharedSet.has(name) && !dualHosted.has(name)) {
        console.warn(
          `[Server] Service "${name}" is registered on the server but missing from SERVER_SERVICE_NAMES in @natstack/rpc. ` +
          `Panel calls to this service will be misrouted in Electron mode.`
        );
      }
    }
  }

  // ===========================================================================
  // Report ready
  // ===========================================================================

  const rpcPort = container.get<{ port: number }>("rpcServer").port;
  const workerdMgr = container.get<import("./workerdManager.js").WorkerdManager>("workerdManager");

  if (ipcChannel) {
    ipcChannel.postMessage({
      type: "ready",
      rpcPort,
      gitPort: gitServer.getPort(),
      pubsubPort: 0, // deprecated — channel DOs replace PubSub server
      workerdPort: workerdMgr?.getPort() ?? 0,
      adminToken,
    });
  } else {
    const panelHttpPort = container.has("panelHttpServer")
      ? container.get<{ port: number }>("panelHttpServer").port
      : null;

    // Register for browser extension auto-discovery (idempotent file writes)
    const { registerHeadlessService } = await import("./headlessServiceRegistration.js");
    try {
      registerHeadlessService(statePath, {
        rpcPort,
        panelPort: panelHttpPort,
        gitPort: gitServer.getPort(),
        adminToken,
      });
    } catch (err) {
      console.warn("[Server] Failed to register headless service:", err);
    }

    console.log("natstack-server ready:");
    console.log(`  Git:       http://127.0.0.1:${gitServer.getPort()}`);
    console.log(`  Workerd:   http://127.0.0.1:${workerdMgr?.getPort() ?? '?'}`);
    console.log(`  RPC:       ws://127.0.0.1:${rpcPort}`);
    if (panelHttpPort) {
      console.log(`  Panels:    http://127.0.0.1:${panelHttpPort}`);
      console.log(`  Panel API: http://127.0.0.1:${panelHttpPort}/api/panels`);
    }
    console.log(`  Admin token: ${adminToken}`);
  }

  // ===========================================================================
  // Graceful shutdown — container.stopAll() handles everything
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

    await container.stopAll()
      .then(() => console.log("[Server] All services stopped"))
      .catch((e) => console.error("[Server] Service shutdown error:", e))
      .finally(() => {
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
