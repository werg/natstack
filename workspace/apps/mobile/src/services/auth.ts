/**
 * Auth service -- device pairing and native-held app connection grants.
 *
 * The durable refresh credential is owned by the native host. RN JS only sees
 * non-secret connection metadata and one-time WebSocket connection grants.
 */

import { NativeModules } from "react-native";
import type { AppCapability } from "@natstack/shared/unitManifest";
import { isSelectedWorkspaceUrl } from "@natstack/shared/connect";

export class StoredCredentialsNeedRepairError extends Error {
  constructor(
    message = "Stored mobile credentials were created by an older NatStack build and cannot be reused. Scan a new pairing QR code to reconnect."
  ) {
    super(message);
    this.name = "StoredCredentialsNeedRepairError";
  }
}

export interface Credentials {
  serverUrl: string;
  hubUrl?: string;
  workspaceName?: string;
  deviceId: string;
  serverId: string;
  workspaceId?: string;
}

export interface ServerPairingResponse {
  serverUrl: string;
  hubUrl: string;
  deviceId: string;
  serverId: string;
}

export interface RemoteWorkspaceEntry {
  name: string;
  lastOpened: number;
  running?: boolean;
  ephemeral?: boolean;
}

export interface ConnectionGrantResponse {
  connectionGrant: string;
  callerId: string;
  deviceId: string;
  expiresAt?: number;
  serverId: string;
  serverBootId?: string;
  workspaceId: string;
}

export type PairingResponse = Credentials & ConnectionGrantResponse;

export interface PreparedAppBundle {
  appId: string;
  buildKey: string;
  effectiveVersion?: string;
  capabilities: AppCapability[];
  rnHostAbi: string;
  integrity: string;
  platform: string;
  url: string;
  path: string;
  localPath: string;
}

export interface ActivatePreparedAppBundleResult {
  activated: boolean;
}

export interface ResetToNativeBootstrapResult {
  reloading: boolean;
}

export function isWorkspaceMobileAppCallerId(callerId: string, deviceId?: string): boolean {
  if (!callerId.startsWith("app:apps/")) return false;
  if (deviceId && !callerId.endsWith(`:${deviceId}`)) return false;
  return callerId.split(":").length >= 3;
}

export function isMobileShellCallerId(callerId: string, deviceId?: string): boolean {
  if (!callerId.startsWith("shell:")) return false;
  if (deviceId && callerId !== `shell:${deviceId}`) return false;
  return callerId.length > "shell:".length;
}

export function isWorkspaceMobileHostCallerId(callerId: string, deviceId?: string): boolean {
  return (
    isMobileShellCallerId(callerId, deviceId) ||
    isWorkspaceMobileAppCallerId(callerId, deviceId)
  );
}

interface NatStackMobileHostNative {
  getCredentials(): Promise<Credentials | null>;
  clearCredentials(): Promise<void>;
  resetToNativeBootstrap(): Promise<ResetToNativeBootstrapResult>;
  pairServer(serverUrl: string, code: string): Promise<ServerPairingResponse>;
  listWorkspaces(): Promise<{ workspaces: RemoteWorkspaceEntry[] }>;
  selectWorkspace(name: string, source: string | null): Promise<PairingResponse>;
  issueConnectionGrant(): Promise<ConnectionGrantResponse>;
  prepareAppBundle(
    expectedRnHostAbi: string,
    platform: "android" | "ios",
    source: string | null
  ): Promise<PreparedAppBundle>;
  activatePreparedAppBundle(
    localPath: string,
    buildKey: string,
    integrity: string
  ): Promise<ActivatePreparedAppBundleResult>;
}

function nativeHost(): NatStackMobileHostNative {
  const module = NativeModules["NatStackMobileHost"] as NatStackMobileHostNative | undefined;
  if (!module) {
    throw new Error(
      "NatStackMobileHost native module is unavailable; mobile credentials cannot be handled in JS"
    );
  }
  return module;
}

export async function getCredentials(): Promise<Credentials | null> {
  try {
    const credentials = await nativeHost().getCredentials();
    if (!credentials) return null;
    if (
      typeof credentials.serverUrl !== "string" ||
      typeof credentials.deviceId !== "string" ||
      typeof credentials.serverId !== "string" ||
      credentials.serverId.length === 0
    ) {
      await clearCredentials().catch(() => {});
      throw new StoredCredentialsNeedRepairError(
        "Stored mobile credentials are incomplete. Scan a new pairing QR code to reconnect."
      );
    }
    const hasWorkspaceId =
      typeof credentials.workspaceId === "string" && credentials.workspaceId.length > 0;
    const hasHubUrl = typeof credentials.hubUrl === "string" && credentials.hubUrl.length > 0;
    if (hasWorkspaceId && !isSelectedWorkspaceUrl(credentials.serverUrl)) {
      await clearCredentials().catch(() => {});
      throw new StoredCredentialsNeedRepairError(
        "Stored mobile credentials are not scoped to a workspace. Scan a new pairing QR code to reconnect."
      );
    }
    if (!hasWorkspaceId && !hasHubUrl) {
      await clearCredentials().catch(() => {});
      throw new StoredCredentialsNeedRepairError(
        "Stored mobile credentials are incomplete. Scan a new pairing QR code to reconnect."
      );
    }
    return credentials;
  } catch (error) {
    if (isNativeRepairError(error)) {
      await clearCredentials().catch(() => {});
      throw new StoredCredentialsNeedRepairError();
    }
    throw error;
  }
}

export async function clearCredentials(): Promise<void> {
  await nativeHost().clearCredentials();
}

export async function resetToNativeBootstrap(): Promise<ResetToNativeBootstrapResult> {
  const response = await nativeHost().resetToNativeBootstrap();
  if (!response || typeof response.reloading !== "boolean") {
    throw new Error("Native host returned an invalid bootstrap reset response");
  }
  return response;
}

export async function pairServer(serverUrl: string, code: string): Promise<ServerPairingResponse> {
  const response = await nativeHost().pairServer(serverUrl, code);
  if (
    typeof response.serverUrl !== "string" ||
    typeof response.hubUrl !== "string" ||
    typeof response.deviceId !== "string" ||
    typeof response.serverId !== "string"
  ) {
    throw new Error("Native host returned an invalid server pairing response");
  }
  return response;
}

export async function listWorkspaces(): Promise<RemoteWorkspaceEntry[]> {
  const response = await nativeHost().listWorkspaces();
  if (!response || !Array.isArray(response.workspaces)) {
    throw new Error("Native host returned an invalid workspace list");
  }
  return response.workspaces.filter(
    (entry): entry is RemoteWorkspaceEntry =>
      entry &&
      typeof entry === "object" &&
      typeof (entry as RemoteWorkspaceEntry).name === "string"
  );
}

export async function selectWorkspace(
  name: string,
  source?: string | null
): Promise<PairingResponse> {
  const response = await nativeHost().selectWorkspace(name, source ?? null);
  validateNativeHostGrant(response, "Workspace selection response");
  return response;
}

export async function issueConnectionGrant(): Promise<ConnectionGrantResponse> {
  const response = await nativeHost().issueConnectionGrant();
  validateNativeHostGrant(response, "Native host response");
  return response;
}

export async function prepareAppBundle(
  expectedRnHostAbi: string,
  platform: "android" | "ios",
  source?: string | null
): Promise<PreparedAppBundle> {
  const response = await nativeHost().prepareAppBundle(expectedRnHostAbi, platform, source ?? null);
  if (
    typeof response.appId !== "string" ||
    typeof response.buildKey !== "string" ||
    !Array.isArray(response.capabilities) ||
    response.capabilities.some((capability) => typeof capability !== "string") ||
    typeof response.rnHostAbi !== "string" ||
    typeof response.integrity !== "string" ||
    typeof response.localPath !== "string"
  ) {
    throw new Error("Native host returned an invalid prepared app bundle");
  }
  return response;
}

export async function activatePreparedAppBundle(
  bundle: Pick<PreparedAppBundle, "localPath" | "buildKey" | "integrity">
): Promise<ActivatePreparedAppBundleResult> {
  const response = await nativeHost().activatePreparedAppBundle(
    bundle.localPath,
    bundle.buildKey,
    bundle.integrity
  );
  if (typeof response.activated !== "boolean") {
    throw new Error("Native host returned an invalid app bundle activation result");
  }
  return response;
}

function isNativeRepairError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const maybe = error as { code?: unknown; message?: unknown };
  return (
    maybe.code === "needs_repair" ||
    String(maybe.message ?? "")
      .toLowerCase()
      .includes("repair")
  );
}

function validateNativeHostGrant(
  response: Partial<ConnectionGrantResponse>,
  source: string
): asserts response is ConnectionGrantResponse {
  if (
    typeof response.connectionGrant !== "string" ||
    response.connectionGrant.length === 0 ||
    typeof response.callerId !== "string" ||
    typeof response.deviceId !== "string" ||
    response.deviceId.length === 0 ||
    !isWorkspaceMobileHostCallerId(response.callerId, response.deviceId) ||
    typeof response.serverId !== "string" ||
    response.serverId.length === 0 ||
    typeof response.workspaceId !== "string" ||
    response.workspaceId.length === 0
  ) {
    throw new Error(`${source} did not include a valid mobile host connection grant`);
  }
}
