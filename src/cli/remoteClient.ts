import * as os from "node:os";
import {
  createConnectDeepLink,
  PAIRING_CODE_PATTERN,
  parseConnectLink,
  parseConnectServerUrl,
} from "@natstack/shared/connect";
import { AuthError } from "./output.js";
import { RpcClient, type DeviceCredential } from "./rpcClient.js";

export type { DeviceCredential } from "./rpcClient.js";
export { refreshShell, type RefreshShellResponse } from "./rpcClient.js";

export interface PairOptions {
  url?: string;
  code?: string;
  link?: string;
  label?: string;
}

export interface PairingInvite {
  code: string;
  deepLink: string;
  connectUrl: string;
  serverUrl?: string;
  expiresAt?: number;
}

export async function completePairing(options: PairOptions): Promise<DeviceCredential> {
  const parsed = parsePairOptions(options);
  let response: Response;
  try {
    response = await fetch(new URL("/_r/s/auth/complete-pairing", parsed.url), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        code: parsed.code,
        label: options.label ?? `${os.userInfo().username}@${os.hostname()}`,
        platform: "desktop",
      }),
    });
  } catch (error) {
    throw new AuthError(
      `cannot reach ${parsed.url}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  const body = (await response.json().catch(() => ({}))) as {
    deviceId?: unknown;
    refreshToken?: unknown;
    error?: unknown;
  };
  if (!response.ok || typeof body.deviceId !== "string" || typeof body.refreshToken !== "string") {
    throw new AuthError(
      remoteErrorMessage(body, `pairing failed (${response.status} ${response.statusText})`)
    );
  }
  return {
    schemaVersion: 1,
    kind: "device",
    url: parsed.url,
    deviceId: body.deviceId,
    refreshToken: body.refreshToken,
  };
}

export async function createPairingInvite(
  creds: Pick<DeviceCredential, "url" | "deviceId" | "refreshToken">,
  options: { ttlMs?: number } = {}
): Promise<PairingInvite> {
  const client = new RpcClient(creds);
  const result = (await client.call("auth.createPairingInvite", [
    options.ttlMs ? { ttlMs: options.ttlMs } : {},
  ])) as Record<string, unknown> | undefined;
  if (!result || typeof result["code"] !== "string" || typeof result["connectUrl"] !== "string") {
    throw new Error("invite failed: server returned an unexpected response");
  }
  return {
    code: result["code"],
    deepLink:
      typeof result["deepLink"] === "string"
        ? result["deepLink"]
        : createConnectDeepLink(result["connectUrl"], result["code"]),
    connectUrl: result["connectUrl"],
    serverUrl: typeof result["serverUrl"] === "string" ? result["serverUrl"] : undefined,
    expiresAt: typeof result["expiresAt"] === "number" ? result["expiresAt"] : undefined,
  };
}

function remoteErrorMessage(body: { error?: unknown; code?: unknown }, fallback: string): string {
  const message = typeof body.error === "string" ? body.error : fallback;
  const code = typeof body.code === "string" ? body.code : undefined;
  return code ? `${message} [${code}]` : message;
}

function parsePairOptions(options: PairOptions): { url: string; code: string } {
  if (options.link) {
    const parsed = parseConnectLink(options.link);
    if (parsed.kind === "error") throw new Error(parsed.reason);
    return parsed;
  }
  if (!options.url || !options.code) {
    throw new Error("pair requires a natstack:// link or --url and --code");
  }
  if (!PAIRING_CODE_PATTERN.test(options.code)) {
    throw new Error("pairing code has an unexpected format");
  }
  const parsedUrl = parseConnectServerUrl(options.url);
  if (parsedUrl.kind === "error") throw new Error(parsedUrl.reason);
  return { url: parsedUrl.url, code: options.code };
}
