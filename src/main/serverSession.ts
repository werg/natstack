/**
 * ServerSession — server connection establishment.
 *
 * Subsumes local spawn vs remote connect and workspace info fetch.
 * Returns a single SessionConnection
 * with everything needed to continue startup.
 */

import { app } from "electron";
import * as fs from "fs";
import * as http from "http";
import * as https from "https";
import * as os from "os";
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
import { saveRemoteCredentials } from "./remoteCredentialStore.js";
import { resolveServerRouteUrl, resolveServerWsUrl } from "@natstack/shared/connect";

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

interface ShellCredentialResponse {
  deviceId: string;
  refreshToken?: string;
  shellToken: string;
  serverId?: string;
  serverBootId?: string;
  workspaceId?: string;
}

async function postAuthJson(
  remoteUrl: URL,
  path: string,
  bodyValue: unknown,
  bearerToken: string | null,
  tls?: TlsPinningOptions
): Promise<{ statusCode: number; statusMessage: string; body: string }> {
  const requestUrl = resolveServerRouteUrl(remoteUrl, path);
  const body = JSON.stringify(bodyValue);
  return new Promise<{
    statusCode: number;
    statusMessage: string;
    body: string;
  }>((resolve, reject) => {
    const isHttps = requestUrl.protocol === "https:";
    const agent =
      isHttps && tls?.fingerprint
        ? createPinnedHttpsAgent(tls.fingerprint)
        : isHttps && tls?.caPath
          ? new https.Agent({ ca: fs.readFileSync(tls.caPath) })
          : undefined;
    const headers: Record<string, string | number> = {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(body),
    };
    if (bearerToken) headers["Authorization"] = `Bearer ${bearerToken}`;
    const req = (isHttps ? https : http).request(
      requestUrl,
      {
        method: "POST",
        agent,
        headers,
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
}

async function issueElectronDevice(
  remoteUrl: URL,
  adminToken: string,
  tls?: TlsPinningOptions
): Promise<ShellCredentialResponse> {
  const responseBody = await postAuthJson(
    remoteUrl,
    "/_r/s/auth/issue-device",
    { label: `Electron on ${os.hostname()}`, platform: "desktop" },
    adminToken,
    tls
  );
  const json = JSON.parse(responseBody.body || "{}") as Partial<ShellCredentialResponse> & {
    error?: unknown;
  };
  if (
    responseBody.statusCode < 200 ||
    responseBody.statusCode >= 300 ||
    typeof json.shellToken !== "string" ||
    typeof json.deviceId !== "string"
  ) {
    throw new Error(
      `Failed to issue remote device credential (${responseBody.statusCode}): ${
        typeof json.error === "string" ? json.error : responseBody.statusMessage
      }`
    );
  }
  return json as ShellCredentialResponse;
}

async function refreshShellCredential(
  remoteUrl: URL,
  deviceId: string,
  refreshToken: string,
  tls?: TlsPinningOptions
): Promise<ShellCredentialResponse> {
  const responseBody = await postAuthJson(
    remoteUrl,
    "/_r/s/auth/refresh-shell",
    { deviceId, refreshToken },
    null,
    tls
  );
  const json = JSON.parse(responseBody.body || "{}") as Partial<ShellCredentialResponse> & {
    error?: unknown;
  };
  if (
    responseBody.statusCode < 200 ||
    responseBody.statusCode >= 300 ||
    typeof json.shellToken !== "string"
  ) {
    throw new Error(
      `Failed to refresh shell token (${responseBody.statusCode}): ${
        typeof json.error === "string" ? json.error : responseBody.statusMessage
      }`
    );
  }
  return json as ShellCredentialResponse;
}

function persistRemoteShellCredential(
  mode: Extract<StartupMode, { kind: "remote" }>,
  credential: ShellCredentialResponse
): void {
  if (!credential.refreshToken) return;
  if (mode.bootstrap === "device") {
    saveRemoteCredentials({
      kind: "device",
      url: mode.remoteUrl.href,
      deviceId: credential.deviceId,
      refreshToken: credential.refreshToken,
      caPath: mode.tls?.caPath,
      fingerprint: mode.tls?.fingerprint,
    });
  } else if (mode.adminToken) {
    saveRemoteCredentials({
      kind: "hybrid",
      url: mode.remoteUrl.href,
      adminToken: mode.adminToken,
      deviceId: credential.deviceId,
      refreshToken: credential.refreshToken,
      caPath: mode.tls?.caPath,
      fingerprint: mode.tls?.fingerprint,
    });
    mode.bootstrap = "hybrid";
  }
  mode.deviceId = credential.deviceId;
  mode.refreshToken = credential.refreshToken;
}

async function acquireShellCredential(
  mode: Extract<StartupMode, { kind: "remote" }>
): Promise<ShellCredentialResponse> {
  if (mode.deviceId && mode.refreshToken) {
    try {
      return await refreshShellCredential(
        mode.remoteUrl,
        mode.deviceId,
        mode.refreshToken,
        mode.tls
      );
    } catch (err) {
      const message = (err as Error).message;
      log.warn(`Stored device credential could not refresh shell token: ${message}`);
      if (mode.bootstrap === "device") {
        if (/Failed to refresh shell token \((401|403)\)/.test(message)) {
          throw new Error("Device credential expired or revoked — re-pair from the server");
        }
        throw err;
      }
    }
  }

  if (!mode.adminToken) {
    throw new Error("Remote admin token is unavailable — re-pair from the server");
  }
  const credential = await issueElectronDevice(mode.remoteUrl, mode.adminToken, mode.tls);
  persistRemoteShellCredential(mode, credential);
  return credential;
}

/**
 * Establish a server session — either by spawning a local server or connecting to remote.
 */
export async function establishServerSession(args: {
  mode: StartupMode;
  centralData: CentralDataManager;
  onServerEvent: (event: string, payload: unknown) => void;
  onConnectionStatusChanged?: (status: ConnectionStatus) => void;
  onRecovery?: (kind: "resubscribe" | "cold-recover") => void | Promise<void>;
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
    const { remoteUrl, tls } = mode;
    externalHost = remoteUrl.hostname;
    protocol = remoteUrl.protocol === "https:" ? "https" : "http";
    const remotePort = parseInt(remoteUrl.port) || (protocol === "https" ? 443 : 80);
    gatewayConfig = { serverUrl: remoteUrl.toString().replace(/\/$/, "") };

    let shellCredential = await acquireShellCredential(mode);
    let shellToken = shellCredential.shellToken;
    ports = {
      workerdPort: remotePort,
      gatewayPort: remotePort,
      adminToken: mode.adminToken ?? "",
      shellToken,
    };

    serverClient = await createServerClient(remotePort, shellToken, {
      wsUrl: resolveServerWsUrl(remoteUrl),
      tls,
      reconnect: true,
      refreshAuthToken: async () => {
        if (!shellCredential.refreshToken) {
          shellCredential = await acquireShellCredential(mode);
        } else {
          shellCredential = await refreshShellCredential(
            remoteUrl,
            shellCredential.deviceId,
            shellCredential.refreshToken,
            tls
          ).catch(() => acquireShellCredential(mode));
        }
        shellToken = shellCredential.shellToken;
        persistRemoteShellCredential(mode, shellCredential);
        ports.shellToken = shellToken;
        return shellToken;
      },
      onConnectionStatusChanged: (status) => {
        args.onConnectionStatusChanged?.(status);
      },
      onRecovery: args.onRecovery,
      onDisconnect: () => {
        // Called only after all reconnection attempts are exhausted
        console.error(
          "[App] Remote server disconnected: connection was lost and could not be re-established after multiple attempts. Exiting."
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
      workspaceName: mode.workspaceName,
      appRoot: getAppRoot(),
      isEphemeral: mode.isEphemeral,
      onCrash: (code) => {
        console.error(`[App] Server process crashed with code ${code}`);
        console.error(
          "[App] Server process exited repeatedly and could not be recovered. Relaunching."
        );
        app.relaunch();
        app.exit(1);
      },
      onRestart: (restartedPorts) => {
        Object.assign(ports, restartedPorts);
        gatewayConfig.serverUrl = `http://127.0.0.1:${ports.gatewayPort}`;
        args.onConnectionStatusChanged?.("connecting");
        log.info(`[Server] Child process restarted (Gateway: ${ports.gatewayPort})`);
      },
      onIpcRequest: async (type, msg) => {
        if (type === "workspace-list-request") {
          return { workspaces: args.centralData.listWorkspaces() };
        }
        if (type === "workspace-active-entry-request") {
          return { entry: args.centralData.getWorkspaceEntry(mode.workspaceName) };
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
      reconnect: true,
      getWsUrl: () => {
        const url = serverProcessManager?.getCurrentGatewayUrl();
        return url ?? `ws://127.0.0.1:${ports.gatewayPort}/rpc`;
      },
      refreshAuthToken: async () => {
        if (!ports.shellToken) {
          throw new Error("Local server has not issued a replacement shell token yet");
        }
        return ports.shellToken;
      },
      onConnectionStatusChanged: (status) => {
        args.onConnectionStatusChanged?.(status);
      },
      onRecovery: args.onRecovery,
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
    getBuildRevision: () => undefined,
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
