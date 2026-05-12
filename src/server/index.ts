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
import { getPublicUrl } from "./publicUrl.js";
// __filename is available natively in CJS and via the esbuild banner shim in ESM.
declare const __filename: string;

// =============================================================================
// IPC channel detection (synchronous — must run before main())
// =============================================================================

interface IpcChannel {
  postMessage(msg: unknown): void;
  on(event: string, handler: (msg: unknown) => void): void;
}

interface ElectronParentPort {
  postMessage(msg: unknown): void;
  on(event: "message", handler: (envelope: unknown) => void): void;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function detectServerIpcChannel(): IpcChannel | null {
  // Electron utilityProcess: process.parentPort exists
  const parentPort = (process as NodeJS.Process & { parentPort?: ElectronParentPort }).parentPort;
  if (parentPort) {
    return {
      postMessage: (msg: unknown) => parentPort.postMessage(msg),
      on: (_event: string, handler: (msg: unknown) => void) => {
        parentPort.on("message", (envelope: unknown) => {
          const record = asRecord(envelope);
          handler(record && "data" in record ? record["data"] : envelope);
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
  ipcChannel.on("message", (msg: unknown) => {
    const record = asRecord(msg);
    const id = typeof record?.["id"] === "string" ? record["id"] : null;
    if (id && pendingIpcResponses.has(id)) {
      pendingIpcResponses.get(id)!(msg);
      pendingIpcResponses.delete(id);
    }
  });
}

/**
 * Send a typed request to the parent process and await a correlated response.
 * Returns null if no IPC channel or if the parent doesn't respond within 5s.
 */
function ipcRequest<T = unknown>(
  type: string,
  payload?: Record<string, unknown>,
  timeoutMs: number = 5_000
): Promise<T | null> {
  if (!ipcChannel) return Promise.resolve(null);
  const id = randomBytes(8).toString("hex");
  return new Promise<T | null>((resolve) => {
    const timeout = setTimeout(() => {
      pendingIpcResponses.delete(id);
      resolve(null);
    }, timeoutMs);
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
  readyFile?: string;
  ephemeral?: boolean;
  servePanels?: boolean;
  gatewayPort?: number;
  panelPort?: number;
  init?: boolean;
  host?: string;
  bindHost?: string;
  protocol?: "http" | "https";
  tlsCert?: string;
  tlsKey?: string;
  printCredentials?: boolean;
  publicUrl?: string;
  noVpnDetect?: boolean;
  help?: boolean;
}

function printHelp(): void {
  console.log(`
natstack-server — Headless and standalone NatStack server

Usage:
  node dist/server.mjs [options]

Options:
  --workspace <name>       Workspace name to resolve (default: last-opened or "default")
  --workspace-dir <path>   Explicit workspace directory path
  --app-root <path>        Application root directory (default: cwd)
  --ready-file <path>      Write structured readiness JSON to this file
  --ephemeral              Use a disposable dev workspace (deleted on shutdown)
  --host <hostname>        External hostname (also sets bind to 0.0.0.0)
  --bind-host <addr>       Explicit bind address (default: 127.0.0.1, or 0.0.0.0 with --host)
  --protocol <http|https>  Protocol for panel-facing URLs (default: http)
  --tls-cert <path>        TLS certificate file (PEM). Enables HTTPS when used with --tls-key.
  --tls-key <path>         TLS private key file (PEM). Required when --tls-cert is provided.
  --serve-panels           Enable panel HTTP serving
  --gateway-port <port>    Port for the gateway HTTP/WS ingress (default: auto-assigned)
  --panel-port <port>      Port for panel HTTP (default: auto-assigned)
  --init                   Auto-create workspace from template if it doesn't exist
  --log-level <level>      Log verbosity
  --print-credentials      Print NATSTACK_ADMIN_TOKEN and NATSTACK_PAIRING_CODE for scripting
  --public-url <url>       Externally-reachable base URL (e.g. https://server.lan:3000).
                           Used for OAuth redirect URIs, webhooks, and any route that
                           needs to be reached from the user's browser. Falls back to
                           constructing a URL from --protocol/--host/<gatewayPort>.
                           When set, OAuth flows default to redirecting through this
                           URL — register <public-url>/_r/s/credentials/oauth/callback
                           with each OAuth provider as the allowed redirect URI.
  --no-vpn-detect          Skip auto-detection and auto-configuration of the VPN-based
                           public URL (Tailscale today). Useful if you manage
                           tailscale serve yourself or use --public-url.
  --help                   Show this help message and exit

Environment variables:
  NATSTACK_ADMIN_TOKEN     Use a stable admin token instead of generating a random one
  NATSTACK_HOST            External hostname (same as --host)
  NATSTACK_BIND_HOST       Explicit bind address (same as --bind-host)
  NATSTACK_PROTOCOL        Protocol for panel URLs (same as --protocol)
  NATSTACK_GATEWAY_PORT    Gateway ingress port (same as --gateway-port)
  NATSTACK_WORKSPACE       Workspace name (same as --workspace)
  NATSTACK_WORKSPACE_DIR   Workspace directory (same as --workspace-dir)
  NATSTACK_APP_ROOT        Application root (same as --app-root)
  NATSTACK_LOG_LEVEL       Log verbosity (same as --log-level)
  NATSTACK_PUBLIC_URL      External base URL (same as --public-url)

Remote Electron connection:
  To connect an Electron frontend to this server, set these env vars before
  launching the Electron app:
    NATSTACK_REMOTE_URL=https://<host>:<gateway-port>
    NATSTACK_REMOTE_TOKEN=<admin-token>
`);
}

function parsePort(value: string | undefined, label: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error(`${label} must be an integer from 1 to 65535`);
    process.exit(1);
  }
  return port;
}

function parseEnvPort(name: string): number | undefined {
  const value = process.env[name];
  if (value == null || value === "") return undefined;
  return parsePort(value, name);
}

function printReadinessActionBlock(title: string, lines: string[]): void {
  const divider = "=".repeat(72);
  console.log("");
  console.log(divider);
  console.log(`  ACTION NEEDED — ${title}`);
  console.log(divider);
  for (const line of lines) {
    console.log(line ? `  ${line}` : "");
  }
  console.log(`${divider}\n`);
}

async function waitForPublicUrlReachable(
  probe: (url: string) => Promise<{ ok: boolean; reason?: string }>,
  url: string,
  timeoutMs = 12_000,
  intervalMs = 1_000
): Promise<{ ok: boolean; reason?: string }> {
  const deadline = Date.now() + timeoutMs;
  let lastResult: { ok: boolean; reason?: string } = { ok: false, reason: "not checked yet" };
  while (true) {
    lastResult = await probe(url).catch((error) => ({
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
    }));
    if (lastResult.ok) return lastResult;
    if (Date.now() >= deadline) return lastResult;
    await new Promise((resolve) => setTimeout(resolve, Math.min(intervalMs, Math.max(0, deadline - Date.now()))));
  }
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {};
  const known = new Set([
    "workspace",
    "workspace-dir",
    "app-root",
    "ready-file",
    "ephemeral",
    "log-level",
    "serve-panels",
    "gateway-port",
    "panel-port",
    "init",
    "host",
    "bind-host",
    "protocol",
    "tls-cert",
    "tls-key",
    "print-credentials",
    "public-url",
    "no-vpn-detect",
    "help",
  ]);
  /** Flags that don't take a value */
  const booleanFlags = new Set([
    "serve-panels",
    "ephemeral",
    "init",
    "print-credentials",
    "no-vpn-detect",
    "help",
  ]);

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
      case "ready-file":
        args.readyFile = value;
        break;
      case "log-level":
        args.logLevel = value;
        break;
      case "serve-panels":
        args.servePanels = true;
        break;
      case "ephemeral":
        args.ephemeral = true;
        break;
      case "init":
        args.init = true;
        break;
      case "gateway-port":
        args.gatewayPort = parsePort(value, "--gateway-port");
        break;
      case "panel-port":
        args.panelPort = parsePort(value, "--panel-port");
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
      case "print-credentials":
        args.printCredentials = true;
        break;
      case "public-url":
        args.publicUrl = value;
        break;
      case "no-vpn-detect":
        args.noVpnDetect = true;
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
  process.env["NATSTACK_APP_ROOT"] =
    args.appRoot ?? process.env["NATSTACK_APP_ROOT"] ?? process.cwd();
  if (args.logLevel) process.env["NATSTACK_LOG_LEVEL"] = args.logLevel;
} else {
  // IPC mode: env vars already set by parent via fork({ env: {...} })
}

// =============================================================================
// Phase B: Async main — load app modules, initialize services
// =============================================================================

async function main() {
  const { getUserDataPath, setUserDataPath } = await import("@natstack/env-paths");
  const {
    loadCentralEnv,
    deleteWorkspaceDir,
    loadPersistedAdminToken,
    savePersistedAdminToken,
    getAdminTokenPath,
  } = await import("@natstack/shared/workspace/loader");
  const { resolveLocalWorkspaceStartup } = await import("@natstack/shared/workspace/startup");
  const { CentralDataManager } = await import("@natstack/shared/centralData");
  const { GitServer } = await import("@natstack/git-server");
  const { TokenManager } = await import("@natstack/shared/tokenManager");
  const { ServiceDispatcher } = await import("@natstack/shared/serviceDispatcher");
  const { EventService, createEventsServiceDefinition } =
    await import("@natstack/shared/eventsService");
  const { getExistingAppNodeModulesRoots } = await import("@natstack/shared/runtimePaths");
  const { assertGitAvailable } = await import("@natstack/shared/gitRuntime");
  const eventService = new EventService();
  const { RpcServer } = await import("./rpcServer.js");
  const { ServiceContainer } = await import("@natstack/shared/serviceContainer");
  const { rpcService } = await import("@natstack/shared/managedService");
  const { initBuildSystemV2 } = await import("./buildV2/index.js");

  loadCentralEnv();

  // ===========================================================================
  // Workspace resolution
  // ===========================================================================
  // Shared resolution via resolveLocalWorkspaceStartup():
  //   --workspace-dir <path>   → explicit managed workspace root
  //   --workspace <name>       → resolve by name via getWorkspaceDir()
  //   NATSTACK_WORKSPACE_DIR   → env var (set by Electron parent or user)
  //   (none, standalone)       → last-opened from central data, or "default"
  //
  // With --init: auto-create from template if workspace doesn't exist.

  const appRoot = process.env["NATSTACK_APP_ROOT"] ?? process.cwd();
  assertGitAvailable();
  const centralData = !ipcChannel ? new CentralDataManager() : null;

  const wsDir = args.workspaceDir ?? process.env["NATSTACK_WORKSPACE_DIR"];
  const wsName = args.workspaceName ?? process.env["NATSTACK_WORKSPACE"];

  let workspace: import("@natstack/shared/workspace/types").Workspace;
  let workspaceName: string;
  let workspaceIsEphemeral = false;
  try {
    const startup = resolveLocalWorkspaceStartup({
      appRoot,
      centralData,
      wsDir,
      name: wsName,
      init: args.init,
      isDev: !!args.ephemeral,
      requireExplicitSelection: !!ipcChannel,
    });
    workspace = startup.resolved.workspace;
    workspaceName = startup.resolved.name;
    workspaceIsEphemeral =
      startup.isEphemeral || process.env["NATSTACK_WORKSPACE_EPHEMERAL"] === "1";
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

  const appNodeModules = getExistingAppNodeModulesRoots(appRoot);
  if (appNodeModules.length === 0) {
    console.warn("[Server] Could not find app node_modules — panel builds may fail");
  }

  // ===========================================================================
  // Service initialization
  // ===========================================================================

  const tokenManager = new TokenManager();
  const serverBootId = `boot_${randomBytes(18).toString("base64url")}`;
  const { DeviceAuthStore } = await import("./services/deviceAuthStore.js");
  const deviceAuthStore = new DeviceAuthStore(path.join(statePath, "auth", "devices.json"));
  const startupPairingCode = !ipcChannel ? deviceAuthStore.createPairingCode() : null;

  try {
    const { recoverPersistedPanelTokens, installPanelTokenPersistence } =
      await import("./persistedPanelTokens.js");
    const summary = recoverPersistedPanelTokens(tokenManager, statePath);
    installPanelTokenPersistence(tokenManager, statePath);
    if (summary.recovered > 0 || summary.errors > 0) {
      console.log(
        `[Server] Recovered ${summary.recovered} persisted panel token(s)` +
          (summary.errors > 0 ? ` (${summary.errors} unreadable)` : ""),
      );
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[Server] Panel token recovery unavailable: ${msg}`);
  }

  // Re-seed TokenManager from persisted DO state so DOs that wake from a
  // restart-survived alarm don't 401 with a token issued by a previous
  // server lifetime. See recoverPersistedDOTokens.ts for the rationale.
  // Best-effort: if `node:sqlite` is unavailable (Node < 22.5) the recovery
  // skips silently and the system falls back to pre-fix behavior.
  try {
    const { recoverPersistedDOTokens } = await import("./recoverPersistedDOTokens.js");
    const summary = recoverPersistedDOTokens(tokenManager, statePath);
    if (summary.recovered > 0 || summary.errors > 0) {
      console.log(
        `[Server] Recovered ${summary.recovered} persisted DO token(s)` +
          (summary.errors > 0 ? ` (${summary.errors} unreadable)` : ""),
      );
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[Server] DO token recovery unavailable: ${msg}`);
  }

  const workerdGatewayToken = randomBytes(32).toString("hex");
  const { CredentialStore } = await import("../../packages/shared/src/credentials/store.js");
  const { ClientConfigStore } =
    await import("../../packages/shared/src/credentials/clientConfigStore.js");
  const { AuditLog } = await import("../../packages/shared/src/credentials/audit.js");
  const { CodeIdentityResolver } = await import("./services/codeIdentityResolver.js");
  const { createEgressProxy } = await import("./services/egressProxy.js");
  const { CredentialLifecycle } = await import("./services/credentialLifecycle.js");
  const { CredentialSessionGrantStore } = await import("./services/credentialSessionGrants.js");

  const credentialStore = new CredentialStore();
  const clientConfigStore = new ClientConfigStore();
  const auditLog = new AuditLog({ logDir: path.join(statePath, "credentials-audit") });
  const codeIdentityResolver = new CodeIdentityResolver();
  const credentialSessionGrantStore = new CredentialSessionGrantStore();
  const { CapabilityGrantStore } = await import("./services/capabilityGrantStore.js");
  const capabilityGrantStore = new CapabilityGrantStore({ statePath });
  const { UserlandApprovalGrantStore } = await import("./services/userlandApprovalGrantStore.js");
  const userlandApprovalGrantStore = new UserlandApprovalGrantStore({ statePath });
  const { createApprovalQueue } = await import("./services/approvalQueue.js");
  const approvalQueue = createApprovalQueue({ eventService });
  const credentialLifecycle = new CredentialLifecycle({
    credentialStore,
    clientConfigStore,
  });

  const egressProxy = createEgressProxy({
    credentialStore,
    auditLog,
    codeIdentityResolver,
    approvalQueue,
    sessionGrantStore: credentialSessionGrantStore,
    credentialLifecycle,
  });
  const egressProxyPort = await egressProxy.start();

  // In pnpm dev mode, the app runs from a throwaway workspace copied from
  // `<appRoot>/workspace`. Mirror accepted pushes back to that template so
  // edits made in the generated workspace persist into the source checkout.
  const templateDir = path.join(appRoot, "workspace");
  const isPnpmDevMode = process.env["NODE_ENV"] === "development";
  const hasDevTemplate = fs.existsSync(path.join(templateDir, "meta", "natstack.yml"));
  const templateDiffersFromActive =
    templateDir !== workspacePath && !workspacePath.startsWith(templateDir + path.sep);
  const devTargetDir =
    isPnpmDevMode && workspaceIsEphemeral && hasDevTemplate && templateDiffersFromActive
      ? templateDir
      : undefined;
  const requestedGatewayPort = args.gatewayPort ?? parseEnvPort("NATSTACK_GATEWAY_PORT");
  const configuredProtocol = (process.env["NATSTACK_PROTOCOL"] ?? args.protocol ?? "http") as
    | "http"
    | "https";
  const configuredExternalHost = process.env["NATSTACK_HOST"] ?? args.host ?? "localhost";

  const { createGitWriteAuthorizer } = await import("./services/gitWritePermission.js");
  const { WORKSPACE_GIT_INIT_PATTERNS } = await import("@natstack/shared/workspace/sourceDirs");
  const gitServer = new GitServer({
    reposPath: workspacePath,
    initPatterns: [...WORKSPACE_GIT_INIT_PATTERNS],
    devTargetDir,
    getSourceForCaller: (callerId) =>
      codeIdentityResolver.resolveByCallerId(callerId)?.repoPath ?? null,
    getAllowedOrigins: () => {
      const port = gatewayPortResolved ?? requestedGatewayPort ?? 0;
      const origins = new Set<string>();
      if (port) {
        origins.add(`http://127.0.0.1:${port}`);
        origins.add(`http://localhost:${port}`);
        origins.add(`https://127.0.0.1:${port}`);
        origins.add(`https://localhost:${port}`);
        origins.add(`${configuredProtocol}://${configuredExternalHost}:${port}`);
      }
      // Picks up both explicit --public-url and the auto-detected VPN URL,
      // since both flow into configurePublicUrl().
      try {
        origins.add(new URL(getPublicUrl()).origin);
      } catch {
        // configurePublicUrl not yet called or value invalid — ignore.
      }
      return Array.from(origins);
    },
    writeAuthorizer: createGitWriteAuthorizer({
      approvalQueue,
      grantStore: capabilityGrantStore,
      codeIdentityResolver,
    }),
  });

  // Create ContextFolderManager before core services
  const { ContextFolderManager } = await import("@natstack/shared/contextFolderManager");
  const contextFolderManager = new ContextFolderManager({
    sourcePath: workspacePath,
    contextsRoot: path.join(statePath, ".contexts"),
    getWorkspaceTree: () => gitServer.getWorkspaceTree(),
    getWorkspaceConfig: () => workspaceConfig,
  });

  const { syncDeclaredRemoteForRepo } = await import("@natstack/shared/workspace/remotes");
  const { loadWorkspaceConfig } = await import("@natstack/shared/workspace/loader");
  const syncDeclaredRemotesForSource = async (repoPath?: string): Promise<void> => {
    const repos = repoPath
      ? [repoPath]
      : collectWorkspaceRepoPaths((await gitServer.getWorkspaceTree()).children);
    await Promise.all(
      repos.map((repo) =>
        syncDeclaredRemoteForRepo({
          config: workspaceConfig,
          workspaceRoot: workspacePath,
          repoPath: repo,
        }).catch((err: unknown) => {
          console.warn(`[GitRemotes] Failed to sync declared remote for ${repo}:`, err);
        })
      )
    );
  };
  gitServer.onPush((event) => {
    if (event.repo !== "meta") {
      queueMicrotask(() => {
        syncDeclaredRemotesForSource(event.repo)
          .then(() => contextFolderManager.syncDeclaredRemotes(event.repo))
          .catch((err: unknown) =>
            console.warn(
              `[GitRemotes] Failed to sync declared remote after push to ${event.repo}:`,
              err
            )
          );
      });
      return;
    }
    queueMicrotask(() => {
      try {
        const nextConfig = loadWorkspaceConfig(workspacePath);
        replaceWorkspaceConfig(workspaceConfig, nextConfig);
        syncDeclaredRemotesForSource()
          .then(() => contextFolderManager.syncDeclaredRemotes())
          .catch((err: unknown) =>
            console.warn("[GitRemotes] Failed to sync declared remotes after meta push:", err)
          );
      } catch (err) {
        console.warn("[GitRemotes] Failed to reload workspace config after meta push:", err);
      }
    });
  });

  // ===========================================================================
  // Unified ServiceContainer — lifecycle + RPC services in one container
  // ===========================================================================

  const dispatcher = new ServiceDispatcher();
  const container = new ServiceContainer(dispatcher);

  // Route registry — shared across workerdManager (registers manifest-declared
  // worker routes) and the gateway (dispatches `/_r/` requests). Constructed
  // early so both consumers can wire it without awaiting other services.
  const { RouteRegistry } = await import("./routeRegistry.js");
  const routeRegistry = new RouteRegistry();

  // ── Lifecycle services ──

  // Foundation: pre-created instances wrapped for container participation
  container.register({
    name: "tokenManager",
    async start() {
      return tokenManager;
    },
  });
  container.register({
    name: "gitServer",
    async start() {
      await gitServer.init();
      await syncDeclaredRemotesForSource();
      return gitServer;
    },
  });

  // Build system
  container.register({
    name: "buildSystem",
    async start() {
      return await initBuildSystemV2(
        workspacePath,
        gitServer,
        appNodeModules.length > 0 ? appNodeModules : [path.join(appRoot, "node_modules")]
      );
    },
    async stop(instance: import("./buildV2/index.js").BuildSystemV2) {
      await instance?.shutdown();
    },
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
    async stop(instance: import("@natstack/shared/workspace/gitWatcher").GitWatcher) {
      await instance?.close();
    },
  });

  // ── RPC-only services (replacing serverServiceRegistry.ts) ──

  const { createBuildService } = await import("./services/buildService.js");
  const { createWorkerdService } = await import("./services/workerdService.js");
  const { createTokensService } = await import("./services/tokensService.js");
  const { createGitService } = await import("./services/gitService.js");
  const { createTestService } = await import("./services/testService.js");
  const { createTypecheckService } = await import("./services/typecheckService.js");
  const { createWorkerService } = await import("./services/workerService.js");

  // Resolve testSetup.ts relative to this module's location
  const serverDir = path.dirname(__filename);
  const setupCandidates = [
    path.resolve(serverDir, "../main/services/testSetup.ts"),
    path.resolve(serverDir, "../src/main/services/testSetup.ts"),
  ];
  const panelTestSetupPath: string =
    setupCandidates.find((p) => fs.existsSync(p)) ?? setupCandidates[0]!;

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
    let tokensDefinition: import("@natstack/shared/serviceDefinition").ServiceDefinition | null =
      null;
    container.register({
      name: "tokens",
      dependencies: ["tokenManager", "fsService"],
      async start(resolve) {
        const fsService = resolve<import("@natstack/shared/fsService").FsService>("fsService")!;
        // Only persist the admin token centrally in standalone mode. In
        // IPC/Electron-embedded mode the token is consumed by the parent
        // process from the ready message, and writing it into the shared
        // central config would leak into other workspaces.
        const persistAdminToken = !ipcChannel
          ? (token: string) => savePersistedAdminToken(token)
          : undefined;
        tokensDefinition = createTokensService({
          tokenManager,
          fsService,
          codeIdentityResolver,
          getEffectiveVersion: async (source: string) => {
            const buildSystem =
              container.get<import("./buildV2/index.js").BuildSystemV2>("buildSystem");
            return buildSystem?.getEffectiveVersion(source) ?? undefined;
          },
          persistAdminToken,
        });
      },
      getServiceDefinition() {
        if (!tokensDefinition) throw new Error("tokens service not initialized");
        return tokensDefinition;
      },
    });
  }
  container.register(
    rpcService(
      createGitService({
        gitServer,
        tokenManager,
        workspacePath,
        workspaceConfig,
        contextFolderManager,
        egressProxy,
        approvalQueue,
        grantStore: capabilityGrantStore,
        codeIdentityResolver,
      }),
      ["gitServer"]
    )
  );
  container.register(
    rpcService(createTestService({ contextFolderManager, workspacePath, panelTestSetupPath }))
  );
  {
    const { createWorkerLogService } = await import("./services/workerLogService.js");
    container.register(rpcService(createWorkerLogService()));
  }
  container.register(rpcService(createTypecheckService({ contextFolderManager })));
  container.register(rpcService(createEventsServiceDefinition(eventService)));

  // ── Approval-gated host capabilities ──
  {
    const { createExternalOpenService } = await import("./services/externalOpenService.js");
    container.register(
      rpcService(
        createExternalOpenService({
          eventService,
          approvalQueue,
          grantStore: capabilityGrantStore,
          codeIdentityResolver,
        })
      )
    );
  }

  // ── Notification service ──
  const { createNotificationService } = await import("./services/notificationService.js");
  const notificationResult = createNotificationService({ eventService });
  container.register(rpcService(notificationResult.definition));

  // ── Push + shell presence services ──
  {
    const { createPushService } = await import("./services/pushService.js");
    const pushResult = createPushService();
    container.register({
      name: "push",
      start: async () => pushResult,
      getServiceDefinition: () => pushResult.definition,
    });
  }
  {
    const { createShellPresenceService } = await import("./services/shellPresenceService.js");
    const shellPresenceResult = createShellPresenceService();
    container.register({
      name: "shellPresence",
      start: async () => shellPresenceResult,
      getServiceDefinition: () => shellPresenceResult.definition,
    });
  }
  {
    const { createApprovalPushBridge } = await import("./services/approvalPushBridge.js");
    container.register({
      name: "approvalPushBridge",
      dependencies: ["push", "shellPresence"],
      start: async (resolve) => {
        const push = resolve<import("./services/pushService.js").PushServiceResult>("push")!;
        const shellPresence =
          resolve<import("./services/shellPresenceService.js").ShellPresenceServiceResult>(
            "shellPresence",
          )!;
        return createApprovalPushBridge({
          approvalQueue,
          push: push.internal,
          shellPresence: shellPresence.internal,
        });
      },
      stop: async (bridge: import("./services/approvalPushBridge.js").ApprovalPushBridge) => {
        bridge.stop();
      },
    });
  }

  // ── Shell approval service (consent bar queue) ──
  const { createShellApprovalService } = await import("./services/shellApprovalService.js");
  container.register(rpcService(createShellApprovalService({ approvalQueue })));
  const { createUserlandApprovalService } = await import("./services/userlandApprovalService.js");
  container.register(
    rpcService(
      createUserlandApprovalService({
        approvalQueue,
        grantStore: userlandApprovalGrantStore,
        codeIdentityResolver,
      })
    )
  );

  // ── Credential service ──
  {
    const { createCredentialService } = await import("./services/credentialService.js");
    const { rpcServiceWithRoutes } = await import("./rpcServiceWithRoutes.js");
    const captureSessionCredential = async <T extends Record<string, unknown>>(
      payload: Record<string, unknown>
    ): Promise<T> => {
      const response = await ipcRequest<T & { error?: unknown }>(
        "credential-session-capture-request",
        payload,
        300_000
      );
      if (!response) {
        throw new Error("Session credential capture timed out or is unavailable");
      }
      if (response.error) {
        throw new Error(String(response.error));
      }
      return response;
    };
    const credentialService = createCredentialService({
      credentialStore,
      clientConfigStore,
      auditLog,
      eventService,
      tokenManager,
      egressProxy,
      codeIdentityResolver,
      approvalQueue,
      sessionGrantStore: credentialSessionGrantStore,
      credentialLifecycle,
      sessionCredentialCapture: {
        captureCookies: async (params) => {
          const response = await captureSessionCredential<{
            cookieHeader?: string;
            cookieSession?: {
              origins?: unknown;
              cookies?: unknown;
            };
            expiresAt?: number;
            accountIdentity?: Record<string, string>;
          }>({
            kind: "cookies",
            signInUrl: params.signInUrl,
            origins: params.origins,
            cookieNames: params.cookieNames,
            completionUrlPattern: params.completionUrlPattern,
            maxTtlSeconds: params.maxTtlSeconds,
            browser: params.browser,
          });
          if (!response.cookieHeader) {
            throw new Error("Session credential capture returned no cookies");
          }
          return {
            cookieHeader: response.cookieHeader,
            cookieSession: response.cookieSession as never,
            expiresAt: response.expiresAt,
            accountIdentity: response.accountIdentity,
          };
        },
        captureSamlSession: async (params) => {
          const response = await captureSessionCredential<{
            cookieHeader?: string;
            cookieSession?: {
              origins?: unknown;
              cookies?: unknown;
            };
            assertion?: string;
            expiresAt?: number;
            accountIdentity?: Record<string, string>;
          }>({
            kind: "saml",
            signInUrl: params.signInUrl,
            spAudience: params.spAudience,
            cookieNames: params.cookieNames,
            assertion: params.assertion,
            completionUrlPattern: params.completionUrlPattern,
            maxTtlSeconds: params.maxTtlSeconds,
            browser: params.browser,
          });
          return {
            cookieHeader: response.cookieHeader,
            cookieSession: response.cookieSession as never,
            assertion: response.assertion,
            expiresAt: response.expiresAt,
            accountIdentity: response.accountIdentity,
          };
        },
      },
    }) as ReturnType<typeof createCredentialService> & {
      routes?: import("./routeRegistry.js").ServiceRouteDecl[];
    };
    container.register(
      rpcServiceWithRoutes(
        {
          definition: credentialService,
          routes: credentialService.routes,
        },
        routeRegistry
      )
    );
  }

  // ── DODispatch (source-scoped HTTP dispatch to Durable Objects) ──

  container.register({
    name: "doDispatch",
    dependencies: ["workerdManager"],
    async start(resolve) {
      const { DODispatch } = await import("./doDispatch.js");
      const doDispatch = new DODispatch();

      // Dispatch DO method calls via HTTP POST to the workerd /_w/ URL scheme.
      const workerdManager =
        resolve<import("./workerdManager.js").WorkerdManager>("workerdManager")!;
      doDispatch.setDispatcher(async (urlPath, args) => {
        const port = workerdManager.getPort();
        if (!port) {
          throw new Error(`workerd not running — cannot dispatch to ${urlPath}`);
        }
        const url = `http://127.0.0.1:${port}${urlPath}`;
        const resp = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${workerdGatewayToken}`,
            // Internal DO dispatches stamp the process-private secret. The
            // router verifies this when present, but public gateway-routed DO
            // routes intentionally do not require it.
            "X-NatStack-Dispatch-Secret": workerdManager.getDispatchSecret(),
          },
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
      doDispatch.setBeforeDispatch(async (ref) => {
        let identity = workerdManager.getDoCodeIdentity(ref.source, ref.className);
        if (!identity) {
          await workerdManager.ensureDOClass(ref.source, ref.className);
          identity = workerdManager.getDoCodeIdentity(ref.source, ref.className);
        }
        if (!identity) {
          return;
        }
        codeIdentityResolver.upsertCallerIdentity({
          callerId: `do:${ref.source}:${ref.className}:${ref.objectKey}`,
          callerKind: "worker",
          repoPath: identity.repoPath,
          effectiveVersion: identity.effectiveVersion,
        });
      });
      doDispatch.setGetWorkerdUrl(() => {
        const port = workerdManager.getPort();
        if (!port) {
          throw new Error("workerd not running — cannot build workerd URL");
        }
        return `http://127.0.0.1:${port}`;
      });
      // SECURITY (audit 4.8): stamp every postToDOWithToken-based dispatch
      // with the dispatch secret. See WorkerdManager.dispatchSecret for the
      // full rationale.
      doDispatch.setGetDispatchSecret(() => workerdManager.getDispatchSecret());
      doDispatch.setGetWorkerdGatewayToken(() => workerdGatewayToken);

      return doDispatch;
    },
  });

  // ── Internal DO-backed services ──
  {
    const { createScopeService } = await import("./services/scopeService.js");
    let scopeDefinition: import("@natstack/shared/serviceDefinition").ServiceDefinition | null =
      null;
    container.register({
      name: "scope",
      dependencies: ["doDispatch"],
      async start(resolve) {
        const doDispatch = resolve<import("./doDispatch.js").DODispatch>("doDispatch")!;
        scopeDefinition = createScopeService({ doDispatch });
      },
      getServiceDefinition() {
        if (!scopeDefinition) throw new Error("scope service not initialized");
        return scopeDefinition;
      },
    });
  }

  {
    const { createPanelPersistenceService } = await import("./services/panelPersistenceService.js");
    let panelPersistenceDefinition:
      | import("@natstack/shared/serviceDefinition").ServiceDefinition
      | null = null;
    container.register({
      name: "panel-persistence",
      dependencies: ["doDispatch"],
      async start(resolve) {
        const doDispatch = resolve<import("./doDispatch.js").DODispatch>("doDispatch")!;
        panelPersistenceDefinition = createPanelPersistenceService({
          doDispatch,
          workspaceId: workspace.config.id,
        });
      },
      getServiceDefinition() {
        if (!panelPersistenceDefinition)
          throw new Error("panel-persistence service not initialized");
        return panelPersistenceDefinition;
      },
    });
  }

  {
    const { createBrowserDataService } = await import("./services/browserDataService.js");
    let browserDataDefinition:
      | import("@natstack/shared/serviceDefinition").ServiceDefinition
      | null = null;
    container.register({
      name: "browser-data",
      dependencies: ["doDispatch"],
      async start(resolve) {
        const doDispatch = resolve<import("./doDispatch.js").DODispatch>("doDispatch")!;
        browserDataDefinition = createBrowserDataService({ doDispatch, eventService });
      },
      getServiceDefinition() {
        if (!browserDataDefinition) throw new Error("browser-data service not initialized");
        return browserDataDefinition;
      },
    });
  }

  // ── Generic public webhook ingress ──
  {
    const { createWebhookIngressService } = await import("./services/webhookIngressService.js");
    let webhookIngress: ReturnType<typeof createWebhookIngressService> | null = null;
    container.register({
      name: "webhookIngress",
      dependencies: ["doDispatch"],
      async start(resolve) {
        const doDispatch = resolve<import("./doDispatch.js").DODispatch>("doDispatch")!;
        webhookIngress = createWebhookIngressService({
          relaySigningSecret: process.env["NATSTACK_RELAY_SIGNING_SECRET"],
          publicBaseUrl: process.env["NATSTACK_WEBHOOK_PUBLIC_URL"] ?? "https://hooks.snugenv.com",
          doDispatch,
          codeIdentityResolver,
          dispatchToTarget: async (target, event) => {
            await doDispatch.dispatch(
              {
                source: target.source,
                className: target.className,
                objectKey: target.objectKey,
              },
              target.method,
              event
            );
          },
        });
        if (webhookIngress.routes.length > 0) {
          routeRegistry.registerService(webhookIngress.routes);
        }
        return webhookIngress;
      },
      async stop() {
        routeRegistry.unregisterService("webhookIngress");
      },
      getServiceDefinition() {
        if (!webhookIngress) throw new Error("webhookIngress service not initialized");
        return webhookIngress.definition;
      },
    });
  }

  // ── gad provenance store ──
  {
    const { createGadService } = await import("./services/gadService.js");
    const { resolveUserlandService, toDORef } = await import("./userlandServices.js");
    let gadDefinition: import("@natstack/shared/serviceDefinition").ServiceDefinition | null = null;
    container.register({
      name: "gad",
      dependencies: ["doDispatch", "buildSystem"],
      async start(resolve) {
        const doDispatch = resolve<import("./doDispatch.js").DODispatch>("doDispatch")!;
        const buildSystem = resolve<import("./buildV2/index.js").BuildSystemV2>("buildSystem")!;
        gadDefinition = createGadService({
          doDispatch,
          resolveStore: () => toDORef(resolveUserlandService(buildSystem, "natstack.gad.workspace.v1")),
          approvalQueue,
          grantStore: userlandApprovalGrantStore,
          codeIdentityResolver,
        });
      },
      getServiceDefinition() {
        if (!gadDefinition) throw new Error("gad service not initialized");
        return gadDefinition;
      },
    });
  }

  // Admin token resolution (first hit wins):
  //   1. NATSTACK_ADMIN_TOKEN env var (always overrides)
  //   2. Persisted token at ~/.config/natstack/admin-token (survives restarts)
  //   3. Generate a random one and persist it so remote clients can save it
  //
  // In IPC mode (Electron-embedded) we skip persistence: the Electron parent
  // process consumes the token directly via the "ready" message, and writing
  // a token for one workspace into the shared central config would leak into
  // other workspaces.
  let adminToken: string;
  let tokenSource: "env" | "persisted" | "generated" = "generated";
  if (process.env["NATSTACK_ADMIN_TOKEN"]) {
    adminToken = process.env["NATSTACK_ADMIN_TOKEN"]!;
    tokenSource = "env";
  } else if (!ipcChannel) {
    const persisted = loadPersistedAdminToken();
    if (persisted) {
      adminToken = persisted;
      tokenSource = "persisted";
    } else {
      adminToken = randomBytes(32).toString("hex");
      try {
        savePersistedAdminToken(adminToken);
      } catch (err) {
        console.warn(`[Server] Failed to persist admin token at ${getAdminTokenPath()}:`, err);
      }
    }
  } else {
    adminToken = randomBytes(32).toString("hex");
  }
  tokenManager.setAdminToken(adminToken);
  let gatewayPortResolved: number | null = null;

  // ── RPC server (always present) ──
  let rpcServerForGateway: import("./rpcServer.js").RpcServer | null = null;

  container.register({
    name: "rpcServer",
    dependencies: ["tokenManager"],
    async start() {
      const server = new RpcServer({ tokenManager, dispatcher, eventService });
      server.initHandlers();
      rpcServerForGateway = server;
      return { server };
    },
    async stop(instance: { server: import("./rpcServer.js").RpcServer }) {
      await instance?.server?.stop();
    },
  });

  // ── Workers RPC service ──

  {
    let workerServiceDef: import("@natstack/shared/serviceDefinition").ServiceDefinition;
    container.register({
      name: "workersRpc",
      dependencies: ["doDispatch", "buildSystem", "fsService"],
      async start(resolve) {
        const doDispatch = resolve<import("./doDispatch.js").DODispatch>("doDispatch")!;
        const buildSystemInst = resolve<import("./buildV2/index.js").BuildSystemV2>("buildSystem")!;
        const fsServiceInst = resolve<import("@natstack/shared/fsService").FsService>("fsService")!;
        workerServiceDef = createWorkerService({
          doDispatch,
          buildSystem: buildSystemInst,
          fsService: fsServiceInst,
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
  //
  // Workers POST back through the gateway. The gateway starts before
  // container.startAll(), so this URL is stable by the time workerd boots.
  let workerdManagerForGateway: import("./workerdManager.js").WorkerdManager | null = null;
  {
    let workerdManagerInstance: import("./workerdManager.js").WorkerdManager | null = null;
    let buildSystemForWorkerd: import("./buildV2/index.js").BuildSystemV2 | null = null;
    container.register({
      name: "workerdManager",
      dependencies: ["buildSystem", "fsService"],
      async start(resolve) {
        const { WorkerdManager } = await import("./workerdManager.js");
        buildSystemForWorkerd = resolve<import("./buildV2/index.js").BuildSystemV2>("buildSystem")!;
        const fsServiceInst = resolve<import("@natstack/shared/fsService").FsService>("fsService")!;

        workerdManagerInstance = new WorkerdManager({
          tokenManager,
          fsService: fsServiceInst,
          getServerUrl: () => {
            if (!gatewayPortResolved) {
              throw new Error("Gateway port not finalized before workerd startup");
            }
            return `http://127.0.0.1:${gatewayPortResolved}`;
          },
          getBuild: (unitPath, ref) => buildSystemForWorkerd!.getBuild(unitPath, ref),
          workspacePath,
          statePath,
          routeRegistry,
          getManifestRoutes: (source) => {
            const node = buildSystemForWorkerd
              ?.getGraph()
              .allNodes()
              .find((n) => n.relativePath === source);
            const manifest = node?.manifest as
              | import("@natstack/shared/types").PackageManifest
              | undefined;
            return manifest?.routes ?? [];
          },
          getProxyPort: () => egressProxyPort,
          getWorkerdGatewayToken: () => workerdGatewayToken,
          codeIdentityResolver,
        });
        workerdManagerForGateway = workerdManagerInstance;

        // Wire push trigger to restart workers on source rebuild.
        //
        // Always pass an explicit array (possibly empty) so onSourceRebuilt
        // can reconcile removals: if a manifest edit DROPS a DO class, the
        // array reflects that absence and the stale DO service gets torn
        // down. Passing `undefined` would leave stale services bound forever.
        buildSystemForWorkerd.onPushBuild((source) => {
          const node = buildSystemForWorkerd
            ?.getGraph()
            .allNodes()
            .find((n) => n.relativePath === source);
          const manifest = node?.manifest as Record<string, unknown> | undefined;
          const durable = manifest?.["durable"] as
            | { classes?: Array<{ className: string }> }
            | undefined;
          const doClasses = durable?.classes ?? [];

          workerdManagerInstance?.onSourceRebuilt(source, doClasses).catch((err) => {
            console.error(`[WorkerdManager] Failed to handle rebuilt source ${source}:`, err);
          });
        });

        // Pre-register all DO classes from the build graph so they're available
        // before any panel connects or agent subscribes. Single workerd restart.
        {
          const { INTERNAL_DO_CLASSES, INTERNAL_DO_SOURCE } =
            await import("./internalDOs/internalDoLoader.js");
          const graph = buildSystemForWorkerd.getGraph();
          const doClasses: Array<{ source: string; className: string }> = [];
          for (const className of INTERNAL_DO_CLASSES) {
            doClasses.push({ source: INTERNAL_DO_SOURCE, className });
          }
          for (const node of graph.allNodes()) {
            if (node.kind !== "worker") continue;
            if (!node.manifest.durable) continue;
            for (const cls of node.manifest.durable.classes) {
              doClasses.push({ source: node.relativePath, className: cls.className });
            }
          }
          if (doClasses.length > 0) {
            console.log(
              `[WorkerdManager] Pre-registering DO classes:`,
              doClasses.map((c) => `${c.source}:${c.className}`).join(", ")
            );
            await workerdManagerInstance.registerAllDOClasses(doClasses);
          }
        }

        return workerdManagerInstance;
      },
      async stop(instance: import("./workerdManager.js").WorkerdManager | null) {
        await instance?.shutdown();
      },
      getServiceDefinition() {
        if (!workerdManagerInstance || !buildSystemForWorkerd) {
          throw new Error("workerd service not initialized");
        }
        return createWorkerdService({
          workerdManager: workerdManagerInstance,
          buildSystem: buildSystemForWorkerd,
        });
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
    workerdPort: 0, // ports filled later
    gatewayPort: requestedGatewayPort ?? 0,
    host: args.host,
    bindHost: args.bindHost,
    protocol: args.protocol,
    tlsCert: args.tlsCert,
    tlsKey: args.tlsKey,
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
  const commonDeps = {
    container,
    dispatcher,
    tokenManager,
    workspace,
    workspacePath,
    workspaceConfig,
    gitServer,
    adminToken,
    centralData: centralData ?? null,
    args,
    hostConfig,
    isIpcMode: !!ipcChannel,
    eventService,
    requestRelaunch,
    requestWorkspaceList,
    codeIdentityResolver,
    getEffectiveVersion: async (source: string) => {
      const buildSystem = container.get<import("./buildV2/index.js").BuildSystemV2>("buildSystem");
      return buildSystem?.getEffectiveVersion(source) ?? undefined;
    },
  };
  await registerPanelServices(commonDeps);

  {
    const { createMetaService } = await import("./services/metaService.js");
    const { panelRuntimeSurface } =
      await import("../../workspace/packages/runtime/src/shared/runtimeSurface.panel.js");
    const { workerRuntimeSurface } =
      await import("../../workspace/packages/runtime/src/shared/runtimeSurface.worker.js");
    container.register(
      rpcService(
        createMetaService({
          dispatcher,
          runtimeSurfaces: {
            panel: panelRuntimeSurface,
            workerRuntime: workerRuntimeSurface,
          },
        })
      )
    );
  }

  if (!ipcChannel) {
    // Settings service for remote/mobile shells.
    const { createSettingsServiceStandalone } =
      await import("./services/settingsServiceStandalone.js");
    container.register(rpcService(createSettingsServiceStandalone({ dispatcher })));
  }

  // ── W1k: image service (server-side resize/convert via photon WASM) ──
  // Placed at the end of the registration block to minimize merge conflicts
  // with parallel tracks editing the auth/AI sections above.
  {
    const { createImageService } = await import("./services/imageService.js");
    container.register(rpcService(createImageService()));
  }

  // ── Per-workspace content-addressable blobstore ──
  {
    const { createBlobstoreService } = await import("./services/blobstoreService.js");
    const { createAuthService } = await import("./services/authService.js");
    const { rpcServiceWithRoutes } = await import("./rpcServiceWithRoutes.js");
    container.register(rpcServiceWithRoutes(createAuthService({
      tokenManager,
      deviceAuthStore,
      getServerBootId: () => serverBootId,
      getWorkspaceId: () => workspace.config.id,
    }), routeRegistry));

    const blobsDir = path.join(getUserDataPath(), "blobs");
    container.register(rpcServiceWithRoutes(createBlobstoreService({ blobsDir }), routeRegistry));
  }

  // ── Gateway ingress ──
  //
  // Start the only caller-facing socket before service startup. Handlers are
  // attached dynamically as container services start.
  const { Gateway } = await import("./gateway.js");
  const startedAt = Date.now();
  const isTlsInitial = !!(hostConfig.tlsCert && hostConfig.tlsKey);
  const gateway = new Gateway({
    getRpcHandler: () => rpcServerForGateway,
    getPanelHttpHandler: () => {
      if (!container.has("panelHttpServer")) return null;
      return container.get<{ server: import("./panelHttpServer.js").PanelHttpServer }>(
        "panelHttpServer"
      ).server;
    },
    getGitHandler: () => gitServer,
    getWorkerdPort: () => workerdManagerForGateway?.getPort() ?? null,
    externalHost: hostConfig.externalHost,
    bindHost: hostConfig.bindHost,
    tlsCert: hostConfig.tlsCert,
    tlsKey: hostConfig.tlsKey,
    adminToken,
    workerdGatewayToken,
    tokenManager,
    routeRegistry,
    getPublicUrl: () => {
      try {
        return getPublicUrl();
      } catch {
        return null;
      }
    },
    healthProvider: (detailed) => {
      const base: Record<string, unknown> = {
        ok: true,
        protocol: isTlsInitial ? "https" : "http",
        serverId: deviceAuthStore.getServerId(),
        serverBootId,
        workspaceId: workspace.config.id,
      };
      if (!detailed) return base;
      return {
        ...base,
        version: "0.1.0",
        uptimeMs: Date.now() - startedAt,
        workerd: workerdManagerForGateway?.getPort() ? "running" : "stopped",
        tokenSource,
      };
    },
  });
  const gatewayPort = await gateway.start(requestedGatewayPort ?? 0);
  gatewayPortResolved = gatewayPort;

  // ── Public URL: explicit input now, auto-detection in parallel below ──
  // The explicit --public-url path runs synchronously; auto-detection runs
  // concurrently with service startup so we don't block on it.
  interface VpnSetupResult {
    detectedVpn: import("./vpnDetect.js").DetectedVpnPublicUrl | null;
    serveProvision: import("./tailscaleServe.js").ServeProvisionResult | null;
    publicUrlVerified: boolean;
    publicUrlReachabilityReason?: string;
  }
  const explicitOverride = args.publicUrl ?? process.env["NATSTACK_PUBLIC_URL"];
  const skipVpnDetect =
    args.noVpnDetect
    || process.env["NATSTACK_NO_VPN_DETECT"] === "1"
    || !!explicitOverride;
  const { configurePublicUrl, markPublicUrlVerified } = await import("./publicUrl.js");
  configurePublicUrl({
    override: explicitOverride,
    protocol: isTlsInitial ? "https" : "http",
    externalHost: hostConfig.externalHost,
    gatewayPort,
  });
  // Explicit URLs are trusted up-front. Auto-detected URLs (if any) get
  // verified in the parallel block below and update this state then.
  markPublicUrlVerified(!!explicitOverride);

  const vpnSetupPromise: Promise<VpnSetupResult> = skipVpnDetect
    ? Promise.resolve({ detectedVpn: null, serveProvision: null, publicUrlVerified: false })
    : (async (): Promise<VpnSetupResult> => {
      const { detectVpnPublicUrl } = await import("./vpnDetect.js");
      const detectedVpn = await detectVpnPublicUrl().catch(() => null);
      if (!detectedVpn) {
        return { detectedVpn: null, serveProvision: null, publicUrlVerified: false };
      }
      const { probeHttpsReachable, ensureHttpsServe } = await import("./tailscaleServe.js");
      let reachability = await probeHttpsReachable(detectedVpn.url).catch((error) => ({
        ok: false,
        reason: error instanceof Error ? error.message : String(error),
      }));
      let publicUrlVerified = reachability.ok;
      let serveProvision: import("./tailscaleServe.js").ServeProvisionResult | null = null;
      if (!publicUrlVerified && detectedVpn.vendor === "tailscale") {
        serveProvision = await ensureHttpsServe({
          port: gatewayPort,
          hostname: detectedVpn.hostname,
        }).catch((err) => ({
          kind: "error",
          message: err instanceof Error ? err.message : String(err),
        } as import("./tailscaleServe.js").ServeProvisionResult));
        if (serveProvision.kind === "configured" || serveProvision.kind === "already-configured") {
          reachability = await waitForPublicUrlReachable(
            (url) => probeHttpsReachable(url),
            detectedVpn.url
          );
          publicUrlVerified = reachability.ok;
        }
      }
      configurePublicUrl({
        override: detectedVpn.url,
        protocol: isTlsInitial ? "https" : "http",
        externalHost: hostConfig.externalHost,
        gatewayPort,
      });
      markPublicUrlVerified(publicUrlVerified);
      return {
        detectedVpn,
        serveProvision,
        publicUrlVerified,
        publicUrlReachabilityReason: reachability.ok ? undefined : reachability.reason,
      };
    })();

  // ── Start all services in dependency order ──
  await container.startAll();
  // Settle VPN setup before printing the readiness banner (so the operator
  // sees the auto-detected Mobile URL line if one is available).
  const { detectedVpn, serveProvision, publicUrlVerified, publicUrlReachabilityReason } = await vpnSetupPromise;

  // Wire DODispatch to workerdManager for restart recovery
  const workerdManager =
    container.get<import("./workerdManager.js").WorkerdManager>("workerdManager");
  const doDispatchInst = container.get<import("./doDispatch.js").DODispatch>("doDispatch");

  doDispatchInst.setEnsureDO((source, className, objectKey) =>
    workerdManager.ensureDO(source, className, objectKey)
  );

  // Wire workerdUrl into rpcServer for HTTP relay to workers/DOs
  const rpcServerInstance = container.get<{
    server: import("./rpcServer.js").RpcServer;
    port: number;
  }>("rpcServer").server;
  const workerdPort = workerdManager.getPort();
  if (workerdPort) {
    rpcServerInstance.setWorkerdUrl(`http://127.0.0.1:${workerdPort}`);
  }
  rpcServerInstance.setWorkerdGatewayToken(workerdGatewayToken);

  const panelServiceData = container.get<{
    urlConfig: import("./services/panelService.js").PanelUrlConfig;
  }>("panelService");
  panelServiceData?.urlConfig?.finalizeForGateway(gatewayPort);

  dispatcher.markInitialized();

  // ===========================================================================
  // Report ready
  // ===========================================================================

  const workerdMgr = container.get<import("./workerdManager.js").WorkerdManager>("workerdManager");

  if (ipcChannel) {
    const shellToken = tokenManager.ensureToken("electron-main", "shell");
    ipcChannel.postMessage({
      type: "ready",
      workerdPort: workerdMgr?.getPort() ?? 0,
      gatewayPort,
      adminToken,
      shellToken,
    });
  } else {
    // Register for browser extension auto-discovery (idempotent file writes)
    const { registerHeadlessService } = await import("./headlessServiceRegistration.js");
    try {
      registerHeadlessService(statePath, {
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
    console.log(`  Workspace:   ${workspaceName}${workspaceIsEphemeral ? " (ephemeral dev)" : ""}`);
    console.log(`  Gateway:     ${proto}://${hostConfig.externalHost}:${gatewayPort}`);
    console.log(`  Git:         (via gateway /_git/)`);
    console.log(`  Workerd:     (via gateway /_w/)`);
    console.log(`  RPC:         ${wsProto}://${hostConfig.externalHost}:${gatewayPort}/rpc`);
    const sourceLabel =
      tokenSource === "env"
        ? " (from NATSTACK_ADMIN_TOKEN)"
        : tokenSource === "persisted"
          ? " (persisted)"
          : " (newly generated)";
    console.log(`  Token file:  ${tokenFilePath}${sourceLabel}`);
    if (tokenSource !== "env") {
      console.log(`  Persisted:   ${getAdminTokenPath()}`);
    }
    {
      const explicitPublicUrl = args.publicUrl ?? process.env["NATSTACK_PUBLIC_URL"];
      const publicUrlForBanner = explicitPublicUrl ?? detectedVpn?.url;
      if (publicUrlForBanner) {
        const publicUrlLabel = explicitPublicUrl
          ? "(--public-url)"
          : detectedVpn
            ? `(auto-detected ${detectedVpn.vendor})`
            : "";
        const reachabilityLabel = publicUrlVerified
          ? "verified reachable"
          : "not yet reachable — see note below";
        console.log(`  Public URL:  ${publicUrlForBanner} ${publicUrlLabel} (${reachabilityLabel})`);
        if (publicUrlVerified) {
          // Single canonical URL for QR pairing, panel chrome, and OAuth.
          // mobile-pair prefers this line over Gateway: when present.
          console.log(`  Mobile URL:  ${publicUrlForBanner}`);
        }
        console.log(`  OAuth callback (register with each provider):`);
        console.log(`    ${publicUrlForBanner}/_r/s/credentials/oauth/callback`);
        if (serveProvision?.kind === "configured") {
          if (publicUrlVerified) {
            console.log(`  Tailscale: configured \`tailscale serve\` to forward https://${detectedVpn?.hostname}/ → 127.0.0.1:${gatewayPort}.`);
            console.log(`             Persistent across reboots; remove with \`tailscale serve reset\`.`);
          } else {
            printReadinessActionBlock("Tailscale Serve is configured but not reachable", [
              "Tailscale accepted the Serve configuration, but the HTTPS URL",
              "did not return NatStack's health check.",
              "",
              `Public URL: https://${detectedVpn?.hostname}`,
              publicUrlReachabilityReason ? `Last check: ${publicUrlReachabilityReason}` : "",
              "",
              "This can be a short Tailscale startup delay, a stale Serve target,",
              "or a local gateway that is not listening on the configured port.",
              "",
              "First try rerunning:",
              "  pnpm mobile:pair",
              "",
              "If it still falls back to HTTP, check both:",
              "  tailscale serve status",
              `  curl http://127.0.0.1:${gatewayPort}/healthz`,
            ]);
          }
        } else if (serveProvision?.kind === "permission-denied") {
          printReadinessActionBlock("Tailscale Serve needs permission", [
            "NatStack found your Tailscale HTTPS name:",
            `  https://${detectedVpn?.hostname}`,
            "",
            "That URL will only work after Tailscale is told to forward HTTPS",
            `traffic to this NatStack server on local port ${gatewayPort}. NatStack tried`,
            "to configure that automatically, but Tailscale denied permission.",
            "",
            "Recommended one-time fix:",
            "  sudo tailscale set --operator=$USER",
            "Then restart your terminal/session if Tailscale asks, and run:",
            "  pnpm mobile:pair",
            "",
            "Manual alternative for this port only:",
            `  sudo tailscale serve --bg ${gatewayPort}`,
            "Then run:",
            "  pnpm mobile:pair",
            "",
            "Until this is fixed, the QR below uses a Tailscale HTTP fallback.",
            "Basic pairing may work, but mobile OAuth/browser redirects need HTTPS.",
          ]);
        } else if (serveProvision?.kind === "https-feature-disabled") {
          printReadinessActionBlock("Tailscale HTTPS certificates are not enabled", [
            "NatStack found your Tailscale name, but this tailnet is not allowed",
            "to issue HTTPS certificates for MagicDNS names yet.",
            "",
            "Enable HTTPS Certificates here:",
            "  https://login.tailscale.com/admin/dns",
            "Then run:",
            "  pnpm mobile:pair",
            "",
            "Until this is fixed, the QR below uses a Tailscale HTTP fallback.",
            "Basic pairing may work, but mobile OAuth/browser redirects need HTTPS.",
          ]);
        } else if (serveProvision?.kind === "serve-feature-disabled") {
          printReadinessActionBlock("Tailscale Serve is not enabled", [
            "NatStack found your Tailscale HTTPS name, but Tailscale Serve is",
            "not enabled for this tailnet. Serve is the Tailscale feature that",
            "forwards that HTTPS name to this NatStack server.",
            "",
            "Enable Tailscale Serve:",
            serveProvision.activationUrl
              ? `  ${serveProvision.activationUrl}`
              : "  Open the Tailscale admin console -> Settings -> Serve.",
            "",
            "Then run:",
            "  pnpm mobile:pair",
            "",
            "Until this is fixed, the QR below uses a Tailscale HTTP fallback.",
            "Basic pairing may work, but mobile OAuth/browser redirects need HTTPS.",
          ]);
        } else if (serveProvision?.kind === "skipped-conflict") {
          printReadinessActionBlock("Existing Tailscale Serve config conflicts", [
            "Tailscale Serve is already configured for something else, and",
            "NatStack will not overwrite that automatically.",
            "",
            serveProvision.reason,
            "",
            "If you want NatStack to manage this hostname, run:",
            "  tailscale serve reset",
            "",
            "Then run:",
            "  pnpm mobile:pair",
          ]);
        } else if (serveProvision?.kind === "error") {
          printReadinessActionBlock("Tailscale Serve setup failed", [
            "NatStack found a Tailscale HTTPS name, but could not configure",
            "Tailscale Serve for it.",
            "",
            `Tailscale error: ${serveProvision.message}`,
            "",
            "The QR below will use the HTTP fallback.",
            "Basic pairing may work, but mobile OAuth/browser redirects need HTTPS.",
            "",
            "Fix Tailscale Serve, then run:",
            "  pnpm mobile:pair",
          ]);
        } else if (!publicUrlVerified && !explicitPublicUrl && detectedVpn?.setupHint) {
          printReadinessActionBlock("HTTPS mobile URL is not ready", [
            "NatStack found a likely mobile HTTPS URL, but it is not reachable yet.",
            publicUrlReachabilityReason ? `Last check: ${publicUrlReachabilityReason}` : "",
            "",
            detectedVpn.setupHint,
            "",
            "The QR below will use the HTTP fallback.",
            "Basic pairing may work, but mobile OAuth/browser redirects need HTTPS.",
          ]);
        }
      }
    }
    if (startupPairingCode) {
      console.log(`  Pairing code: ${startupPairingCode}`);
    }

    if (args.readyFile) {
      const readyPayload = {
        workspaceName,
        workspaceId: workspace.config.id,
        workspaceDir: workspacePath,
        isEphemeral: workspaceIsEphemeral,
        gatewayUrl: `${proto}://${hostConfig.externalHost}:${gatewayPort}`,
        rpcUrl: `${wsProto}://${hostConfig.externalHost}:${gatewayPort}/rpc`,
        gitUrl: `${proto}://${hostConfig.externalHost}:${gatewayPort}/_git/`,
        workerdUrl: `${proto}://${hostConfig.externalHost}:${gatewayPort}/_w/`,
        adminToken,
        pairingCode: startupPairingCode,
        serverId: deviceAuthStore.getServerId(),
        serverBootId,
        tokenFilePath,
        gatewayPort,
        workerdPort: workerdMgr?.getPort() ?? 0,
      };
      try {
        fs.mkdirSync(path.dirname(args.readyFile), { recursive: true });
        fs.writeFileSync(args.readyFile, `${JSON.stringify(readyPayload, null, 2)}\n`, "utf8");
      } catch (error) {
        console.warn("[Server] Failed to write ready file:", error);
      }
    }

    if (args.printCredentials) {
      console.log(`\nNATSTACK_ADMIN_TOKEN=${adminToken}`);
      if (startupPairingCode) console.log(`NATSTACK_PAIRING_CODE=${startupPairingCode}`);
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

    await container
      .stopAll()
      .then(() => console.log("[Server] All services stopped"))
      .catch((e) => console.error("[Server] Service shutdown error:", e))
      .finally(() => {
        if (!ipcChannel && workspaceIsEphemeral && centralData) {
          try {
            deleteWorkspaceDir(workspaceName);
            centralData.removeWorkspace(workspaceName);
            console.log(`[Server] Deleted ephemeral workspace "${workspaceName}"`);
          } catch (error) {
            console.error("[Server] Failed to delete ephemeral workspace:", error);
          }
        }
        clearTimeout(forceExit);
        console.log("[Server] Shutdown complete");
        process.exit(0);
      });
  }

  if (ipcChannel) {
    ipcChannel.on("message", (msg: unknown) => {
      const record = asRecord(msg);
      if (record?.["type"] === "shutdown") void shutdown();
    });
  } else {
    process.on("SIGTERM", () => void shutdown());
    process.on("SIGINT", () => void shutdown());
  }
}

function collectWorkspaceRepoPaths(
  nodes: Array<{ path: string; isGitRepo: boolean; children: unknown[] }>
): string[] {
  const repos: string[] = [];
  for (const node of nodes) {
    if (node.isGitRepo) repos.push(node.path);
    repos.push(
      ...collectWorkspaceRepoPaths(
        node.children as Array<{ path: string; isGitRepo: boolean; children: unknown[] }>
      )
    );
  }
  return repos;
}

function replaceWorkspaceConfig<T extends object>(target: T, next: T): void {
  const mutableTarget = target as Record<string, unknown>;
  for (const key of Object.keys(mutableTarget)) {
    delete mutableTarget[key];
  }
  Object.assign(target, next);
}

main().catch((err) => {
  if (ipcChannel) {
    ipcChannel.postMessage({ type: "error", message: String(err) });
  }
  console.error("Fatal:", err);
  process.exit(1);
});
