/**
 * ServerSession — server connection establishment.
 *
 * Subsumes local spawn vs remote connect and workspace info fetch.
 * Returns a single SessionConnection
 * with everything needed to continue startup.
 */

import { dialog, app } from "electron";
import { createDevLogger } from "@natstack/dev-log";
import { getAppRoot } from "./paths.js";
import { ServerProcessManager, type ServerPorts } from "./serverProcessManager.js";
import { createServerClient, type ServerClient, type ConnectionStatus } from "./serverClient.js";
import type { PanelHttpServerLike, ServerInfoLike } from "@natstack/shared/panelInterfaces";
import type { ServerInfo } from "./serverInfo.js";
import type { WorkspaceConfig } from "@natstack/shared/workspace/types";
import type { CentralDataManager } from "@natstack/shared/centralData";
import type { StartupMode } from "./startupMode.js";

const log = createDevLogger("ServerSession");

export interface SessionConnection {
  protocol: "http" | "https";
  rpcPort: number;
  gatewayPort: number;
  externalHost: string;
  rpcWsUrl: string;
  pubsubUrl: string;
  gitBaseUrl: string;
  workerdPort: number;
  workspaceId: string;
  workspacePath: string;
  statePath: string;
  workspaceConfig: WorkspaceConfig;
  serverClient: ServerClient;
  serverProcessManager: ServerProcessManager | null;
  panelHttpServer: PanelHttpServerLike;
  serverInfo: ServerInfo;
}

/**
 * Build the ServerInfo object that provides token management and RPC proxying.
 */
function buildServerInfo(
  ports: ServerPorts,
  externalHost: string,
  protocol: "http" | "https",
  rpcWsUrl: string,
  pubsubUrl: string,
  gitBaseUrl: string,
  getClient: () => ServerClient,
): ServerInfo {
  return {
    rpcPort: ports.rpcPort,
    rpcWsUrl,
    pubsubUrl,
    gitBaseUrl,
    workerdPort: ports.workerdPort ?? 0,
    externalHost,
    gatewayPort: ports.gatewayPort ?? ports.panelHttpPort ?? ports.rpcPort,
    protocol,
    createPanelToken: (panelId, kind) =>
      getClient().call("tokens", "create", [panelId, kind]) as Promise<string>,
    ensurePanelToken: (panelId, kind) =>
      getClient().call("tokens", "ensure", [panelId, kind]) as Promise<string>,
    revokePanelToken: (panelId) =>
      getClient().call("tokens", "revoke", [panelId]) as Promise<void>,
    getPanelToken: (panelId) =>
      getClient().call("tokens", "get", [panelId]) as Promise<string | null>,
    getGitTokenForPanel: (panelId) =>
      getClient().call("git", "getTokenForPanel", [panelId]) as Promise<string>,
    revokeGitToken: (panelId) =>
      getClient().call("git", "revokeTokenForPanel", [panelId]) as Promise<void>,
    getWorkspaceTree: () =>
      getClient().call("git", "getWorkspaceTree", []),
    listBranches: (repoPath) =>
      getClient().call("git", "listBranches", [repoPath]),
    listCommits: (repoPath, ref, limit) =>
      getClient().call("git", "listCommits", [repoPath, ref, limit]),
    resolveRef: (repoPath, ref) =>
      getClient().call("git", "resolveRef", [repoPath, ref]) as Promise<string>,
    call: (service, method, args) =>
      getClient().call(service, method, args),
  };
}

/**
 * Establish a server session — either by spawning a local server or connecting to remote.
 */
export async function establishServerSession(args: {
  mode: StartupMode;
  centralData: CentralDataManager;
  onServerEvent: (event: string, payload: unknown) => void;
  onConnectionStatusChanged?: (status: ConnectionStatus) => void;
  onIpcRequest?: (type: string, msg: Record<string, unknown>) => Promise<Record<string, unknown> | null>;
}): Promise<SessionConnection> {
  const { mode, onServerEvent } = args;

  let serverClient: ServerClient;
  let serverProcessManager: ServerProcessManager | null = null;
  let ports: ServerPorts;
  let protocol: "http" | "https";
  let externalHost: string;
  let rpcWsUrl: string;
  let pubsubUrl: string;
  let gitBaseUrl: string;

  if (mode.kind === "remote") {
    // Remote mode: connect to existing server with automatic reconnection
    const { remoteUrl, adminToken, tls } = mode;
    externalHost = remoteUrl.hostname;
    protocol = remoteUrl.protocol === "https:" ? "https" : "http";
    const remotePort = parseInt(remoteUrl.port) || (protocol === "https" ? 443 : 80);
    rpcWsUrl = `${protocol === "https" ? "wss" : "ws"}://${externalHost}:${remotePort}/rpc`;
    pubsubUrl = `${protocol === "https" ? "wss" : "ws"}://${externalHost}:${remotePort}/_w/workers/pubsub-channel/PubSubChannel`;
    gitBaseUrl = `${protocol}://${externalHost}:${remotePort}/_git`;

    serverClient = await createServerClient(remotePort, adminToken, {
      wsUrl: rpcWsUrl,
      tls,
      reconnect: true,
      maxReconnectAttempts: 10,
      onConnectionStatusChanged: (status) => {
        args.onConnectionStatusChanged?.(status);
      },
      onDisconnect: () => {
        // Called only after all reconnection attempts are exhausted
        dialog.showErrorBox(
          "Remote Server Disconnected",
          "The connection to the remote NatStack server was lost and could not be re-established after multiple attempts. The app will now exit."
        );
        app.exit(1);
      },
      onEvent: onServerEvent,
    });

    ports = {
      rpcPort: remotePort,
      gitPort: remotePort,
      workerdPort: remotePort,
      gatewayPort: remotePort,
      adminToken,
    };
    log.info(`[Server] Connected to remote server at ${remoteUrl.href}`);
  } else {
    // Local mode: spawn server as child process
    protocol = "http";
    externalHost = "localhost";

    serverProcessManager = new ServerProcessManager({
      wsDir: mode.wsDir,
      appRoot: getAppRoot(),
      isEphemeral: mode.isEphemeral,
      onCrash: (code) => {
        console.error(`[App] Server process crashed with code ${code}`);
        dialog.showErrorBox(
          "Server Process Crashed",
          "The NatStack server process exited unexpectedly. The app will now restart."
        );
        app.relaunch();
        app.exit(1);
      },
      onIpcRequest: async (type, msg) => {
        if (type === "workspace-list-request") {
          return { workspaces: args.centralData.listWorkspaces() };
        }
        const delegated = await args.onIpcRequest?.(type, msg);
        if (delegated) return delegated;
        return null;
      },
      onRelaunch: (name) => {
        // workspace.select on the server side asked us to relaunch into a
        // different workspace. Strip any existing --workspace=<...> args from
        // process.argv and add the new one, then relaunch + exit cleanly.
        const filteredArgs: string[] = [];
        const rawArgs = process.argv.slice(1);
        for (let i = 0; i < rawArgs.length; i++) {
          const arg = rawArgs[i];
          if (arg === "--workspace" && i + 1 < rawArgs.length) {
            i++; // skip the value
            continue;
          }
          if (arg && arg.startsWith("--workspace=")) continue;
          if (arg !== undefined) filteredArgs.push(arg);
        }
        filteredArgs.push("--workspace", name);
        log.info(`[App] Relaunching into workspace "${name}"`);
        app.relaunch({ args: filteredArgs });
        app.exit(0);
      },
    });

    ports = await serverProcessManager.start();
    log.info(`[Server] Child process started (RPC: ${ports.rpcPort}, Git: ${ports.gitPort})`);
    rpcWsUrl = `ws://127.0.0.1:${ports.rpcPort}`;
    pubsubUrl = ports.workerdPort
      ? `ws://127.0.0.1:${ports.workerdPort}/_w/workers/pubsub-channel/PubSubChannel`
      : "";
    gitBaseUrl = `http://127.0.0.1:${ports.gitPort}`;

    serverClient = await createServerClient(ports.rpcPort, ports.adminToken, {
      onDisconnect: () => {
        console.error("[App] Server process disconnected");
      },
      onEvent: onServerEvent,
    });
  }

  log.info("[Server] Admin client connected");

  const getClient = () => serverClient;
  const serverInfo = buildServerInfo(
    ports,
    externalHost,
    protocol,
    rpcWsUrl,
    pubsubUrl,
    gitBaseUrl,
    getClient,
  );

  // Get workspace metadata from server
  const wsInfo = await serverClient.call("workspace", "getInfo", []) as {
    path: string; statePath: string; contextsPath: string;
    config: WorkspaceConfig;
  };
  log.info(`[Workspace] Server workspace: ${wsInfo.config.id}`);

  const gatewayPort = ports.gatewayPort ?? ports.panelHttpPort ?? 0;
  const panelHttpServer: PanelHttpServerLike = {
    hasBuild: () => false,
    invalidateBuild: () => {},
    getPort: () => gatewayPort,
  };

  return {
    protocol,
    rpcPort: ports.rpcPort,
    gatewayPort,
    externalHost,
    rpcWsUrl,
    pubsubUrl,
    gitBaseUrl,
    workerdPort: ports.workerdPort ?? 0,
    workspaceId: wsInfo.config.id,
    workspacePath: wsInfo.path,
    /** The server's own state directory — lives on the remote filesystem.
     *  Do NOT use for local I/O; use getRemoteUserDataDir() instead. */
    statePath: wsInfo.statePath,
    workspaceConfig: wsInfo.config,
    serverClient,
    serverProcessManager,
    panelHttpServer,
    serverInfo,
  };
}
