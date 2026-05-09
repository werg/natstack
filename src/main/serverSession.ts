/**
 * ServerSession — server connection establishment.
 *
 * Subsumes local spawn vs remote connect and workspace info fetch.
 * Returns a single SessionConnection
 * with everything needed to continue startup.
 */

import { dialog, app } from "electron";
import * as fs from "fs";
import * as http from "http";
import * as https from "https";
import { createDevLogger } from "@natstack/dev-log";
import { getAppRoot } from "./paths.js";
import { ServerProcessManager, type ServerPorts } from "./serverProcessManager.js";
import {
  createServerClient,
  type ServerClient,
  type ConnectionStatus,
  type TlsPinningOptions,
} from "./serverClient.js";
import { createPinnedHttpsAgent } from "./tlsPinning.js";
import type { PanelHttpServerLike } from "@natstack/shared/panelInterfaces";
import type { ServerInfo } from "./serverInfo.js";
import type { WorkspaceConfig } from "@natstack/shared/workspace/types";
import type { CentralDataManager } from "@natstack/shared/centralData";
import type { StartupMode } from "./startupMode.js";

const log = createDevLogger("ServerSession");

export interface SessionConnection {
  protocol: "http" | "https";
  gatewayPort: number;
  externalHost: string;
  gatewayConfig: { serverUrl: string };
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
  gatewayConfig: { serverUrl: string },
  getClient: () => ServerClient
): ServerInfo {
  return {
    gatewayConfig,
    workerdPort: ports.workerdPort ?? 0,
    externalHost,
    gatewayPort: ports.gatewayPort,
    protocol,
    getWorkspaceTree: () => getClient().call("git", "getWorkspaceTree", []),
    listBranches: (repoPath) => getClient().call("git", "listBranches", [repoPath]),
    listCommits: (repoPath, ref, limit) =>
      getClient().call("git", "listCommits", [repoPath, ref, limit]),
    resolveRef: (repoPath, ref) =>
      getClient().call("git", "resolveRef", [repoPath, ref]) as Promise<string>,
    call: (service, method, args) => getClient().call(service, method, args),
  };
}

async function exchangeAdminForShell(
  remoteUrl: URL,
  adminToken: string,
  tls?: TlsPinningOptions
): Promise<string> {
  const exchangeUrl = new URL("/_r/s/auth/exchange-admin-for-shell", remoteUrl);
  const body = JSON.stringify({ callerId: "electron-remote" });
  const responseBody = await new Promise<{
    statusCode: number;
    statusMessage: string;
    body: string;
  }>((resolve, reject) => {
    const isHttps = exchangeUrl.protocol === "https:";
    const agent =
      isHttps && tls?.fingerprint
        ? createPinnedHttpsAgent(tls.fingerprint)
        : isHttps && tls?.caPath
          ? new https.Agent({ ca: fs.readFileSync(tls.caPath) })
          : undefined;
    const req = (isHttps ? https : http).request(
      exchangeUrl,
      {
        method: "POST",
        agent,
        headers: {
          Authorization: `Bearer ${adminToken}`,
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          resolve({
            statusCode: res.statusCode ?? 0,
            statusMessage: res.statusMessage ?? "",
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      }
    );
    req.on("error", reject);
    req.end(body);
  });
  const json = JSON.parse(responseBody.body || "{}") as { token?: unknown; error?: unknown };
  if (
    responseBody.statusCode < 200 ||
    responseBody.statusCode >= 300 ||
    typeof json.token !== "string"
  ) {
    throw new Error(
      `Failed to exchange admin token for shell token (${responseBody.statusCode}): ${
        typeof json.error === "string" ? json.error : responseBody.statusMessage
      }`
    );
  }
  return json.token;
}

/**
 * Establish a server session — either by spawning a local server or connecting to remote.
 */
export async function establishServerSession(args: {
  mode: StartupMode;
  centralData: CentralDataManager;
  onServerEvent: (event: string, payload: unknown) => void;
  onConnectionStatusChanged?: (status: ConnectionStatus) => void;
  onIpcRequest?: (
    type: string,
    msg: Record<string, unknown>
  ) => Promise<Record<string, unknown> | null>;
}): Promise<SessionConnection> {
  const { mode, onServerEvent } = args;

  let serverClient: ServerClient;
  let serverProcessManager: ServerProcessManager | null = null;
  let ports: ServerPorts;
  let protocol: "http" | "https";
  let externalHost: string;
  let gatewayConfig: { serverUrl: string };

  if (mode.kind === "remote") {
    // Remote mode: connect to existing server with automatic reconnection
    const { remoteUrl, adminToken, tls } = mode;
    externalHost = remoteUrl.hostname;
    protocol = remoteUrl.protocol === "https:" ? "https" : "http";
    const remotePort = parseInt(remoteUrl.port) || (protocol === "https" ? 443 : 80);
    gatewayConfig = { serverUrl: `${protocol}://${externalHost}:${remotePort}` };

    let shellToken = await exchangeAdminForShell(remoteUrl, adminToken, tls);
    ports = {
      workerdPort: remotePort,
      gatewayPort: remotePort,
      adminToken,
      shellToken,
    };

    serverClient = await createServerClient(remotePort, shellToken, {
      wsUrl: `${protocol === "https" ? "wss" : "ws"}://${externalHost}:${remotePort}/rpc`,
      tls,
      reconnect: true,
      maxReconnectAttempts: 10,
      refreshAuthToken: async () => {
        shellToken = await exchangeAdminForShell(remoteUrl, adminToken, tls);
        ports.shellToken = shellToken;
        return shellToken;
      },
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
    const localGatewayPort = ports.gatewayPort;
    log.info(`[Server] Child process started (Gateway: ${localGatewayPort})`);
    gatewayConfig = { serverUrl: `http://127.0.0.1:${localGatewayPort}` };

    const shellToken = ports.shellToken;
    if (!shellToken) {
      throw new Error("Local server did not provide a shell caller token");
    }
    serverClient = await createServerClient(localGatewayPort, shellToken, {
      onDisconnect: () => {
        console.error("[App] Server process disconnected");
      },
      onEvent: onServerEvent,
    });
  }

  log.info("[Server] Shell client connected");

  const getClient = () => serverClient;
  const serverInfo = buildServerInfo(ports, externalHost, protocol, gatewayConfig, getClient);

  // Get workspace metadata from server
  const wsInfo = (await serverClient.call("workspace", "getInfo", [])) as {
    path: string;
    statePath: string;
    contextsPath: string;
    config: WorkspaceConfig;
  };
  log.info(`[Workspace] Server workspace: ${wsInfo.config.id}`);

  const gatewayPort = ports.gatewayPort;
  const panelHttpServer: PanelHttpServerLike = {
    hasBuild: () => false,
    invalidateBuild: () => {},
    getPort: () => gatewayPort,
  };

  return {
    protocol,
    gatewayPort,
    externalHost,
    gatewayConfig,
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
