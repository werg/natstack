/**
 * HTTP POST-based RPC bridge for Cloudflare Workers/DOs.
 *
 * Implements the RpcBridge interface over HTTP POST requests instead of
 * WebSocket connections. Used by environments that don't maintain persistent
 * connections (e.g., Durable Objects calling back to the server).
 */

import type { RpcBridge } from "@natstack/rpc";

const rpcFetch = globalThis.fetch.bind(globalThis);

export interface HttpRpcBridgeConfig {
  selfId: string;
  serverUrl: string;
  authToken: string;
}

export function createHttpRpcBridge(config: HttpRpcBridgeConfig): RpcBridge & {
  handleIncomingPost(body: unknown): Promise<unknown>;
} {
  const { selfId, serverUrl, authToken } = config;
  const methodHandlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();
  const eventListeners = new Map<string, Set<(fromId: string, payload: unknown) => void>>();

  async function postToServer(payload: object): Promise<unknown> {
    const maxRetries = 3;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      let res: Response;
      try {
        res = await rpcFetch(`${serverUrl}/rpc`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${authToken}`,
          },
          body: JSON.stringify(payload),
        });
      } catch (err: any) {
        // Network error (ECONNREFUSED, etc.) — retry
        if (attempt < maxRetries - 1) {
          await new Promise(r => setTimeout(r, 100 * Math.pow(2, attempt)));
          continue;
        }
        throw err;
      }

      // Server error — retry
      if (res.status >= 500 && attempt < maxRetries - 1) {
        await new Promise(r => setTimeout(r, 100 * Math.pow(2, attempt)));
        continue;
      }

      // Auth error — don't retry
      if (res.status === 401) {
        throw new Error("RPC authentication failed");
      }

      const json = await res.json() as Record<string, unknown>;
      if (json["error"]) {
        const err = new Error(json["error"] as string);
        if (json["errorCode"]) (err as any).code = json["errorCode"];
        throw err;
      }
      return json["result"];
    }
    throw new Error("RPC request failed after retries");
  }

  return {
    selfId,

    exposeMethod(method, handler) {
      methodHandlers.set(method, handler as any);
    },

    expose(methods) {
      for (const [name, handler] of Object.entries(methods)) {
        methodHandlers.set(name, handler as any);
      }
    },

    /**
     * Streaming method handlers can't be registered on the HTTP
     * bridge: HTTP is one-shot POST/response with no inbound channel,
     * so there's nowhere for a peer-initiated `stream-request` to
     * arrive. Streaming method handlers belong on the server-side
     * RpcServer (which serves `/rpc/stream`) or on the WS-side bridge
     * (which dispatches peer-initiated `stream-request` messages).
     *
     * We throw rather than silently no-op so that a caller wiring
     * the handler in the wrong place gets immediate feedback.
     */
    exposeStreamingMethod(method, _handler) {
      throw new Error(
        `exposeStreamingMethod("${method}") is not supported on the HTTP RPC bridge — ` +
          `register the handler on the server-side RpcServer (for /rpc/stream) ` +
          `or on a transport-based RpcBridge instead.`,
      );
    },

    async call<T>(targetId: string, method: string, ...args: unknown[]): Promise<T> {
      if (targetId === selfId) {
        // Local dispatch
        const handler = methodHandlers.get(method);
        if (!handler) throw new Error(`No handler for method '${method}'`);
        return handler(...args) as T;
      }
      return postToServer({ type: "call", targetId, method, args }) as Promise<T>;
    },

    /**
     * Streaming call over HTTP. Posts to `/rpc/stream` and returns the
     * raw binary-framed response — `decodeFramedResponseToStreaming`
     * (in `@natstack/shared/credentials/streamFraming`) decodes it
     * into a `Response` with a real ReadableStream body. This is the
     * only bridge that physically streams today; transport-based
     * bridges (createRpcBridge) provide an API-compatible buffered
     * wrapper.
     */
    async streamCall(
      targetId: string,
      method: string,
      args: unknown[],
      options?: { signal?: AbortSignal },
    ): Promise<Response> {
      if (targetId === selfId) {
        throw new Error("streamCall is not supported for local dispatch");
      }
      const wireResponse = await rpcFetch(`${serverUrl}/rpc/stream`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${authToken}`,
        },
        body: JSON.stringify({ targetId, method, args }),
        signal: options?.signal,
      });
      if (wireResponse.status === 401) {
        await wireResponse.text().catch(() => "");
        throw new Error("RPC streaming authentication failed");
      }
      if (!wireResponse.ok) {
        let detail = "";
        try {
          detail = await wireResponse.text();
        } catch {
          // ignore
        }
        throw new Error(
          `RPC streaming endpoint returned HTTP ${wireResponse.status}${detail ? `: ${detail}` : ""}`,
        );
      }
      // Decode the binary-framed body into a Response with a real
      // ReadableStream. The caller sees the same Response API
      // regardless of which bridge they went through.
      const wireBody = wireResponse.body;
      if (!wireBody) {
        throw new Error("RPC streaming response has no body");
      }
      const { decodeFramedResponseToStreaming } = await import(
        "@natstack/shared/credentials/streamFraming"
      );
      // The HTTP bridge doesn't have the requested URL handy here —
      // pass the empty string and let the HEAD frame's finalUrl be
      // the source of truth.
      return decodeFramedResponseToStreaming(wireBody, "", options?.signal ?? null);
    },

    async emit(targetId: string, event: string, payload: unknown): Promise<void> {
      await postToServer({ type: "emit", targetId, event, payload, fromId: selfId });
    },

    onEvent(event: string, listener: (fromId: string, payload: unknown) => void): () => void {
      if (!eventListeners.has(event)) eventListeners.set(event, new Set());
      eventListeners.get(event)!.add(listener);
      return () => eventListeners.get(event)?.delete(listener);
    },

    async handleIncomingPost(body: unknown): Promise<unknown> {
      const msg = body as any;
      if (msg.type === "call") {
        const handler = methodHandlers.get(msg.method);
        if (!handler) return { error: `No handler for method '${msg.method}'` };
        try {
          const result = await handler(...(msg.args ?? []));
          return { result };
        } catch (err: any) {
          return { error: err.message, errorCode: err.code };
        }
      }
      if (msg.type === "emit") {
        const listeners = eventListeners.get(msg.event);
        if (listeners) {
          for (const listener of listeners) {
            try {
              listener(msg.fromId ?? "", msg.payload);
            } catch (err) {
              console.error(`[RpcBridge] Event listener error for '${msg.event}':`, err);
            }
          }
        }
        return { result: "ok" };
      }
      return { error: "Unknown message type" };
    },
  };
}
