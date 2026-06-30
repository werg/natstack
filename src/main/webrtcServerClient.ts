/**
 * WebRtcServerClient — the desktop shell's {@link ServerClient} over the WebRTC
 * pipe. It is the peer-to-peer counterpart of `createServerClient` (which dials a
 * co-located loopback `/rpc` over WS): same `ServerClient` surface, but every
 * principal is a logical session multiplexed over one DTLS pipe rather than its
 * own socket.
 *
 * Structure mirrors `createServerClient` exactly so the two are interchangeable
 * behind `ServerClient`:
 *   - the main `shell` principal is one `openSession({ callerKind: "shell" })`;
 *   - each Electron-hosted `app` principal gets a one-time connection grant
 *     (`auth.grantConnection`) redeemed by its own `openSession({ callerKind:
 *     "app" })` over the same pipe — so one app dropping never tears down others.
 *
 * The shell token is supplied by the caller (`getShellToken`), exactly as the
 * local path receives `ports.shellToken` from its child server and the CLI client
 * receives `getToken`: the device-credential → shell-token derivation is the
 * pairing layer's concern, not the transport's. `node-datachannel` is loaded
 * lazily (only when a real pipe is built), so non-remote shells never touch it.
 */

import { randomUUID } from "node:crypto";
import { createRpcClient, type RpcClient, type RpcCallOptions } from "@natstack/rpc";
import { type WebRtcSession, type WebRtcTransport } from "@natstack/rpc/transports/webrtcClient";
import { createOffererTransport } from "@natstack/rpc/transports/offererTransport";
import { authMethods } from "@natstack/shared/serviceSchemas/auth";
import { createTypedServiceClient } from "@natstack/shared/typedServiceClient";
import type { ConnectPairing } from "@natstack/shared/connect";
import type {
  ConnectionStatus,
  PanelSession,
  ScopedServerCaller,
  ServerClient,
  ServerMessageListener,
} from "./serverClient.js";

export interface WebRtcServerClientArgs {
  /** The parsed pairing link (room/fp/sig/ice). */
  pairing: ConnectPairing;
  /** The shell's caller id, e.g. `shell:<deviceId>`. */
  callerId: string;
  /**
   * Supplies the short-lived shell token for each (re)open of the main session.
   * Re-invoked per open because connection grants are one-shot. The
   * device-credential → shell-token derivation lives in the pairing layer.
   */
  getShellToken: () => Promise<string> | string;
  /** Stable connection id (lease key) for the main shell session. */
  connectionId?: string;
  /**
   * Fired once when the main session paired a fresh device (the QR code was
   * redeemed): the durable device credential to persist so `getShellToken` can
   * switch to `refresh:<deviceId>:<refreshToken>` for reconnects.
   */
  onPaired?: (credential: { deviceId: string; refreshToken: string }) => void;
  onServerEvent?: (event: string, payload: unknown) => void;
  onConnectionStatusChanged?: (status: ConnectionStatus) => void;
  onRecovery?: (kind: "resubscribe" | "cold-recover") => void | Promise<void>;
  /**
   * Test seam: a pre-built transport (the real path lazy-loads node-datachannel
   * + signaling). Production callers omit this.
   */
  transport?: WebRtcTransport;
}

export async function createWebRtcServerClient(
  args: WebRtcServerClientArgs
): Promise<ServerClient> {
  const transport = args.transport ?? (await buildTransport(args.pairing));
  transport.onStatusChange((status) => args.onConnectionStatusChanged?.(status));
  // connect() now rejects on an unreachable peer (transport connect timeout) rather
  // than hanging the "connecting" spinner forever. Close the transport on failure so
  // its background reconnect loop stops instead of re-dialing a dead pairing.
  try {
    await transport.connect();
  } catch (error) {
    await transport.close().catch(() => {});
    throw error;
  }

  const mainSession = transport.openSession({
    connectionId: args.connectionId ?? randomUUID(),
    callerKind: "shell",
    clientPlatform: "desktop",
    getToken: args.getShellToken,
    onPaired: args.onPaired,
    onRecovery: (kind) => {
      void args.onRecovery?.(kind);
    },
  });
  await mainSession.ready?.();
  if (args.onServerEvent) {
    mainSession.onMessage((envelope) => {
      const message = envelope.message;
      if (message && message.type === "event") args.onServerEvent?.(message.event, message.payload);
    });
  }
  const rpc = createRpcClient({
    selfId: args.callerId,
    callerKind: "shell",
    transport: mainSession,
  });
  const authClient = createTypedServiceClient("auth", authMethods, (service, method, callArgs) =>
    rpc.call("main", `${service}.${method}`, callArgs)
  );

  type ScopedClient = { session: WebRtcSession; rpc: RpcClient; close(): void };
  const scopedClients = new Map<string, Promise<ScopedClient>>();
  const scopedListeners = new Map<string, Set<ServerMessageListener>>();
  const scopedKey = (caller: ScopedServerCaller): string =>
    `${caller.callerKind}\x00${caller.callerId}`;

  const createScopedClient = async (caller: ScopedServerCaller): Promise<ScopedClient> => {
    // Only app principals get a scoped runtime connection (mirrors the WS path:
    // a panel holds its own lease; native `shell` callers use call()).
    if (caller.callerKind !== "app") {
      throw new Error(`Scoped server RPC is not available for ${caller.callerKind} callers`);
    }
    const session = transport.openSession({
      connectionId: randomUUID(),
      callerKind: "app",
      clientPlatform: "desktop",
      // Re-grant on EVERY (re)open: connection grants are one-shot, so pinning the
      // first grant's token would fail the redeem on reconnect — the auto-reopened
      // session would reject unhandled, once per app principal. Mirrors the main
      // shell session, whose getShellToken is likewise re-invoked per open.
      getToken: async () => (await authClient.grantConnection(caller.callerId)).token,
    });
    await session.ready?.();
    const scopedRpc = createRpcClient({
      selfId: caller.callerId,
      callerKind: caller.callerKind,
      transport: session,
    });
    session.onMessage((envelope) => {
      for (const listener of scopedListeners.get(scopedKey(caller)) ?? []) listener(envelope);
    });
    return { session, rpc: scopedRpc, close: () => session.close() };
  };

  const getScopedClient = async (caller: ScopedServerCaller): Promise<ScopedClient> => {
    const key = scopedKey(caller);
    const existing = scopedClients.get(key);
    if (existing) {
      const client = await existing;
      // The pipe outlives individual sessions: a scoped session can be terminally
      // closed (e.g. a lease revoke) while transport.status() still reads
      // "connected". Reusing it would throw "Session is closed" on the next call —
      // so re-grant a fresh session when EITHER the pipe is down or the session died.
      if (transport.status() === "connected" && !client.session.isClosed()) return client;
      scopedClients.delete(key);
      client.close();
    }
    const next = createScopedClient(caller).catch((err) => {
      scopedClients.delete(key);
      throw err;
    });
    scopedClients.set(key, next);
    return next;
  };

  const openPanelSession = async (
    runtimeEntityId: string,
    connectionId: string
  ): Promise<PanelSession> => {
    // A panel-principal logical session on the panel's lease connectionId. The
    // grant for the entity id makes the server derive callerKind:"panel" and the
    // connectionId satisfies the lease gate (authorizePanelConnection). Re-grant
    // per open — grants are one-shot and the pipe auto-reopens sessions.
    const session = transport.openSession({
      connectionId,
      callerKind: "panel",
      clientPlatform: "desktop",
      getToken: async () => (await authClient.grantConnection(runtimeEntityId)).token,
    });
    await session.ready?.();
    return {
      send: (envelope) => session.send(envelope),
      onMessage: (listener) => session.onMessage(listener),
      status: () => session.status?.() ?? transport.status(),
      isClosed: () => session.isClosed(),
      close: () => session.close(),
    };
  };

  return {
    call(service, method, callArgs, options?: RpcCallOptions): Promise<unknown> {
      return rpc.call("main", `${service}.${method}`, callArgs, options);
    },
    stream(service, method, callArgs): Promise<Response> {
      // Streamed over the main shell session's bulk channel (chunked) — for
      // large bodies like gateway.fetch panel assets.
      return rpc.stream("main", `${service}.${method}`, callArgs);
    },
    async callAs(caller, service, method, callArgs, options?: RpcCallOptions): Promise<unknown> {
      const client = await getScopedClient(caller);
      return client.rpc.call("main", `${service}.${method}`, callArgs, options);
    },
    addMessageListener(caller, listener): () => void {
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
    openPanelSession,
    isConnected(): boolean {
      return transport.status() === "connected";
    },
    getConnectionStatus(): ConnectionStatus {
      return transport.status();
    },
    async close(): Promise<void> {
      await Promise.allSettled(
        [...scopedClients.values()].map(async (client) => (await client).close())
      );
      scopedClients.clear();
      mainSession.close();
      await transport.close();
    },
  };
}

/** The real pipe: lazy-load the native peer + signaling, dial as the offerer. */
async function buildTransport(pairing: ConnectPairing): Promise<WebRtcTransport> {
  const { createNodeDatachannelProvider } = await import("./webrtc/nodeDatachannelPeer.js");
  const { default: WS } = (await import("ws")) as unknown as {
    default: new (url: string) => unknown;
  };
  return createOffererTransport({
    provider: createNodeDatachannelProvider({ peerName: "shell" }),
    pairing,
    webSocketImpl: WS,
    fetchImpl: fetch,
  });
}
