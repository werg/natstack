import * as os from "node:os";
import {
  serverAuthRouteUrl,
  serverWorkspaceRouteUrl,
  PAIRING_CODE_PATTERN,
  parseConnectServerUrl,
} from "@natstack/shared/connect";
import { AuthError } from "./output.js";
import { authMethods } from "@natstack/shared/serviceSchemas/auth";
import { RpcClient, type DeviceCredential } from "./rpcClient.js";
import { typedClient } from "./typedClients.js";

export type { DeviceCredential } from "./rpcClient.js";
export { refreshShell, type RefreshShellResponse } from "./rpcClient.js";

export interface PairOptions {
  url?: string;
  code?: string;
  link?: string;
  label?: string;
  platform?: string;
}

export interface PairingInvite {
  code: string;
  deepLink: string | null;
  /** Legacy WS server URL. WebRTC-paired servers no longer return one, so it is
   * optional — the deep link (room/fp/sig) is the pairing material now. */
  connectUrl?: string;
  serverUrl?: string;
  expiresAt?: number;
}

export interface RemoteWorkspaceEntry {
  name: string;
  lastOpened: number;
  running?: boolean;
  ephemeral?: boolean;
}

export async function pairRemoteServer(options: PairOptions): Promise<DeviceCredential> {
  const parsed = parsePairOptions(options);
  let response: Response;
  try {
    response = await fetch(serverAuthRouteUrl(parsed.url, "complete-pairing"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        code: parsed.code,
        label: options.label ?? `${os.userInfo().username}@${os.hostname()}`,
        platform: options.platform ?? "desktop",
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
    hubUrl: parsed.url,
    deviceId: body.deviceId,
    refreshToken: body.refreshToken,
  };
}

async function postHubWorkspaceJson(
  creds: Pick<DeviceCredential, "hubUrl" | "deviceId" | "refreshToken">,
  route: string,
  body: Record<string, unknown> = {}
): Promise<Record<string, unknown>> {
  if (!creds.hubUrl) {
    throw new AuthError("stored credential is missing a hub URL; pair again");
  }
  const response = await fetch(serverWorkspaceRouteUrl(creds.hubUrl, route), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ...body,
      deviceId: creds.deviceId,
      refreshToken: creds.refreshToken,
    }),
  });
  const json = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    throw new AuthError(remoteErrorMessage(json, `workspace ${route} failed (${response.status})`));
  }
  return json;
}

export async function listRemoteWorkspaces(
  creds: Pick<DeviceCredential, "hubUrl" | "deviceId" | "refreshToken">
): Promise<RemoteWorkspaceEntry[]> {
  const json = await postHubWorkspaceJson(creds, "list");
  const workspaces = Array.isArray(json["workspaces"]) ? json["workspaces"] : [];
  const result: RemoteWorkspaceEntry[] = [];
  for (const entry of workspaces) {
    const record = entry as Record<string, unknown>;
    if (typeof record["name"] !== "string") continue;
    result.push({
      name: record["name"],
      lastOpened: typeof record["lastOpened"] === "number" ? record["lastOpened"] : 0,
      running: typeof record["running"] === "boolean" ? record["running"] : undefined,
      ephemeral: typeof record["ephemeral"] === "boolean" ? record["ephemeral"] : undefined,
    });
  }
  return result;
}

export async function selectRemoteWorkspace(
  creds: DeviceCredential,
  name: string
): Promise<DeviceCredential> {
  const json = await postHubWorkspaceJson(creds, "select", { name });
  const serverUrl = typeof json["serverUrl"] === "string" ? json["serverUrl"] : null;
  const workspaceName = typeof json["workspaceName"] === "string" ? json["workspaceName"] : name;
  if (!serverUrl) throw new AuthError("server did not return a workspace URL");
  return {
    ...creds,
    url: serverUrl,
    workspaceName,
  };
}

export async function createPairingInvite(
  creds: Pick<DeviceCredential, "url" | "deviceId" | "refreshToken">,
  options: { ttlMs?: number } = {}
): Promise<PairingInvite> {
  const auth = typedClient("auth", authMethods, new RpcClient(creds));
  // createPairingInvite has no `returns` schema yet — validate the shape here.
  const result = (await auth.createPairingInvite(options.ttlMs ? { ttlMs: options.ttlMs } : {})) as
    | Record<string, unknown>
    | undefined;
  if (!result || typeof result["code"] !== "string") {
    throw new Error("invite failed: server returned an unexpected response");
  }
  return {
    // The server mints the deep link from its WebRTC pairing material (room/fp/
    // sig); the CLI no longer has that material, so it cannot build one itself.
    // A null deepLink means the server hasn't advertised pairing material yet.
    code: result["code"],
    deepLink: typeof result["deepLink"] === "string" ? result["deepLink"] : null,
    connectUrl: typeof result["connectUrl"] === "string" ? result["connectUrl"] : undefined,
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
    // A natstack://connect link now carries a WebRTC room + DTLS fingerprint, not
    // a server URL — it is redeemed by the desktop/mobile shell over the encrypted
    // pipe, not by the CLI's HTTP device-credential pairing. There is no origin to
    // POST a pairing request to, so the CLI pairs against a co-located server URL.
    throw new Error(
      "natstack://connect links pair the desktop/mobile app over WebRTC, not the CLI. " +
        "Pair the CLI against a co-located server with --url <http://127.0.0.1:PORT> --code <code>."
    );
  }
  if (!options.url || !options.code) {
    throw new Error("pair requires --url and --code");
  }
  if (!PAIRING_CODE_PATTERN.test(options.code)) {
    throw new Error("pairing code has an unexpected format");
  }
  const parsedUrl = parseConnectServerUrl(options.url);
  if (parsedUrl.kind === "error") throw new Error(parsedUrl.reason);
  // parseConnectServerUrl's declared return type unions in ConnectLink, whose ok
  // variant (now WebRTC room/fp, no `url`) it never actually produces — narrow to
  // the origin-bearing result.
  if (!("url" in parsedUrl)) throw new Error("server URL did not resolve to an origin");
  return { url: parsedUrl.url, code: options.code };
}
