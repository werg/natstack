/**
 * Auth service -- device pairing and native-held app connection grants.
 *
 * The durable refresh credential is owned by the native host. RN JS only sees
 * non-secret connection metadata and one-time WebSocket connection grants.
 */

import { NativeModules } from "react-native";
import type { AppCapability } from "@natstack/shared/unitManifest";

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
  deviceId: string;
  serverId: string;
  workspaceId: string;
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

export function isWorkspaceMobileAppCallerId(callerId: string, deviceId?: string): boolean {
  if (!callerId.startsWith("app:apps/")) return false;
  if (deviceId && !callerId.endsWith(`:${deviceId}`)) return false;
  return callerId.split(":").length >= 3;
}

interface NatStackMobileHostNative {
  getCredentials(): Promise<Credentials | null>;
  clearCredentials(): Promise<void>;
  completePairing(serverUrl: string, code: string, source: string | null): Promise<PairingResponse>;
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
      credentials.serverId.length === 0 ||
      typeof credentials.workspaceId !== "string" ||
      credentials.workspaceId.length === 0
    ) {
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

export async function completePairing(
  serverUrl: string,
  code: string,
  source?: string | null
): Promise<PairingResponse> {
  const response = await nativeHost().completePairing(serverUrl, code, source ?? null);
  validateNativeAppGrant(response, "Pairing response");
  return response;
}

export async function issueConnectionGrant(): Promise<ConnectionGrantResponse> {
  const response = await nativeHost().issueConnectionGrant();
  validateNativeAppGrant(response, "Native host response");
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

function validateNativeAppGrant(
  response: Partial<ConnectionGrantResponse>,
  source: string
): asserts response is ConnectionGrantResponse {
  if (
    typeof response.connectionGrant !== "string" ||
    response.connectionGrant.length === 0 ||
    typeof response.callerId !== "string" ||
    typeof response.deviceId !== "string" ||
    response.deviceId.length === 0 ||
    !isWorkspaceMobileAppCallerId(response.callerId, response.deviceId) ||
    typeof response.serverId !== "string" ||
    response.serverId.length === 0 ||
    typeof response.workspaceId !== "string" ||
    response.workspaceId.length === 0
  ) {
    throw new Error(`${source} did not include a valid native app connection grant`);
  }
}
