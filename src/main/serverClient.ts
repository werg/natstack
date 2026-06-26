/**
 * ServerClient — WebSocket RPC client that connects Electron to the server.
 */

import { WebSocket } from "ws";
import * as fs from "fs";
import {
  createRpcClient,
  type RpcClient,
  type RpcCallOptions,
  type RpcConnectionStatus,
  type RpcEnvelope,
} from "@natstack/rpc";
import { wsClientTransport } from "@natstack/rpc/transports/wsClient";
import { NodeWsLike } from "@natstack/shared/shell/transport/nodeWsLike";
import { authMethods } from "@natstack/shared/serviceSchemas/auth";
import type { CallerKind } from "@natstack/shared/serviceDispatcher";
import { createTypedServiceClient } from "@natstack/shared/typedServiceClient";
import { serverRpcWsUrl } from "@natstack/shared/connect";
import { createPinnedTlsSocket } from "./tlsPinning.js";

export type ConnectionStatus = RpcConnectionStatus;

export interface ScopedServerCaller {
  callerId: string;
  callerKind: CallerKind;
}

export type ServerMessageListener = (envelope: RpcEnvelope) => void;

export interface TlsPinningOptions {
  /** Path to a CA certificate (PEM) for self-signed servers */
  caPath?: string;
  /** Expected leaf cert SHA-256 fingerprint (uppercase, colon-separated) */
  fingerprint?: string;
}

export interface ServerClient {
  /** Call a backend service via the server */
  call(
    service: string,
    method: string,
    args: unknown[],
    options?: RpcCallOptions
  ): Promise<unknown>;
  /** Call a backend service via the server as an Electron-hosted runtime principal. */
  callAs(
    caller: ScopedServerCaller,
    service: string,
    method: string,
    args: unknown[],
    options?: RpcCallOptions
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
  /** Called when the server sends a host event */
  onServerEvent?: (event: string, payload: unknown) => void;
  /** Called after auth when the transport needs subscriptions or state replayed. */
  onRecovery?: (kind: "resubscribe" | "cold-recover") => void | Promise<void>;
  /** Enable automatic reconnection on disconnect (default: false for local, true if wsUrl is set) */
  reconnect?: boolean;
  /** Refresh the caller token after an auth failure during reconnect. */
  refreshAuthToken?: () => Promise<string>;
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
    options?.getWsUrl ??
    (() => options?.wsUrl ?? serverRpcWsUrl(`http://127.0.0.1:${serverRpcPort}`));
  const shouldReconnect = options?.reconnect ?? !!(options?.wsUrl || options?.getWsUrl);
  const refreshAuthToken = options?.refreshAuthToken;

  const transport = wsClientTransport({
    selfId: "admin",
    getWsUrl,
    reconnect: shouldReconnect,
    logPrefix: "ServerClient",
    onServerEvent: options?.onServerEvent,
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
  transport.onStatusChange?.((status) => {
    options?.onConnectionStatusChanged?.(status);
    if (status === "disconnected") options?.onDisconnect?.();
  });

  await transport.connectAndWait();
  const rpc = createRpcClient({
    selfId: "admin",
    callerKind: "server",
    transport,
  });
  const authClient = createTypedServiceClient("auth", authMethods, (service, method, args) =>
    rpc.call("main", `${service}.${method}`, args)
  );

  type ScopedClient = {
    transport: ReturnType<typeof wsClientTransport>;
    rpc: RpcClient;
    close(): Promise<void>;
  };
  const scopedClients = new Map<string, Promise<ScopedClient>>();
  const scopedListeners = new Map<string, Set<ServerMessageListener>>();
  const scopedKey = (caller: ScopedServerCaller): string =>
    `${caller.callerKind}\x00${caller.callerId}`;

  const createScopedClient = async (caller: ScopedServerCaller): Promise<ScopedClient> => {
    if (caller.callerKind !== "app" && caller.callerKind !== "panel") {
      throw new Error(`Scoped server RPC is not available for ${caller.callerKind} callers`);
    }
    const grant = await authClient.grantConnection(caller.callerId);
    const scopedTransport = wsClientTransport({
      selfId: caller.callerId,
      getWsUrl,
      reconnect: false,
      logPrefix: `ServerClient:${caller.callerId}`,
      translateEvent: (event, payload, deliver) => {
        deliver({
          type: "event",
          fromId: "main",
          event,
          payload,
        });
        return true;
      },
      adapter: {
        now: () => Date.now(),
        getAuthToken: async () => grant.token,
        createSocket: (url) =>
          new NodeWsLike(new WebSocket(url, createWsOptions(url, options?.tls))),
      },
    });
    const scopedRpc = createRpcClient({
      selfId: caller.callerId,
      callerKind: caller.callerKind,
      transport: scopedTransport,
    });
    scopedTransport.onStatusChange?.((status) => {
      if (status === "disconnected") scopedClients.delete(scopedKey(caller));
    });
    scopedTransport.onMessage((envelope) => {
      for (const listener of scopedListeners.get(scopedKey(caller)) ?? []) {
        listener(envelope);
      }
    });
    await scopedTransport.connectAndWait();
    return {
      transport: scopedTransport,
      rpc: scopedRpc,
      close: () => scopedTransport.close(),
    };
  };

  const getScopedClient = async (caller: ScopedServerCaller): Promise<ScopedClient> => {
    const key = scopedKey(caller);
    const existing = scopedClients.get(key);
    if (existing) {
      const client = await existing;
      if (client.transport.status?.() === "connected") return client;
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
    call(
      service: string,
      method: string,
      args: unknown[],
      options?: RpcCallOptions
    ): Promise<unknown> {
      return rpc.call("main", `${service}.${method}`, args, options);
    },
    async callAs(
      caller: ScopedServerCaller,
      service: string,
      method: string,
      args: unknown[],
      options?: RpcCallOptions
    ): Promise<unknown> {
      // Scoped server RPC is for Electron-hosted runtime principals that can be
      // granted a caller-bound connection. Native-host `shell` callers
      // (electron-main / launch gate) use the admin connection via `call()`;
      // there is no shell→runtime proxy.
      const client = await getScopedClient(caller);
      return client.rpc.call("main", `${service}.${method}`, args, options);
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
      return transport.status?.() === "connected";
    },
    getConnectionStatus(): ConnectionStatus {
      return transport.status?.() ?? "disconnected";
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
