import type { TokenManager } from "@natstack/shared/tokenManager";
import { createConnectDeepLink } from "@natstack/shared/connect";
import { DEFAULT_PAIRING_CODE_TTL_MS, type DeviceAuthStore } from "../deviceAuthStore.js";

export interface AuthConnectionInfo {
  serverUrl: string;
  publicUrl?: string | null;
  protocol?: "http" | "https";
  externalHost?: string;
  gatewayPort?: number | null;
}

export interface ConnectionInfoResponse {
  serverUrl: string;
  publicUrl: string | null;
  connectUrl: string;
  protocol?: "http" | "https";
  externalHost?: string;
  gatewayPort?: number | null;
  serverId: string;
  serverBootId: string;
  workspaceId: string;
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
  workspaceId: string;
}

export function shellCallerId(deviceId: string): string {
  return `shell:${deviceId}`;
}

export function connectionInfoResponse(deps: {
  deviceAuthStore: DeviceAuthStore;
  getServerBootId: () => string;
  getWorkspaceId: () => string;
  getConnectionInfo?: () => AuthConnectionInfo;
}): ConnectionInfoResponse {
  const info = deps.getConnectionInfo?.() ?? { serverUrl: "" };
  const publicUrl = info.publicUrl || null;
  const connectUrl = publicUrl || info.serverUrl;
  return {
    serverUrl: info.serverUrl,
    publicUrl,
    connectUrl,
    protocol: info.protocol,
    externalHost: info.externalHost,
    gatewayPort: info.gatewayPort,
    serverId: deps.deviceAuthStore.getServerId(),
    serverBootId: deps.getServerBootId(),
    workspaceId: deps.getWorkspaceId(),
  };
}

export function createPairingInviteResponse(
  deps: {
    deviceAuthStore: DeviceAuthStore;
    getServerBootId: () => string;
    getWorkspaceId: () => string;
    getConnectionInfo?: () => AuthConnectionInfo;
  },
  ttlMs?: number
): PairingInviteResponse {
  const expiresInMs = ttlMs ?? DEFAULT_PAIRING_CODE_TTL_MS;
  const code = deps.deviceAuthStore.createPairingCode(expiresInMs);
  const info = connectionInfoResponse(deps);
  return {
    ...info,
    code,
    expiresInMs,
    expiresAt: Date.now() + expiresInMs,
    deepLink: info.connectUrl ? createConnectDeepLink(info.connectUrl, code) : null,
  };
}

export function responseForCredential(
  deps: {
    tokenManager: TokenManager;
    deviceAuthStore: DeviceAuthStore;
    getServerBootId: () => string;
    getWorkspaceId: () => string;
  },
  credential: { deviceId: string; refreshToken: string; label: string; platform?: string },
  options: { includeShellToken: boolean }
): DeviceCredentialResponse {
  const shellFields = options.includeShellToken
    ? {
        shellToken: deps.tokenManager.ensureToken(
          shellCallerId(credential.deviceId),
          "shell-remote"
        ),
        callerId: shellCallerId(credential.deviceId),
      }
    : {};
  return {
    ...credential,
    ...shellFields,
    serverId: deps.deviceAuthStore.getServerId(),
    serverBootId: deps.getServerBootId(),
    workspaceId: deps.getWorkspaceId(),
  };
}
