/**
 * Server RPC connection for the headless host: WS /rpc transport with
 * ws:auth fields declaring a headless client, token refresh for paired
 * device credentials, and event subscription for lease changes.
 */
import { WebSocket } from "ws";
import { createRpcClient, type RpcClient } from "@natstack/rpc";
import { wsClientTransport } from "@natstack/rpc/transports/wsClient";
import { NodeWsLike } from "@natstack/shared/shell/transport/nodeWsLike";
import { createDevLogger } from "@natstack/dev-log";
import type { HeadlessHostConfig } from "./config.js";
import { serverAuthRouteUrl, serverRpcWsUrl } from "@natstack/shared/connect";

const log = createDevLogger("HeadlessHost:rpc");

/** Exchange a paired device credential for a short-lived shell token. */
async function refreshShellToken(auth: {
  serverUrl: string;
  deviceId: string;
  refreshToken: string;
}): Promise<string> {
  const response = await fetch(serverAuthRouteUrl(auth.serverUrl, "refresh-shell"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ deviceId: auth.deviceId, refreshToken: auth.refreshToken }),
  });
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok || typeof body["shellToken"] !== "string") {
    throw new Error(
      typeof body["error"] === "string"
        ? body["error"]
        : `shell refresh failed (${response.status})`
    );
  }
  return body["shellToken"];
}

export interface ServerConnection {
  rpc: RpcClient;
  /** Current auth token (refreshed for device credentials). */
  getToken(): string;
  onServerEvent(listener: (event: string, payload: unknown) => void): void;
  onResubscribe(handler: () => void | Promise<void>): void;
  close(): Promise<void>;
}

export function normalizeServerEventName(event: string): string {
  return event.startsWith("event:") ? event.slice("event:".length) : event;
}

export async function connectToServer(config: HeadlessHostConfig): Promise<ServerConnection> {
  let currentToken =
    config.auth.kind === "token" ? config.auth.token : await refreshShellToken(config.auth);
  const eventListeners = new Set<(event: string, payload: unknown) => void>();
  const wsUrl = serverRpcWsUrl(config.serverUrl);

  const transport = wsClientTransport({
    selfId: config.clientSessionId,
    getWsUrl: () => wsUrl,
    reconnect: true,
    logPrefix: "HeadlessHost",
    onServerEvent: (event, payload) => {
      const normalizedEvent = normalizeServerEventName(event);
      for (const listener of eventListeners) listener(normalizedEvent, payload);
    },
    getAuthMessageFields: () => ({
      clientLabel: config.label,
      clientSessionId: config.clientSessionId,
      clientPlatform: "headless",
    }),
    adapter: {
      now: () => Date.now(),
      getAuthToken: async () => currentToken,
      refreshAuthToken:
        config.auth.kind === "device"
          ? async () => {
              currentToken = await refreshShellToken(
                config.auth as { serverUrl: string; deviceId: string; refreshToken: string }
              );
              return currentToken;
            }
          : undefined,
      createSocket: (url) => new NodeWsLike(new WebSocket(url)),
    },
  });

  await transport.connectAndWait();
  log.info(`connected to ${wsUrl} as ${config.clientSessionId}`);

  const rpc = createRpcClient({
    selfId: config.clientSessionId,
    callerKind: "shell",
    transport,
  });

  return {
    rpc,
    getToken: () => currentToken,
    onServerEvent: (listener) => {
      eventListeners.add(listener);
    },
    onResubscribe: (handler) => {
      transport.onRecovery("resubscribe", handler);
      transport.onRecovery("cold-recover", handler);
    },
    close: () => transport.close(),
  };
}
