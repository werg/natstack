import { app, dialog } from "electron";
import { z } from "zod";
import * as fs from "fs";
import * as os from "os";
import * as tls from "tls";
import { request as httpsRequest, Agent as HttpsAgent, type RequestOptions } from "https";
import { request as httpRequest } from "http";
import { createHash } from "crypto";
import type { ServiceDefinition } from "@natstack/shared/serviceDefinition";
import type { StartupMode } from "../startupMode.js";
import {
  loadRemoteCredentials,
  saveRemoteCredentials,
  clearRemoteCredentials,
} from "../remoteCredentialStore.js";
import { createServerClient, type ServerClient, type TlsPinningOptions } from "../serverClient.js";
import { createPinnedHttpsAgent } from "../tlsPinning.js";
import { discoverNatstackServers } from "@natstack/shared/tailscaleDiscovery";
import { PAIRING_CODE_PATTERN, parseConnectServerUrl } from "@natstack/shared/connect";
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
  workspaceId: string;
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
    path: "/healthz",
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

async function postAuthJson(
  remoteUrl: URL,
  route: string,
  bodyValue: unknown,
  tlsOpts?: TlsPinningOptions
): Promise<{ statusCode: number; statusMessage: string; body: string }> {
  const requestUrl = new URL(route, remoteUrl);
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

export function createRemoteCredService(deps: {
  startupMode: StartupMode;
  getServerClient?: () => ServerClient | null;
}): ServiceDefinition {
  return {
    name: "remoteCred",
    description: "Manage the Electron-side remote-server credential store",
    policy: { allowed: ["shell"] },
    methods: {
      getCurrent: { args: z.tuple([]) },
      save: {
        args: z.tuple([
          z.object({
            url: z.string(),
            token: z.string(),
            caPath: z.string().optional(),
            fingerprint: z.string().optional(),
          }),
        ]),
      },
      testConnection: {
        args: z.tuple([
          z.object({
            url: z.string(),
            token: z.string(),
            caPath: z.string().optional(),
            fingerprint: z.string().optional(),
          }),
        ]),
      },
      exchangePairingCode: {
        args: z.tuple([
          z.object({
            url: z.string(),
            code: z.string(),
            caPath: z.string().optional(),
            fingerprint: z.string().optional(),
            label: z.string().optional(),
          }),
        ]),
      },
      discoverServers: { args: z.tuple([]) },
      createPairingInvite: {
        args: z.tuple([
          z
            .object({
              ttlMs: z
                .number()
                .int()
                .min(30_000)
                .max(60 * 60 * 1000)
                .optional(),
            })
            .optional(),
        ]),
      },
      listDevices: { args: z.tuple([]) },
      revokeDevice: { args: z.tuple([z.string()]) },
      fetchPeerFingerprint: { args: z.tuple([z.string()]) },
      pickCaFile: { args: z.tuple([]) },
      clear: { args: z.tuple([]) },
      relaunch: { args: z.tuple([]) },
    },
    handler: async (_ctx, method, args) => {
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
          const parsed = parseConnectServerUrl(payload.url);
          if (parsed.kind === "error") throw new Error(parsed.reason);
          saveRemoteCredentials({
            kind: "admin-token",
            url: parsed.url,
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
          const trust = await probeRemoteTrust(payload);
          if (!trust.ok) return trust;
          const parsed = new URL(parseOkUrl(payload.url));
          const isTls = parsed.protocol === "https:";
          const gatewayPort = parseInt(parsed.port, 10) || (isTls ? 443 : 80);
          const wsUrl = `${isTls ? "wss" : "ws"}://${parsed.hostname}:${gatewayPort}/rpc`;
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
          const payload = args[0] as {
            url: string;
            code: string;
            caPath?: string;
            fingerprint?: string;
            label?: string;
          };
          if (!PAIRING_CODE_PATTERN.test(payload.code)) {
            return {
              ok: false,
              error: "invalid-url",
              message: "Pairing code has an unexpected format",
            } satisfies TestConnectionResult;
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
            } satisfies TestConnectionResult;
          }
          saveRemoteCredentials({
            kind: "device",
            url: canonicalUrl,
            deviceId: json.deviceId,
            refreshToken: json.refreshToken,
            caPath: payload.caPath,
            fingerprint: payload.fingerprint,
          });
          app.relaunch();
          app.exit(0);
          return { ok: true };
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
          return (await client.call("auth", "createPairingInvite", [
            args[0] ?? {},
          ])) as PairingInvite;
        }
        case "listDevices": {
          if (deps.startupMode.kind !== "remote") return [];
          const client = deps.getServerClient?.();
          if (!client) return [];
          const response = (await client.call("auth", "listDevices", [])) as {
            devices?: DeviceRecord[];
          };
          return response.devices ?? [];
        }
        case "revokeDevice": {
          const deviceId = args[0] as string;
          if (deps.startupMode.kind !== "remote")
            throw new Error("Not connected to a remote server");
          const client = deps.getServerClient?.();
          if (!client) throw new Error("Not connected to a server");
          const response = (await client.call("auth", "revokeDevice", [deviceId])) as {
            revoked: boolean;
          };
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
