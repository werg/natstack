/**
 * natstack-server — Headless and IPC entry point for NatStack.
 *
 * Starts all headless-capable services (Build V2, Git, workspace services, RPC).
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
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "crypto";
import { canonicalEntityId, type EntityRecord } from "@natstack/shared/runtime/entitySpec";
import { normalizeUnitRepoPath } from "@natstack/unit-host";
import { formatPairUrlLine } from "./pairingBanner.js";
import { getPublicUrl, isPublicUrlVerified } from "./publicUrl.js";
import { registerBuildProvider, unregisterBuildProvider } from "./buildV2/buildProviderRegistry.js";
import { RuntimeDiagnosticsStore } from "./runtimeDiagnosticsStore.js";
import { assertPresent, deleteDynamicProperty } from "../lintHelpers";
import { resolveHeadlessHostAutospawn } from "./headlessHostAutospawn.js";

// __filename is available natively in CJS and via the esbuild banner shim in ESM.
declare const __filename: string;

// =============================================================================
// IPC channel detection (synchronous — must run before main())
// =============================================================================

interface IpcChannel {
  postMessage(msg: unknown): void;
  on(event: string, handler: (msg: unknown) => void): void;
  onDisconnect(handler: () => void): void;
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
      onDisconnect: (handler: () => void) => {
        (
          parentPort as unknown as {
            on(event: "close", handler: () => void): void;
          }
        ).on("close", handler);
        process.on("disconnect", handler);
      },
    };
  }
  // Node.js fork: process.send exists
  if (typeof process.send === "function") {
    return {
      postMessage: (msg: unknown) => assertPresent(process.send)(msg),
      on: (_event: string, handler: (msg: unknown) => void) => {
        process.on("message", handler);
      },
      onDisconnect: (handler: () => void) => {
        process.on("disconnect", handler);
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
      assertPresent(pendingIpcResponses.get(id))(msg);
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
  timeoutMs: number = 5_000,
  signal?: AbortSignal
): Promise<T | null> {
  if (!ipcChannel) return Promise.resolve(null);
  if (signal?.aborted) return Promise.resolve(null);
  const id = randomBytes(8).toString("hex");
  return new Promise<T | null>((resolve) => {
    let settled = false;
    const finish = (value: T | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      pendingIpcResponses.delete(id);
      resolve(value);
    };
    const onAbort = () => finish(null);
    const timeout = setTimeout(() => {
      finish(null);
    }, timeoutMs);
    pendingIpcResponses.set(id, (response: unknown) => {
      finish(response as T);
    });
    signal?.addEventListener("abort", onAbort, { once: true });
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
  requirePublicUrl?: boolean;
  requireMobileReady?: boolean;
  requireElectronReady?: boolean;
  noVpnDetect?: boolean;
  headlessHostAutospawn?: boolean;
  help?: boolean;
}

function printHelp(): void {
  console.log(`
natstack-server — Headless and standalone NatStack server

Usage:
  natstack-server [options]
  pnpm server:live [options]
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
  --require-public-url     Fail startup unless the advertised public URL is verified reachable.
  --require-mobile-ready   Fail startup unless the workspace React Native app can be
                           built and served to native mobile clients.
  --require-electron-ready Fail startup unless the workspace Electron shell app can be
                           built and served to desktop clients.
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
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(intervalMs, Math.max(0, deadline - Date.now())))
    );
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
    "require-public-url",
    "require-mobile-ready",
    "require-electron-ready",
    "no-vpn-detect",
    "headless-host-autospawn",
    "help",
  ]);
  /** Flags that don't take a value */
  const booleanFlags = new Set([
    "serve-panels",
    "ephemeral",
    "init",
    "print-credentials",
    "require-public-url",
    "require-mobile-ready",
    "require-electron-ready",
    "no-vpn-detect",
    "headless-host-autospawn",
    "help",
  ]);

  for (let i = 0; i < argv.length; i++) {
    const arg = assertPresent(argv[i]);
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
      case "require-public-url":
        args.requirePublicUrl = true;
        break;
      case "require-mobile-ready":
        args.requireMobileReady = true;
        break;
      case "headless-host-autospawn":
        args.headlessHostAutospawn = value !== "off" && value !== "0" && value !== "false";
        break;
      case "require-electron-ready":
        args.requireElectronReady = true;
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
  const { loadCentralEnv, deleteWorkspaceDir } = await import("@natstack/shared/workspace/loader");
  const { loadPersistedAdminToken, savePersistedAdminToken, getAdminTokenPath } =
    await import("@natstack/shared/centralAuth");
  const { resolveLocalWorkspaceStartup } = await import("@natstack/shared/workspace/startup");
  const { CentralDataManager } = await import("@natstack/shared/centralData");
  const { TokenManager } = await import("@natstack/shared/tokenManager");
  const { ServiceDispatcher } = await import("@natstack/shared/serviceDispatcher");
  const { EventService, createEventsServiceDefinition } =
    await import("@natstack/shared/eventsService");
  const { getExistingAppNodeModulesRoots } = await import("@natstack/shared/runtimePaths");
  const eventService = new EventService();
  const { RpcServer } = await import("./rpcServer.js");
  const { ServiceContainer } = await import("@natstack/shared/serviceContainer");
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

  // Parse workspace declarations (singletonObjects + services + routes).
  // Validation (every DO-backed service/route has a matching singleton row)
  // runs eagerly here — bad workspaces fail fast at startup with a clear msg.
  const { buildWorkspaceDeclarations } =
    await import("@natstack/shared/workspace/singletonRegistry");
  const workspaceDecls = buildWorkspaceDeclarations(workspaceConfig);
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
  const { EntityCache } = await import("@natstack/shared/runtime/entityCache");
  const { ConnectionGrantService } = await import("@natstack/shared/connectionGrants");
  const entityCache = new EntityCache();
  entityCache.registerBootstrap({ id: "server", kind: "server" });
  entityCache.registerBootstrap({ id: "electron-main", kind: "shell" });
  const connectionGrants = new ConnectionGrantService({ entityCache });
  const serverBootId = `boot_${randomBytes(18).toString("base64url")}`;
  const { DEFAULT_PAIRING_CODE_TTL_MS, DeviceAuthStore } =
    await import("./services/deviceAuthStore.js");
  const deviceAuthStore = new DeviceAuthStore(path.join(statePath, "auth", "devices.json"));
  const startupPairingCodes = !ipcChannel
    ? [
        deviceAuthStore.createPairingCode(DEFAULT_PAIRING_CODE_TTL_MS),
        deviceAuthStore.createPairingCode(DEFAULT_PAIRING_CODE_TTL_MS),
      ]
    : [];
  const startupPairingCode = startupPairingCodes[0] ?? null;
  const startupQrPairingCode = startupPairingCodes[1] ?? null;

  const workerdGatewayToken = randomBytes(32).toString("hex");
  const { CredentialStore } = await import("../../packages/shared/src/credentials/store.js");
  const { ClientConfigStore } =
    await import("../../packages/shared/src/credentials/clientConfigStore.js");
  const { AuditLog } = await import("../../packages/shared/src/credentials/audit.js");
  const { createEgressProxy } = await import("./services/egressProxy.js");
  const { CredentialLifecycle } = await import("./services/credentialLifecycle.js");
  const { CredentialSessionGrantStore } = await import("./services/credentialSessionGrants.js");

  const credentialStore = new CredentialStore();
  const clientConfigStore = new ClientConfigStore();
  const auditLog = new AuditLog({ logDir: path.join(statePath, "credentials-audit") });
  const credentialSessionGrantStore = new CredentialSessionGrantStore();
  const { CapabilityGrantStore } = await import("./services/capabilityGrantStore.js");
  const capabilityGrantStore = new CapabilityGrantStore({ statePath });
  const { UserlandApprovalGrantStore } = await import("./services/userlandApprovalGrantStore.js");
  const userlandApprovalGrantStore = new UserlandApprovalGrantStore({ statePath });
  // EntityTitleService: source-of-truth for display titles lives in the
  // WorkspaceDO (entities.display_title). The cache here is populated at
  // boot via `hydrate()` and updated on every write. The lazy doDispatch
  // resolver lets approval-queue consumers read the cache immediately,
  // while DO writes only start landing once the container has spun up
  // `doDispatch` (registered alongside workerdManager).
  const { createEntityTitleService } = await import("./services/entityTitleService.js");
  const { INTERNAL_DO_SOURCE: ENTITY_TITLE_INTERNAL_DO_SOURCE } =
    await import("./internalDOs/internalDoLoader.js");
  let resolvedDoDispatchForTitles: import("./doDispatch.js").DODispatch | null = null;
  const entityTitleService = createEntityTitleService({
    getDoDispatch: () => resolvedDoDispatchForTitles,
    workspaceRef: {
      source: ENTITY_TITLE_INTERNAL_DO_SOURCE,
      className: "WorkspaceDO",
      objectKey: workspace.config.id,
    },
  });
  const { createApprovalQueue } = await import("./services/approvalQueue.js");
  const approvalQueue = createApprovalQueue({
    eventService,
    resolveTitle: (entityId) => entityTitleService.getTitle(entityId),
    autoApprove:
      process.env["NODE_ENV"] === "development" && process.env["NATSTACK_AUTO_APPROVE"] === "1",
  });
  const { ServerUnitApprovalCoordinator } = await import("./unitApprovalCoordinator.js");
  const unitApprovalCoordinator = new ServerUnitApprovalCoordinator({ approvalQueue });
  const requireMobileReady =
    args.requireMobileReady || process.env["NATSTACK_REQUIRE_MOBILE_READY"] === "1";
  const requireElectronReady =
    args.requireElectronReady || process.env["NATSTACK_REQUIRE_ELECTRON_READY"] === "1";
  const credentialLifecycle = new CredentialLifecycle({
    credentialStore,
    clientConfigStore,
  });

  const egressProxy = createEgressProxy({
    credentialStore,
    auditLog,
    approvalQueue,
    grantStore: capabilityGrantStore,
    sessionGrantStore: credentialSessionGrantStore,
    credentialLifecycle,
  });
  let panelRuntimeCoordinatorForCleanup:
    | import("./panelRuntimeCoordinator.js").PanelRuntimeCoordinator
    | null = null;
  const cleanupRuntimeEntityRecord = async (
    record: import("@natstack/shared/runtime/entitySpec").EntityRecord
  ) => {
    const { cleanupRuntimeEntity } = await import("./runtimeEntityCleanup.js");
    await cleanupRuntimeEntity(record, {
      panelRuntimeCoordinator: panelRuntimeCoordinatorForCleanup,
      egressProxy,
      approvalQueue,
      credentialSessionGrantStore,
      tokenManager,
      connectionGrants,
      entityTitleService,
      getFsService: () => {
        try {
          return container.get<import("@natstack/shared/fsService").FsService>("fsService");
        } catch {
          return null;
        }
      },
      getWebhookIngress: () => {
        try {
          return container.get<{
            internal?: {
              revokeForCaller?: (callerId: string) => Promise<number>;
            };
          }>("webhookIngress");
        } catch {
          return null;
        }
      },
      getWorkerdManager: () => {
        try {
          return container.get<import("./workerdManager.js").WorkerdManager>("workerdManager");
        } catch {
          return null;
        }
      },
    });
  };
  // In pnpm dev mode, the app runs from a throwaway workspace copied from
  // `<appRoot>/workspace`. Mirror committed workspace changes back to that
  // template so edits made in the generated workspace persist into the source
  // checkout.
  const templateDir = path.join(appRoot, "workspace");
  const isPnpmDevMode = process.env["NODE_ENV"] === "development";
  const hasDevTemplate = fs.existsSync(path.join(templateDir, "meta", "natstack.yml"));
  const templateDiffersFromActive =
    templateDir !== workspacePath && !workspacePath.startsWith(templateDir + path.sep);
  // pnpm dev mode: mirror committed workspace changes back to the template
  // checkout so edits persist. Hooked onto vcs state advances (see below).
  const devTemplateMirrorDir =
    isPnpmDevMode && workspaceIsEphemeral && hasDevTemplate && templateDiffersFromActive
      ? templateDir
      : null;
  if (process.env["NATSTACK_DOGFOOD"] === "1") {
    console.warn(
      "[Dogfood] NATSTACK_DOGFOOD git-fast-forward mirroring is unavailable under the GAD vcs; " +
        "use the git bridge (vcs export) once available."
    );
  }
  const requestedGatewayPort = args.gatewayPort ?? parseEnvPort("NATSTACK_GATEWAY_PORT");
  const configuredProtocol = (process.env["NATSTACK_PROTOCOL"] ?? args.protocol ?? "http") as
    | "http"
    | "https";
  let extensionHostForGateway: import("@natstack/extension-host").ExtensionHost | null = null;
  let appHostForGateway: import("./appHost.js").AppHost | null = null;
  type TrustedUnitHostInstance =
    | import("@natstack/extension-host").ExtensionHost
    | import("./appHost.js").AppHost;
  const trustedUnitHosts = (): TrustedUnitHostInstance[] =>
    [extensionHostForGateway, appHostForGateway].filter(
      (host): host is TrustedUnitHostInstance => host !== null
    );
  // Workspace VCS (GAD-native): starts local-first (no DO needed), attaches
  // to the gad-store DO once workerd is up (see "vcsAttach" below).
  const { WorkspaceVcs } = await import("./gadVcs/workspaceVcs.js");
  const workspaceVcs = new WorkspaceVcs({
    blobsDir: path.join(getUserDataPath(), "blobs"),
    workspaceRoot: workspacePath,
    contextsRoot: path.join(statePath, ".contexts"),
    buildSourcesRoot: path.join(getUserDataPath(), "build-sources"),
  });
  const readWorkspaceFileAtCommit = async (
    commit: string,
    filePath: string
  ): Promise<string | null> => {
    const ref = commit.startsWith("state:")
      ? commit
      : /^[0-9a-f]{64}$/i.test(commit)
        ? `state:${commit}`
        : commit;
    const file = await workspaceVcs.readFile(ref, filePath);
    if (!file || file.content.kind !== "text") return null;
    return file.content.text;
  };
  // Create ContextFolderManager before core services. Context folders are
  // GAD branch forks of the workspace main head, materialized from the CAS.
  const { ContextFolderManager } = await import("@natstack/shared/contextFolderManager");
  const contextFolderManager = new ContextFolderManager({
    contextsRoot: path.join(statePath, ".contexts"),
    materialize: (contextId) => workspaceVcs.ensureContextFolder(contextId),
  });

  const { isDeclaredRemoteRepoPath, syncDeclaredRemoteForRepo } =
    await import("@natstack/shared/workspace/remotes");
  const { loadWorkspaceConfig, resolveDeclaredApps, resolveDeclaredExtensions } =
    await import("@natstack/shared/workspace/loader");
  const reconcileDeclaredWorkspaceUnits = async (
    nextConfig: ReturnType<typeof loadWorkspaceConfig>,
    trigger: "startup" | "meta-change"
  ): Promise<void> => {
    const reconcile = async (): Promise<void> => {
      const tasks: Array<Promise<void>> = [];
      if (extensionHostForGateway) {
        tasks.push(
          extensionHostForGateway
            .reconcileDeclared(resolveDeclaredExtensions(nextConfig), { trigger })
            .then(() => extensionHostForGateway?.whenReconciled())
            .then(() => import("@natstack/shared/workspace/extensionRegistry"))
            .then(({ writeExtensionRegistry }) => {
              writeExtensionRegistry(workspacePath);
            })
            .catch((err: unknown) =>
              console.warn("[Extensions] Failed to reconcile declared workspace units:", err)
            )
        );
      }
      if (appHostForGateway) {
        if (trigger === "startup") {
          tasks.push(
            appHostForGateway
              .reconcileDeclared(resolveDeclaredApps(nextConfig), { trigger })
              .then(() => appHostForGateway?.whenReconciled())
              .catch((err: unknown) =>
                console.warn("[Apps] Failed to reconcile declared workspace app units:", err)
              )
          );
        } else {
          try {
            appHostForGateway.setDeclared(resolveDeclaredApps(nextConfig), { trigger });
          } catch (err) {
            console.warn("[Apps] Failed to update declared workspace app units:", err);
          }
        }
      }
      await Promise.all(tasks);
    };
    await reconcile();
  };

  type MobileHostReadinessForPairing = {
    ready: boolean;
    reason?: string;
    details?: string[];
    source?: string | null;
    appId?: string | null;
    buildKey?: string;
    approvalRequired?: boolean;
    approvals?: import("@natstack/shared/approvals").PendingUnitBatchApproval[];
  };

  const ensureReactNativeProviderReadyForPairing =
    async (): Promise<MobileHostReadinessForPairing> => {
      const extensionHost = extensionHostForGateway;
      if (!extensionHost) {
        return { ready: false, reason: "Extension host is not available", details: [] };
      }
      const buildSystemInst =
        container.get<import("./buildV2/index.js").BuildSystemV2>("buildSystem");
      if (buildSystemInst.getBuildProviderDetails?.("react-native")) {
        return { ready: true };
      }

      const currentConfig = loadWorkspaceConfig(workspacePath);
      const declaredExtensions = resolveDeclaredExtensions(currentConfig);
      const hasReactNativeProvider = declaredExtensions.some(
        (decl) => normalizeUnitRepoPath(decl.source) === "extensions/react-native"
      );
      if (!hasReactNativeProvider) {
        return {
          ready: false,
          reason: "React Native build provider extension is not declared",
          details: ["Declare extensions/react-native before pairing a React Native host."],
        };
      }

      await extensionHost.reconcileDeclared(declaredExtensions, { trigger: "startup" });
      await extensionHost.whenSettled();

      if (buildSystemInst.getBuildProviderDetails?.("react-native")) {
        return { ready: true };
      }

      const providerUnit = extensionHost
        .listWorkspaceUnits()
        .find((unit) => normalizeUnitRepoPath(unit.source) === "extensions/react-native");
      return {
        ready: false,
        reason: "React Native build provider extension is not ready",
        details: [
          providerUnit
            ? `${providerUnit.displayName || providerUnit.name}: ${providerUnit.status}${
                providerUnit.lastError ? ` (${providerUnit.lastError})` : ""
              }`
            : "extensions/react-native is declared but no workspace unit status is available.",
        ],
      };
    };

  const ensureMobileHostReadyForPairing = async (
    source?: string | null
  ): Promise<MobileHostReadinessForPairing> => {
    const provider = await ensureReactNativeProviderReadyForPairing();
    if (!provider.ready) return provider;
    const appHost = appHostForGateway;
    if (!appHost) {
      return {
        ready: false,
        reason: "App host is not available",
        details: [],
      };
    }
    const readiness = await appHost.ensureReactNativeReady(source, { waitForApproval: false });
    if (readiness.ready) return readiness;
    const approvals = appHost.listPendingHostTargetApprovals("react-native");
    if (approvals.length > 0) {
      return {
        ready: false,
        approvalRequired: true,
        approvals,
        reason: "React Native workspace app requires approval",
        details: readiness.details,
        source: readiness.source,
        appId: readiness.appId,
      };
    }
    return readiness;
  };

  const { WorkspaceTreeScanner } = await import("./gadVcs/workspaceTree.js");
  const treeScanner = new WorkspaceTreeScanner(workspacePath);
  const skippedDeclaredRemoteRepoWarnings = new Set<string>();
  const syncDeclaredRemotesForSource = async (repoPath?: string): Promise<void> => {
    const repos = repoPath
      ? [repoPath]
      : collectWorkspaceUnitPaths((await treeScanner.getSourceTree()).children);
    await Promise.all(
      repos.map((repo) => {
        if (!isDeclaredRemoteRepoPath(repo)) {
          if (!skippedDeclaredRemoteRepoWarnings.has(repo)) {
            skippedDeclaredRemoteRepoWarnings.add(repo);
            console.log(
              `[GitRemotes] Skipping declared remote sync for non-declarable workspace repo path ${repo}`
            );
          }
          return Promise.resolve();
        }
        return syncDeclaredRemoteForRepo({
          config: workspaceConfig,
          workspaceRoot: workspacePath,
          repoPath: repo,
        }).catch((err: unknown) => {
          console.warn(`[GitRemotes] Failed to sync declared remote for ${repo}:`, err);
        });
      })
    );
  };
  // Workspace state advances drive source-side reactions:
  //  - meta/ changes reload the workspace config and reconcile declared units
  //  - any change invalidates the tree scanner cache
  //  - pnpm dev mode mirrors the committed tree back to the template checkout
  let devMirrorTimer: NodeJS.Timeout | null = null;
  let initialWorkspaceUnitReconcileComplete = false;
  let pendingStartupMetaConfigReload = false;
  // Bridge every head advance to the client event bus so subscribers (panels)
  // can react incrementally: `vcs.subscribeHead(head)` listens on this topic.
  workspaceVcs.onStateAdvanced((event) => {
    eventService.emit(`vcs:head:${event.head}`, event);
  });
  workspaceVcs.onStateAdvanced((event) => {
    if (event.head !== "main") return;
    treeScanner.invalidate();
    if (event.changedPaths.some((changed) => changed.startsWith("meta/"))) {
      queueMicrotask(() => {
        try {
          const nextConfig = loadWorkspaceConfig(workspacePath);
          replaceWorkspaceConfig(workspaceConfig, nextConfig);
          if (!initialWorkspaceUnitReconcileComplete) {
            pendingStartupMetaConfigReload = true;
            return;
          }
          void reconcileDeclaredWorkspaceUnits(nextConfig, "meta-change");
          syncDeclaredRemotesForSource().catch((err: unknown) =>
            console.warn("[GitRemotes] Failed to sync declared remotes after meta change:", err)
          );
        } catch (err) {
          console.warn("[GitRemotes] Failed to reload workspace config after meta change:", err);
        }
      });
    }
    if (devTemplateMirrorDir) {
      // Debounced non-destructive rsync — state advances can arrive in bursts
      // during agent commit loops; mirror once things settle.
      if (devMirrorTimer) clearTimeout(devMirrorTimer);
      devMirrorTimer = setTimeout(() => {
        devMirrorTimer = null;
        execFile(
          "rsync",
          [
            "-a",
            "--exclude=.git",
            "--exclude=node_modules",
            "--exclude=.contexts",
            "--exclude=.gad",
            "--exclude=.cache",
            "--exclude=.databases",
            `${workspacePath}/`,
            `${devTemplateMirrorDir}/`,
          ],
          (err) => {
            if (err) console.warn("[DevMirror] rsync to template failed:", err.message);
          }
        );
      }, 500);
    }
  });
  // Configure declared remotes for repos already present at startup — without
  // this, remotes are only synced when a later state advance touches meta/.
  syncDeclaredRemotesForSource().catch((err: unknown) =>
    console.warn("[GitRemotes] Failed to sync declared remotes at startup:", err)
  );

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
  container.registerManaged({
    name: "tokenManager",
    async start() {
      return tokenManager;
    },
  });
  container.registerManaged({
    name: "workspaceVcs",
    async start() {
      return workspaceVcs;
    },
  });

  // Build system
  container.registerManaged({
    name: "buildSystem",
    dependencies: ["workspaceVcs"],
    async start() {
      return await initBuildSystemV2(
        workspacePath,
        workspaceVcs,
        appNodeModules.length > 0 ? appNodeModules : [path.join(appRoot, "node_modules")]
      );
    },
    async stop(instance: import("./buildV2/index.js").BuildSystemV2) {
      await instance?.shutdown();
    },
  });

  // ── RPC-only services (replacing serverServiceRegistry.ts) ──

  const { createBuildService } = await import("./services/buildService.js");
  const { createWorkerdService } = await import("./services/workerdService.js");
  const { createTokensService } = await import("./services/tokensService.js");
  const { createPresenceService, createPresenceTracker } =
    await import("./services/presenceService.js");
  const { createGitInteropService } = await import("./services/gitInteropService.js");
  const { createWorkerService } = await import("./services/workerService.js");

  {
    let buildSystemInstance: import("./buildV2/index.js").BuildSystemV2 | null = null;
    container.registerManaged({
      name: "build",
      dependencies: ["buildSystem"],
      start: async (resolve) => {
        buildSystemInstance = assertPresent(
          resolve<import("./buildV2/index.js").BuildSystemV2>("buildSystem")
        );
      },
      getServiceDefinition() {
        return createBuildService({ buildSystem: assertPresent(buildSystemInstance) });
      },
    });
  }
  const presence = createPresenceTracker({ eventService });
  container.registerRpc(createPresenceService({ presence }));

  {
    let tokensDefinition: import("@natstack/shared/serviceDefinition").ServiceDefinition | null =
      null;
    container.registerManaged({
      name: "tokens",
      dependencies: ["tokenManager", "fsService"],
      async start() {
        // Only persist the admin token centrally in standalone mode. In
        // IPC/Electron-embedded mode the token is consumed by the parent
        // process from the ready message, and writing it into the shared
        // central config would leak into other workspaces.
        const persistAdminToken = !ipcChannel
          ? (token: string) => savePersistedAdminToken(token)
          : undefined;
        tokensDefinition = createTokensService({
          tokenManager,
          persistAdminToken,
        });
      },
      getServiceDefinition() {
        if (!tokensDefinition) throw new Error("tokens service not initialized");
        return tokensDefinition;
      },
    });
  }
  container.registerRpc(
    createGitInteropService({
      treeScanner,
      workspacePath,
      workspaceConfig,
      egressProxy,
      approvalQueue,
      grantStore: capabilityGrantStore,
    })
  );
  {
    const { createVcsService } = await import("./services/vcsService.js");
    const { createMainAdvanceApprovalGate, FileMetaApprovalGrantStore } =
      await import("./services/mainAdvanceApproval.js");
    const mainAdvanceGate = createMainAdvanceApprovalGate({
      approvalQueue,
      grantStore: new FileMetaApprovalGrantStore({ statePath }),
      grantTtlMs: 4 * 60 * 60 * 1000,
      capabilityGrantStore,
      getProviders: () => trustedUnitHosts(),
    });
    let buildSystemForVcs: import("./buildV2/index.js").BuildSystemV2 | null = null;
    container.registerManaged({
      name: "vcsService",
      dependencies: ["buildSystem"],
      async start(resolve) {
        buildSystemForVcs = assertPresent(
          resolve<import("./buildV2/index.js").BuildSystemV2>("buildSystem")
        );
      },
      getServiceDefinition() {
        return createVcsService({
          workspaceVcs,
          entityCache,
          getBuildSystem: () => buildSystemForVcs,
          mainAdvanceGate,
        });
      },
    });
  }
  const runtimeDiagnostics = new RuntimeDiagnosticsStore({ statePath });
  // Bridge state-triggered build failures (and completions) into the per-unit
  // diagnostics store so `workspace.units.diagnostics` surfaces build errors
  // alongside runtime logs. Keyed the same way unitDiagnostics resolves
  // entities: workers by source path, everything else by package name.
  container.registerManaged({
    name: "buildDiagnosticsBridge",
    dependencies: ["buildSystem"],
    start: async (resolve) => {
      const buildSystem = assertPresent(
        resolve<import("./buildV2/index.js").BuildSystemV2>("buildSystem")
      );
      const kindMap: Record<string, import("./runtimeDiagnosticsStore.js").RuntimeDiagnosticKind> =
        {
          panel: "panel",
          worker: "worker",
          extension: "extension",
          app: "app",
        };
      return buildSystem.onBuildEvent((event) => {
        if (event.type === "build-started") return;
        const node = buildSystem.getGraph().tryGet(event.name);
        const kind = kindMap[node?.kind ?? ""] ?? "worker";
        const entityId = node?.kind === "worker" ? (node.relativePath ?? event.name) : event.name;
        runtimeDiagnostics.record({
          workspaceId: workspace.config.id,
          entityId,
          kind,
          level: event.type === "build-error" ? "error" : "info",
          message:
            event.type === "build-error"
              ? `Build failed: ${event.error ?? "unknown error"}`
              : `Build complete (${event.buildKey ?? "no key"})`,
          source: "lifecycle",
          fields: {
            buildEvent: event.type,
            ...(event.buildKey ? { buildKey: event.buildKey } : {}),
            ...(event.trigger
              ? { head: event.trigger.head, stateHash: event.trigger.stateHash }
              : {}),
          },
        });
      });
    },
    stop: async (unsubscribe: () => void) => {
      unsubscribe?.();
    },
  });
  {
    const { createWorkerLogService } = await import("./services/workerLogService.js");
    container.registerRpc(
      createWorkerLogService({
        onLog: (entry) => {
          if (!entry.source) return;
          runtimeDiagnostics.record({
            workspaceId: workspace.config.id,
            entityId: entry.callerId,
            kind: entry.callerId.startsWith("do:") ? "do" : "worker",
            timestamp: entry.timestamp,
            level: entry.level === "warn" ? "warn" : entry.level,
            message: entry.message,
            source: "console",
            fields: entry.source ? { source: entry.source } : undefined,
          });
          runtimeDiagnostics.record({
            workspaceId: workspace.config.id,
            entityId: entry.source,
            kind: "worker",
            timestamp: entry.timestamp,
            level: entry.level === "warn" ? "warn" : entry.level,
            message: entry.message,
            source: "console",
            fields: { callerId: entry.callerId },
          });
          eventService.emit("workspace:unit-log", {
            workspaceId: workspace.config.id,
            unitName: entry.source,
            kind: "worker",
            timestamp: entry.timestamp,
            level: entry.level,
            message: entry.message,
            source: "console",
          } satisfies import("./services/workspaceService.js").WorkspaceUnitLogRecord);
        },
      })
    );
  }
  {
    const { createPanelLogService } = await import("./services/panelLogService.js");
    container.registerRpc(
      createPanelLogService({
        onRecords: (records) => {
          const buildSystem = container.has("buildSystem")
            ? container.get<import("./buildV2/index.js").BuildSystemV2>("buildSystem")
            : null;
          for (const entry of records) {
            // Diagnostics for panels are keyed by package name (matching
            // unitDiagnostics' entity resolution); fall back to the source
            // path when the unit isn't in the graph.
            const node = buildSystem
              ?.getGraph()
              .allNodes()
              .find((candidate) => candidate.relativePath === entry.unitSource);
            const entityId = node?.name ?? entry.unitSource;
            runtimeDiagnostics.record({
              workspaceId: workspace.config.id,
              entityId,
              kind: "panel",
              timestamp: entry.timestamp,
              level: entry.level,
              message: entry.message,
              source: entry.source,
              fields: { panelId: entry.panelId, ...entry.fields },
              url: entry.url,
              line: entry.line,
            });
            eventService.emit("workspace:unit-log", {
              workspaceId: workspace.config.id,
              unitName: entityId,
              kind: "panel",
              timestamp: entry.timestamp,
              level: entry.level,
              message: entry.message,
              source: entry.source === "lifecycle" ? "console" : entry.source,
            });
          }
        },
      })
    );
  }
  container.registerRpc(
    createEventsServiceDefinition(eventService, {
      snapshots: {
        "shell-approval:pending-changed": () => ({ pending: approvalQueue.listPending() }),
      },
    })
  );

  // ── Approval-gated host capabilities ──
  {
    const { createExternalOpenService } = await import("./services/externalOpenService.js");
    container.registerRpc(
      createExternalOpenService({
        eventService,
        approvalQueue,
        grantStore: capabilityGrantStore,
      })
    );
  }

  // ── Notification service ──
  const { createNotificationService } = await import("./services/notificationService.js");
  const notificationResult = createNotificationService({ eventService });
  container.registerRpc(notificationResult.definition);

  // ── Push + shell presence services ──
  {
    const { createPushService } = await import("./services/pushService.js");
    const pushResult = createPushService();
    container.registerManaged({
      name: "push",
      start: async () => pushResult,
      getServiceDefinition: () => pushResult.definition,
    });
  }
  {
    const { createShellPresenceService } = await import("./services/shellPresenceService.js");
    const shellPresenceResult = createShellPresenceService();
    container.registerManaged({
      name: "shellPresence",
      start: async () => shellPresenceResult,
      getServiceDefinition: () => shellPresenceResult.definition,
    });
  }
  {
    const { createApprovalPushBridge } = await import("./services/approvalPushBridge.js");
    container.registerManaged({
      name: "approvalPushBridge",
      dependencies: ["push", "shellPresence"],
      start: async (resolve) => {
        const push = assertPresent(
          resolve<import("./services/pushService.js").PushServiceResult>("push")
        );
        const shellPresence = assertPresent(
          resolve<import("./services/shellPresenceService.js").ShellPresenceServiceResult>(
            "shellPresence"
          )
        );
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
  container.registerRpc(createShellApprovalService({ approvalQueue }));
  const { createCorsApprovalService } = await import("./services/corsApprovalService.js");
  container.registerRpc(
    createCorsApprovalService({
      approvalQueue,
      grantStore: capabilityGrantStore,
    })
  );
  const { createUserlandApprovalService } = await import("./services/userlandApprovalService.js");
  container.registerRpc(
    createUserlandApprovalService({
      approvalQueue,
      grantStore: userlandApprovalGrantStore,
    })
  );

  // ── Credential service ──
  {
    const { createCredentialService } = await import("./services/credentialService.js");
    const { serviceWithHttpRoutes } = await import("./serviceWithHttpRoutes.js");
    const captureSessionCredential = async <T extends Record<string, unknown>>(
      payload: Record<string, unknown>,
      signal?: AbortSignal
    ): Promise<T> => {
      const response = await ipcRequest<T & { error?: unknown }>(
        "credential-session-capture-request",
        payload,
        300_000,
        signal
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
      connectionLookup: {
        getAuthorizingShell: (principalId: string) =>
          rpcServerForGateway?.getAuthorizingShell(principalId) ?? null,
      },
      egressProxy,
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
          }>(
            {
              kind: "cookies",
              signInUrl: params.signInUrl,
              origins: params.origins,
              cookieNames: params.cookieNames,
              completionUrlPattern: params.completionUrlPattern,
              maxTtlSeconds: params.maxTtlSeconds,
              browser: params.browser,
            },
            params.signal
          );
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
          }>(
            {
              kind: "saml",
              signInUrl: params.signInUrl,
              spAudience: params.spAudience,
              cookieNames: params.cookieNames,
              assertion: params.assertion,
              completionUrlPattern: params.completionUrlPattern,
              maxTtlSeconds: params.maxTtlSeconds,
              browser: params.browser,
            },
            params.signal
          );
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
    container.registerManaged(
      serviceWithHttpRoutes(
        {
          definition: credentialService,
          routes: credentialService.routes,
        },
        routeRegistry
      )
    );
  }

  // ── Internal DO-backed services ──
  {
    const { createScopeService } = await import("./services/scopeService.js");
    let scopeDefinition: import("@natstack/shared/serviceDefinition").ServiceDefinition | null =
      null;
    container.registerManaged({
      name: "scope",
      dependencies: ["doDispatch"],
      async start(resolve) {
        const doDispatch = assertPresent(
          resolve<import("./doDispatch.js").DODispatch>("doDispatch")
        );
        scopeDefinition = createScopeService({
          doDispatch,
        });
      },
      getServiceDefinition() {
        if (!scopeDefinition) throw new Error("scope service not initialized");
        return scopeDefinition;
      },
    });
  }

  // Server-driven DO alarms (workerd lacks SQLite/facet alarms). Created as a
  // managed service below; the workspace-state `onAlarmChanged` hook pokes it.
  let alarmDriverInstance: import("./services/alarmDriver.js").AlarmDriver | null = null;

  {
    const { createWorkspaceStateService } = await import("./services/workspaceStateService.js");
    let workspaceStateDefinition:
      | import("@natstack/shared/serviceDefinition").ServiceDefinition
      | null = null;
    container.registerManaged({
      name: "workspace-state",
      dependencies: ["doDispatch"],
      async start(resolve) {
        const doDispatch = assertPresent(
          resolve<import("./doDispatch.js").DODispatch>("doDispatch")
        );
        // Now that doDispatch is up, the title cache can talk to the DO.
        // Hydrate so synchronous getTitle() lookups (used by approvalQueue
        // when building a PendingApproval) see existing titles from previous
        // sessions. Best-effort — failures keep an empty cache until the
        // first explicit write.
        resolvedDoDispatchForTitles = doDispatch;
        void entityTitleService.hydrate();
        workspaceStateDefinition = createWorkspaceStateService({
          doDispatch,
          workspaceId: workspace.config.id,
          // The DO already writes display_title in the same transaction as
          // searchable_title (see workspaceDO.panelIndex / panelUpdateTitle),
          // so the callback only needs to mirror into the in-memory cache.
          onPanelTitleChanged: (entityId, title) => {
            entityTitleService.mirrorCachedTitle(entityId, title);
          },
          onAlarmChanged: () => alarmDriverInstance?.notifyChanged(),
        });
      },
      getServiceDefinition() {
        if (!workspaceStateDefinition) {
          throw new Error("workspace-state service not initialized");
        }
        return workspaceStateDefinition;
      },
    });
  }

  // ── runtime.* service ──
  // runtime.createEntity / retireEntity is the only path that
  // mints or retires entity rows. Cleanup hooks fire post-retire (see §10).
  {
    const { createRuntimeService } = await import("./services/runtimeService.js");
    let runtimeDefinition: import("@natstack/shared/serviceDefinition").ServiceDefinition | null =
      null;
    container.registerManaged({
      name: "runtime",
      dependencies: ["doDispatch", "workerdManager", "buildSystem"],
      async start(resolve) {
        const doDispatch = assertPresent(
          resolve<import("./doDispatch.js").DODispatch>("doDispatch")
        );
        const workerdManager = assertPresent(
          resolve<import("./workerdManager.js").WorkerdManager>("workerdManager")
        );
        const buildSystem = assertPresent(
          resolve<import("./buildV2/index.js").BuildSystemV2>("buildSystem")
        );
        runtimeDefinition = createRuntimeService({
          doDispatch,
          workspaceId: workspace.config.id,
          entityCache,
          contextFolders: contextFolderManager,
          hooks: {
            prepareDurableObject: (args) => workerdManager.ensureDurableObjectEntity(args),
            prepareWorker: (args) => workerdManager.startWorker(args),
            resolvePanelEffectiveVersion: async ({ source, ref }) => {
              if (source.startsWith("browser:")) return "";
              void ref;
              return buildSystem.getEffectiveVersion(source) ?? "";
            },
            resolveAppEffectiveVersion: async ({ source, ref }) => {
              void ref;
              return buildSystem.getEffectiveVersion(source) ?? "";
            },
            onRetire: async (record) => {
              await cleanupRuntimeEntityRecord(record);
            },
          },
          capability: {
            approvalQueue,
            grantStore: capabilityGrantStore,
          },
          canCreateCrossContextEntity: (caller, spec) =>
            spec.kind === "panel" &&
            appHostForGateway?.hasAppCapability(caller.runtime.id, "panel-hosting") === true,
          setEntityTitle: (entityId, title, options) =>
            entityTitleService.setTitle(entityId, title, options),
        });
      },
      getServiceDefinition() {
        if (!runtimeDefinition) {
          throw new Error("runtime service not initialized");
        }
        return runtimeDefinition;
      },
    });
  }

  // browser-data is now an extension at
  // workspace/extensions/browser-data — callers reach it
  // through `extensions.invoke`. The extension proxies to the BrowserDataDO
  // via unified RPC, so storage stays in workerd unchanged.

  // ── Generic public webhook ingress ──
  {
    const { createWebhookIngressService } = await import("./services/webhookIngressService.js");
    let webhookIngress: ReturnType<typeof createWebhookIngressService> | null = null;
    container.registerManaged({
      name: "webhookIngress",
      dependencies: ["rpcServer"],
      async start(resolve) {
        const rpcServer = assertPresent(
          resolve<{ server: import("./rpcServer.js").RpcServer }>("rpcServer")
        );
        webhookIngress = createWebhookIngressService({
          relaySigningSecret: process.env["NATSTACK_RELAY_SIGNING_SECRET"],
          publicBaseUrl: process.env["NATSTACK_WEBHOOK_PUBLIC_URL"] ?? "https://hooks.snugenv.com",
          rpc: {
            call: (targetId, method, ...args) =>
              rpcServer.server.callTarget(targetId, method, ...args),
          },
          dispatchToTarget: async (target, event) => {
            await rpcServer.server.callTarget(
              `do:${target.source}:${target.className}:${target.objectKey}`,
              target.method,
              event
            );
          },
        });
        if (webhookIngress.routes.length > 0) {
          routeRegistry.registerHttpServiceRoutes(webhookIngress.routes);
        }
        return webhookIngress;
      },
      async stop() {
        routeRegistry.unregisterHttpServiceRoutes("webhookIngress");
      },
      getServiceDefinition() {
        if (!webhookIngress) throw new Error("webhookIngress service not initialized");
        return webhookIngress.definition;
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
    adminToken = assertPresent(process.env["NATSTACK_ADMIN_TOKEN"]);
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
  function getResolvedGatewayPort(context: string): number {
    if (!gatewayPortResolved) {
      throw new Error(`Gateway port not finalized before ${context}`);
    }
    return gatewayPortResolved;
  }
  function gatewayProtocol(): "http" | "https" {
    return hostConfig.tlsCert && hostConfig.tlsKey ? "https" : "http";
  }
  function getLocalGatewayUrl(context: string): string {
    return `${gatewayProtocol()}://127.0.0.1:${getResolvedGatewayPort(context)}`;
  }
  function getExternalGatewayUrl(context: string): string {
    return `${gatewayProtocol()}://${hostConfig.externalHost}:${getResolvedGatewayPort(context)}`;
  }
  function getConfiguredPublicUrl(): string | null {
    const explicitPublicUrl = args.publicUrl ?? process.env["NATSTACK_PUBLIC_URL"];
    if (explicitPublicUrl) return explicitPublicUrl;
    return isPublicUrlVerified() ? getPublicUrl() : null;
  }
  // Single advertised origin for QR/deep-link pairing, auth connection info, and
  // native React Native bundle bootstrap. Keep these in lockstep.
  function getConnectUrl(context: string): string {
    return getConfiguredPublicUrl() ?? getExternalGatewayUrl(context);
  }
  const { PanelRuntimeCoordinator } = await import("./panelRuntimeCoordinator.js");
  const panelRuntimeCoordinator = new PanelRuntimeCoordinator({ eventService });
  panelRuntimeCoordinatorForCleanup = panelRuntimeCoordinator;

  // ── RPC server (always present) ──
  let rpcServerForGateway: import("./rpcServer.js").RpcServer | null = null;

  container.registerManaged({
    name: "rpcServer",
    dependencies: ["tokenManager", "fsService"],
    async start(resolve) {
      const fsService = assertPresent(
        resolve<import("@natstack/shared/fsService").FsService>("fsService")
      );
      const server = new RpcServer({
        tokenManager,
        dispatcher,
        eventService,
        egressProxy,
        fsService,
        entityCache,
        connectionGrants,
        runtimeCoordinator: panelRuntimeCoordinator,
        resolveExtensionInvocation: (extensionName, invocationToken) =>
          extensionHostForGateway?.resolveActiveInvocation(extensionName, invocationToken) ?? null,
      });
      server.initHandlers();
      rpcServerForGateway = server;
      return { server };
    },
    async stop(instance: { server: import("./rpcServer.js").RpcServer }) {
      await instance?.server?.stop();
    },
  });
  {
    const { createPanelRuntimeService } = await import("./services/panelRuntimeService.js");
    let panelRuntimeDefinition: import("@natstack/shared/serviceDefinition").ServiceDefinition;
    container.registerManaged({
      name: "panelRuntime",
      async start() {
        panelRuntimeDefinition = createPanelRuntimeService({
          coordinator: panelRuntimeCoordinator,
        });
        return panelRuntimeDefinition;
      },
      getServiceDefinition() {
        if (!panelRuntimeDefinition) throw new Error("panelRuntime service not initialized");
        return panelRuntimeDefinition;
      },
    });
  }

  // ── Extension host RPC service ──
  container.registerManaged({
    name: "extensionHost",
    dependencies: ["buildSystem", "tokenManager"],
    async start(resolve) {
      const { ExtensionHost } = await import("@natstack/extension-host");
      const buildSystemInst = assertPresent(
        resolve<import("./buildV2/index.js").BuildSystemV2>("buildSystem")
      );
      const tokenManagerInst = assertPresent(
        resolve<import("@natstack/shared/tokenManager").TokenManager>("tokenManager")
      );
      const host = new ExtensionHost({
        statePath,
        workspacePath,
        workspaceId: workspace.config.id,
        buildSystem: buildSystemInst,
        tokenManager: tokenManagerInst,
        eventService,
        approvalQueue,
        approvalCoordinator: unitApprovalCoordinator,
        notificationService: notificationResult.internal,
        recordUnitLog: (record) => {
          runtimeDiagnostics.record({
            workspaceId: record.workspaceId,
            entityId: record.unitName,
            kind: "extension",
            timestamp: record.timestamp,
            level: record.level,
            message: record.message,
            source: record.source ?? "ctx.log",
            fields: record.fields,
          });
        },
        readWorkspaceFileAtCommit,
        getContextIdForCaller: (callerId) => entityCache.resolveContext(callerId),
        getGatewayUrl: () => getLocalGatewayUrl("extension startup"),
        extensionTransport: {
          call(name, method, ...args) {
            const rpcServer = rpcServerForGateway;
            if (!rpcServer) throw new Error("RPC server is not initialized");
            return rpcServer.callTarget(name, method, ...args);
          },
          streamCallTarget(name, method, ...args) {
            const rpcServer = rpcServerForGateway;
            if (!rpcServer) throw new Error("RPC server is not initialized");
            return rpcServer.streamCallTarget(name, method, ...args);
          },
        },
        registerBuildProvider,
        unregisterBuildProvider,
      });
      extensionHostForGateway = host;
      return host;
    },
    async stop(instance: import("@natstack/extension-host").ExtensionHost) {
      await instance?.shutdown();
    },
    getServiceDefinition(instance?: import("@natstack/extension-host").ExtensionHost) {
      if (!instance) {
        instance = container.get<import("@natstack/extension-host").ExtensionHost>("extensionHost");
      }
      return instance.createServiceDefinition();
    },
  });

  // ── Workers RPC service ──

  // ── App host (workspace-owned privileged frontend apps) ──
  container.registerManaged({
    name: "appHost",
    dependencies: ["buildSystem"],
    async start(resolve) {
      const { AppHost } = await import("./appHost.js");
      const buildSystemInst = assertPresent(
        resolve<import("./buildV2/index.js").BuildSystemV2>("buildSystem")
      );
      const host = new AppHost({
        statePath,
        workspacePath,
        workspaceId: workspace.config.id,
        buildSystem: buildSystemInst,
        eventService,
        approvalQueue,
        approvalCoordinator: unitApprovalCoordinator,
        notificationService: notificationResult.internal,
        entityCache,
        connectionGrants,
        readWorkspaceFileAtCommit,
        getGatewayUrl: () => getLocalGatewayUrl("app startup"),
        getReactNativeBootstrapUrl: () => getConnectUrl("React Native bootstrap"),
      });
      appHostForGateway = host;
      return host;
    },
    async stop(instance: import("./appHost.js").AppHost) {
      await instance?.shutdown();
    },
  });

  // Activate a Durable Object's entity record (idempotent). A DO that calls
  // back into the server (runtime.*, console bridge) is attributed through the
  // entity cache — without a record its principal kind is unknown and every
  // call 403s. Service resolution activates on demand (workersRpc below);
  // server-dispatched singletons (vcsAttach → gad-store) activate explicitly.
  const activateDurableObjectEntity = async (
    doDispatch: import("./doDispatch.js").DODispatch,
    workerdManagerInst: import("./workerdManager.js").WorkerdManager,
    ref: { source: string; className: string; objectKey: string; buildRef?: string }
  ): Promise<void> => {
    const { source, className, objectKey, buildRef } = ref;
    const targetId = canonicalEntityId({ kind: "do", source, className, key: objectKey });
    if (entityCache.resolveActive(targetId)) return;
    const { INTERNAL_DO_SOURCE } = await import("./internalDOs/internalDoLoader.js");
    const workspaceDORef: import("./doDispatch.js").DORef = {
      source: INTERNAL_DO_SOURCE,
      className: "WorkspaceDO",
      objectKey: workspace.config.id,
    };
    const existing = (await doDispatch.dispatch(
      workspaceDORef,
      "entityResolve",
      targetId
    )) as EntityRecord | null;
    if (existing?.status === "active") {
      entityCache._onActivate(existing);
      return;
    }
    const contextId =
      existing?.contextId ??
      createHash("sha256")
        .update(`${workspace.config.id}\x00${source}\x00${className}\x00${objectKey}`)
        .digest("hex");
    const prepared = await workerdManagerInst.ensureDurableObjectEntity({
      source,
      className,
      key: objectKey,
      contextId,
      ref: buildRef,
    });
    const record = (await doDispatch.dispatch(workspaceDORef, "entityActivate", {
      kind: "do",
      source: {
        repoPath: source,
        effectiveVersion: existing?.source.effectiveVersion ?? prepared.effectiveVersion,
      },
      contextId,
      className,
      key: objectKey,
    })) as EntityRecord;
    entityCache._onActivate(record);
  };

  {
    let workerServiceDef: import("@natstack/shared/serviceDefinition").ServiceDefinition;
    container.registerManaged({
      name: "workersRpc",
      dependencies: ["buildSystem", "workerdManager", "doDispatch"],
      async start(resolve) {
        const buildSystemInst = assertPresent(
          resolve<import("./buildV2/index.js").BuildSystemV2>("buildSystem")
        );
        const workerdManagerInst = assertPresent(
          resolve<import("./workerdManager.js").WorkerdManager>("workerdManager")
        );
        const doDispatch = assertPresent(
          resolve<import("./doDispatch.js").DODispatch>("doDispatch")
        );
        workerServiceDef = createWorkerService({
          buildSystem: buildSystemInst,
          workspaceDecls,
          activateDurableObject: ({ source, className, objectKey }) => {
            const singleton = workspaceDecls.singletons.find(source, className);
            return activateDurableObjectEntity(doDispatch, workerdManagerInst, {
              source,
              className,
              objectKey,
              buildRef: singleton?.contextId ? undefined : "main",
            });
          },
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
    container.registerManaged({
      name: "fsService",
      async start() {
        return new FsService(contextFolderManager, entityCache);
      },
    });
  }

  // WorkerdManager — manages workerd process and worker instances
  //
  // Workers POST back through the gateway. The gateway starts before
  // container.startAll(), so this URL is stable by the time workerd boots.
  let workerdManagerForGateway: import("./workerdManager.js").WorkerdManager | null = null;
  // Live worker → VerifiedCaller registry for attributed egress through the
  // shared listener. Populated by WorkerdManager on worker create/destroy.
  const egressCallers = new Map<
    string,
    import("@natstack/shared/serviceDispatcher").VerifiedCaller
  >();
  {
    let workerdManagerInstance: import("./workerdManager.js").WorkerdManager | null = null;
    let buildSystemForWorkerd: import("./buildV2/index.js").BuildSystemV2 | null = null;
    container.registerManaged({
      name: "workerdManager",
      dependencies: ["buildSystem", "fsService"],
      async start(resolve) {
        const { WorkerdManager } = await import("./workerdManager.js");
        buildSystemForWorkerd = assertPresent(
          resolve<import("./buildV2/index.js").BuildSystemV2>("buildSystem")
        );
        const fsServiceInst = assertPresent(
          resolve<import("@natstack/shared/fsService").FsService>("fsService")
        );

        workerdManagerInstance = new WorkerdManager({
          tokenManager,
          fsService: fsServiceInst,
          getServerUrl: () => {
            if (!gatewayPortResolved) {
              throw new Error("Gateway port not finalized before workerd startup");
            }
            return `http://127.0.0.1:${gatewayPortResolved}`;
          },
          getServerAliasUrls: () => {
            if (!gatewayPortResolved) return [];
            const aliases = new Set<string>();
            const configuredAliases = process.env["NATSTACK_GATEWAY_ALIASES"];
            if (configuredAliases) {
              for (const alias of parseGatewayAliases(configuredAliases)) {
                aliases.add(alias);
              }
            }
            aliases.add(
              `${configuredProtocol}://${hostConfig.externalHost}:${gatewayPortResolved}`
            );
            return [...aliases];
          },
          bindRuntimeImage: (unitPath, ref) =>
            assertPresent(buildSystemForWorkerd).bindRuntimeImage(unitPath, ref),
          getBuildByKey: (key) => assertPresent(buildSystemForWorkerd).getBuildByKey(key),
          workspacePath,
          statePath,
          routeRegistry,
          getManifestRoutes: (source) => workspaceDecls.routes.filter((r) => r.source === source),
          singletonRegistry: workspaceDecls.singletons,
          getProxyPort: (caller) => egressProxy.startForCaller(caller),
          getSharedEgressPort: () =>
            egressProxy.startShared(assertPresent(workerdManagerInstance).getEgressSecret()),
          registerEgressCaller: (callerId, caller) => egressCallers.set(callerId, caller),
          unregisterEgressCaller: (callerId) => egressCallers.delete(callerId),
          getWorkerdGatewayToken: () => workerdGatewayToken,
          recordLifecycleEvent: (event) => {
            runtimeDiagnostics.record({
              workspaceId: workspace.config.id,
              entityId: event.source,
              kind: "worker",
              level: event.level,
              message: event.message,
              source: "lifecycle",
              fields: { callerId: event.callerId, ...event.fields },
            });
            eventService.emit("workspace:unit-log", {
              workspaceId: workspace.config.id,
              unitName: event.source,
              kind: "worker",
              timestamp: Date.now(),
              level: event.level,
              message: event.message,
              source: "console",
            } satisfies import("./services/workspaceService.js").WorkspaceUnitLogRecord);
          },
        });
        workerdManagerForGateway = workerdManagerInstance;
        // Resolve attributed egress (shared listener) → live worker VerifiedCaller.
        egressProxy.setCallerResolver((callerId) => egressCallers.get(callerId) ?? null);

        // Wire source rebuilds to restart workers.
        //
        // Always pass an explicit array (possibly empty) so onSourceRebuilt
        // can reconcile removals: if a manifest edit DROPS a DO class, the
        // array reflects that absence and the stale DO service gets torn
        // down. Passing `undefined` would leave stale services bound forever.
        buildSystemForWorkerd.onPushBuild((source, trigger, buildKey) => {
          const head = trigger?.head ?? "main";
          if (head !== "main") {
            workerdManagerInstance
              ?.onSourceRebuilt(source, undefined, trigger, buildKey)
              .catch((err) => {
                console.error(
                  `[WorkerdManager] Failed to handle rebuilt source ${source}@${head}:`,
                  err
                );
              });
            return;
          }

          const node = buildSystemForWorkerd
            ?.getGraph()
            .allNodes()
            .find((n) => n.relativePath === source);
          const manifest = node?.manifest as Record<string, unknown> | undefined;
          const durable = manifest?.["durable"] as
            | { classes?: Array<{ className: string }> }
            | undefined;
          const doClasses = durable?.classes ?? [];

          workerdManagerInstance
            ?.onSourceRebuilt(source, doClasses, trigger, buildKey)
            .catch((err) => {
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

  {
    container.registerManaged({
      name: "doDispatch",
      dependencies: ["workerdManager"],
      async start(resolve) {
        const { DODispatch } = await import("./doDispatch.js");
        const workerdManager = assertPresent(
          resolve<import("./workerdManager.js").WorkerdManager>("workerdManager")
        );
        const doDispatch = new DODispatch();
        doDispatch.setTokenManager(tokenManager);
        doDispatch.setGetWorkerdGatewayToken(() => workerdGatewayToken);
        doDispatch.setGetWorkerdUrl(() => {
          const port = workerdManager.getPort();
          if (!port) throw new Error("workerd not running");
          return `http://127.0.0.1:${port}`;
        });
        doDispatch.setGetDispatchSecret(() => workerdManager.getDispatchSecret());
        doDispatch.setEnsureDO((source, className, objectKey) => {
          const targetId = canonicalEntityId({ kind: "do", source, className, key: objectKey });
          const record = entityCache.resolveActive(targetId);
          return workerdManager.ensureDO(source, className, objectKey, {
            contextId: record?.contextId,
          });
        });
        return doDispatch;
      },
    });
  }

  {
    // Attach the workspace vcs to the gad-store DO: ingest the bootstrap
    // local state (same state hash — no EV churn) and enable durable
    // commits, context forks, and the builds provenance log.
    container.registerManaged({
      name: "vcsAttach",
      dependencies: ["doDispatch", "workerdManager"],
      async start(resolve) {
        const doDispatch = assertPresent(
          resolve<import("./doDispatch.js").DODispatch>("doDispatch")
        );
        const workerdManagerInst = assertPresent(
          resolve<import("./workerdManager.js").WorkerdManager>("workerdManager")
        );
        const gadRef = {
          source: "workers/gad-store",
          className: "GadWorkspaceDO",
          objectKey:
            workspaceDecls.singletons.find("workers/gad-store", "GadWorkspaceDO")?.key ??
            "workspace-gad",
          buildRef: "main",
        };
        // Entity record first: the DO's callbacks into the server (setTitle,
        // console bridge) resolve their principal through the entity cache.
        await activateDurableObjectEntity(doDispatch, workerdManagerInst, gadRef);
        await workspaceVcs.attachGad({
          call: <T>(method: string, input: unknown): Promise<T> =>
            doDispatch.dispatch(gadRef, method, input) as Promise<T>,
        });
        workspaceVcs.enableMemoryIndexing();
        console.log("[Vcs] Attached to gad-store DO");
        return workspaceVcs;
      },
    });
  }

  {
    container.registerManaged({
      name: "lifecycleDriver",
      dependencies: ["workerdManager", "doDispatch"],
      async start(resolve) {
        const { LifecycleDriver } = await import("./services/lifecycleDriver.js");
        const driver = new LifecycleDriver({
          workerdManager: assertPresent(
            resolve<import("./workerdManager.js").WorkerdManager>("workerdManager")
          ),
          doDispatch: assertPresent(resolve<import("./doDispatch.js").DODispatch>("doDispatch")),
          workspaceId: workspace.config.id,
        });
        driver.start();
        return driver;
      },
      async stop(instance: import("./services/lifecycleDriver.js").LifecycleDriver | null) {
        instance?.stop();
      },
    });
  }

  {
    container.registerManaged({
      name: "alarmDriver",
      dependencies: ["doDispatch"],
      async start(resolve) {
        const { AlarmDriver } = await import("./services/alarmDriver.js");
        const driver = new AlarmDriver({
          doDispatch: assertPresent(resolve<import("./doDispatch.js").DODispatch>("doDispatch")),
          workspaceId: workspace.config.id,
        });
        alarmDriverInstance = driver;
        driver.start();
        return driver;
      },
      async stop(instance: import("./services/alarmDriver.js").AlarmDriver | null) {
        instance?.stop();
        alarmDriverInstance = null;
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
  // Set once the container constructs the manager (registered before
  // startAll below); the commonDeps closure resolves it lazily.
  let headlessHostManager: import("./headlessHostManager.js").HeadlessHostManager | null = null;
  const getHeadlessHostManager = () => headlessHostManager;
  const commonDeps = {
    container,
    dispatcher,
    entityCache,
    connectionGrants,
    workspace,
    workspacePath,
    workspaceConfig,
    treeScanner,
    adminToken,
    centralData: centralData ?? null,
    args,
    hostConfig,
    isIpcMode: !!ipcChannel,
    tokenManager,
    grantStore: capabilityGrantStore,
    panelRuntimeCoordinator,
    ensureDefaultHeadlessHost: async () => {
      const manager = getHeadlessHostManager();
      if (!manager) return false;
      return Boolean(await manager.ensureDefaultHost());
    },
    getGatewayPort: () => gatewayPortResolved,
    eventService,
    requestRelaunch,
    requestWorkspaceList,
    listWorkspaceUnits: () => {
      const buildSystem = container.get<import("./buildV2/index.js").BuildSystemV2>("buildSystem");
      type WorkspaceUnitStatus = import("./services/workspaceService.js").WorkspaceUnitStatus;
      const trustedRows: WorkspaceUnitStatus[] = trustedUnitHosts().flatMap(
        (host) => host.listWorkspaceUnits() as WorkspaceUnitStatus[]
      );
      const trustedRowsBySource = new Map<string, WorkspaceUnitStatus>(
        trustedRows.map((row) => [row.source, row])
      );
      const workerInstances = new Map(
        workerdManagerForGateway?.listInstances().map((instance) => [instance.source, instance]) ??
          []
      );
      const rows: import("./services/workspaceService.js").WorkspaceUnitStatus[] = [
        ...trustedRows.filter((row) => row.kind === "app"),
      ];
      for (const node of buildSystem?.getGraph().allNodes() ?? []) {
        if (node.kind !== "panel" && node.kind !== "worker" && node.kind !== "extension") continue;
        if (node.kind === "extension") {
          rows.push(
            trustedRowsBySource.get(node.relativePath) ?? {
              name: node.name,
              kind: "extension",
              source: node.relativePath,
              displayName: node.manifest.displayName ?? node.name,
              status: "stopped",
              ev: buildSystem?.getEffectiveVersion(node.name) ?? null,
              lastError: null,
              health: null,
              methods: [],
              hasFetch: false,
              respawn: null,
              inspectorUrl: null,
            }
          );
          continue;
        }
        const workerInstance =
          node.kind === "worker" ? workerInstances.get(node.relativePath) : null;
        const workerLastError =
          node.kind === "worker"
            ? (workerdManagerForGateway?.getLastWorkerError(node.relativePath) ?? null)
            : null;
        rows.push({
          name: node.name,
          kind: node.kind,
          source: node.relativePath,
          displayName: node.manifest.displayName ?? node.manifest.title ?? node.name,
          status: workerInstance
            ? workerInstance.status === "starting"
              ? "building"
              : workerInstance.status
            : workerLastError
              ? "error"
              : "available",
          lastError: workerLastError?.message ?? null,
          ev: workerInstance?.buildKey ?? buildSystem?.getEffectiveVersion(node.name) ?? null,
          inspectorUrl: workerInstance
            ? (workerdManagerForGateway?.getWorkerInspectorUrl(workerInstance.source) ?? null)
            : null,
          bindings:
            node.kind === "worker" && workerInstance
              ? ((workerInstance as { bindings?: Record<string, unknown> | null }).bindings ?? null)
              : null,
          lastBuiltAt: null,
          pendingApproval: null,
          availableUpdate: null,
        });
      }
      return rows;
    },
    restartWorkspaceUnit: async (
      ctx: import("@natstack/shared/serviceDispatcher").ServiceContext,
      name: string
    ) => {
      // Resolve by kind via the build graph so callers can use either the
      // package name or the workspace-relative source path. Extensions go
      // through the approval-gated reload; workers re-spawn through workerd's
      // config-reload path. Panels have no host-driven restart concept — a
      // panel restarts on the next page navigation.
      const extensionHost = extensionHostForGateway;
      if (extensionHost?.registry.get(name)) {
        await extensionHost.reload(ctx, name);
        return;
      }
      const appHost = appHostForGateway;
      if (
        appHost?.registry.get(name) ||
        appHost?.registry.list().some((entry) => entry.source.repo === name)
      ) {
        await appHost.restartApp(name);
        return;
      }
      const buildSystem = container.get<import("./buildV2/index.js").BuildSystemV2>("buildSystem");
      const node = buildSystem
        ?.getGraph()
        .allNodes()
        .find((candidate) => candidate.name === name || candidate.relativePath === name);
      if (!node) {
        throw new Error(`Workspace unit not found: ${name}`);
      }
      if (node.kind === "worker") {
        const workerdManager = workerdManagerForGateway;
        if (!workerdManager) throw new Error("Worker runtime is not available");
        const instance = workerdManager
          .listInstances()
          .find((entry) => entry.source === node.relativePath);
        if (!instance) {
          throw new Error(`Worker has no running instance to restart: ${node.relativePath}`);
        }
        await workerdManager.updateInstance(instance.name, {});
        return;
      }
      if (node.kind === "panel") {
        throw new Error(
          "Panels restart on next page navigation; no host-driven restart is available"
        );
      }
      throw new Error(`Workspace unit kind not restartable: ${node.kind}`);
    },
    listWorkspaceUnitLogs: (
      name: string,
      opts?: {
        since?: number;
        level?: import("./services/workspaceService.js").WorkspaceUnitLogRecord["level"];
        limit?: number;
      }
    ) => {
      // Resolve the unit kind from the build graph (the same surface
      // listWorkspaceUnits uses) and pull from the corresponding store.
      const buildSystem = container.get<import("./buildV2/index.js").BuildSystemV2>("buildSystem");
      const node = buildSystem
        ?.getGraph()
        .allNodes()
        .find((candidate) => candidate.name === name || candidate.relativePath === name);
      const kind = node?.kind;
      if (kind === "app") {
        return appHostForGateway?.listWorkspaceUnitLogs(name) ?? [];
      }
      if (kind === "worker") {
        const source = node?.relativePath ?? name;
        const persisted = runtimeDiagnostics.history(source, {
          since: opts?.since,
          level: opts?.level,
          limit: opts?.limit,
        });
        return persisted.entries.map((entry) => ({
          workspaceId: entry.workspaceId ?? workspace.config.id,
          unitName: source,
          kind: "worker" as const,
          timestamp: entry.timestamp,
          level: entry.level,
          message: entry.message,
          fields: entry.fields,
          source: entry.source === "system" ? "console" : entry.source,
        }));
      }
      if (kind === "panel") {
        // Panel console errors and lifecycle events are forwarded from the
        // shell via panelLog.append and keyed by package name.
        const persisted = runtimeDiagnostics.history(node?.name ?? name, {
          since: opts?.since,
          level: opts?.level,
          limit: opts?.limit,
        });
        return persisted.entries.map((entry) => ({
          workspaceId: entry.workspaceId ?? workspace.config.id,
          unitName: node?.name ?? name,
          kind: "panel" as const,
          timestamp: entry.timestamp,
          level: entry.level,
          message: entry.message,
          fields: entry.fields,
          source:
            entry.source === "system" || entry.source === "lifecycle" ? "console" : entry.source,
        }));
      }
      // Default and extension: the extension host has its own buffer and
      // also returns [] if the name is unknown.
      return extensionHostForGateway?.listWorkspaceUnitLogs(name, opts) ?? [];
    },
    unitDiagnostics: (
      name: string,
      opts?: {
        since?: number;
        sinceSeq?: number;
        level?: import("./services/workspaceService.js").WorkspaceUnitLogRecord["level"];
        limit?: number;
        errorLimit?: number;
      }
    ) => {
      const units = commonDeps.listWorkspaceUnits();
      const unit = units.find((row) => row.name === name || row.source === name) ?? null;
      const entityId = unit?.kind === "worker" ? unit.source : (unit?.name ?? name);
      const history = runtimeDiagnostics.history(entityId, {
        since: opts?.since,
        sinceSeq: opts?.sinceSeq,
        level: opts?.level,
        limit: opts?.limit,
        errorLimit: opts?.errorLimit,
      });
      const kind = unit?.kind ?? "worker";
      const toLog = (
        entry: import("./runtimeDiagnosticsStore.js").RuntimeDiagnosticRecord
      ): import("./services/workspaceService.js").WorkspaceUnitLogRecord => ({
        workspaceId: entry.workspaceId ?? workspace.config.id,
        unitName: entityId,
        kind,
        timestamp: entry.timestamp,
        level: entry.level,
        message: entry.message,
        fields: entry.fields,
        source: entry.source,
        seq: entry.seq,
      });
      const fallbackLogs = commonDeps.listWorkspaceUnitLogs(name, opts);
      const logs = history.entries.length > 0 ? history.entries.map(toLog) : fallbackLogs;
      const buildSystem = container.get<import("./buildV2/index.js").BuildSystemV2>("buildSystem");
      return {
        unit,
        logs,
        errors: history.errors.map(toLog),
        builds: buildSystem?.listRecentBuildEvents(unit?.name ?? name) ?? [],
        dropped: history.dropped,
        capacity: history.capacity,
      };
    },
    bakeAppDist: (sourceOrName: string, opts?: { outDir?: string }) => {
      const appHost = appHostForGateway;
      if (!appHost) throw new Error("App host is not available");
      return appHost.bakeDist(
        sourceOrName,
        opts?.outDir ?? path.join(appRoot, "dist", "baked-app")
      );
    },
    listAppVersions: (sourceOrName: string) => {
      const appHost = appHostForGateway;
      if (!appHost) return { current: null, previous: [], retentionLimit: 0 };
      return appHost.listAppVersions(sourceOrName);
    },
    rollbackAppVersion: (sourceOrName: string, buildKey?: string) => {
      const appHost = appHostForGateway;
      if (!appHost) throw new Error("App host is not available");
      return appHost.rollbackAppVersion(sourceOrName, buildKey);
    },
    listHostTargetCandidates: (target: import("@natstack/shared/hostTargets").HostTarget) => {
      const appHost = appHostForGateway;
      return appHost?.listHostTargetCandidates(target) ?? [];
    },
    getHostTargetSelection: (target: import("@natstack/shared/hostTargets").HostTarget) => {
      const appHost = appHostForGateway;
      return (
        appHost?.getHostTargetSelection(target) ?? {
          selection: null,
          valid: false,
          reason: "App host is not available",
        }
      );
    },
    setHostTargetSelection: (
      target: import("@natstack/shared/hostTargets").HostTarget,
      input: import("@natstack/shared/hostTargets").HostTargetSelectionInput
    ) => {
      const appHost = appHostForGateway;
      if (!appHost) throw new Error("App host is not available");
      return appHost.setHostTargetSelection(target, input);
    },
    clearHostTargetSelection: (target: import("@natstack/shared/hostTargets").HostTarget) => {
      appHostForGateway?.clearHostTargetSelection(target);
    },
    listHostTargetVersions: (
      target: import("@natstack/shared/hostTargets").HostTarget,
      sourceOrName: string
    ) => {
      const appHost = appHostForGateway;
      if (!appHost) return { current: null, previous: [], retentionLimit: 0 };
      return appHost.listHostTargetVersions(target, sourceOrName);
    },
    prepareHostTargetPinnedRef: (
      target: import("@natstack/shared/hostTargets").HostTarget,
      sourceOrName: string,
      ref: string
    ) => {
      const appHost = appHostForGateway;
      if (!appHost) throw new Error("App host is not available");
      return appHost.prepareHostTargetPinnedRef(target, sourceOrName, ref);
    },
    launchHostTarget: (target: import("@natstack/shared/hostTargets").HostTarget) => {
      const appHost = appHostForGateway;
      return (
        appHost?.launchHostTarget(target) ??
        ({
          status: "unavailable",
          launched: false,
          target,
          reason: "App host is not available",
          details: [],
        } satisfies import("@natstack/shared/hostTargets").HostTargetLaunchResult)
      );
    },
    approvalQueue,
    registerEntityTitleListener: (
      listener: (
        entityId: string,
        title: string | undefined,
        origin: "set" | "set-explicit" | "mirror" | "clear"
      ) => void | Promise<void>
    ) =>
      entityTitleService.onChanged((entityId, title, origin) => {
        void Promise.resolve(listener(entityId, title, origin)).catch((error: unknown) => {
          console.warn(
            `[entityTitleService] panel title listener failed: ${
              error instanceof Error ? error.message : String(error)
            }`
          );
        });
      }),
    getEffectiveVersion: async (source: string) => {
      const buildSystem = container.get<import("./buildV2/index.js").BuildSystemV2>("buildSystem");
      return buildSystem?.getEffectiveVersion(source) ?? undefined;
    },
  };
  await registerPanelServices(commonDeps);

  {
    const { createMetaService } = await import("./services/metaService.js");
    const { panelRuntimeSurface } = await import("@natstack/shared/runtimeSurface.panel");
    const { workerRuntimeSurface } = await import("@natstack/shared/runtimeSurface.worker");
    container.registerRpc(
      createMetaService({
        dispatcher,
        runtimeSurfaces: {
          panel: panelRuntimeSurface,
          workerRuntime: workerRuntimeSurface,
        },
      })
    );
  }

  if (!ipcChannel) {
    // Settings service for trusted remote hosts and mobile workspace apps.
    const { createSettingsServiceStandalone } =
      await import("./services/settingsServiceStandalone.js");
    container.registerRpc(createSettingsServiceStandalone({ dispatcher }));
  }

  // ── Per-workspace content-addressable blobstore ──
  {
    const { createBlobstoreService } = await import("./services/blobstoreService.js");
    const { createAuthService } = await import("./services/authService.js");
    const { serviceWithHttpRoutes } = await import("./serviceWithHttpRoutes.js");
    container.registerManaged(
      serviceWithHttpRoutes(
        createAuthService({
          tokenManager,
          deviceAuthStore,
          getServerBootId: () => serverBootId,
          getWorkspaceId: () => workspace.config.id,
          getConnectionInfo: () => {
            const gatewayPort = getResolvedGatewayPort("auth connection info");
            const protocol = gatewayProtocol();
            return {
              serverUrl: getExternalGatewayUrl("auth connection info"),
              publicUrl: getConfiguredPublicUrl(),
              protocol,
              externalHost: hostConfig.externalHost,
              gatewayPort,
            };
          },
          connectionGrants,
          auditLog,
          hasAppCapability: (callerId, capability) =>
            appHostForGateway?.hasAppCapability(callerId, capability) ?? false,
          ensureMobileAppReady: ensureMobileHostReadyForPairing,
          getMobileAppBootstrap: async (source) =>
            appHostForGateway?.getReactNativeBootstrap(source) ?? null,
          registerMobileAppPrincipal: (deviceId, source) =>
            appHostForGateway?.registerReactNativeAppPrincipal(deviceId, source) ?? null,
          retireMobileAppPrincipal: (deviceId) => {
            appHostForGateway?.retireReactNativeAppPrincipal(deviceId);
          },
        }),
        routeRegistry
      )
    );

    const blobsDir = path.join(getUserDataPath(), "blobs");
    container.registerManaged(
      serviceWithHttpRoutes(createBlobstoreService({ blobsDir }), routeRegistry)
    );
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
    getExtensionHttpHandler: () => extensionHostForGateway,
    getAppArtifactHandler: () => appHostForGateway,
    getWorkerdPort: () => workerdManagerForGateway?.getPort() ?? null,
    getWorkerHost: () => workerdManagerForGateway,
    externalHost: hostConfig.externalHost,
    bindHost: hostConfig.bindHost,
    tlsCert: hostConfig.tlsCert,
    tlsKey: hostConfig.tlsKey,
    adminToken,
    workerdGatewayToken,
    getWorkerdDispatchSecret: () => workerdManagerForGateway?.getDispatchSecret() ?? null,
    tokenManager,
    connectionGrants,
    entityCache,
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
        product: "natstack",
        discoveryVersion: 1,
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
    args.noVpnDetect || process.env["NATSTACK_NO_VPN_DETECT"] === "1" || !!explicitOverride;
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
        let detectedVpn = await detectVpnPublicUrl().catch(() => null);
        if (!detectedVpn) {
          const { detectHttpsServePublicUrl } = await import("./tailscaleServe.js");
          const serveUrl = await detectHttpsServePublicUrl({ port: gatewayPort }).catch(() => null);
          if (serveUrl) {
            detectedVpn = {
              vendor: "tailscale",
              hostname: serveUrl.hostname,
              url: serveUrl.url,
              raw: { source: "tailscale-serve-status" },
            };
          }
        }
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
          }).catch(
            (err) =>
              ({
                kind: "error",
                message: err instanceof Error ? err.message : String(err),
              }) as import("./tailscaleServe.js").ServeProvisionResult
          );
          if (
            serveProvision.kind === "configured" ||
            serveProvision.kind === "already-configured"
          ) {
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

  // ── Workerd inspector bridge + service (userland profiling of workers/DOs) ──
  {
    let workerdInspectorDefinition:
      | import("@natstack/shared/serviceDefinition").ServiceDefinition
      | null = null;
    container.registerManaged({
      name: "workerdInspector",
      dependencies: ["workerdManager", "panelHttpServer"],
      async start(resolve) {
        const workerdManager = assertPresent(
          resolve<import("./workerdManager.js").WorkerdManager>("workerdManager")
        );
        const { server } = assertPresent(
          resolve<{ server: import("./panelHttpServer.js").PanelHttpServer }>("panelHttpServer")
        );
        const { WorkerdInspectorBridge } = await import("./workerdInspectorBridge.js");
        const bridge = new WorkerdInspectorBridge({
          getInspectorUrl: () => workerdManager.getInspectorUrl(),
          protocol: hostConfig.protocol,
          externalHost: hostConfig.externalHost,
          port: gatewayPort,
        });
        server.setWorkerdInspectorBridge(bridge);
        // Inspector sessions cannot survive a workerd restart — close them
        // eagerly so clients fail fast instead of hanging on a dead socket.
        workerdManager.onRestartBegin(() => bridge.closeAll());
        const { createWorkerdInspectorService } =
          await import("./services/workerdInspectorService.js");
        workerdInspectorDefinition = createWorkerdInspectorService({
          approvalQueue,
          grantStore: capabilityGrantStore,
          listTargets: () => bridge.listTargets(),
          getEndpoint: (targetPath, principalId) => bridge.getEndpoint(targetPath, principalId),
        });
        return bridge;
      },
      async stop(instance: import("./workerdInspectorBridge.js").WorkerdInspectorBridge) {
        instance?.stop();
      },
      getServiceDefinition() {
        if (!workerdInspectorDefinition) throw new Error("workerdInspector not initialized");
        return workerdInspectorDefinition;
      },
    });
  }

  // ── Headless host auto-spawn (renderer of last resort) ──
  {
    // Default ON but lazy: server-created browser panels may need a CDP host
    // even when the Electron desktop is connected, because desktop clients are
    // not lease-assignment defaults. Env/flag override both ways.
    const envAutospawn = process.env["NATSTACK_HEADLESS_HOST_AUTOSPAWN"];
    const autospawnEnabled = resolveHeadlessHostAutospawn({
      cliValue: args.headlessHostAutospawn,
      envValue: envAutospawn,
    });
    container.registerManaged({
      name: "headlessHostManager",
      dependencies: ["cdpBridge"],
      async start(resolve) {
        const cdpBridge = assertPresent(resolve<import("./cdpBridge.js").CdpBridge>("cdpBridge"));
        const { HeadlessHostManager } = await import("./headlessHostManager.js");
        const manager = new HeadlessHostManager({
          tokenManager,
          coordinator: panelRuntimeCoordinator,
          isHostAvailable: (hostConnectionId) => cdpBridge.isProviderConnected(hostConnectionId),
          getServerUrl: () => `http://127.0.0.1:${gatewayPort}`,
          config: { enabled: autospawnEnabled },
        });
        headlessHostManager = manager;
        return manager;
      },
      async stop(instance: import("./headlessHostManager.js").HeadlessHostManager) {
        await instance?.stop();
      },
    });
  }

  // ── Start all services in dependency order ──
  await container.startAll();
  // Settle VPN setup before printing the readiness banner (so the operator
  // sees the auto-detected Mobile URL line if one is available).
  const { detectedVpn, serveProvision, publicUrlVerified, publicUrlReachabilityReason } =
    await vpnSetupPromise;
  const requirePublicUrl =
    args.requirePublicUrl || process.env["NATSTACK_REQUIRE_PUBLIC_URL"] === "1";
  let requiredPublicUrlVerified = publicUrlVerified;
  let requiredPublicUrlReachabilityReason = publicUrlReachabilityReason;
  if (requirePublicUrl && explicitOverride) {
    if (!explicitOverride.startsWith("https://")) {
      requiredPublicUrlVerified = false;
      requiredPublicUrlReachabilityReason = "required public URL must use https://";
    } else {
      const { probeHttpsReachable } = await import("./tailscaleServe.js");
      const reachability = await probeHttpsReachable(explicitOverride).catch((error) => ({
        ok: false,
        reason: error instanceof Error ? error.message : String(error),
      }));
      requiredPublicUrlVerified = reachability.ok;
      requiredPublicUrlReachabilityReason = reachability.ok ? undefined : reachability.reason;
      markPublicUrlVerified(reachability.ok);
    }
  }
  if (requirePublicUrl && !requiredPublicUrlVerified) {
    const publicUrl = explicitOverride ?? detectedVpn?.url;
    const lines = [
      "This server was started with a required public pairing URL, but NatStack",
      "could not verify one. Refusing to continue so clients do not pair against",
      "a fallback URL by mistake.",
      "",
      publicUrl ? `Public URL: ${publicUrl}` : "Public URL: not detected",
      requiredPublicUrlReachabilityReason
        ? `Last check: ${requiredPublicUrlReachabilityReason}`
        : "",
      explicitOverride
        ? "Use a reachable https:// public URL, or remove --require-public-url."
        : "",
      serveProvision?.kind === "permission-denied"
        ? "Tailscale denied Serve configuration. Run:"
        : "",
      serveProvision?.kind === "permission-denied" ? "  sudo tailscale set --operator=$USER" : "",
      serveProvision?.kind === "permission-denied"
        ? `  sudo tailscale serve --bg ${gatewayPort}`
        : "",
      serveProvision?.kind === "serve-feature-disabled"
        ? "Enable Tailscale Serve, then restart this command."
        : "",
      serveProvision?.kind === "https-feature-disabled"
        ? "Enable Tailscale HTTPS certificates, then restart this command."
        : "",
      serveProvision?.kind === "skipped-conflict"
        ? `Existing Serve config conflicts: ${serveProvision.reason}`
        : "",
      serveProvision?.kind === "error" ? `Tailscale error: ${serveProvision.message}` : "",
      "",
      "After fixing Tailscale Serve, restart the pair command.",
    ].filter((line) => line !== "");
    printReadinessActionBlock("Required public URL is not ready", lines);
    process.exit(1);
  }

  const workerdManager =
    container.get<import("./workerdManager.js").WorkerdManager>("workerdManager");

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
  rpcServerInstance.setWorkerdDispatchSecret(workerdManager.getDispatchSecret());
  rpcServerInstance.setEnsureDO((source, className, objectKey) => {
    const targetId = canonicalEntityId({ kind: "do", source, className, key: objectKey });
    const record = entityCache.resolveActive(targetId);
    return workerdManager.ensureDO(source, className, objectKey, {
      contextId: record?.contextId,
    });
  });

  dispatcher.markInitialized();

  // ===========================================================================
  // WorkspaceDO bootstrap reconciliation
  // (see plan §6 singleton reconciliation, §9 restart revival, §11 GC safety)
  // ===========================================================================
  const doDispatchForBootstrap = container.get<import("./doDispatch.js").DODispatch>("doDispatch");
  const workspaceDORefForBootstrap: import("./doDispatch.js").DORef = {
    source: (await import("./internalDOs/internalDoLoader.js")).INTERNAL_DO_SOURCE,
    className: "WorkspaceDO",
    objectKey: workspace.config.id,
  };
  const dispatchWorkspaceDO = <T>(method: string, ...args: unknown[]) =>
    doDispatchForBootstrap.dispatch(workspaceDORefForBootstrap, method, ...args) as Promise<T>;

  // Steps 1-3 (hydrate, incomplete-cleanup reconcile, GC safety sweep) are
  // factored into `runStartupReconciliation` so both the boot path and tests
  // can call them.
  const { runStartupReconciliation } = await import("./services/startupReconciliation.js");
  const lifecycleDriver =
    container.get<import("./services/lifecycleDriver.js").LifecycleDriver>("lifecycleDriver");
  const reconciliation = await runStartupReconciliation({
    dispatchWorkspaceDO,
    entityCache,
    recoverLifecycle: () => lifecycleDriver.recoverStartup("server_restart"),
    logger: { warn: (msg, ...args) => console.warn(msg, ...args) },
  });
  // Re-arm server-driven DO alarms now that workerd is up and WorkspaceDO is
  // reachable (the managed-service start() ran before workerd was ready).
  try {
    container.get<import("./services/alarmDriver.js").AlarmDriver>("alarmDriver").notifyChanged();
  } catch (err) {
    console.warn("[Bootstrap] alarm re-arm skipped:", err);
  }

  // Re-register bootstrap entries that don't have DO rows.
  entityCache.registerBootstrap({ id: "server", kind: "server" });
  entityCache.registerBootstrap({ id: "electron-main", kind: "shell" });
  if (reconciliation.incompleteCleanupIds.length > 0) {
    console.log(
      `[Bootstrap] Reconciled ${reconciliation.incompleteCleanupIds.length} incomplete cleanup(s): ${reconciliation.incompleteCleanupIds.join(
        ", "
      )}`
    );
  }

  // 4. Singleton reconciliation against natstack.yml.singletonObjects.
  try {
    const { createHash } = await import("node:crypto");
    const { canonicalEntityId } = await import("@natstack/shared/runtime/entitySpec");
    type EntityRecord = import("@natstack/shared/runtime/entitySpec").EntityRecord;
    const declaredKeys = new Set<string>();
    for (const decl of workspaceDecls.singletons.all()) {
      const contextId =
        decl.contextId ??
        createHash("sha256")
          .update(`${workspace.config.id}\x00${decl.source}\x00${decl.className}\x00${decl.key}`)
          .digest("hex");
      const targetId = canonicalEntityId({
        kind: "do",
        source: decl.source,
        className: decl.className,
        key: decl.key,
      });
      declaredKeys.add(targetId);
      try {
        const prepared = await workerdManager.ensureDurableObjectEntity({
          source: decl.source,
          className: decl.className,
          key: decl.key,
          contextId,
          ref: decl.contextId ? undefined : "main",
        });
        const record = await dispatchWorkspaceDO<EntityRecord>("entityActivate", {
          kind: "do",
          source: { repoPath: decl.source, effectiveVersion: prepared.effectiveVersion },
          contextId,
          className: decl.className,
          key: decl.key,
        });
        entityCache._onActivate(record);
      } catch (err) {
        console.warn(
          `[Bootstrap] Singleton activate failed for ${decl.source}:${decl.className}:${decl.key}:`,
          err
        );
      }
    }
    void declaredKeys;
  } catch (err) {
    console.warn("[Bootstrap] Singleton reconciliation failed:", err);
  }

  // 5. Start cleanup reaper to retry partial-failed hooks.
  const { createCleanupReaper } = await import("./services/cleanupReaper.js");
  const cleanupReaper = createCleanupReaper({
    doDispatch: doDispatchForBootstrap,
    workspaceDORef: workspaceDORefForBootstrap,
    onRetire: async (record) => {
      await cleanupRuntimeEntityRecord(record);
    },
    logger: { warn: (msg, ...args) => console.warn(msg, ...args) },
  });
  cleanupReaper.start();

  let syncDeclaredRemotesAfterStartupReload = false;
  do {
    if (pendingStartupMetaConfigReload) {
      try {
        replaceWorkspaceConfig(workspaceConfig, loadWorkspaceConfig(workspacePath));
        syncDeclaredRemotesAfterStartupReload = true;
      } catch (err) {
        console.warn(
          "[GitRemotes] Failed to reload workspace config before startup reconcile:",
          err
        );
      }
      pendingStartupMetaConfigReload = false;
    }
    await reconcileDeclaredWorkspaceUnits(workspaceConfig, "startup");
  } while (pendingStartupMetaConfigReload);
  initialWorkspaceUnitReconcileComplete = true;
  if (syncDeclaredRemotesAfterStartupReload) {
    syncDeclaredRemotesForSource().catch((err: unknown) =>
      console.warn("[GitRemotes] Failed to sync declared remotes after startup config reload:", err)
    );
  }

  if (requireMobileReady) {
    const readiness = await ensureMobileHostReadyForPairing();
    if (!readiness?.ready) {
      printReadinessActionBlock("React Native mobile app is not ready", [
        "This server was started with mobile pairing enabled, but the",
        "workspace-owned React Native app is not ready to serve to the native host.",
        "",
        readiness?.reason ?? "App host is not available",
        ...(readiness?.source ? [`Source: ${readiness.source}`] : []),
        ...(readiness?.appId ? [`App: ${readiness.appId}`] : []),
        ...(readiness?.details?.length ? ["", ...readiness.details] : []),
        "",
        "Fix the blocking app/extension build above, then restart this command.",
      ]);
      process.exit(1);
    }
    console.log(
      `[Mobile] React Native app ready${readiness.appId ? `: ${readiness.appId} (${readiness.source ?? "unknown"}) build ${readiness.buildKey ?? "unknown"}` : ""}`
    );
  }
  if (requireElectronReady) {
    const appHost = container.get<import("./appHost.js").AppHost>("appHost");
    const readiness = await appHost.ensureElectronReady();
    if (!readiness.ready) {
      printReadinessActionBlock("Electron desktop shell app is not ready", [
        "This server was started with desktop pairing enabled, but the",
        "workspace-owned Electron shell app is not ready to serve to desktop clients.",
        "",
        readiness.reason ?? "App host is not available",
        ...(readiness.source ? [`Source: ${readiness.source}`] : []),
        ...(readiness.appId ? [`App: ${readiness.appId}`] : []),
        ...(readiness.details.length ? ["", ...readiness.details] : []),
        "",
        "Fix the blocking app build above, then restart this command.",
      ]);
      process.exit(1);
    }
    console.log(
      `[Desktop] Electron shell app ready: ${readiness.appId} (${readiness.source}) build ${readiness.buildKey}`
    );
  }

  // ===========================================================================
  // Report ready
  // ===========================================================================

  const workerdMgr = container.get<import("./workerdManager.js").WorkerdManager>("workerdManager");

  if (ipcChannel) {
    // The in-process Electron main retains kind:"shell" for its synchronous
    // service dispatch; for the WS connection it uses kind:"shell-remote",
    // which the WS-handshake invariant in rpcServer accepts while rejecting
    // bare kind:"shell".
    const shellToken = tokenManager.ensureToken("electron-main", "shell-remote");
    ipcChannel.postMessage({
      type: "ready",
      workerdPort: workerdMgr?.getPort() ?? 0,
      gatewayPort,
      adminToken,
      shellToken,
    });
  } else {
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
    const explicitPublicUrl = args.publicUrl ?? process.env["NATSTACK_PUBLIC_URL"];
    const pairingTargetUrl = getConnectUrl("readiness pairing URL");
    console.log("natstack-server ready:");
    console.log(`  Workspace:   ${workspaceName}${workspaceIsEphemeral ? " (ephemeral dev)" : ""}`);
    console.log(`  Gateway:     ${proto}://${hostConfig.externalHost}:${gatewayPort}`);
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
        console.log(
          `  Public URL:  ${publicUrlForBanner} ${publicUrlLabel} (${reachabilityLabel})`
        );
        if (publicUrlVerified) {
          // Single canonical URL for QR pairing, panel chrome, and OAuth.
          // mobile-pair prefers this line over Gateway: when present.
          console.log(`  Mobile URL:  ${publicUrlForBanner}`);
        }
        console.log(`  OAuth callback (register with each provider):`);
        console.log(`    ${publicUrlForBanner}/_r/s/credentials/oauth/callback`);
        if (serveProvision?.kind === "configured") {
          if (publicUrlVerified) {
            console.log(
              `  Tailscale: configured \`tailscale serve\` to forward https://${detectedVpn?.hostname}/ → 127.0.0.1:${gatewayPort}.`
            );
            console.log(
              `             Persistent across reboots; remove with \`tailscale serve reset\`.`
            );
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
              `  natstack mobile pair --host tailscale --port ${gatewayPort}`,
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
            `  natstack mobile pair --host tailscale --port ${gatewayPort}`,
            "",
            "Manual alternative for this port only:",
            `  sudo tailscale serve --bg ${gatewayPort}`,
            "Then run:",
            `  natstack mobile pair --host tailscale --port ${gatewayPort}`,
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
            `  natstack mobile pair --host tailscale --port ${gatewayPort}`,
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
            `  natstack mobile pair --host tailscale --port ${gatewayPort}`,
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
            `  natstack mobile pair --host tailscale --port ${gatewayPort}`,
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
            `  natstack mobile pair --host tailscale --port ${gatewayPort}`,
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
      if (startupQrPairingCode) {
        console.log(`  QR pairing code: ${startupQrPairingCode}`);
      }
      console.log(
        `  Pairing TTL:  ${Math.round(DEFAULT_PAIRING_CODE_TTL_MS / 60_000)} minutes (server exits if unused)`
      );
      console.log(formatPairUrlLine(pairingTargetUrl, startupPairingCode));
    }

    if (args.readyFile) {
      const readyPayload = {
        workspaceName,
        workspaceId: workspace.config.id,
        workspaceDir: workspacePath,
        isEphemeral: workspaceIsEphemeral,
        gatewayUrl: `${proto}://${hostConfig.externalHost}:${gatewayPort}`,
        rpcUrl: `${wsProto}://${hostConfig.externalHost}:${gatewayPort}/rpc`,
        workerdUrl: `${proto}://${hostConfig.externalHost}:${gatewayPort}/_w/`,
        publicUrl: explicitPublicUrl ?? detectedVpn?.url ?? null,
        connectUrl: pairingTargetUrl,
        adminToken,
        pairingCode: startupPairingCode,
        qrPairingCode: startupQrPairingCode,
        pairingCodes: {
          desktop: startupPairingCode,
          mobile: startupQrPairingCode,
          qr: startupQrPairingCode,
        },
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
      if (startupQrPairingCode) console.log(`NATSTACK_QR_PAIRING_CODE=${startupQrPairingCode}`);
    }
  }

  // ===========================================================================
  // Graceful shutdown — container.stopAll() handles everything
  // ===========================================================================

  let isShuttingDown = false;
  let startupPairingExpiryTimer: NodeJS.Timeout | null = null;

  async function shutdown() {
    if (isShuttingDown) return;
    isShuttingDown = true;
    console.log("[Server] Shutting down...");

    const lifecycleDriver =
      container.get<import("./services/lifecycleDriver.js").LifecycleDriver>("lifecycleDriver");
    const shutdownStartedAt = Date.now();
    const forceExit = setTimeout(() => {
      console.warn("[Server] Shutdown timeout — forcing exit");
      process.exit(1);
    }, 8000);

    cleanupReaper.stop();
    if (startupPairingExpiryTimer) {
      clearTimeout(startupPairingExpiryTimer);
      startupPairingExpiryTimer = null;
    }

    const prepareBudgetMs = Math.max(0, Math.min(2000, 8000 - (Date.now() - shutdownStartedAt)));
    if (prepareBudgetMs > 0) {
      await lifecycleDriver
        .prepareForShutdown(prepareBudgetMs)
        .catch((err) => console.warn("[Server] lifecycle shutdown prepare failed:", err));
    }

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
    ipcChannel.onDisconnect(() => void shutdown());
    process.on("SIGTERM", () => void shutdown());
    process.on("SIGINT", () => void shutdown());
  } else {
    if (startupPairingCodes.length > 0) {
      startupPairingExpiryTimer = setTimeout(() => {
        const allStartupCodesStillPending = startupPairingCodes.every((code) =>
          deviceAuthStore.hasPendingPairingCode(code)
        );
        if (!allStartupCodesStillPending) return;
        console.warn(
          `[Server] Startup pairing code expired after ${Math.round(
            DEFAULT_PAIRING_CODE_TTL_MS / 60_000
          )} minutes without being used; shutting down. Restart the pair command to print a fresh code.`
        );
        void shutdown();
      }, DEFAULT_PAIRING_CODE_TTL_MS);
      startupPairingExpiryTimer.unref?.();
    }
    process.on("SIGTERM", () => void shutdown());
    process.on("SIGINT", () => void shutdown());
  }
}

function collectWorkspaceUnitPaths(
  nodes: Array<{ path: string; isUnit: boolean; children: unknown[] }>
): string[] {
  const units: string[] = [];
  for (const node of nodes) {
    if (node.isUnit) units.push(node.path);
    units.push(
      ...collectWorkspaceUnitPaths(
        node.children as Array<{ path: string; isUnit: boolean; children: unknown[] }>
      )
    );
  }
  return units;
}

function replaceWorkspaceConfig<T extends object>(target: T, next: T): void {
  const mutableTarget = target as Record<string, unknown>;
  for (const key of Object.keys(mutableTarget)) {
    deleteDynamicProperty(mutableTarget, key);
  }
  Object.assign(target, next);
}

function parseGatewayAliases(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (Array.isArray(parsed)) {
      return parsed.filter(
        (entry): entry is string => typeof entry === "string" && entry.length > 0
      );
    }
  } catch {
    // Fall through to comma-separated env syntax.
  }
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

main().catch((err) => {
  if (ipcChannel) {
    ipcChannel.postMessage({ type: "error", message: String(err) });
  }
  console.error("Fatal:", err);
  process.exit(1);
});
