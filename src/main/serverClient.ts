/**
 * ServerClient — WebSocket RPC client that connects Electron to the server.
 */

import { WebSocket } from "ws";
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

export type ConnectionStatus = RpcConnectionStatus;

export interface ScopedServerCaller {
  callerId: string;
  callerKind: CallerKind;
}

export type ServerMessageListener = (envelope: RpcEnvelope) => void;

/**
 * A dedicated logical session for a single desktop panel principal. The host
 * (ipcDispatcher) relays the panel webview's RAW envelopes over it, so it carries
 * the panel's FULL RPC surface — requests, routed DO calls, event subscriptions,
 * and streams — as that panel's own `callerKind:"panel"` connection (the desktop
 * analogue of mobile's `openPanelSession`). The server attributes everything to
 * the panel by the authenticated session, so the host needs no per-message-type
 * handling.
 */
export interface PanelSession {
  send(envelope: RpcEnvelope): Promise<void> | void;
  onMessage(listener: ServerMessageListener): () => void;
  /** Status of the underlying session — the relay re-creates a dead one. */
  status?(): ConnectionStatus;
  /** True once the session is terminally closed (WebRTC). */
  isClosed?(): boolean;
  close(): void;
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
  /**
   * Open a dedicated session for a desktop panel principal, redeeming its
   * existing runtime lease (`connectionId`) with a one-shot grant for
   * `runtimeEntityId`. The host relays the panel's raw envelopes over it; see
   * {@link PanelSession}. Since the panel no longer opens its own `/rpc` socket
   * (the shell-bridge migration), the host-opened session redeems the lease with
   * no conflict.
   */
  openPanelSession(runtimeEntityId: string, connectionId: string): Promise<PanelSession>;
  /**
   * Stream a backend service method's `Response` over the pipe's bulk channel
   * (chunked) — for large/streamed bodies (e.g. `gateway.fetch` panel assets)
   * that exceed the control-channel message-size limit.
   */
  stream(service: string, method: string, args: unknown[]): Promise<Response>;
  /** Check if connected */
  isConnected(): boolean;
  /** Current connection status */
  getConnectionStatus(): ConnectionStatus;
  /** Close connection, reject all pending calls, stop reconnection */
  close(): Promise<void>;
}

export interface ServerClientOptions {
  /**
   * Dynamic WebSocket URL provider, consulted before each connect/reconnect.
   * Used by local mode to follow the child server's port across restarts; when
   * omitted the client dials the fixed loopback gateway. There is no remote
   * `wsUrl`/TLS option — remote topology is WebRTC (DTLS), never a direct wss.
   */
  getWsUrl?: () => string;
  /** Called when the connection is permanently lost after explicit non-reconnect close. */
  onDisconnect?: () => void;
  /** Called when connection status changes (for UI indicators) */
  onConnectionStatusChanged?: (status: ConnectionStatus) => void;
  /** Called when the server sends a host event */
  onServerEvent?: (event: string, payload: unknown) => void;
  /** Called after auth when the transport needs subscriptions or state replayed. */
  onRecovery?: (kind: "resubscribe" | "cold-recover") => void | Promise<void>;
  /** Enable automatic reconnection on disconnect (default: true if getWsUrl is set). */
  reconnect?: boolean;
  /** Refresh the caller token after an auth failure during reconnect. */
  refreshAuthToken?: () => Promise<string>;
}

export async function createServerClient(
  serverRpcPort: number,
  authToken: string,
  options?: ServerClientOptions
): Promise<ServerClient> {
  let activeAuthToken = authToken;
  const getWsUrl = options?.getWsUrl ?? (() => serverRpcWsUrl(`http://127.0.0.1:${serverRpcPort}`));
  const shouldReconnect = options?.reconnect ?? !!options?.getWsUrl;
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
      createSocket: (url) => new NodeWsLike(new WebSocket(url)),
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
    // Only app principals get a scoped runtime connection. A panel authenticates
    // its own direct connection, which holds the panel lease; a second
    // host-opened connection for the same panel is rejected by the lease gate.
    // Panel operations are therefore translated by the trusted host instead (see
    // panelView / panelOrchestrator). Native `shell` callers use call().
    if (caller.callerKind !== "app") {
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
        createSocket: (url) => new NodeWsLike(new WebSocket(url)),
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
    stream(service: string, method: string, args: unknown[]): Promise<Response> {
      return rpc.stream("main", `${service}.${method}`, args);
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
    async openPanelSession(runtimeEntityId: string, connectionId: string): Promise<PanelSession> {
      // A dedicated panel-principal socket on the panel's lease connectionId, so
      // the server's lease gate (authorizePanelConnection) accepts it. The grant
      // encodes the panel principal (the server derives callerKind:"panel"), and
      // getAuthToken re-grants on every (re)connect because grants are one-shot.
      // reconnect:false — the ipcDispatcher relay re-opens a dead session lazily.
      const panelTransport = wsClientTransport({
        selfId: runtimeEntityId,
        getWsUrl,
        connectionId,
        reconnect: false,
        logPrefix: `PanelSession:${runtimeEntityId}`,
        translateEvent: (event, payload, deliver) => {
          deliver({ type: "event", fromId: "main", event, payload });
          return true;
        },
        adapter: {
          now: () => Date.now(),
          getAuthToken: async () => (await authClient.grantConnection(runtimeEntityId)).token,
          createSocket: (url) => new NodeWsLike(new WebSocket(url)),
        },
      });
      await panelTransport.connectAndWait();
      return {
        send: (envelope: RpcEnvelope) => panelTransport.send(envelope),
        onMessage: (listener: ServerMessageListener) => panelTransport.onMessage(listener),
        status: () => panelTransport.status?.() ?? "disconnected",
        close: () => {
          void panelTransport.close();
        },
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
