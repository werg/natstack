/**
 * ServerSession — server connection establishment.
 *
 * Subsumes local spawn vs remote connect and workspace info fetch.
 * Returns a single SessionConnection
 * with everything needed to continue startup.
 */

import { app } from "electron";
import * as path from "node:path";
import { createDevLogger } from "@natstack/dev-log";
import { getAppRoot } from "./paths.js";
import { ServerProcessManager, type ServerPorts } from "./serverProcessManager.js";
import { createServerClient, type ServerClient, type ConnectionStatus } from "./serverClient.js";
import { createWebRtcServerClient } from "./webrtcServerClient.js";
import { startPanelAssetFacade } from "./panelAssetFacade.js";
import { relaunchApp } from "./relaunchApp.js";
import {
  loadStoredRemotePairing,
  persistRotatedRemoteCredential,
  saveStoredRemote,
} from "./services/remoteCredService.js";
import type { StoredRemote } from "./services/remoteCredStore.js";
import type { PanelHttpServerLike } from "@natstack/shared/panelInterfaces";
import type { ServerInfo } from "./serverInfo.js";
import type { WorkspaceConfig } from "@natstack/shared/workspace/types";
import type { CentralDataManager } from "@natstack/shared/centralData";
import { workspaceRelaunchArgs, type ConnectedStartupMode } from "./startupMode.js";
import { createTypedServiceClient } from "@natstack/shared/typedServiceClient";
import { workspaceMethods } from "@natstack/shared/serviceSchemas/workspace";
import { serverRpcWsUrl, type ConnectPairing } from "@natstack/shared/connect";

const log = createDevLogger("ServerSession");

export interface SessionConnection {
  protocol: "http" | "https";
  gatewayPort: number;
  externalHost: string;
  gatewayConfig: { serverUrl: string };
  adminToken: string;
  shellToken: string;
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
    call: (service, method, args) => getClient().call(service, method, args),
  };
}

/**
 * Connect to a remote server over the WebRTC pipe (the only remote transport;
 * §8 deleted the direct-wss/TLS-pin path). The QR-pairing flow hands its parsed
 * `ConnectPairing` ({room, fp, code, sig, ice}) here, along with the shell-token
 * provider derived from the persisted device credential.
 *
 * Returns a `ServerClient` indistinguishable from the loopback-WS one
 * (`createServerClient`): the main `shell` principal and each Electron-hosted
 * `app` principal are logical sessions multiplexed over one DTLS pipe. The
 * device-credential → shell-token derivation is the pairing layer's concern
 * (`getShellToken`), exactly as the local path receives `ports.shellToken` from
 * its child server — the transport never sees a half-authenticated pipe.
 */
export function connectRemoteViaWebRtc(
  pairing: ConnectPairing,
  options: {
    /** The shell's caller id, e.g. `shell:<deviceId>`. */
    callerId: string;
    /** Device-credential → short-lived shell token (re-invoked per session open). */
    getShellToken: () => Promise<string> | string;
    connectionId?: string;
    /** Fired when a fresh device is paired — persist the returned credential. */
    onPaired?: (credential: { deviceId: string; refreshToken: string }) => void;
    onServerEvent?: (event: string, payload: unknown) => void;
    onConnectionStatusChanged?: (status: ConnectionStatus) => void;
    onRecovery?: (kind: "resubscribe" | "cold-recover") => void | Promise<void>;
  }
): Promise<ServerClient> {
  return createWebRtcServerClient({ pairing, ...options });
}

/**
 * Establish a server session. Three branches, in precedence order:
 *
 *   (a) FRESH pair — `args.pendingPairing` carries a pairing link the bootstrap
 *       chooser redeemed THIS launch. The single pairing connection authenticates
 *       with the one-time `code` and stays as the session; the device credential
 *       the server issues is persisted so the next launch reconnects via refresh.
 *       (No throwaway redeem-then-relaunch.)
 *   (b) Returning device — a pairing persisted on a prior launch. Re-dial it and
 *       re-authenticate with the refresh token (a RUNTIME branch, not a startup
 *       mode).
 *   (c) Local — spawn the local child server and connect over loopback WS.
 *
 * Remote topology is always WebRTC (`connectRemoteViaWebRtc`), never a direct
 * socket.
 */
export async function establishServerSession(args: {
  mode: ConnectedStartupMode | null;
  /**
   * A pairing the bootstrap chooser redeemed this launch. When set, the pairing
   * connection IS the session (branch (a) above) — it takes precedence over both
   * a stored pairing and a local spawn.
   */
  pendingPairing?: ConnectPairing;
  /**
   * Suppress returning-device auto-dial for this launch. Used by the chooser
   * fallback after a failed remote launch so a local workspace choice stays local.
   */
  skipStoredRemote?: boolean;
  centralData: CentralDataManager;
  onServerEvent: (event: string, payload: unknown) => void;
  onConnectionStatusChanged?: (status: ConnectionStatus) => void;
  onRecovery?: (kind: "resubscribe" | "cold-recover") => void | Promise<void>;
  onIpcRequest?: (
    type: string,
    msg: Record<string, unknown>
  ) => Promise<Record<string, unknown> | null>;
}): Promise<SessionConnection> {
  const { mode, pendingPairing, skipStoredRemote, onServerEvent } = args;

  // (a) FRESH pair: the bootstrap chooser handed us a pairing link this launch.
  // The pairing connection authenticates with the code and stays as the session.
  if (pendingPairing) {
    return establishFreshPairSession(pendingPairing, args);
  }
  // (b) Returning device: a paired WebRTC remote persisted on a prior launch
  // takes precedence over the local spawn. Here we just re-dial it.
  const storedRemote = skipStoredRemote ? null : loadStoredRemotePairing();
  if (storedRemote) {
    return establishRemoteSession(storedRemote, args);
  }
  // (c) Local spawn.
  if (!mode) {
    throw new Error(
      "establishServerSession: no connected startup mode, fresh pairing, or stored remote pairing"
    );
  }

  let serverClient: ServerClient;
  let serverProcessManager: ServerProcessManager | null = null;
  let ports: ServerPorts;
  let gatewayConfig: { serverUrl: string };

  // Local topology: spawn the server as a child process and connect over
  // loopback WS. Remote topology is WebRTC (`establishRemoteSession`), never a
  // direct socket — so the session is always http/localhost here.
  const protocol = "http" as const;
  const externalHost = "localhost";
  {
    serverProcessManager = new ServerProcessManager({
      wsDir: mode.wsDir,
      appRoot: getAppRoot(),
      isEphemeral: mode.isEphemeral,
      autoApproveStartupUnits: mode.autoApproveStartupUnits,
      onCrash: (code) => {
        console.error(`[App] Server process crashed with code ${code}`);
        console.error(
          "[App] Server process exited repeatedly and could not be recovered. Relaunching."
        );
        relaunchApp({ exitCode: 1 });
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
        const delegated = await args.onIpcRequest?.(type, msg);
        if (delegated) return delegated;
        return null;
      },
      onRelaunch: (name) => {
        log.info(`[App] Relaunching into workspace "${name}"`);
        relaunchApp({ args: workspaceRelaunchArgs(name) });
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
        return url ?? serverRpcWsUrl(`http://127.0.0.1:${ports.gatewayPort}`);
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
      onServerEvent,
    });
  }

  log.info("[Server] Shell client connected");

  const getClient = () => serverClient;
  const serverInfo = buildServerInfo(ports, externalHost, protocol, gatewayConfig, getClient);

  // Get workspace metadata from server
  const workspaceClient = createTypedServiceClient("workspace", workspaceMethods, (svc, m, a) =>
    serverClient.call(svc, m, a)
  );
  const wsInfo = await workspaceClient.getInfo();
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
    /** The local child server's own state directory (same host). */
    statePath: wsInfo.statePath,
    workspaceConfig: wsInfo.config,
    adminToken: ports.adminToken,
    shellToken: ports.shellToken ?? "",
    serverClient,
    serverProcessManager,
    panelHttpServer,
    serverInfo,
  };
}

/** The connect-callback subset both remote-session paths forward to the pipe. */
type RemoteConnectArgs = {
  onServerEvent: (event: string, payload: unknown) => void;
  onConnectionStatusChanged?: (status: ConnectionStatus) => void;
  onRecovery?: (kind: "resubscribe" | "cold-recover") => void | Promise<void>;
};

/**
 * Connect to a paired WebRTC remote as the RETURNING device and shape it into a
 * {@link SessionConnection}. The shell re-authenticates with its refresh token
 * (`refresh:<deviceId>:<refreshToken>`); the RPC plane rides the pipe exactly as
 * the local loopback-WS plane does.
 */
async function establishRemoteSession(
  stored: StoredRemote,
  args: RemoteConnectArgs
): Promise<SessionConnection> {
  const serverClient = await connectRemoteViaWebRtc(
    { ...stored.pairing, code: "" },
    {
      callerId: `shell:${stored.deviceId}`,
      getShellToken: () => `refresh:${stored.deviceId}:${stored.refreshToken}`,
      // A returning device re-auths with its refresh token; if the server rotates
      // it (delivered via onPaired), persist the fresh secret for next launch.
      onPaired: (credential) => persistRotatedRemoteCredential(credential),
      onServerEvent: args.onServerEvent,
      onConnectionStatusChanged: args.onConnectionStatusChanged,
      onRecovery: args.onRecovery,
    }
  );
  log.info("[Server] Shell client connected over WebRTC remote pipe (returning device)");
  return buildRemoteSessionConnection(serverClient);
}

/**
 * Pair a FRESH device over WebRTC and KEEP the pipe as the session. The one-time
 * `code` is presented as the session token (which pairs a new device server-side
 * and delivers `{deviceId, refreshToken}` via `onPaired`); that credential is
 * persisted so the next launch reconnects as a returning device. There is no
 * throwaway redeem — this connection IS the session.
 */
async function establishFreshPairSession(
  pairing: ConnectPairing,
  args: RemoteConnectArgs
): Promise<SessionConnection> {
  const serverClient = await connectRemoteViaWebRtc(pairing, {
    // The server assigns the real `shell:<deviceId>` principal when it redeems the
    // one-time code; we don't know that id yet, so dial with a stable selfId. (If
    // the resolved id is ever threaded back, swap it in here.)
    callerId: "shell:pairing",
    getShellToken: () => pairing.code,
    // Persist the issued device credential against the pairing material (minus the
    // one-time code) so the NEXT launch reconnects via refresh:<deviceId>:<token>.
    onPaired: (credential) =>
      saveStoredRemote({
        pairing: {
          room: pairing.room,
          fp: pairing.fp,
          sig: pairing.sig,
          ice: pairing.ice,
          srv: pairing.srv,
        },
        deviceId: credential.deviceId,
        refreshToken: credential.refreshToken,
        pairedAt: Date.now(),
      }),
    onServerEvent: args.onServerEvent,
    onConnectionStatusChanged: args.onConnectionStatusChanged,
    onRecovery: args.onRecovery,
  });
  log.info("[Server] Shell client connected over WebRTC remote pipe (fresh pairing)");
  return buildRemoteSessionConnection(serverClient);
}

/**
 * Shape an already-connected remote WebRTC pipe into a {@link SessionConnection}.
 * Shared by the fresh-pair and returning-device paths — the only difference
 * between them is HOW the pipe authenticated (one-time code vs refresh token).
 */
async function buildRemoteSessionConnection(
  serverClient: ServerClient
): Promise<SessionConnection> {
  const protocol = "http" as const;
  const externalHost = "localhost";
  // There is no local gateway/workerd process in remote mode — the RPC plane
  // rides the pipe. Panel ASSETS, however, must still load from a loopback
  // origin (buildPanelUrl → http://127.0.0.1:{gatewayPort}/{source}/), so stand
  // up an assets-only façade that proxies each request to the remote server's
  // own gateway over the pipe (gateway.fetch RPC). The façade lives for the
  // whole session; there is no teardown hook on this path (the process exits
  // with the session), which is acceptable for a single loopback listener.
  const facade = await startPanelAssetFacade(serverClient);
  const remotePorts: ServerPorts = { gatewayPort: facade.port, workerdPort: 0, adminToken: "" };
  const gatewayConfig = { serverUrl: `http://127.0.0.1:${facade.port}` };

  const serverInfo = buildServerInfo(
    remotePorts,
    externalHost,
    protocol,
    gatewayConfig,
    () => serverClient
  );

  // Mirror the local path: read the remote workspace's identity + config over
  // the pipe so the shell can label and route the session.
  const workspaceClient = createTypedServiceClient("workspace", workspaceMethods, (svc, m, a) =>
    serverClient.call(svc, m, a)
  );
  const wsInfo = await workspaceClient.getInfo();
  log.info(`[Workspace] Remote workspace: ${wsInfo.config.id}`);

  const panelHttpServer: PanelHttpServerLike = {
    hasBuild: () => false,
    getBuildRevision: () => undefined,
    invalidateBuild: () => {},
    getPort: () => facade.port,
  };

  // Local consumers (shellCore, app state, diagnostics) WRITE to statePath, so it
  // must be a locally-writable path — the remote `wsInfo.statePath` describes the
  // server's host, not ours. Scope a local scratch dir under userData.
  const statePath = path.join(app.getPath("userData"), "remote-state");

  return {
    protocol,
    gatewayPort: remotePorts.gatewayPort,
    externalHost,
    gatewayConfig,
    workerdPort: remotePorts.workerdPort ?? 0,
    workspaceId: wsInfo.config.id,
    // TODO(remote): wsInfo.path is the REMOTE host's tree — panel manifests are
    // not present locally. Full remote panel serving (manifests + assets over the
    // bridge) is a follow-up; carried here so the session is labelled correctly.
    workspacePath: wsInfo.path,
    statePath,
    workspaceConfig: wsInfo.config,
    // TODO(remote): no local admin/shell token in remote mode — session auth is
    // the device refresh credential, derived per session by connectRemoteViaWebRtc.
    adminToken: "",
    shellToken: "",
    serverClient,
    serverProcessManager: null,
    panelHttpServer,
    serverInfo,
  };
}
