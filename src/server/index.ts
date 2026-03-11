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
  const { setUserDataPath, getUserDataPath } = await import("@natstack/env-paths");
  const { loadCentralEnv, discoverWorkspace, createWorkspace } = await import("../shared/workspace/loader.js");
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

  // ===========================================================================
  // Service initialization
  // ===========================================================================

  const githubConfig = workspace.config.git?.github;
  const tokenManager = new TokenManager();

  const gitServer = new GitServer(tokenManager, {
    port: workspace.config.git?.port,
    reposPath: workspace.gitReposPath,
    github: {
      ...githubConfig,
      token: githubConfig?.token ?? process.env["GITHUB_TOKEN"],
    },
  });

  // Create ContextFolderManager before core services
  const { ContextFolderManager } = await import("../shared/contextFolderManager.js");
  const contextFolderManager = new ContextFolderManager({
    workspacePath: workspacePath,
    getWorkspaceTree: () => gitServer.getWorkspaceTree(),
  });

  const databaseManager = new DatabaseManager(workspacePath);

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
      return await initBuildSystemV2(workspacePath, gitServer);
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

  // PubSub server
  container.register({
    name: "pubsub",
    dependencies: ["tokenManager", "databaseManager"],
    async start() {
      const { PubSubServer, SqliteMessageStore } = await import("@natstack/pubsub-server");
      const { findServicePort } = await import("@natstack/port-utils");
      const server = new PubSubServer({
        tokenValidator: tokenManager,
        messageStore: new SqliteMessageStore(databaseManager),
        findPort: () => findServicePort("pubsub"),
      });
      const port = await server.start();
      return { server, port };
    },
    async stop(instance: { server: import("@natstack/pubsub-server").PubSubServer; port: number }) { await instance?.server?.stop(); },
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
  const { createChannelService } = await import("./services/channelService.js");
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

  // ── WorkerRouter (central registry for DO/participant/harness mappings) ──

  container.register({
    name: "workerRouter",
    dependencies: ["workerdManager"],
    async start(resolve) {
      const { WorkerRouter } = await import("./workerRouter.js");
      const router = new WorkerRouter();

      // Dispatch DO method calls via HTTP to the workerd router.
      // The workerd router worker has /_do/{className}/{objectKey}/{method} routes
      // that proxy to the DO instance via stub.fetch().
      const workerdManager = resolve<import("./workerdManager.js").WorkerdManager>("workerdManager")!;
      router.setDispatcher(async (className, objectKey, method, ...args) => {
        const port = workerdManager.getPort();
        if (!port) {
          throw new Error(`workerd not running — cannot dispatch to DO class ${className}`);
        }
        const url = `http://127.0.0.1:${port}/_do/${encodeURIComponent(className)}/${encodeURIComponent(objectKey)}/${encodeURIComponent(method)}`;
        const resp = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(args.length === 1 ? args[0] : args),
        });
        if (!resp.ok) {
          const body = await resp.text();
          throw new Error(`DO dispatch failed (${resp.status}): ${body}`);
        }
        return await resp.json() as import("@natstack/harness").WorkerActions;
      });

      return router;
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

  // Late-binding reference for crash recovery action execution.
  // harnessManager starts before pubsubFacade in the dependency graph,
  // but onCrash fires at runtime when all services are up.
  let crashExecuteActions: ((actions: import("@natstack/harness").WorkerActions, ctx: { participantId: string }) => Promise<void>) | null = null;

  container.register({
    name: "harnessManager",
    dependencies: ["rpcServer", "workerRouter"],
    async start(resolve) {
      const { HarnessManager } = await import("./harnessManager.js");
      const { server: rpcServer, port: rpcPort } = resolve<{ server: import("./rpcServer.js").RpcServer; port: number }>("rpcServer")!;
      const workerRouter = resolve<import("./workerRouter.js").WorkerRouter>("workerRouter")!;

      const manager = new HarnessManager({
        getRpcWsUrl: () => `ws://127.0.0.1:${rpcPort}`,
        createToken: (callerId, callerKind) => tokenManager.createToken(callerId, callerKind),
        revokeToken: (callerId) => tokenManager.revokeToken(callerId),
        getClientBridge: (callerId) => rpcServer.getClientBridge(callerId),
        onCrash: (harnessId) => {
          // Notify the owning DO of the crash and execute recovery actions
          const doReg = workerRouter.getDOForHarness(harnessId);
          if (!doReg) {
            console.error(`[HarnessManager] onCrash: no DO registration for harness ${harnessId}`);
            workerRouter.unregisterHarness(harnessId);
            return;
          }

          // Dispatch crash event WITHOUT code — triggers the crash recovery path
          // (with code it would go to the turn-level error path which does NOT respawn)
          void (async () => {
            try {
              const actions = await workerRouter.dispatch(
                doReg.className, doReg.objectKey,
                "onHarnessEvent", harnessId,
                { type: "error", error: "harness process crashed" },
              );

              // Unregister AFTER dispatch (respawn will re-register)
              workerRouter.unregisterHarness(harnessId);

              // Execute returned actions (contains respawnHarness, channel cleanup, etc.)
              if (actions?.actions?.length > 0 && crashExecuteActions) {
                const participants = workerRouter.getParticipantsForDO(doReg.className, doReg.objectKey);
                const participantId = participants[0];
                if (participantId) {
                  await crashExecuteActions(actions, { participantId });
                } else {
                  console.error(`[HarnessManager] onCrash: no participantId for DO ${doReg.className}/${doReg.objectKey}, recovery actions dropped`);
                }
              }
            } catch (err) {
              console.error(`[HarnessManager] onCrash: crash recovery failed for ${harnessId}:`, err);
              workerRouter.unregisterHarness(harnessId);
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

  // ── PubSubFacade (glue between PubSub callback participants and DO dispatch) ──

  container.register({
    name: "pubsubFacade",
    dependencies: ["pubsub", "workerRouter", "harnessManager"],
    async start(resolve) {
      const { PubSubFacade } = await import("./services/pubsubFacade.js");
      const { executeActions } = await import("./executeActions.js");
      const { server: pubsubServer } = resolve<{ server: import("@natstack/pubsub-server").PubSubServer }>("pubsub")!;
      const workerRouter = resolve<import("./workerRouter.js").WorkerRouter>("workerRouter")!;
      const harnessManager = resolve<import("./harnessManager.js").HarnessManager>("harnessManager")!;

      const facade = new PubSubFacade(
        pubsubServer,
        workerRouter,
        async (actions, ctx) => {
          await executeActions(actions, {
            facade,
            harnessManager,
            router: workerRouter,
            ensureContextFolder: (ctxId) => contextFolderManager.ensureContextFolder(ctxId),
            participantId: ctx.participantId,
          });
        },
      );

      // Wire up late-binding reference for crash recovery action execution
      crashExecuteActions = async (actions, ctx) => {
        await executeActions(actions, {
          facade,
          harnessManager,
          router: workerRouter,
          ensureContextFolder: (ctxId) => contextFolderManager.ensureContextFolder(ctxId),
          participantId: ctx.participantId,
        });
      };

      return facade;
    },
    async stop(instance: import("./services/pubsubFacade.js").PubSubFacade) {
      await instance?.flushAll();
      instance?.unsubscribeAll();
    },
  });

  // ── Channels RPC service ──

  {
    let channelServiceDef: import("../shared/serviceDefinition.js").ServiceDefinition;
    container.register({
      name: "channelsRpc",
      dependencies: ["pubsub", "workerRouter", "pubsubFacade", "harnessManager"],
      async start(resolve) {
        const { server: pubsubServer } = resolve<{ server: import("@natstack/pubsub-server").PubSubServer }>("pubsub")!;
        const workerRouter = resolve<import("./workerRouter.js").WorkerRouter>("workerRouter")!;
        const pubsubFacade = resolve<import("./services/pubsubFacade.js").PubSubFacade>("pubsubFacade")!;
        const harnessManager = resolve<import("./harnessManager.js").HarnessManager>("harnessManager")!;
        channelServiceDef = createChannelService({
          pubsub: pubsubServer,
          router: workerRouter,
          facade: pubsubFacade,
          harnessManager,
        });
      },
      getServiceDefinition() {
        return channelServiceDef;
      },
    });
  }

  // ── Harness RPC service ──

  {
    let harnessServiceDef: import("../shared/serviceDefinition.js").ServiceDefinition;
    container.register({
      name: "harnessRpc",
      dependencies: ["workerRouter", "pubsubFacade", "harnessManager"],
      async start(resolve) {
        const workerRouter = resolve<import("./workerRouter.js").WorkerRouter>("workerRouter")!;
        const pubsubFacade = resolve<import("./services/pubsubFacade.js").PubSubFacade>("pubsubFacade")!;
        const harnessManagerInst = resolve<import("./harnessManager.js").HarnessManager>("harnessManager")!;
        const { executeActions } = await import("./executeActions.js");

        harnessServiceDef = createHarnessService({
          router: workerRouter,
          executeActions: async (actions, ctx) => {
            await executeActions(actions, {
              facade: pubsubFacade,
              harnessManager: harnessManagerInst,
              router: workerRouter,
              ensureContextFolder: (ctxId) => contextFolderManager.ensureContextFolder(ctxId),
              participantId: ctx.participantId,
            });
          },
          resolveParticipantForHarness: (harnessId) => {
            const doReg = workerRouter.getDOForHarness(harnessId);
            if (!doReg) return undefined;
            // Find a participant for this DO
            const participants = workerRouter.getParticipantsForDO(doReg.className, doReg.objectKey);
            return participants[0]; // Return the first (primary) participant
          },
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
      dependencies: ["workerRouter", "pubsubFacade", "harnessManager", "buildSystem"],
      async start(resolve) {
        const workerRouter = resolve<import("./workerRouter.js").WorkerRouter>("workerRouter")!;
        const pubsubFacade = resolve<import("./services/pubsubFacade.js").PubSubFacade>("pubsubFacade")!;
        const harnessManagerInst = resolve<import("./harnessManager.js").HarnessManager>("harnessManager")!;
        const buildSystemInst = resolve<import("./buildV2/index.js").BuildSystemV2>("buildSystem")!;

        workerServiceDef = createWorkerService({
          router: workerRouter,
          facade: pubsubFacade,
          harnessManager: harnessManagerInst,
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
        aiServiceDef = createAiService({ aiHandler, rpcServer });
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
        });

        // Wire push trigger to restart workers on source rebuild
        buildSystemForWorkerd.onPushBuild((source) => {
          workerdManagerInstance?.onSourceRebuilt(source).catch((err) => {
            console.error(`[WorkerdManager] Failed to handle rebuilt source ${source}:`, err);
          });
        });

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
        const pubsubPort = resolve<{ port: number }>("pubsub")!.port;
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
            pubsubUrl: `ws://127.0.0.1:${pubsubPort}`,
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
  const pubsubPort = container.get<{ port: number }>("pubsub").port;

  if (ipcChannel) {
    ipcChannel.postMessage({
      type: "ready",
      rpcPort,
      gitPort: gitServer.getPort(),
      pubsubPort,
      adminToken,
    });
  } else {
    const panelHttpPort = container.has("panelHttpServer")
      ? container.get<{ port: number }>("panelHttpServer").port
      : null;

    // Register for browser extension auto-discovery (idempotent file writes)
    const { registerHeadlessService } = await import("./headlessServiceRegistration.js");
    try {
      const configDir = args.dataDir ?? process.env["NATSTACK_USER_DATA_PATH"] ?? getUserDataPath();
      registerHeadlessService(configDir, {
        rpcPort,
        panelPort: panelHttpPort,
        gitPort: gitServer.getPort(),
        pubsubPort,
        adminToken,
      });
    } catch (err) {
      console.warn("[Server] Failed to register headless service:", err);
    }

    console.log("natstack-server ready:");
    console.log(`  Git:       http://127.0.0.1:${gitServer.getPort()}`);
    console.log(`  PubSub:    ws://127.0.0.1:${pubsubPort}`);
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
