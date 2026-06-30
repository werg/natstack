import { app, safeStorage } from "electron";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ServiceDefinition } from "@natstack/shared/serviceDefinition";
import { createTypedServiceClient } from "@natstack/shared/typedServiceClient";
import { authMethods } from "@natstack/shared/serviceSchemas/auth";
import type { ViewManager } from "../viewManager.js";
import { requireChromeAppCallerOrHost } from "./appCapabilities.js";
import { remoteCredMethods } from "@natstack/shared/serviceSchemas/remoteCred";
import type { StartupMode } from "../startupMode.js";
import { createServerClient, type ServerClient } from "../serverClient.js";
import { relaunchApp } from "../relaunchApp.js";
import {
  isLoopbackHost,
  selectedWorkspaceNameFromUrl,
  parseConnectLink,
  createConnectDeepLink,
} from "@natstack/shared/connect";
import {
  createRemoteCredStore,
  type RemoteCredStore,
  type StoredRemote,
} from "./remoteCredStore.js";

/**
 * Client-side persistence of a WebRTC remote pairing. A desktop client that has
 * paired with a remote server over WebRTC (DTLS-fingerprint pinned, §8c) keeps,
 * encrypted at rest under `safeStorage`:
 *   - the pairing material (`room`/`fp`/`sig`/`ice`/`srv`) MINUS the one-time
 *     `code`, so it can re-dial the same answerer, and
 *   - the durable device credential (`deviceId`/`refreshToken`) the server
 *     issued, so it can re-authenticate without re-pairing (`refresh:…`).
 *
 * The store is created lazily (on first use) so that `app.getPath("userData")`
 * is read AFTER the startup `app.setPath("userData", …)` call has run, and so the
 * module can be imported in non-Electron unit tests without touching safeStorage.
 */
let storeSingleton: RemoteCredStore | null = null;
function getStore(): RemoteCredStore {
  if (!storeSingleton) {
    storeSingleton = createRemoteCredStore({
      filePath: path.join(app.getPath("userData"), "webrtc-remote.json"),
      cipher: {
        encrypt: (s) => safeStorage.encryptString(s),
        decrypt: (b) => safeStorage.decryptString(b),
        isAvailable: () => safeStorage.isEncryptionAvailable(),
      },
      fs,
      dirname: path.dirname,
    });
  }
  return storeSingleton;
}

function remoteCredentialPersistenceDisabled(): boolean {
  const value = process.env["NATSTACK_DISABLE_REMOTE_CRED_PERSISTENCE"];
  return value === "1" || value === "true";
}

/** Read the persisted WebRTC remote pairing, if any (consumed by serverSession). */
export function loadStoredRemotePairing(): StoredRemote | null {
  return getStore().load();
}

/**
 * Drop the persisted WebRTC remote pairing. Used by the startup recovery path
 * when a returning device's credential is terminally rejected (revoked/reset/cert
 * regenerated): clearing it makes the next launch fall back to the server chooser
 * instead of re-dialing a dead pairing forever (a permanent-lockout otherwise).
 */
export function clearStoredRemotePairing(): void {
  getStore().clear();
}

/**
 * Persist via the store, surfacing (loudly) a refusal to write the refresh secret
 * in plaintext (OS secure storage unavailable) rather than crashing the live
 * session. The pipe stays up; the device simply re-pairs on the next launch.
 */
function persistOrWarn(label: string, persist: () => void): void {
  try {
    persist();
  } catch (error) {
    console.error(
      `[remoteCred] ${label}: ${error instanceof Error ? error.message : String(error)} ` +
        "— the device will need to re-pair on next launch."
    );
  }
}

/**
 * Persist a rotated device credential against the existing stored pairing. Fired
 * from the reconnect path's `onPaired` if the server hands back a fresh
 * refresh token, so the next launch authenticates with the current secret.
 * No-ops when nothing is stored (there is no pairing to attach it to).
 */
export function persistRotatedRemoteCredential(cred: {
  deviceId: string;
  refreshToken: string;
}): void {
  if (remoteCredentialPersistenceDisabled()) return;
  const existing = getStore().load();
  if (!existing) return;
  persistOrWarn("could not persist rotated credential", () =>
    getStore().save({
      ...existing,
      deviceId: cred.deviceId,
      refreshToken: cred.refreshToken,
      pairedAt: Date.now(),
    })
  );
}

/**
 * Persist a freshly-paired WebRTC remote — the pairing material (minus the
 * one-time `code`) plus the device credential the server issued. Called from the
 * fresh-pair session's `onPaired` (serverSession.establishFreshPairSession) so
 * the NEXT launch reconnects with the refresh token instead of re-pairing.
 */
export function saveStoredRemote(value: StoredRemote): void {
  if (remoteCredentialPersistenceDisabled()) return;
  persistOrWarn("could not persist remote pairing", () => getStore().save(value));
}

export interface RemoteCredCurrent {
  configured: boolean;
  isActive: boolean;
  bootstrap: "device" | "admin-token" | "hybrid" | "none";
  url?: string;
  tokenPreview?: string;
  deviceId?: string;
  hubUrl?: string;
  workspaceName?: string;
}

export interface TestConnectionResult {
  ok: boolean;
  error?: "invalid-url" | "unreachable" | "unauthorized" | "unknown";
  message?: string;
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
  serverUrl: string;
  expiresAt: number;
  expiresInMs: number;
  serverId: string;
  serverBootId: string;
  workspaceId?: string | null;
}

// `exchangePairingCode` (the throwaway redeem-then-relaunch) was removed: the
// bootstrap chooser now hands a parsed pairing straight to
// `establishServerSession({ pendingPairing })`, and that single WebRTC pipe
// authenticates with the one-time code and STAYS as the session — see
// serverSession.establishFreshPairSession. The fresh credential is persisted via
// `saveStoredRemote` (above) on `onPaired`, so the next launch reconnects with a
// refresh token.

function authClientFor(client: ServerClient) {
  return createTypedServiceClient("auth", authMethods, (svc, m, a) => client.call(svc, m, a));
}

export function createRemoteCredService(deps: {
  startupMode: StartupMode;
  getServerClient?: () => ServerClient | null;
  getViewManager?: () => ViewManager;
}): ServiceDefinition {
  const liveServerClient = (): ServerClient | null => deps.getServerClient?.() ?? null;
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
          // Reflect the persisted WebRTC pairing. A stored remote means this
          // process connected to it remotely (establishServerSession picks it up
          // before spawning local), so "active" is "stored + live pipe".
          const stored = loadStoredRemotePairing();
          const client = liveServerClient();
          return {
            configured: !!stored,
            isActive: !!stored && (client?.isConnected() ?? false),
            bootstrap: stored ? "device" : "none",
            deviceId: stored?.deviceId,
            workspaceName: stored?.workspaceName,
          } satisfies RemoteCredCurrent;
        }
        case "save":
          // Admin-token remote persistence rode the deleted cleartext-remote
          // store (§8c). Remote servers are paired by WebRTC QR now; fail loud
          // rather than pretend to persist an admin-token remote.
          throw new Error(
            "Admin-token remote persistence was removed (§8c). Pair a server over WebRTC instead."
          );
        case "testConnection": {
          // Rewritten to drop the TLS fingerprint probe: just validate the URL
          // resolves to a loopback gateway and that the token authenticates. The
          // only cleartext origin allowed post-cutover is loopback; a remote
          // server is reached over WebRTC, not tested by URL here.
          const payload = args[0] as { url: string; token: string };
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
          const parsed = new URL(selected.serverUrl);
          const gatewayPort = parseInt(parsed.port, 10) || 80;
          let client: Awaited<ReturnType<typeof createServerClient>> | null = null;
          try {
            // createServerClient dials the fixed loopback gateway for the port.
            client = await createServerClient(gatewayPort, payload.token, { reconnect: false });
          } catch (err) {
            const msg = (err as Error).message ?? "auth failed";
            const isAuth = /auth|unauthorized|401|token/i.test(msg);
            const isReach = /ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|timed out|timeout/i.test(msg);
            return {
              ok: false,
              error: isAuth ? "unauthorized" : isReach ? "unreachable" : "unknown",
              message: msg,
            } satisfies TestConnectionResult;
          } finally {
            try {
              await client?.close();
            } catch {
              /* ignore */
            }
          }
          return { ok: true } satisfies TestConnectionResult;
        }
        case "exchangePairingCode": {
          // New model: there is NO separate redeem step — the WebRTC pipe
          // authenticates with the one-time code on connect (establishServerSession),
          // so this can't redeem in-process. Relaunch carrying the pairing as a
          // `natstack://` deep-link arg; the startup's enqueueFirstArgvLink →
          // getPendingConnectLink hands it to establishServerSession, which dials it
          // and KEEPS the pipe as the session (the issued device credential persists
          // on onPaired). The shell-reachable analogue of the bootstrap pair-remote IPC.
          const { link } = (args[0] ?? {}) as { link?: string };
          const parsed = parseConnectLink(typeof link === "string" ? link : "");
          if (parsed.kind === "error") {
            return {
              ok: false,
              error: "invalid-url",
              message: parsed.reason,
            } satisfies TestConnectionResult;
          }
          const { kind: _kind, ...pairing } = parsed;
          const deepLink = createConnectDeepLink(pairing);
          // Drop any prior pairing arg so relaunches don't accumulate stale links.
          const relaunchArgs = process.argv.slice(1).filter((a) => !a.startsWith("natstack://"));
          relaunchArgs.push(deepLink);
          relaunchApp({ args: relaunchArgs });
          return { ok: true } satisfies TestConnectionResult; // unreachable; relaunchApp exits
        }
        case "createPairingInvite": {
          // Mint a pairing invite on the currently-connected server (local OR
          // remote). Available whenever a server session exists — it never
          // depended on the client-side store.
          const client = liveServerClient();
          if (!client) throw new Error("Not connected to a server");
          const payload = (args[0] ?? {}) as { ttlMs?: number };
          return await authClientFor(client).createPairingInvite({ ttlMs: payload.ttlMs });
        }
        case "listDevices": {
          const client = liveServerClient();
          if (!client) return [];
          const response = await authClientFor(client).listDevices();
          return response.devices;
        }
        case "revokeDevice": {
          const deviceId = args[0] as string;
          const client = liveServerClient();
          if (!client) throw new Error("Not connected to a server");
          return await authClientFor(client).revokeDevice(deviceId);
        }
        case "clear":
          // Forget the persisted WebRTC pairing; the next launch starts unpaired
          // (local chooser) until a new server is paired.
          getStore().clear();
          return { ok: true };
        case "relaunch":
          relaunchApp();
          return { ok: true };
        default:
          throw new Error(`Unknown remoteCred method: ${method}`);
      }
    },
  };
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
  if (url.protocol === "http:" && !isLoopbackHost(url.hostname)) {
    throw new Error(
      `Cleartext HTTP is only allowed for loopback. A remote server is reached over WebRTC, not by URL. Use https:// for ${url.hostname}.`
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
