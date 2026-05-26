/**
 * ServerClient — WebSocket RPC client that connects Electron to the server.
 */

import { WebSocket } from "ws";
import * as fs from "fs";
import {
  BaseWsTransport,
  type ConnectionStatus,
  type WsLike,
} from "@natstack/shared/shell/transport";
import type { RpcMessage } from "@natstack/rpc";
import type { CallerKind } from "@natstack/shared/serviceDispatcher";
import { createPinnedTlsSocket } from "./tlsPinning.js";

export type { ConnectionStatus };

export interface ScopedServerCaller {
  callerId: string;
  callerKind: CallerKind;
}

export type ServerMessageListener = (fromId: string, message: RpcMessage) => void;

export interface TlsPinningOptions {
  /** Path to a CA certificate (PEM) for self-signed servers */
  caPath?: string;
  /** Expected leaf cert SHA-256 fingerprint (uppercase, colon-separated) */
  fingerprint?: string;
}

export interface ServerClient {
  /** Call a backend service via the server */
  call(service: string, method: string, args: unknown[]): Promise<unknown>;
  /** Call a backend service via the server as an Electron-hosted runtime principal. */
  callAs(
    caller: ScopedServerCaller,
    service: string,
    method: string,
    args: unknown[]
  ): Promise<unknown>;
  /** Forward server-originated messages for an Electron-hosted runtime principal. */
  addMessageListener(caller: ScopedServerCaller, listener: ServerMessageListener): () => void;
  /** Check if connected */
  isConnected(): boolean;
  /** Current connection status */
  getConnectionStatus(): ConnectionStatus;
  /** Close connection, reject all pending calls, stop reconnection */
  close(): Promise<void>;
}

export interface ServerClientOptions {
  /** Full WebSocket URL (e.g., "ws://127.0.0.1:3000" or "ws://remote.example.com:8080/rpc") */
  wsUrl?: string;
  /** Dynamic WebSocket URL provider, consulted before each connect/reconnect. */
  getWsUrl?: () => string;
  /** TLS pinning options — only honored for wss:// URLs */
  tls?: TlsPinningOptions;
  /** Called when the connection is permanently lost after explicit non-reconnect close. */
  onDisconnect?: () => void;
  /** Called when connection status changes (for UI indicators) */
  onConnectionStatusChanged?: (status: ConnectionStatus) => void;
  /** Called when the server sends an event */
  onEvent?: (event: string, payload: unknown) => void;
  /** Called after auth when the transport needs subscriptions or state replayed. */
  onRecovery?: (kind: "resubscribe" | "cold-recover") => void | Promise<void>;
  /** Enable automatic reconnection on disconnect (default: false for local, true if wsUrl is set) */
  reconnect?: boolean;
  /** Deprecated. Reconnect is now unbounded and this option is ignored. */
  maxReconnectAttempts?: number;
  /** Refresh the caller token after an auth failure during reconnect. */
  refreshAuthToken?: () => Promise<string>;
}

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

function createWsOptions(
  wsUrl: string,
  tlsOpts: TlsPinningOptions | undefined
): Record<string, unknown> {
  const isTls = wsUrl.startsWith("wss://");
  const wsOptions: Record<string, unknown> = {};
  if (!isTls || !tlsOpts) return wsOptions;

  if (tlsOpts.caPath) {
    wsOptions["ca"] = fs.readFileSync(tlsOpts.caPath);
  }

  if (tlsOpts.fingerprint) {
    const expectedFingerprint = tlsOpts.fingerprint;
    wsOptions["rejectUnauthorized"] = false;
    wsOptions["checkServerIdentity"] = () => undefined;
    const url = new URL(wsUrl);
    const host = url.hostname;
    const port = parseInt(url.port, 10) || 443;
    wsOptions["createConnection"] = () =>
      createPinnedTlsSocket({ host, port, expectedFingerprint });
  }

  return wsOptions;
}

export async function createServerClient(
  serverRpcPort: number,
  authToken: string,
  options?: ServerClientOptions
): Promise<ServerClient> {
  let activeAuthToken = authToken;
  const getWsUrl =
    options?.getWsUrl ?? (() => options?.wsUrl ?? `ws://127.0.0.1:${serverRpcPort}/rpc`);
  const shouldReconnect = options?.reconnect ?? !!(options?.wsUrl || options?.getWsUrl);
  const refreshAuthToken = options?.refreshAuthToken;

  const transport = new BaseWsTransport({
    selfId: "admin",
    getWsUrl,
    reconnect: shouldReconnect,
    logPrefix: "ServerClient",
    onConnectionStatusChanged: options?.onConnectionStatusChanged,
    onDisconnect: options?.onDisconnect,
    onEvent: options?.onEvent,
    onRecovery: options?.onRecovery,
    adapter: {
      now: () => Date.now(),
      getAuthToken: async () => activeAuthToken,
      refreshAuthToken: refreshAuthToken
        ? async () => {
            activeAuthToken = await refreshAuthToken();
            return activeAuthToken;
          }
        : undefined,
      createSocket: (url) => new NodeWsLike(new WebSocket(url, createWsOptions(url, options?.tls))),
    },
  });

  await transport.connectAndWait();

  type ScopedClient = {
    transport: BaseWsTransport;
    close(): Promise<void>;
  };
  const scopedClients = new Map<string, Promise<ScopedClient>>();
  const scopedListeners = new Map<string, Set<ServerMessageListener>>();
  const scopedKey = (caller: ScopedServerCaller): string =>
    `${caller.callerKind}\x00${caller.callerId}`;

  const createScopedClient = async (caller: ScopedServerCaller): Promise<ScopedClient> => {
    if (caller.callerKind !== "app") {
      throw new Error(`Scoped server RPC is not available for ${caller.callerKind} callers`);
    }
    const grant = await transport.callMain<{ token: string }>("auth.grantConnection", [
      caller.callerId,
    ]);
    const scopedTransport = new BaseWsTransport({
      selfId: caller.callerId,
      getWsUrl,
      reconnect: false,
      logPrefix: `ServerClient:${caller.callerId}`,
      adapter: {
        now: () => Date.now(),
        getAuthToken: async () => grant.token,
        createSocket: (url) =>
          new NodeWsLike(new WebSocket(url, createWsOptions(url, options?.tls))),
      },
      onDisconnect: () => {
        scopedClients.delete(scopedKey(caller));
      },
    });
    scopedTransport.onMessage((fromId, message) => {
      for (const listener of scopedListeners.get(scopedKey(caller)) ?? []) {
        listener(fromId, message);
      }
    });
    await scopedTransport.connectAndWait();
    return {
      transport: scopedTransport,
      close: () => scopedTransport.close(),
    };
  };

  const getScopedClient = async (caller: ScopedServerCaller): Promise<ScopedClient> => {
    const key = scopedKey(caller);
    const existing = scopedClients.get(key);
    if (existing) {
      const client = await existing;
      if (client.transport.isConnected()) return client;
      scopedClients.delete(key);
      void client.close();
    }
    const next = createScopedClient(caller).catch((err) => {
      scopedClients.delete(key);
      throw err;
    });
    scopedClients.set(key, next);
    return next;
  };

  return {
    call(service: string, method: string, args: unknown[]): Promise<unknown> {
      return transport.callMain(`${service}.${method}`, args);
    },
    async callAs(
      caller: ScopedServerCaller,
      service: string,
      method: string,
      args: unknown[]
    ): Promise<unknown> {
      if (caller.callerKind === "shell") return transport.callMain(`${service}.${method}`, args);
      const client = await getScopedClient(caller);
      return client.transport.callMain(`${service}.${method}`, args);
    },
    addMessageListener(caller: ScopedServerCaller, listener: ServerMessageListener): () => void {
      const key = scopedKey(caller);
      let listeners = scopedListeners.get(key);
      if (!listeners) {
        listeners = new Set();
        scopedListeners.set(key, listeners);
      }
      listeners.add(listener);
      return () => {
        listeners?.delete(listener);
        if (listeners?.size === 0) scopedListeners.delete(key);
      };
    },
    isConnected(): boolean {
      return transport.isConnected();
    },
    getConnectionStatus(): ConnectionStatus {
      return transport.getConnectionStatus();
    },
    async close(): Promise<void> {
      await Promise.allSettled(
        [...scopedClients.values()].map(async (client) => (await client).close())
      );
      scopedClients.clear();
      return transport.close();
    },
  };
}
