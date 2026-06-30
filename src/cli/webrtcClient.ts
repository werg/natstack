/**
 * WebRTC RPC client for the CLI — the peer-to-peer counterpart of the HTTP
 * `RpcClient` (`rpcClient.ts`). Where the HTTP client `POST`s envelopes to a
 * co-located loopback `/rpc`, this client dials the server over the WebRTC pipe:
 * it joins the signaling room from the pairing link (`room`/`sig`), establishes a
 * real DTLS pipe pinning the server's fingerprint (`fp`), opens a `shell` session
 * with the device-derived shell token, and round-trips RPC envelopes over the
 * session.
 *
 * It exposes the SAME `call(method,args)` / `callTarget(targetId,method,args)`
 * surface as the HTTP `RpcClient`, so `typedClient(...)` and every CLI command
 * work unchanged — only the transport differs. node-datachannel is loaded lazily
 * (only when a WebRTC connection is actually opened), so plain HTTP CLI usage
 * never touches the native module.
 */

import { randomUUID } from "node:crypto";
import { createRpcClient, type RpcClient as RpcCore, type RpcEnvelope } from "@natstack/rpc";
import { type WebRtcSession, type WebRtcTransport } from "@natstack/rpc/transports/webrtcClient";
import { createOffererTransport } from "@natstack/rpc/transports/offererTransport";
import type { ConnectPairing } from "@natstack/shared/connect";
import { RpcError } from "./rpcClient.js";

export interface WebRtcClientConfig {
  /** The parsed pairing link (room/fp/sig/ice). */
  pairing: ConnectPairing;
  /** The CLI's caller id (e.g. `shell:<deviceId>`). */
  callerId: string;
  /** Supplies the (short-lived) shell token for each session (re)open. */
  getToken: () => Promise<string> | string;
  /** Stable connection id binding this client's session (defaults to a uuid). */
  connectionId?: string;
}

export class WebRtcRpcClient {
  private transport: WebRtcTransport | null = null;
  private session: WebRtcSession | null = null;
  private core: RpcCore | null = null;
  private readonly connectionId: string;

  constructor(private readonly config: WebRtcClientConfig) {
    this.connectionId = config.connectionId ?? randomUUID();
  }

  /** Direct service dispatch: `service.method` on the server dispatcher (target "main"). */
  async call<T = unknown>(method: string, args: unknown[] = []): Promise<T> {
    return this.dispatch<T>("main", method, args);
  }

  /** Relay call to a runtime target (worker, DO, panel) by entity/target id. */
  async callTarget<T = unknown>(
    targetId: string,
    method: string,
    args: unknown[] = []
  ): Promise<T> {
    return this.dispatch<T>(targetId, method, args);
  }

  async close(): Promise<void> {
    this.session?.close();
    await this.transport?.close();
    this.session = null;
    this.transport = null;
    this.core = null;
  }

  /** Establish the pipe + session lazily; reuse across calls. */
  private async ensureSession(): Promise<RpcCore> {
    if (this.core) return this.core;
    // Lazy: createNodeDatachannelProvider loads the native module only here.
    const { createNodeDatachannelProvider } = await import("../main/webrtc/nodeDatachannelPeer.js");
    const { default: WS } = (await import("ws")) as unknown as {
      default: new (url: string) => unknown;
    };

    const transport = createOffererTransport({
      provider: createNodeDatachannelProvider({ peerName: "cli" }),
      pairing: this.config.pairing,
      webSocketImpl: WS,
      fetchImpl: fetch,
    });
    await transport.connect();
    const session = transport.openSession({
      connectionId: this.connectionId,
      callerKind: "shell",
      clientPlatform: "desktop",
      getToken: this.config.getToken,
    });
    await session.ready!();
    const core = createRpcClient({
      selfId: this.config.callerId,
      transport: session,
      callerKind: "shell",
    });
    this.transport = transport;
    this.session = session;
    this.core = core;
    return core;
  }

  /** Streaming call (e.g. credentials.proxyFetch) over the bulk channel. */
  async stream(targetId: string, method: string, args: unknown[] = []): Promise<Response> {
    const core = await this.ensureSession();
    return core.stream(targetId, method, args);
  }

  private async dispatch<T>(targetId: string, method: string, args: unknown[]): Promise<T> {
    const core = await this.ensureSession();
    try {
      // The core correlates the request/response by id over the session and
      // returns the unwrapped result (or throws on an error response).
      return await core.call<T>(targetId, method, args);
    } catch (error) {
      throw error instanceof RpcError
        ? error
        : new RpcError(error instanceof Error ? error.message : String(error));
    }
  }
}

/** Build a one-shot request envelope (used when the core is not yet available). */
export function buildRequestEnvelope(
  callerId: string,
  targetId: string,
  method: string,
  args: unknown[]
): RpcEnvelope {
  const caller = { callerId, callerKind: "shell" as const };
  return {
    from: callerId,
    target: targetId,
    delivery: { caller },
    provenance: [caller],
    message: { type: "request", requestId: randomUUID(), fromId: callerId, method, args },
  };
}
