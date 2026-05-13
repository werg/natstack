/**
 * Auth service -- device pairing and shell-token refresh.
 *
 * Stores the server URL and durable device refresh credential in the device
 * keychain. WebSocket shell tokens are minted on demand and are never
 * persisted.
 */

import * as Keychain from "react-native-keychain";

const KEYCHAIN_SERVICE = "com.natstack.mobile";

export class StoredCredentialsNeedRepairError extends Error {
  constructor(message = "Stored mobile credentials were created by an older NatStack build and cannot be reused. Scan a new pairing QR code to reconnect.") {
    super(message);
    this.name = "StoredCredentialsNeedRepairError";
  }
}

export interface Credentials {
  serverUrl: string;
  deviceId: string;
  refreshToken: string;
  serverId?: string;
  workspaceId?: string;
}

/**
 * Save server credentials to the device keychain.
 *
 * The serverUrl is stored as the "username" field and the device credential
 * JSON is stored as the "password" field.
 */
export async function saveCredentials(credentials: Credentials): Promise<void> {
  const { serverUrl } = credentials;
  const secretPayload: Omit<Credentials, "serverUrl"> = {
    deviceId: credentials.deviceId,
    refreshToken: credentials.refreshToken,
    serverId: credentials.serverId,
    workspaceId: credentials.workspaceId,
  };
  await Keychain.setGenericPassword(serverUrl, JSON.stringify(secretPayload), {
    service: KEYCHAIN_SERVICE,
    // Confine the refresh credential to the device it was provisioned on. The
    // default iOS accessibility (`AccessibleWhenUnlocked`) is included in
    // encrypted iTunes / iCloud backups, which would let an attacker
    // restore a working credential onto a different device. Pinning to
    // `WHEN_UNLOCKED_THIS_DEVICE_ONLY` keeps the item out of backups and
    // requires the device to be unlocked at access time.
    accessible: Keychain.ACCESSIBLE.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  });
}

/**
 * Retrieve stored credentials from the device keychain.
 * Returns null if no credentials are stored.
 */
export async function getCredentials(): Promise<Credentials | null> {
  const result = await Keychain.getGenericPassword({
    service: KEYCHAIN_SERVICE,
  });
  if (!result) return null;
  let parsed: Omit<Credentials, "serverUrl">;
  try {
    parsed = JSON.parse(result.password) as Omit<Credentials, "serverUrl">;
  } catch {
    await clearCredentials().catch(() => {});
    throw new StoredCredentialsNeedRepairError();
  }
  if (typeof parsed.deviceId !== "string" || typeof parsed.refreshToken !== "string") {
    await clearCredentials().catch(() => {});
    throw new StoredCredentialsNeedRepairError("Stored mobile credentials are incomplete. Scan a new pairing QR code to reconnect.");
  }
  return {
    serverUrl: result.username,
    deviceId: parsed.deviceId,
    refreshToken: parsed.refreshToken,
    serverId: parsed.serverId,
    workspaceId: parsed.workspaceId,
  };
}

/**
 * Remove stored credentials from the device keychain.
 */
export async function clearCredentials(): Promise<void> {
  await Keychain.resetGenericPassword({
    service: KEYCHAIN_SERVICE,
  });
}

export interface ShellTokenResponse {
  shellToken: string;
  callerId: string;
  deviceId: string;
  refreshToken?: string;
  serverId?: string;
  serverBootId?: string;
  workspaceId?: string;
}

export async function completePairing(
  serverUrl: string,
  code: string,
): Promise<Credentials & ShellTokenResponse> {
  const response = await postAuth(serverUrl, "/_r/s/auth/complete-pairing", {
    code,
    label: "Mobile device",
    platform: "mobile",
  });
  if (typeof response.deviceId !== "string" || typeof response.refreshToken !== "string" || typeof response.shellToken !== "string") {
    throw new Error("Pairing response did not include device credentials");
  }
  return {
    serverUrl,
    deviceId: response.deviceId,
    refreshToken: response.refreshToken,
    shellToken: response.shellToken,
    callerId: String(response.callerId ?? ""),
    serverId: typeof response.serverId === "string" ? response.serverId : undefined,
    serverBootId: typeof response.serverBootId === "string" ? response.serverBootId : undefined,
    workspaceId: typeof response.workspaceId === "string" ? response.workspaceId : undefined,
  };
}

export async function refreshShellToken(credentials: Credentials): Promise<ShellTokenResponse> {
  const response = await postAuth(credentials.serverUrl, "/_r/s/auth/refresh-shell", {
    deviceId: credentials.deviceId,
    refreshToken: credentials.refreshToken,
  });
  if (typeof response.shellToken !== "string") {
    throw new Error("Refresh response did not include a shell token");
  }
  return {
    shellToken: response.shellToken,
    callerId: String(response.callerId ?? ""),
    deviceId: credentials.deviceId,
    serverId: typeof response.serverId === "string" ? response.serverId : undefined,
    serverBootId: typeof response.serverBootId === "string" ? response.serverBootId : undefined,
    workspaceId: typeof response.workspaceId === "string" ? response.workspaceId : undefined,
  };
}

async function postAuth(serverUrl: string, path: string, body: unknown): Promise<Record<string, unknown>> {
  const url = `${serverUrl.replace(/\/$/, "")}${path}`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) {
    throw new Error(typeof payload.error === "string" ? payload.error : `Auth request failed (${response.status})`);
  }
  return payload;
}
