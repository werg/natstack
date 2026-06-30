import type { TokenManager } from "@natstack/shared/tokenManager";
import { type ConnectPairing, createConnectDeepLink } from "@natstack/shared/connect";
import { DEFAULT_PAIRING_CODE_TTL_MS, type DeviceAuthStore } from "../deviceAuthStore.js";

/**
 * The WebRTC pairing material the running server advertises (its signaling
 * `room`, DTLS `fp`, and signaling endpoint `sig`, plus optional turn policy /
 * label). `code` is minted per-invite, so it is NOT part of the seam — the
 * server-side WebRTC/signaling wiring populates this; until it does, invites
 * carry a null `deepLink`.
 */
export type ConnectPairingSeam = Omit<ConnectPairing, "code" | "v">;

export interface AuthConnectionInfo {
  serverUrl: string;
  protocol?: "http" | "https";
  externalHost?: string;
  gatewayPort?: number | null;
  /** WebRTC pairing material (room/fp/sig) used to mint the pairing deep link. */
  pairing?: ConnectPairingSeam;
}

export interface ConnectionInfoResponse {
  serverUrl: string;
  protocol?: "http" | "https";
  externalHost?: string;
  gatewayPort?: number | null;
  serverId: string;
  serverBootId: string;
  workspaceId?: string | null;
}

export interface PairingInviteResponse extends ConnectionInfoResponse {
  code: string;
  expiresInMs: number;
  expiresAt: number;
  deepLink: string | null;
}

export interface DeviceCredentialResponse {
  deviceId: string;
  refreshToken: string;
  label: string;
  platform?: string;
  shellToken?: string;
  callerId?: string;
  serverId: string;
  serverBootId: string;
  workspaceId?: string | null;
}

export function shellCallerId(deviceId: string): string {
  return `shell:${deviceId}`;
}

export function connectionInfoResponse(deps: {
  deviceAuthStore: DeviceAuthStore;
  getServerBootId: () => string;
  getWorkspaceId: () => string | null | undefined;
  getConnectionInfo?: () => AuthConnectionInfo;
}): ConnectionInfoResponse {
  const info = deps.getConnectionInfo?.() ?? { serverUrl: "" };
  return {
    serverUrl: info.serverUrl,
    protocol: info.protocol,
    externalHost: info.externalHost,
    gatewayPort: info.gatewayPort,
    serverId: deps.deviceAuthStore.getServerId(),
    serverBootId: deps.getServerBootId(),
    workspaceId: deps.getWorkspaceId() ?? null,
  };
}

export function createPairingInviteResponse(
  deps: {
    deviceAuthStore: DeviceAuthStore;
    getServerBootId: () => string;
    getWorkspaceId: () => string | null | undefined;
    getConnectionInfo?: () => AuthConnectionInfo;
  },
  ttlMs?: number
): PairingInviteResponse {
  const expiresInMs = ttlMs ?? DEFAULT_PAIRING_CODE_TTL_MS;
  const code = deps.deviceAuthStore.createPairingCode(expiresInMs);
  const info = connectionInfoResponse(deps);
  const pairing = deps.getConnectionInfo?.().pairing;
  return {
    ...info,
    code,
    expiresInMs,
    expiresAt: Date.now() + expiresInMs,
    deepLink: pairing ? createConnectDeepLink({ ...pairing, code }) : null,
  };
}

export function responseForCredential(
  deps: {
    tokenManager: TokenManager;
    deviceAuthStore: DeviceAuthStore;
    getServerBootId: () => string;
    getWorkspaceId: () => string | null | undefined;
  },
  credential: { deviceId: string; refreshToken: string; label: string; platform?: string },
  options: { includeShellToken: boolean }
): DeviceCredentialResponse {
  const shellFields = options.includeShellToken
    ? {
        shellToken: deps.tokenManager.ensureToken(shellCallerId(credential.deviceId), "shell"),
        callerId: shellCallerId(credential.deviceId),
      }
    : {};
  return {
    ...credential,
    ...shellFields,
    serverId: deps.deviceAuthStore.getServerId(),
    serverBootId: deps.getServerBootId(),
    workspaceId: deps.getWorkspaceId() ?? null,
  };
}
