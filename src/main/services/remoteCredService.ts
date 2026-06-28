import { app, dialog } from "electron";
import * as fs from "fs";
import * as os from "os";
import * as tls from "tls";
import { request as httpsRequest, Agent as HttpsAgent, type RequestOptions } from "https";
import { request as httpRequest } from "http";
import { createHash } from "crypto";
import type { ServiceDefinition } from "@natstack/shared/serviceDefinition";
import { createTypedServiceClient } from "@natstack/shared/typedServiceClient";
import { authMethods } from "@natstack/shared/serviceSchemas/auth";
import type { ViewManager } from "../viewManager.js";
import { requireChromeAppCallerOrHost } from "./appCapabilities.js";
import { remoteCredMethods } from "@natstack/shared/serviceSchemas/remoteCred";
import type { StartupMode } from "../startupMode.js";
import {
  loadRemoteCredentials,
  saveRemoteCredentials,
  clearRemoteCredentials,
} from "../remoteCredentialStore.js";
import { createServerClient, type ServerClient, type TlsPinningOptions } from "../serverClient.js";
import { createPinnedHttpsAgent } from "../tlsPinning.js";
import { discoverNatstackServers } from "@natstack/shared/tailscaleDiscovery";
import { type Remote, reachKindForHost, normalizeRemoteId } from "@natstack/shared/remotes";
import {
  isTrustedCleartextHost,
  PAIRING_CODE_PATTERN,
  parseConnectServerUrl,
  selectedWorkspaceNameFromUrl,
  serverAuthRouteUrl,
  serverWorkspaceRouteUrl,
  serverRpcWsUrl,
} from "@natstack/shared/connect";
import { assertPresent } from "../../lintHelpers";

export interface RemoteCredCurrent {
  configured: boolean;
  isActive: boolean;
  bootstrap: "device" | "admin-token" | "hybrid" | "none";
  url?: string;
  caPath?: string;
  fingerprint?: string;
  tokenPreview?: string;
  deviceId?: string;
  hubUrl?: string;
  workspaceName?: string;
}

export interface TestConnectionResult {
  ok: boolean;
  error?: "invalid-url" | "unreachable" | "tls-mismatch" | "unauthorized" | "unknown";
  message?: string;
  observedFingerprint?: string;
  serverVersion?: string;
  serverId?: string;
  workspaceId?: string;
}

export interface DeviceRecord {
  deviceId: string;
  label: string;
  platform?: string;
  createdAt: number;
  lastUsedAt?: number;
  revokedAt?: number;
}

export interface PairingInvite {
  code: string;
  deepLink: string | null;
  connectUrl: string;
  serverUrl: string;
  publicUrl?: string | null;
  expiresAt: number;
  expiresInMs: number;
  serverId: string;
  serverBootId: string;
  workspaceId?: string | null;
}

export interface PairingCodeExchangePayload {
  url: string;
  code: string;
  caPath?: string;
  fingerprint?: string;
  label?: string;
}

export interface RemoteWorkspaceEntry {
  name: string;
  lastOpened: number;
  running?: boolean;
  ephemeral?: boolean;
}

export interface RemoteWorkspaceSelectionResult {
  workspaceName: string;
  serverUrl: string;
}

const TEST_CONNECT_TIMEOUT_MS = 7_000;

function sha256Fingerprint(der: Buffer): string {
  const hex = createHash("sha256").update(der).digest("hex").toUpperCase();
  return assertPresent(hex.match(/.{2}/g)).join(":");
}

async function probePeerFingerprint(host: string, port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const isIpLiteral = /^\d{1,3}(\.\d{1,3}){3}$|:/.test(host);
    const sock = tls.connect({
      host,
      port,
      ...(isIpLiteral ? {} : { servername: host }),
      rejectUnauthorized: false,
      checkServerIdentity: () => undefined,
      timeout: TEST_CONNECT_TIMEOUT_MS,
    });
    const cleanup = () => {
      try {
        sock.destroy();
      } catch {
        /* ignore */
      }
    };
    sock.once("secureConnect", () => {
      const cert = sock.getPeerCertificate(false);
      if (!cert || !cert.raw) {
        cleanup();
        reject(new Error("Peer presented no certificate"));
        return;
      }
      const fp = sha256Fingerprint(cert.raw);
      cleanup();
      resolve(fp);
    });
    sock.once("error", (err) => {
      cleanup();
      reject(err);
    });
    sock.once("timeout", () => {
      cleanup();
      reject(new Error("TLS probe timed out"));
    });
  });
}

async function healthProbe(
  parsed: URL,
  opts: { caPath?: string; mode: "ca-strict" | "tofu" }
): Promise<{ status: number; body: string; fingerprint?: string }> {
  const isTls = parsed.protocol === "https:";
  const port = parseInt(parsed.port, 10) || (isTls ? 443 : 80);
  const requestOptions: RequestOptions = {
    method: "GET",
    host: parsed.hostname,
    port,
    path: `${parsed.pathname.replace(/\/+$/, "") || ""}/healthz`,
    timeout: TEST_CONNECT_TIMEOUT_MS,
  };

  let fingerprint: string | undefined;

  if (isTls) {
    if (opts.caPath) {
      (requestOptions as RequestOptions & { ca?: Buffer }).ca = fs.readFileSync(opts.caPath);
    }
    if (opts.mode === "tofu") {
      (requestOptions as RequestOptions & { rejectUnauthorized?: boolean }).rejectUnauthorized =
        false;
      (
        requestOptions as RequestOptions & { checkServerIdentity?: () => undefined }
      ).checkServerIdentity = () => undefined;
    }
  }

  return new Promise((resolve, reject) => {
    const req = (isTls ? httpsRequest : httpRequest)(requestOptions, (res) => {
      if (isTls) {
        const sock = res.socket as tls.TLSSocket;
        const cert = sock.getPeerCertificate?.(false);
        if (cert && cert.raw) fingerprint = sha256Fingerprint(cert.raw);
      }
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        resolve({
          status: res.statusCode ?? 0,
          body: Buffer.concat(chunks).toString("utf-8"),
          fingerprint,
        });
      });
    });
    req.once("error", reject);
    req.once("timeout", () => req.destroy(new Error("health probe timed out")));
    req.end();
  });
}

export async function probeRemoteTrust(payload: {
  url: string;
  caPath?: string;
  fingerprint?: string;
}): Promise<TestConnectionResult> {
  const parsedUrl = parseConnectServerUrl(payload.url);
  if (parsedUrl.kind === "error") {
    return { ok: false, error: "invalid-url", message: parsedUrl.reason };
  }
  const parsed = new URL(parsedUrl.url);
  return await probeTrustAtUrl(parsed, payload);
}

async function probeSelectedWorkspaceTrust(payload: {
  url: string;
  caPath?: string;
  fingerprint?: string;
}): Promise<TestConnectionResult> {
  let selected: ReturnType<typeof parseSelectedWorkspaceUrl>;
  try {
    selected = parseSelectedWorkspaceUrl(payload.url);
  } catch (error) {
    return {
      ok: false,
      error: "invalid-url",
      message: error instanceof Error ? error.message : String(error),
    };
  }
  return await probeTrustAtUrl(new URL(selected.serverUrl), payload);
}

async function probeTrustAtUrl(
  parsed: URL,
  payload: { caPath?: string; fingerprint?: string }
): Promise<TestConnectionResult> {
  const isTls = parsed.protocol === "https:";

  try {
    const strict = await healthProbe(parsed, { caPath: payload.caPath, mode: "ca-strict" });
    if (
      isTls &&
      payload.fingerprint &&
      strict.fingerprint &&
      strict.fingerprint !== payload.fingerprint
    ) {
      return {
        ok: false,
        error: "tls-mismatch",
        message: `Fingerprint mismatch: expected ${payload.fingerprint}, got ${strict.fingerprint}`,
        observedFingerprint: strict.fingerprint,
      };
    }
    return healthProbeToResult(strict);
  } catch (err) {
    const msg = (err as Error).message ?? "unreachable";
    const isCert = isTls && /certificate|TLS|unable to verify|self[- ]signed|cert/i.test(msg);
    if (!isCert) {
      return { ok: false, error: "unreachable", message: msg };
    }
    try {
      const tofu = await healthProbe(parsed, { caPath: payload.caPath, mode: "tofu" });
      if (payload.fingerprint) {
        if (tofu.fingerprint === payload.fingerprint) return healthProbeToResult(tofu);
        return {
          ok: false,
          error: "tls-mismatch",
          message: `Fingerprint mismatch: expected ${payload.fingerprint}, got ${tofu.fingerprint ?? "unknown"}`,
          observedFingerprint: tofu.fingerprint,
        };
      }
      return {
        ok: false,
        error: "tls-mismatch",
        message:
          "No fingerprint configured — confirm the one returned in observedFingerprint before saving.",
        observedFingerprint: tofu.fingerprint,
      };
    } catch (tofuErr) {
      return {
        ok: false,
        error: "tls-mismatch",
        message: (tofuErr as Error).message,
      };
    }
  }
}

function healthProbeToResult(probe: { status: number; body: string; fingerprint?: string }) {
  if (probe.status !== 200) {
    return {
      ok: false,
      error: "unreachable" as const,
      message: `/healthz returned ${probe.status}`,
      observedFingerprint: probe.fingerprint,
    };
  }
  let serverVersion: string | undefined;
  let serverId: string | undefined;
  let workspaceId: string | undefined;
  try {
    const body = JSON.parse(probe.body) as Record<string, unknown>;
    if (typeof body["version"] === "string") serverVersion = body["version"];
    if (typeof body["serverId"] === "string") serverId = body["serverId"];
    if (typeof body["workspaceId"] === "string") workspaceId = body["workspaceId"];
  } catch {
    /* body not JSON — fine */
  }
  return {
    ok: true,
    observedFingerprint: probe.fingerprint,
    serverVersion,
    serverId,
    workspaceId,
  } satisfies TestConnectionResult;
}

async function postJsonUrl(
  requestUrl: URL,
  bodyValue: unknown,
  tlsOpts?: TlsPinningOptions
): Promise<{ statusCode: number; statusMessage: string; body: string }> {
  const body = JSON.stringify(bodyValue);
  const isHttps = requestUrl.protocol === "https:";
  const agent =
    isHttps && tlsOpts?.fingerprint
      ? createPinnedHttpsAgent(tlsOpts.fingerprint)
      : isHttps && tlsOpts?.caPath
        ? new HttpsAgent({ ca: fs.readFileSync(tlsOpts.caPath) })
        : undefined;

  return new Promise((resolve, reject) => {
    const req = (isHttps ? httpsRequest : httpRequest)(
      requestUrl,
      {
        method: "POST",
        agent,
        headers: {
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
}

async function postAuthJson(
  remoteUrl: URL,
  route: string,
  bodyValue: unknown,
  tlsOpts?: TlsPinningOptions
): Promise<{ statusCode: number; statusMessage: string; body: string }> {
  const requestUrl = route.startsWith("/_r/s/auth/")
    ? serverAuthRouteUrl(remoteUrl, route.slice("/_r/s/auth/".length))
    : new URL(route, remoteUrl);
  return postJsonUrl(requestUrl, bodyValue, tlsOpts);
}

function authClientFor(client: ServerClient) {
  return createTypedServiceClient("auth", authMethods, (svc, m, a) => client.call(svc, m, a));
}

async function postHubWorkspaceJson(
  hubUrl: string,
  route: string,
  creds: { deviceId: string; refreshToken: string; caPath?: string; fingerprint?: string },
  body: Record<string, unknown> = {}
): Promise<Record<string, unknown>> {
  const requestUrl = serverWorkspaceRouteUrl(hubUrl, route);
  const response = await postJsonUrl(
    requestUrl,
    {
      ...body,
      deviceId: creds.deviceId,
      refreshToken: creds.refreshToken,
    },
    { caPath: creds.caPath, fingerprint: creds.fingerprint }
  );
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(response.body || "{}") as Record<string, unknown>;
  } catch {
    json = {};
  }
  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new Error(
      typeof json["error"] === "string"
        ? json["error"]
        : `Workspace ${route} failed (${response.statusCode})`
    );
  }
  return json;
}

export async function listRemoteWorkspaces(): Promise<RemoteWorkspaceEntry[]> {
  const creds = loadRemoteCredentials();
  if (!creds || (creds.kind !== "device" && creds.kind !== "hybrid")) {
    throw new Error("Pair with a server before choosing a workspace");
  }
  if (!creds.hubUrl) throw new Error("Stored credential is missing a hub URL; pair again");
  const hubUrl = creds.hubUrl;
  const json = await postHubWorkspaceJson(hubUrl, "list", creds);
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

export async function selectRemoteWorkspace(name: string): Promise<RemoteWorkspaceSelectionResult> {
  const creds = loadRemoteCredentials();
  if (!creds || (creds.kind !== "device" && creds.kind !== "hybrid")) {
    throw new Error("Pair with a server before choosing a workspace");
  }
  if (!creds.hubUrl) throw new Error("Stored credential is missing a hub URL; pair again");
  const hubUrl = creds.hubUrl;
  const json = await postHubWorkspaceJson(hubUrl, "select", creds, { name });
  const workspaceName = typeof json["workspaceName"] === "string" ? json["workspaceName"] : name;
  const serverUrl = typeof json["serverUrl"] === "string" ? json["serverUrl"] : null;
  if (!serverUrl) throw new Error("Server did not return a workspace URL");
  saveRemoteCredentials({
    ...creds,
    url: serverUrl,
    hubUrl,
    workspaceName,
  });
  return { workspaceName, serverUrl };
}

export async function exchangePairingCodeForDeviceCredential(
  payload: PairingCodeExchangePayload
): Promise<TestConnectionResult> {
  if (!PAIRING_CODE_PATTERN.test(payload.code)) {
    return {
      ok: false,
      error: "invalid-url",
      message: "Pairing code has an unexpected format",
    };
  }
  const trust = await probeRemoteTrust(payload);
  if (!trust.ok) return trust;
  const canonicalUrl = parseOkUrl(payload.url);
  const response = await postAuthJson(
    new URL(canonicalUrl),
    "/_r/s/auth/complete-pairing",
    {
      code: payload.code,
      label: payload.label?.trim() || `Electron on ${os.hostname()}`,
      platform: "desktop",
    },
    { caPath: payload.caPath, fingerprint: payload.fingerprint }
  );
  const json = JSON.parse(response.body || "{}") as {
    deviceId?: unknown;
    refreshToken?: unknown;
    error?: unknown;
  };
  if (
    response.statusCode < 200 ||
    response.statusCode >= 300 ||
    typeof json.deviceId !== "string" ||
    typeof json.refreshToken !== "string"
  ) {
    return {
      ok: false,
      error: response.statusCode === 401 ? "unauthorized" : "unknown",
      message:
        typeof json.error === "string"
          ? json.error
          : `Pairing failed (${response.statusCode}): ${response.statusMessage}`,
    };
  }
  saveRemoteCredentials({
    kind: "device",
    url: canonicalUrl,
    hubUrl: canonicalUrl,
    deviceId: json.deviceId,
    refreshToken: json.refreshToken,
    caPath: payload.caPath,
    fingerprint: payload.fingerprint,
  });
  return { ok: true };
}

// Single-remote → roster adapter for userland (the mobile-debug extension).
// The host tracks one remote credential; present it as a one-element Remote
// roster so roster-shaped pairing (remotes.list / *ForRemote) works unchanged.
function currentRemoteAsRoster(): Remote[] {
  const creds = loadRemoteCredentials();
  if (!creds?.url) return [];
  let host: string;
  let gatewayPort: number | undefined;
  try {
    const parsed = new URL(creds.url);
    host = parsed.hostname;
    const port = parseInt(parsed.port, 10);
    if (port) gatewayPort = port;
  } catch {
    return [];
  }
  return [
    {
      id: normalizeRemoteId(creds.workspaceName || host || "current"),
      ...(creds.workspaceName ? { label: creds.workspaceName } : {}),
      reach: [{ kind: reachKindForHost(host), value: host }],
      trust: creds.fingerprint ? { tlsFingerprint: creds.fingerprint } : {},
      source: "paired",
      createdAt: Date.now(),
      server: {
        url: creds.url,
        ...(creds.hubUrl ? { hubUrl: creds.hubUrl } : {}),
        publicUrl: creds.url,
        ...(gatewayPort ? { gatewayPort } : {}),
        ...(creds.workspaceName ? { unitName: creds.workspaceName } : {}),
      },
    },
  ];
}

export function createRemoteCredService(deps: {
  startupMode: StartupMode;
  getServerClient?: () => ServerClient | null;
  getViewManager?: () => ViewManager;
}): ServiceDefinition {
  return {
    name: "remoteCred",
    description: "Manage the Electron-side remote-server credential store",
    // The workspace shell renderer (apps/shell, connection-management) is an
    // `app`; native-host `shell` also calls here. App callers are gated to
    // authorized chrome (panel-hosting) so no arbitrary app can manage creds.
    policy: { allowed: ["shell", "app"] },
    methods: remoteCredMethods,
    handler: async (_ctx, method, args) => {
      if (_ctx.caller.runtime.kind === "app") {
        if (!deps.getViewManager) {
          throw new Error(`remoteCred.${method} app capability unavailable`);
        }
        requireChromeAppCallerOrHost(_ctx, deps.getViewManager(), `remoteCred.${method}`);
      }
      switch (method) {
        case "getCurrent": {
          const creds = loadRemoteCredentials();
          if (!creds) {
            return {
              configured: false,
              isActive: deps.startupMode.kind === "remote",
              bootstrap: "none",
            } satisfies RemoteCredCurrent;
          }
          const adminToken =
            creds.kind === "admin-token" || creds.kind === "hybrid" ? creds.adminToken : undefined;
          return {
            configured: true,
            isActive: deps.startupMode.kind === "remote",
            bootstrap: creds.kind,
            url: creds.url,
            hubUrl: creds.hubUrl,
            workspaceName: creds.workspaceName,
            caPath: creds.caPath,
            fingerprint: creds.fingerprint,
            deviceId:
              creds.kind === "device" || creds.kind === "hybrid" ? creds.deviceId : undefined,
            tokenPreview: adminToken
              ? adminToken.slice(0, 4) + "…" + adminToken.slice(-4)
              : undefined,
          } satisfies RemoteCredCurrent;
        }
        case "save": {
          const payload = args[0] as {
            url: string;
            token: string;
            caPath?: string;
            fingerprint?: string;
          };
          const selected = parseSelectedWorkspaceUrl(payload.url);
          saveRemoteCredentials({
            kind: "admin-token",
            url: selected.serverUrl,
            hubUrl: selected.hubUrl,
            workspaceName: selected.workspaceName,
            adminToken: payload.token,
            caPath: payload.caPath,
            fingerprint: payload.fingerprint,
          });
          return { ok: true };
        }
        case "testConnection": {
          const payload = args[0] as {
            url: string;
            token: string;
            caPath?: string;
            fingerprint?: string;
          };
          let selected: ReturnType<typeof parseSelectedWorkspaceUrl>;
          try {
            selected = parseSelectedWorkspaceUrl(payload.url);
          } catch (error) {
            return {
              ok: false,
              error: "invalid-url",
              message: error instanceof Error ? error.message : String(error),
            } satisfies TestConnectionResult;
          }
          const trust = await probeSelectedWorkspaceTrust(payload);
          if (!trust.ok) return trust;
          const parsed = new URL(selected.serverUrl);
          const isTls = parsed.protocol === "https:";
          const gatewayPort = parseInt(parsed.port, 10) || (isTls ? 443 : 80);
          const wsUrl = serverRpcWsUrl(parsed);
          let client: Awaited<ReturnType<typeof createServerClient>> | null = null;
          try {
            client = await createServerClient(gatewayPort, payload.token, {
              wsUrl,
              tls: { caPath: payload.caPath, fingerprint: payload.fingerprint },
              reconnect: false,
            });
          } catch (err) {
            const msg = (err as Error).message ?? "auth failed";
            const isAuth = /auth|unauthorized|401|token/i.test(msg);
            return {
              ok: false,
              error: isAuth ? "unauthorized" : "unknown",
              message: msg,
              observedFingerprint: trust.observedFingerprint,
            } satisfies TestConnectionResult;
          } finally {
            try {
              await client?.close();
            } catch {
              /* ignore */
            }
          }
          return trust;
        }
        case "exchangePairingCode": {
          const result = await exchangePairingCodeForDeviceCredential(
            args[0] as PairingCodeExchangePayload
          );
          return result;
        }
        case "discoverServers":
          return discoverNatstackServers();
        case "createPairingInvite": {
          if (deps.startupMode.kind !== "remote")
            throw new Error(
              "Pairing invites are only available while connected to a remote server"
            );
          const client = deps.getServerClient?.();
          if (!client) throw new Error("Not connected to a server");
          return await authClientFor(client).createPairingInvite(
            (args[0] ?? {}) as { ttlMs?: number }
          );
        }
        case "listDevices": {
          if (deps.startupMode.kind !== "remote") return [];
          const client = deps.getServerClient?.();
          if (!client) return [];
          const response = await authClientFor(client).listDevices();
          return response.devices;
        }
        case "remotes.list":
          return currentRemoteAsRoster();
        case "createPairingInviteForRemote": {
          if (deps.startupMode.kind !== "remote")
            throw new Error(
              "Pairing invites are only available while connected to a remote server"
            );
          const client = deps.getServerClient?.();
          if (!client) throw new Error("Not connected to a server");
          const payload = (args[0] ?? {}) as { remoteId?: string; ttlMs?: number };
          return await authClientFor(client).createPairingInvite({ ttlMs: payload.ttlMs });
        }
        case "listDevicesForRemote": {
          if (deps.startupMode.kind !== "remote") return [];
          const client = deps.getServerClient?.();
          if (!client) return [];
          const response = await authClientFor(client).listDevices();
          return response.devices;
        }
        case "revokeDevice": {
          const deviceId = args[0] as string;
          if (deps.startupMode.kind !== "remote")
            throw new Error("Not connected to a remote server");
          const client = deps.getServerClient?.();
          if (!client) throw new Error("Not connected to a server");
          const response = await authClientFor(client).revokeDevice(deviceId);
          const current = loadRemoteCredentials();
          if (
            response.revoked &&
            current &&
            (current.kind === "device" || current.kind === "hybrid") &&
            current.deviceId === deviceId
          ) {
            clearRemoteCredentials();
            app.relaunch();
            app.exit(0);
          }
          return response;
        }
        case "fetchPeerFingerprint": {
          const urlStr = args[0] as string;
          let parsed: URL;
          try {
            parsed = new URL(urlStr);
          } catch (err) {
            throw new Error(`Invalid URL: ${(err as Error).message}`);
          }
          if (parsed.protocol !== "https:") {
            throw new Error("fetchPeerFingerprint requires an https:// URL");
          }
          const port = parseInt(parsed.port, 10) || 443;
          return await probePeerFingerprint(parsed.hostname, port);
        }
        case "pickCaFile": {
          const result = await dialog.showOpenDialog({
            properties: ["openFile"],
            title: "Select CA certificate",
            filters: [
              { name: "PEM certificate", extensions: ["pem", "crt", "cer"] },
              { name: "All files", extensions: ["*"] },
            ],
          });
          return result.canceled ? null : (result.filePaths[0] ?? null);
        }
        case "clear":
          clearRemoteCredentials();
          return { ok: true };
        case "relaunch":
          app.relaunch();
          app.exit(0);
          return { ok: true };
        default:
          throw new Error(`Unknown remoteCred method: ${method}`);
      }
    },
  };
}

function parseOkUrl(raw: string): string {
  const parsed = parseConnectServerUrl(raw);
  if (parsed.kind === "error") throw new Error(parsed.reason);
  return parsed.url;
}

function parseSelectedWorkspaceUrl(raw: string): {
  serverUrl: string;
  hubUrl: string;
  workspaceName: string;
} {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`Server URL is not parseable: ${raw}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Server URL must use http:// or https:// (got ${url.protocol || "no scheme"})`);
  }
  if (!url.hostname) throw new Error("Server URL is missing a hostname");
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("Workspace URL must not include credentials, query, or fragment");
  }
  if (url.protocol === "http:" && !isTrustedCleartextHost(url.hostname)) {
    throw new Error(
      `Cleartext HTTP is only allowed for loopback, private LAN, Tailscale, or local hostnames. Use https:// for ${url.hostname}.`
    );
  }
  const workspaceName = selectedWorkspaceNameFromUrl(url);
  if (!workspaceName) {
    throw new Error("Remote credentials require a selected workspace URL");
  }
  const pathName = url.pathname.replace(/\/+$/, "");
  const hubUrl = `${url.protocol}//${url.host}`;
  return {
    serverUrl: `${hubUrl}${pathName}`,
    hubUrl,
    workspaceName,
  };
}
