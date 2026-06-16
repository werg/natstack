/**
 * Server RPC connection for the headless host: WS /rpc transport with
 * ws:auth fields declaring a headless client, token refresh for paired
 * device credentials, and event subscription for lease changes.
 */
import { WebSocket } from "ws";
import { createRpcClient, type RpcClient } from "@natstack/rpc";
import { wsClientTransport } from "@natstack/rpc/transports/wsClient";
import type { WsLike } from "@natstack/rpc/protocol/wsAdapter";
import { createDevLogger } from "@natstack/dev-log";
import type { HeadlessHostConfig } from "./config.js";

const log = createDevLogger("HeadlessHost:rpc");

class NodeWsLike implements WsLike {
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code?: number; reason?: string }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;

  constructor(private readonly ws: WebSocket) {
    ws.on("open", () => this.onopen?.());
    ws.on("message", (data) => this.onmessage?.({ data: data.toString() }));
    ws.on("close", (code, reason) => this.onclose?.({ code, reason: reason.toString() }));
    ws.on("error", (error) => this.onerror?.(error));
  }

  get readyState(): number {
    return this.ws.readyState;
  }

  send(data: string): void {
    this.ws.send(data);
  }

  close(code?: number, reason?: string): void {
    this.ws.close(code, reason);
  }
}

/** Exchange a paired device credential for a short-lived shell token. */
async function refreshShellToken(auth: {
  serverUrl: string;
  deviceId: string;
  refreshToken: string;
}): Promise<string> {
  const response = await fetch(new URL("/_r/s/auth/refresh-shell", auth.serverUrl), {
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
  const wsUrl = `${config.serverUrl.replace(/^http/, "ws")}/rpc`;

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
