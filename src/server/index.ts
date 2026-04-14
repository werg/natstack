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
// IPC request/response — bidirectional message correlation
// =============================================================================
// Extends the existing fire-and-forget IPC pattern (workspace-relaunch,
// open-external, shutdown) with request/response support. The server sends
// a typed request with a correlation ID; the parent (Electron main) returns
// a response with the same ID. A single persistent listener routes all
// responses to their pending promises.

const pendingIpcResponses = new Map<string, (response: unknown) => void>();

if (ipcChannel) {
  ipcChannel.on("message", (msg: any) => {
    if (msg?.id && pendingIpcResponses.has(msg.id)) {
      pendingIpcResponses.get(msg.id)!(msg);
      pendingIpcResponses.delete(msg.id);
    }
  });
}

/**
 * Send a typed request to the parent process and await a correlated response.
 * Returns null if no IPC channel or if the parent doesn't respond within 5s.
 */
function ipcRequest<T = unknown>(type: string, payload?: Record<string, unknown>): Promise<T | null> {
  if (!ipcChannel) return Promise.resolve(null);
  const id = randomBytes(8).toString("hex");
  return new Promise<T | null>((resolve) => {
    const timeout = setTimeout(() => {
      pendingIpcResponses.delete(id);
      resolve(null);
    }, 5000);
    pendingIpcResponses.set(id, (response: unknown) => {
      clearTimeout(timeout);
      resolve(response as T);
    });
    ipcChannel.postMessage({ type, id, ...(payload ?? {}) });
  });
}

// =============================================================================
// Phase A: Synchronous preamble — parse CLI args OR inherit env vars
// =============================================================================

interface CliArgs {
  workspaceName?: string;
  workspaceDir?: string;
  appRoot?: string;
  logLevel?: string;
  servePanels?: boolean;
  panelPort?: number;
  init?: boolean;
  host?: string;
  bindHost?: string;
  protocol?: "http" | "https";
  tlsCert?: string;
  tlsKey?: string;
  printToken?: boolean;
  help?: boolean;
}

function printHelp(): void {
  console.log(`
natstack-server — Headless and standalone NatStack server

Usage:
  node dist/server/index.js [options]

Options:
  --workspace <name>       Workspace name to resolve (default: last-opened or "default")
  --workspace-dir <path>   Explicit workspace directory path
  --app-root <path>        Application root directory (default: cwd)
  --host <hostname>        External hostname (also sets bind to 0.0.0.0)
  --bind-host <addr>       Explicit bind address (default: 127.0.0.1, or 0.0.0.0 with --host)
  --protocol <http|https>  Protocol for panel-facing URLs (default: http)
  --tls-cert <path>        TLS certificate file (PEM). Enables HTTPS when used with --tls-key.
  --tls-key <path>         TLS private key file (PEM). Required when --tls-cert is provided.
  --serve-panels           Enable panel HTTP serving
  --panel-port <port>      Port for panel HTTP (default: auto-assigned)
  --init                   Auto-create workspace from template if it doesn't exist
  --log-level <level>      Log verbosity
  --print-token            Print the admin token in NATSTACK_ADMIN_TOKEN=... format
  --help                   Show this help message and exit

Environment variables:
  NATSTACK_ADMIN_TOKEN     Use a stable admin token instead of generating a random one
  NATSTACK_HOST            External hostname (same as --host)
  NATSTACK_BIND_HOST       Explicit bind address (same as --bind-host)
  NATSTACK_PROTOCOL        Protocol for panel URLs (same as --protocol)
  NATSTACK_WORKSPACE       Workspace name (same as --workspace)
  NATSTACK_WORKSPACE_DIR   Workspace directory (same as --workspace-dir)
  NATSTACK_APP_ROOT        Application root (same as --app-root)
  NATSTACK_LOG_LEVEL       Log verbosity (same as --log-level)

Remote Electron connection:
  To connect an Electron frontend to this server, set these env vars before
  launching the Electron app:
    NATSTACK_REMOTE_URL=http://<host>:<gateway-port>
    NATSTACK_REMOTE_TOKEN=<admin-token>
`);
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {};
  const known = new Set(["workspace", "workspace-dir", "app-root", "log-level", "serve-panels", "panel-port", "init", "host", "bind-host", "protocol", "tls-cert", "tls-key", "print-token", "help"]);
  /** Flags that don't take a value */
  const booleanFlags = new Set(["serve-panels", "init", "print-token", "help"]);

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
        args.workspaceName = value;
        break;
      case "workspace-dir":
        args.workspaceDir = value;
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
      case "init":
        args.init = true;
        break;
      case "panel-port":
        args.panelPort = parseInt(value!, 10);
        if (isNaN(args.panelPort)) {
          console.error("--panel-port must be a number");
          process.exit(1);
        }
        break;
      case "host":
        args.host = value;
        break;
      case "bind-host":
        args.bindHost = value;
        break;
      case "protocol":
        if (value !== "http" && value !== "https") {
          console.error("--protocol must be http or https");
          process.exit(1);
        }
        args.protocol = value;
        break;
      case "tls-cert":
        args.tlsCert = value;
        break;
      case "tls-key":
        args.tlsKey = value;
        break;
      case "print-token":
        args.printToken = true;
        break;
      case "help":
        args.help = true;
        break;
    }
  }

  return args;
}

let args: CliArgs = {};

if (!ipcChannel) {
  // Standalone mode: parse CLI args, set env vars
  args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    process.exit(0);
  }
  if (args.tlsCert && !args.tlsKey) {
    console.error("--tls-cert requires --tls-key");
    process.exit(1);
  }
  if (args.tlsKey && !args.tlsCert) {
    console.error("--tls-key requires --tls-cert");
    process.exit(1);
  }
  if (args.workspaceDir) process.env["NATSTACK_WORKSPACE_DIR"] = args.workspaceDir;
  process.env["NATSTACK_APP_ROOT"] = args.appRoot ?? process.cwd();
  if (args.logLevel) process.env["NATSTACK_LOG_LEVEL"] = args.logLevel;
} else {
  // IPC mode: env vars already set by parent via fork({ env: {...} })
}

// =============================================================================
// Phase B: Async main — load app modules, initialize services
// =============================================================================

async function main() {
  const { setUserDataPath } = await import("@natstack/env-paths");
  const { loadCentralEnv, resolveOrCreateWorkspace } = await import("@natstack/shared/workspace/loader");
  const { CentralDataManager } = await import("@natstack/shared/centralData");
  const { GitServer } = await import("@natstack/git-server");
  const { TokenManager } = await import("@natstack/shared/tokenManager");
  const { z } = await import("zod");
  const { ServiceDispatcher } = await import("@natstack/shared/serviceDispatcher");
  const { EventService, createEventsServiceDefinition } = await import("@natstack/shared/eventsService");
  const eventService = new EventService();
  const { RpcServer } = await import("./rpcServer.js");
  const { ServiceContainer } = await import("@natstack/shared/serviceContainer");
  const { rpcService } = await import("@natstack/shared/managedService");
  const { initBuildSystemV2 } = await import("./buildV2/index.js");
  const { DatabaseManager } = await import("@natstack/shared/db/databaseManager");

  loadCentralEnv();

  // ===========================================================================
  // Workspace resolution
  // ===========================================================================
  // Shared resolution via resolveOrCreateWorkspace():
  //   --workspace-dir <path>   → explicit managed workspace root
  //   --workspace <name>       → resolve by name via getWorkspaceDir()
  //   NATSTACK_WORKSPACE_DIR   → env var (set by Electron parent or user)
  //   (none, standalone)       → last-opened from central data, or "default"
  //
  // With --init: auto-create from template if workspace doesn't exist.

  const appRoot = process.env["NATSTACK_APP_ROOT"] ?? process.cwd();
  const centralData = !ipcChannel ? new CentralDataManager() : null;

  const wsDir = args.workspaceDir ?? process.env["NATSTACK_WORKSPACE_DIR"];
  const wsName = args.workspaceName ?? process.env["NATSTACK_WORKSPACE"];

  function resolveOpts(): import("@natstack/shared/workspace/loader").ResolveWorkspaceOpts {
    if (wsDir) return { wsDir, appRoot, init: args.init };
    if (wsName) return { name: wsName, appRoot, init: args.init };
    if (centralData) {
      // Standalone with no workspace specified — use last-opened or "default"
      const last = centralData.getLastOpenedWorkspace();
      return last
        ? { name: last.name, appRoot }
        : { name: "default", appRoot, init: true };
    }
    // IPC mode with no workspace — fatal
    ipcChannel!.postMessage({ type: "error", message: "No workspace specified (set NATSTACK_WORKSPACE_DIR)" });
    process.exit(1);
  }

  let workspace: import("@natstack/shared/workspace/types").Workspace;
  try {
    const resolved = resolveOrCreateWorkspace(resolveOpts());
    workspace = resolved.workspace;
    centralData?.addWorkspace(resolved.name);
  } catch (error) {
    const msg = `Workspace resolution failed: ${error}`;
    if (ipcChannel) {
      ipcChannel.postMessage({ type: "error", message: msg });
    } else {
      console.error(msg);
      if (!args.init) console.error("  Use --init to auto-create from template.");
    }
    process.exit(1);
  }

  // Set user data path to workspace state dir for env-paths compatibility
  setUserDataPath(workspace.statePath);

  // Aliases — used throughout service init below
  const workspacePath = workspace.path;
  const workspaceConfig = workspace.config;
  const statePath = workspace.statePath;

  // ===========================================================================
  // App node_modules resolution (for @natstack/* platform packages)
  // ===========================================================================

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
    devTargetDir: workspaceConfig.git?.devTargetDir,
    github: {
      ...githubConfig,
      token: githubConfig?.token ?? process.env["GITHUB_TOKEN"],
    },
  });

  // Create ContextFolderManager before core services
  const { ContextFolderManager } = await import("@natstack/shared/contextFolderManager");
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
      const { createGitWatcher } = await import("@natstack/shared/workspace/gitWatcher");
      const watcher = createGitWatcher(workspace);
      gitServer.subscribeToGitWatcher(watcher);
      return watcher;
    },
    async stop(instance: import("@natstack/shared/workspace/gitWatcher").GitWatcher) { await instance?.close(); },
  });

  // ── RPC-only services (replacing serverServiceRegistry.ts) ──

  const { createBuildService } = await import("./services/buildService.js");
  const { createWorkerdService } = await import("./services/workerdService.js");
  const { createTokensService } = await import("./services/tokensService.js");
  const { createGitService } = await import("./services/gitService.js");
  const { createTestService } = await import("./services/testService.js");
  const { createDbService } = await import("./services/dbService.js");
  const { createTypecheckService } = await import("./services/typecheckService.js");
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
  {
    let tokensDefinition: import("@natstack/shared/serviceDefinition").ServiceDefinition | null = null;
    container.register({
      name: "tokens",
      dependencies: ["tokenManager", "fsService", "gitServer"],
      async start(resolve) {
        const fsService = resolve<import("@natstack/shared/fsService").FsService>("fsService")!;
        const liveGitServer = resolve<import("@natstack/git-server").GitServer>("gitServer")!;
        tokensDefinition = createTokensService({ tokenManager, fsService, gitServer: liveGitServer });
      },
      getServiceDefinition() {
        if (!tokensDefinition) throw new Error("tokens service not initialized");
        return tokensDefinition;
      },
    });
  }
  container.register(rpcService(createGitService({ gitServer, tokenManager, workspacePath }), ["gitServer"]));
  container.register(rpcService(createTestService({ contextFolderManager, workspacePath, panelTestSetupPath })));
  {
    const { createWorkerLogService } = await import("./services/workerLogService.js");
    container.register(rpcService(createWorkerLogService()));
  }
  container.register(rpcService(createDbService({ databaseManager }), ["databaseManager"]));
  container.register(rpcService(createTypecheckService({ contextFolderManager })));
  container.register(rpcService(createEventsServiceDefinition(eventService)));

  // ── Notification service ──
  const { createNotificationService } = await import("./services/notificationService.js");
  const notificationResult = createNotificationService({ eventService });
  const notificationInternal = notificationResult.internal;
  container.register(rpcService(notificationResult.definition));

  // ── Secrets service (API keys with user consent) ──
  {
    const { createSecretsService } = await import("./services/secretsService.js");
    let panelRegistry: import("@natstack/shared/panelRegistry").PanelRegistry | undefined;
    try { panelRegistry = container.get<import("@natstack/shared/panelRegistry").PanelRegistry>("panelRegistry"); } catch { /* not available */ }
    container.register(rpcService(createSecretsService({
      notificationService: notificationInternal,
      panelRegistry,
    })));
  }

  // ── OAuth service (works in both Electron and standalone modes) ──
  {
    const { OAuthManager } = await import("@natstack/shared/oauth/oauthManager");
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
        let panelRegistry: import("@natstack/shared/panelRegistry").PanelRegistry | undefined;
        try { panelRegistry = container.get<import("@natstack/shared/panelRegistry").PanelRegistry>("panelRegistry"); } catch { /* not available in Electron mode */ }

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
      // In IPC mode, panels now connect to the server WS, so the server's
      // RpcServer needs a panelManager for panel-to-panel RPC auth.
      // We'll wire it lazily after panelService starts.
      const server = new RpcServer({ tokenManager, dispatcher });
      if (ipcChannel) {
        // IPC mode: server binds its own socket (Electron connects directly)
        await server.start();
      } else {
        // Standalone mode: gateway owns the socket, dispatches to us
        server.initHandlers();
      }
      // Port is a live getter so downstream consumers see updates after gateway starts
      return { server, get port() { return server.getPort() ?? 0; } };
    },
    async stop(instance: { server: import("./rpcServer.js").RpcServer; port: number }) {
      await instance?.server?.stop();
    },
  });

  // ── Workers RPC service ──

  {
    let workerServiceDef: import("@natstack/shared/serviceDefinition").ServiceDefinition;
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

  // ===========================================================================
  // Shared services needed in both standalone and Electron modes
  // ===========================================================================

  // Filesystem service (used internally by workerdManager; in Electron mode
  // the main process has its OWN FsService for panel-facing FS RPC)
  {
    const { FsService } = await import("@natstack/shared/fsService");
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
        const { server: rpcSrvForWorkerd } = resolve<{ server: import("./rpcServer.js").RpcServer }>("rpcServer")!;
        const fsServiceInst = resolve<import("@natstack/shared/fsService").FsService>("fsService")!;

        workerdManagerInstance = new WorkerdManager({
          tokenManager,
          fsService: fsServiceInst,
          getRpcPort: () => rpcSrvForWorkerd.getPort() ?? 0,
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
            if (!node.manifest.durable) continue;
            for (const cls of node.manifest.durable.classes) {
              doClasses.push({ source: node.relativePath, className: cls.className });
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
  // Panel services, workspace info, PanelHttpServer, FS RPC
  // (extracted to panelRuntimeRegistration.ts)
  // ===========================================================================

  // Resolve host configuration from CLI args / env vars
  const { resolveHostConfig } = await import("@natstack/shared/hostConfig");
  const hostConfig = resolveHostConfig({
    rpcPort: 0, panelHttpPort: 0, gitPort: gitServer.getPort(), workerdPort: 0, // ports filled later
    host: args.host, bindHost: args.bindHost, protocol: args.protocol,
    tlsCert: args.tlsCert, tlsKey: args.tlsKey,
  });

  const { registerPanelServices } = await import("./panelRuntimeRegistration.js");
  // Workspace relaunch is only meaningful when running under Electron's
  // utility-process supervisor (IPC mode); in standalone mode there's no
  // app to relaunch, so workspace.select becomes a no-op (the caller has
  // to reconnect manually).
  const requestRelaunch: ((name: string) => void) | undefined = ipcChannel
    ? (name: string) => ipcChannel.postMessage({ type: "workspace-relaunch", name })
    : undefined;
  // In IPC mode, the workspace catalog lives in Electron main. Proxy list()
  // requests through IPC so the server returns the real catalog, not [].
  const requestWorkspaceList: (() => Promise<unknown[]>) | undefined = ipcChannel
    ? async () => {
        const resp = await ipcRequest<{ workspaces: unknown[] }>("workspace-list-request");
        return resp?.workspaces ?? [];
      }
    : undefined;
  const commonDeps = { container, dispatcher, tokenManager, workspace, workspacePath, workspaceConfig, gitServer, adminToken, centralData: centralData ?? null, args, hostConfig, isIpcMode: !!ipcChannel, eventService, requestRelaunch, requestWorkspaceList };
  await registerPanelServices(commonDeps);

  {
    const { createMetaService } = await import("./services/metaService.js");
    const { panelRuntimeSurface } = await import("../../workspace/packages/runtime/src/shared/runtimeSurface.panel.js");
    const { workerRuntimeSurface } = await import("../../workspace/packages/runtime/src/shared/runtimeSurface.worker.js");
    container.register(rpcService(createMetaService({
      dispatcher,
      runtimeSurfaces: {
        panel: panelRuntimeSurface,
        workerRuntime: workerRuntimeSurface,
      },
    })));
  }

  // ── Auth service (AI provider tokens: OAuth + env-var fallback) ──
  // Construct AuthServiceImpl once with an openBrowser dep wired to
  // Electron's shell.openExternal in IPC mode (via parent-port message,
  // matching the existing `workspace-relaunch` pattern) or console.log
  // in standalone mode. The server opens the OAuth browser itself so the
  // panel UI never sees the auth URL.
  {
    const { AuthServiceImpl, createAuthService } = await import("./services/authService.js");
    const openBrowser: (url: string) => void = ipcChannel
      ? (url: string) => ipcChannel.postMessage({ type: "open-external", url })
      : (url: string) => console.log("Open URL:", url);
    const authService = new AuthServiceImpl({ openBrowser });
    container.register(rpcService(createAuthService({ authService })));
  }

  if (!ipcChannel) {
    // Settings service for remote/mobile shells.
    const { createSettingsServiceStandalone } = await import("./services/settingsServiceStandalone.js");
    const { rpcService: rpcSvc } = await import("@natstack/shared/managedService");
    container.register(rpcSvc(createSettingsServiceStandalone({ dispatcher })));

    // Push notification service for mobile device registration.
    const { createPushService } = await import("./services/pushService.js");
    container.register(rpcSvc(createPushService()));
  }

  // ── W1k: image service (server-side resize/convert via photon WASM) ──
  // Placed at the end of the registration block to minimize merge conflicts
  // with parallel tracks editing the auth/AI sections above.
  {
    const { createImageService } = await import("./services/imageService.js");
    container.register(rpcService(createImageService()));
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
    // Services that live on both Electron and server, are internal lifecycle only,
    // or are standalone-mode-only (not present in IPC/Electron mode)
    const localOnly = new Set(["events", "browser", "panel", "settings", "push"]);
    for (const name of dispatcher.getServices()) {
      if (!sharedSet.has(name) && !localOnly.has(name)) {
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
  const panelHttpPort = container.has("panelHttpServer")
    ? container.get<{ port: number }>("panelHttpServer").port
    : null;

  if (ipcChannel) {
    ipcChannel.postMessage({
      type: "ready",
      rpcPort,
      gitPort: gitServer.getPort(),
      pubsubPort: 0, // deprecated — channel DOs replace PubSub server
      workerdPort: workerdMgr?.getPort() ?? 0,
      panelHttpPort: panelHttpPort ?? 0,
      adminToken,
    });
  } else {
    // Start gateway in standalone mode — in-process routing for RPC + panels
    const { Gateway } = await import("./gateway.js");
    const panelHttpServer = container.has("panelHttpServer")
      ? container.get<{ server: import("./panelHttpServer.js").PanelHttpServer }>("panelHttpServer")?.server
      : null;

    const gateway = new Gateway({
      rpcHandler: rpcServerInstance,
      panelHttpHandler: panelHttpServer ?? undefined,
      gitPort: gitServer.getPort(),
      workerdPort: workerdMgr?.getPort() ?? null,
      externalHost: hostConfig.externalHost,
      bindHost: hostConfig.bindHost,
      tlsCert: hostConfig.tlsCert,
      tlsKey: hostConfig.tlsKey,
    });
    const gatewayPort = await gateway.start(0);

    // Back-propagate gateway port: all services that read rpcServer.getPort()
    // now see the gateway port instead of 0.
    rpcServerInstance.setPort(gatewayPort);

    // Update panel-facing URLs to route through the gateway
    const panelServiceData = container.get<{ urlConfig: import("./services/panelService.js").PanelUrlConfig }>("panelService");
    if (panelServiceData?.urlConfig) {
      panelServiceData.urlConfig.finalizeForGateway(gatewayPort);
    }

    // Restart workerd so DO/worker bindings pick up the real gateway port.
    // The initial startup ran with getRpcPort() === 0 because the gateway
    // hadn't bound yet. This restart regenerates the config with the real port.
    if (workerdMgr) {
      await workerdMgr.restartAll();
    }

    // Register for browser extension auto-discovery (idempotent file writes)
    const { registerHeadlessService } = await import("./headlessServiceRegistration.js");
    try {
      registerHeadlessService(statePath, {
        rpcPort: gatewayPort, // In standalone mode, RPC is served via /rpc on the gateway
        panelPort: panelHttpPort,
        gitPort: gitServer.getPort(),
        adminToken,
        gatewayPort,
      });
    } catch (err) {
      console.warn("[Server] Failed to register headless service:", err);
    }

    // Write admin token to a well-known file for scripting
    const tokenFilePath = path.join(statePath, "admin-token");
    try {
      fs.writeFileSync(tokenFilePath, adminToken, { mode: 0o600 });
    } catch (err) {
      console.warn("[Server] Failed to write admin token file:", err);
    }

    const isTls = !!(hostConfig.tlsCert && hostConfig.tlsKey);
    const proto = isTls ? "https" : "http";
    const wsProto = isTls ? "wss" : "ws";
    console.log("natstack-server ready:");
    console.log(`  Gateway:     ${proto}://${hostConfig.externalHost}:${gatewayPort}`);
    console.log(`  Git:         (via gateway /_git/)`);
    console.log(`  Workerd:     (via gateway /_w/)`);
    console.log(`  RPC:         ${wsProto}://${hostConfig.externalHost}:${gatewayPort}/rpc`);
    if (panelHttpPort) {
      console.log(`  Panels:      ${proto}://${hostConfig.externalHost}:${panelHttpPort}`);
    }
    console.log(`  Admin token: ${adminToken}`);
    console.log(`  Token file:  ${tokenFilePath}`);
    // Mint a shell token for mobile/remote shell clients.
    // Shell tokens give callerKind "shell" (not "server"), which is the correct
    // privilege level for browser chrome operations.
    const shellToken = tokenManager.ensureToken("remote-shell", "shell");
    console.log(`  Shell token: ${shellToken}`);

    if (args.printToken) {
      // Machine-readable token output on its own line for scripting
      console.log(`\nNATSTACK_ADMIN_TOKEN=${adminToken}`);
    }
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
