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
  const { setUserDataPath, getUserDataPath } = await import("../shared/envPaths.js");
  const { loadCentralEnv, discoverWorkspace, createWorkspace } = await import("../shared/workspace/loader.js");
  const { GitServer } = await import("../shared/gitServer.js");
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

  // Create ContextFolderManager before core services so agents get context folder paths
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

  // Build system (must init before agents — they need build access)
  container.register({
    name: "buildSystem",
    async start() {
      return await initBuildSystemV2(workspacePath, gitServer);
    },
    async stop(instance: import("./buildV2/index.js").BuildSystemV2) { await instance?.shutdown(); },
  });

  // Agent discovery + settings (combined lifecycle + RPC)
  // agentSettings.getServiceDefinition() needs both instances, so we capture
  // the agentDiscovery reference in a closure scoped to the registration pair.
  let agentSettingsStarted: { service: import("../shared/agentSettings.js").AgentSettingsService; discovery: import("../shared/agentDiscovery.js").AgentDiscovery | null } | null = null;

  container.register({
    name: "agentDiscovery",
    async start() {
      const { initAgentDiscovery } = await import("../shared/agentDiscovery.js");
      return await initAgentDiscovery(workspacePath);
    },
    async stop(instance: import("../shared/agentDiscovery.js").AgentDiscovery) { instance?.stopWatching(); },
  });
  container.register({
    name: "agentSettings",
    dependencies: ["agentDiscovery"],
    async start(resolve) {
      const { AgentSettingsService } = await import("../shared/agentSettings.js");
      const agentDiscovery = resolve<import("../shared/agentDiscovery.js").AgentDiscovery>("agentDiscovery");
      const service = new AgentSettingsService();
      await service.initialize(workspacePath, agentDiscovery!);
      agentSettingsStarted = { service, discovery: agentDiscovery ?? null };
      return service;
    },
    async stop(instance: import("../shared/agentSettings.js").AgentSettingsService) { instance?.shutdown(); },
    getServiceDefinition() {
      return createAgentSettingsServiceDef({ agentSettingsService: agentSettingsStarted!.service, agentDiscovery: agentSettingsStarted?.discovery ?? null });
    },
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
      const { PubSubServer, SqliteMessageStore } = await import("../shared/pubsubServer.js");
      const server = new PubSubServer({
        tokenValidator: tokenManager,
        messageStore: new SqliteMessageStore(databaseManager),
      });
      const port = await server.start();
      return { server, port };
    },
    async stop(instance: { server: import("../shared/pubsubServer.js").PubSubServer; port: number }) { await instance?.server?.stop(); },
  });

  // Agent host
  container.register({
    name: "agentHost",
    dependencies: ["pubsub", "agentDiscovery", "tokenManager", "databaseManager", "buildSystem"],
    async start(resolve) {
      const { AgentHost } = await import("../shared/agentHost.js");
      const { server: pubsubServer, port: pubsubPort } = resolve<{ server: import("../shared/pubsubServer.js").PubSubServer; port: number }>("pubsub")!;
      const agentDiscovery = resolve<import("../shared/agentDiscovery.js").AgentDiscovery>("agentDiscovery")!;
      const buildSystem = resolve<import("./buildV2/index.js").BuildSystemV2>("buildSystem")!;

      const host = new AgentHost({
        workspaceRoot: workspace.path,
        pubsubUrl: `ws://127.0.0.1:${pubsubPort}`,
        messageStore: pubsubServer.getMessageStore(),
        createToken: (instanceId) => tokenManager.createToken(instanceId, "server"),
        revokeToken: (instanceId) => tokenManager.revokeToken(instanceId),
        getBuild: (unitPath) => buildSystem.getBuild(unitPath) as Promise<{ bundlePath: string; dir: string; metadata: { kind: string; name: string } }>,
        contextFolderManager,
        databaseManager,
        agentDiscovery,
      });

      await host.initialize();
      pubsubServer.setAgentHost(host);
      pubsubServer.setContextFolderManager(contextFolderManager);
      return host;
    },
    async stop(instance: import("../shared/agentHost.js").AgentHost) { instance?.shutdown(); },
  });

  // AI handler (lifecycle only — RPC registered separately because it needs rpcServer)
  container.register({
    name: "ai",
    dependencies: ["agentHost"],
    async start(resolve) {
      const { AIHandler: AIHandlerClass } = await import("../shared/ai/aiHandler.js");
      const agentHost = resolve<import("../shared/agentHost.js").AgentHost>("agentHost")!;
      const aiHandler = new AIHandlerClass(workspacePath);
      await aiHandler.initialize();
      agentHost.setAiHandler(aiHandler);
      return aiHandler;
    },
  });

  // ── RPC-only services (replacing serverServiceRegistry.ts) ──

  const { createBuildService } = await import("./services/buildService.js");
  const { createTokensService } = await import("./services/tokensService.js");
  const { createGitService } = await import("./services/gitService.js");
  const { createTestService } = await import("./services/testService.js");
  const { createProjectService } = await import("./services/projectService.js");
  const { createAgentSettingsService: createAgentSettingsServiceDef } = await import("./services/agentSettingsService.js");
  const { createDbService } = await import("./services/dbService.js");
  const { createTypecheckService } = await import("./services/typecheckService.js");

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
  container.register(rpcService(createGitService({ gitServer, tokenManager, contextFolderManager }), ["gitServer"]));
  container.register(rpcService(createTestService({ contextFolderManager, workspacePath, panelTestSetupPath })));
  container.register(rpcService(createProjectService({ contextFolderManager, gitServer, tokenManager }), ["gitServer"]));
  container.register(rpcService(createDbService({ databaseManager }), ["databaseManager"]));
  container.register(rpcService(createTypecheckService({ contextFolderManager })));
  container.register(rpcService(createEventsServiceDefinition(eventService)));

  // ── Start all services in dependency order ──
  await container.startAll();

  // Extract commonly needed values from started services
  const pubsubPort = container.get<{ port: number }>("pubsub").port;
  const buildSystem = container.get<import("./buildV2/index.js").BuildSystemV2>("buildSystem");

  // Admin token: use NATSTACK_ADMIN_TOKEN env var if set, otherwise generate random.
  // A fixed token (e.g. in ~/.config/natstack/.env) avoids having to copy a new
  // token every time the server restarts.
  const adminToken = process.env["NATSTACK_ADMIN_TOKEN"] || randomBytes(32).toString("hex");
  tokenManager.setAdminToken(adminToken);

  let fsServiceRef: { closeHandlesForPanel(panelId: string): void } | null = null;
  let panelManagerRef: { closePanel(panelId: string): void } | null = null;

  const rpcServer = new RpcServer({
    tokenManager: tokenManager,
    dispatcher,
    onClientDisconnect: (callerId, callerKind) => {
      const handleKey = callerKind === "panel" ? callerId : `server:${callerId}`;
      fsServiceRef?.closeHandlesForPanel(handleKey);
      // In headless mode, remove the panel from the tree on disconnect.
      // The grace period in rpcServer ensures normal reloads don't trigger this.
      if (callerKind === "panel") {
        panelManagerRef?.closePanel(callerId);
      }
    },
  });

  // AI RPC service must be registered after RpcServer (needs createWsStreamTarget)
  const { createAiService } = await import("./services/aiService.js");
  dispatcher.registerService(createAiService({
    aiHandler: container.get<import("../shared/ai/aiHandler.js").AIHandler>("ai"),
    rpcServer,
  }));

  const rpcPort = await rpcServer.start();

  // ===========================================================================
  // Headless panel management + HTTP panel serving (standalone mode only)
  // ===========================================================================

  let panelHttpPort: number | null = null;
  let panelHttpServerInstance: { stop(): Promise<void> } | null = null;
  let cdpBridgeInstance: { stop(): Promise<void> } | null = null;

  if (!ipcChannel) {
    const { PanelHttpServer } = await import("./panelHttpServer.js");
    const { PanelRegistry } = await import("../shared/panelRegistry.js");
    const { PanelLifecycle } = await import("../shared/panelLifecycle.js");
    const { handleHeadlessBridgeCall } = await import("./headlessBridge.js");

    // Start HTTP panel server if requested
    let panelHttpServer: InstanceType<typeof PanelHttpServer> | null = null;
    if (args.servePanels) {
      panelHttpServer = new PanelHttpServer("127.0.0.1", adminToken);
      let envPanelPort: number | undefined;
      if (process.env["NATSTACK_PANEL_PORT"]) {
        envPanelPort = parseInt(process.env["NATSTACK_PANEL_PORT"], 10);
        if (isNaN(envPanelPort)) {
          console.warn("[Server] NATSTACK_PANEL_PORT is not a valid number, ignoring");
          envPanelPort = undefined;
        }
      }
      panelHttpPort = await panelHttpServer.start(args.panelPort ?? envPanelPort ?? 0);
      panelHttpServerInstance = panelHttpServer;
    }

    // Filesystem service — per-context sandboxed fs via RPC
    const { FsService, handleFsCall } = await import("../shared/fsService.js");
    const fsService = new FsService(contextFolderManager);
    fsServiceRef = fsService;

    // Create PanelRegistry (no persistence in headless mode)
    const headlessRegistry = new PanelRegistry({
      workspace,
      eventService,
    });

    // Create PanelLifecycle with headless deps
    const headlessLifecycle = new PanelLifecycle({
      registry: headlessRegistry,
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
      panelHttpServer: panelHttpServer as import("../shared/panelLifecycle.js").PanelHttpServerLike | null,
      panelHttpPort: panelHttpPort ?? undefined,
      sendToClient: (callerId, msg) => rpcServer.sendToClient(callerId, msg as import("../shared/ws/protocol.js").WsServerMessage),
    });

    panelManagerRef = headlessLifecycle;

    // Register bridge service for headless panel lifecycle
    const headlessBridgeDeps = {
      pm: headlessLifecycle,
      gitServer,
      agentDiscovery: container.get<import("../shared/agentDiscovery.js").AgentDiscovery | null>("agentDiscovery"),
    };
    dispatcher.registerService({
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
        listAgents: { args: z.tuple([]) },
        openDevtools: { args: z.tuple([]) },
        openFolderDialog: { args: z.tuple([z.object({ title: z.string().optional() }).optional()]) },
      },
      handler: async (ctx, method, serviceArgs) => {
        return handleHeadlessBridgeCall(
          headlessBridgeDeps,
          ctx.callerId,
          method,
          serviceArgs as unknown[],
        );
      },
    });

    // ── On-demand panel creation: populate source registry ───────────
    // Scan the package graph for available panels and register them with
    // deterministic subdomains. When a browser visits one of these subdomains,
    // PanelHttpServer triggers on-demand creation via PanelLifecycle.
    if (panelHttpServer) {
      const graph = buildSystem.getGraph();
      const panelNodes = graph.allNodes().filter((n) => n.kind === "panel");

      // Compute deterministic subdomains from base names
      const sanitize = (s: string) =>
        s.toLowerCase().replace(/[^a-z0-9]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");

      const rawEntries = panelNodes.map((n) => ({
        subdomain: sanitize(n.relativePath.split("/").pop() ?? n.relativePath) || "panel",
        source: n.relativePath,
        name: n.manifest.title ?? n.name,
      }));

      // Resolve collisions: use full path for any duplicated base names
      const counts = new Map<string, number>();
      for (const e of rawEntries) {
        counts.set(e.subdomain, (counts.get(e.subdomain) ?? 0) + 1);
      }
      for (const e of rawEntries) {
        if ((counts.get(e.subdomain) ?? 0) > 1) {
          e.subdomain = sanitize(e.source);
        }
      }

      // Truncate to DNS label max (63 chars) and deduplicate final subdomains.
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

      // Wire callbacks: all panel data flows through these — zero per-panel state on server
      panelHttpServer.setCallbacks({
        onDemandCreate: async (source, subdomain) => {
          const panelId = await headlessLifecycle.createPanelOnDemand(source, subdomain);
          const rpcToken = tokenManager.ensureToken(panelId, "panel");
          return { panelId, rpcPort, rpcToken, serverRpcPort: rpcPort, serverRpcToken: rpcToken };
        },
        listPanels: () => headlessLifecycle.listPanels(),
        getBuild: (source) => buildSystem.getBuild(source),
      });

      // When the push trigger builds something, invalidate the HTTP serving
      // cache so the next request serves fresh content instead of stale cache.
      buildSystem.onPushBuild((source) => {
        panelHttpServer.invalidateBuild(source);
      });

      console.log(`  On-demand panels: ${rawEntries.map((e) => e.subdomain).join(", ") || "(none)"}`);

      // CDP bridge for browser extension automation
      const { CdpBridge } = await import("./cdpBridge.js");
      const cdpBridge = new CdpBridge({
        tokenManager: tokenManager,
        adminToken,
        canAccessBrowser: (requestingPanelId, browserId) => {
          // In headless mode, panels are flat (no parent/child tree)
          // so cross-panel access is not supported
          return headlessRegistry.isDescendantOf(browserId, requestingPanelId) ||
                 headlessRegistry.isDescendantOf(requestingPanelId, browserId);
        },
        panelOwnsBrowser: (requestingPanelId, browserId) => {
          return headlessRegistry.findParentId(browserId) === requestingPanelId;
        },
        port: panelHttpPort!,
      });
      panelHttpServer.setCdpBridge(cdpBridge);
      cdpBridgeInstance = cdpBridge;

      // Register browser service for CDP + navigation
      dispatcher.registerService({
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
              const endpoint = cdpBridge.getCdpEndpoint(a[0] as string, ctx.callerId);
              if (!endpoint) throw new Error(`Access denied or browser not found: ${a[0]}`);
              return endpoint;
            }
            case "navigate":
            case "goBack":
            case "goForward":
            case "reload":
            case "stop":
              return cdpBridge.sendBrowserCommand(a[0] as string, ctx.callerId, method, a.slice(1));
            default:
              throw new Error(`Unknown browser method: ${method}`);
          }
        },
      });
    }

    // Stub browser service when --serve-panels is off
    if (!panelHttpServer) {
      dispatcher.registerService({
        name: "browser",
        description: "CDP/browser automation (headless mode - unavailable)",
        policy: { allowed: ["shell", "panel", "server"] },
        methods: {},
        handler: async () => {
          throw new Error("browser service requires --serve-panels mode");
        },
      });
    }

    const fsMethodSchema = { args: z.tuple([z.string()]).rest(z.unknown()) };
    dispatcher.registerService({
      name: "fs",
      description: "Per-context filesystem operations (sandboxed to context folder)",
      policy: { allowed: ["panel", "server"] },
      methods: {
        readFile: fsMethodSchema,
        writeFile: fsMethodSchema,
        readdir: fsMethodSchema,
        mkdir: fsMethodSchema,
        stat: fsMethodSchema,
        open: fsMethodSchema,
        close: fsMethodSchema,
        read: fsMethodSchema,
        write: fsMethodSchema,
      },
      handler: async (ctx, method, serviceArgs) => {
        return handleFsCall(fsService, ctx, method, serviceArgs as unknown[]);
      },
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
      gitPort: gitServer.getPort(),
      pubsubPort: pubsubPort,
      adminToken,
    });
  } else {
    // Register for browser extension auto-discovery (idempotent file writes)
    const { registerHeadlessService } = await import("./headlessServiceRegistration.js");
    try {
      const configDir = args.dataDir ?? process.env["NATSTACK_USER_DATA_PATH"] ?? getUserDataPath();
      registerHeadlessService(configDir, {
        rpcPort,
        panelPort: panelHttpPort,
        gitPort: gitServer.getPort(),
        pubsubPort: pubsubPort,
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
      container.stopAll().then(() => console.log("[Server] Services stopped")).catch((e) => console.error("[Server] Service shutdown error:", e)),
      rpcServer.stop().then(() => console.log("[Server] RPC stopped")).catch((e) => console.error("[Server] RPC stop error:", e)),
    ];
    if (cdpBridgeInstance) {
      shutdownTasks.push(
        cdpBridgeInstance.stop().then(() => console.log("[Server] CDP bridge stopped")).catch((e) => console.error("[Server] CDP bridge stop error:", e)),
      );
    }
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
