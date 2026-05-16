/**
 * HTTP POST-based RPC bridge for Cloudflare Workers/DOs.
 *
 * Implements the RpcBridge interface over HTTP POST requests instead of
 * WebSocket connections. Used by environments that don't maintain persistent
 * connections (e.g., Durable Objects calling back to the server).
 */

import type {
  RpcAccessPolicy,
  RpcBridge,
  RpcCallerContext,
  RpcMethodDefinition,
  RpcMethodHandler,
} from "@natstack/rpc";

export type { RpcCallerContext } from "@natstack/rpc";

let currentRpcCaller: RpcCallerContext | null = null;

export function getCurrentRpcCaller(): RpcCallerContext | null {
  return currentRpcCaller;
}

export interface HttpRpcBridgeConfig {
  selfId: string;
  serverUrl: string;
  proxyAssertion?: string | (() => string | null | undefined);
}

export function createHttpRpcBridge(config: HttpRpcBridgeConfig): RpcBridge & {
  handleIncomingPost(body: unknown): Promise<unknown>;
} {
  const { selfId, serverUrl } = config;
  const methodHandlers = new Map<string, RpcMethodDefinition>();
  const eventListeners = new Map<string, Set<(sourceId: string, payload: unknown) => void>>();

  async function postToServer(payload: object): Promise<unknown> {
    const maxRetries = 3;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      let res: Response;
      try {
        const proxyAssertion =
          typeof config.proxyAssertion === "function"
            ? config.proxyAssertion()
            : config.proxyAssertion;
        res = await globalThis.fetch(`${serverUrl}/rpc`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(proxyAssertion
              ? { "X-NatStack-Object-Assertion": proxyAssertion }
              : {}),
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

    exposeMethod<TArgs extends unknown[], TReturn>(
      method: string,
      access: RpcAccessPolicy,
      handler: RpcMethodHandler<TArgs, TReturn>,
    ): void {
      methodHandlers.set(method, {
        access,
        handler: handler as RpcMethodHandler<unknown[], unknown>,
      });
    },

    expose(methods: Record<string, RpcMethodDefinition<any[], any>>): void {
      for (const [name, definition] of Object.entries(methods)) {
        methodHandlers.set(name, {
          access: definition.access,
          handler: definition.handler as RpcMethodHandler<unknown[], unknown>,
        });
      }
    },

    async call<T>(targetId: string, method: string, ...args: unknown[]): Promise<T> {
      if (targetId === selfId) {
        // Local dispatch
        const definition = methodHandlers.get(method);
        if (!definition) throw new Error(`No handler for method '${method}'`);
        const ctx: RpcCallerContext = { sourceId: selfId };
        const allowed = await definition.access(ctx);
        if (!allowed) {
          const err = new Error(`RPC access denied for method "${method}"`);
          (err as any).code = "RPC_ACCESS_DENIED";
          throw err;
        }
        return definition.handler(ctx, ...args) as T;
      }
      return postToServer({ type: "call", targetId, method, args }) as Promise<T>;
    },

    async emit(targetId: string, event: string, payload: unknown): Promise<void> {
      await postToServer({ type: "emit", targetId, event, payload });
    },

    onEvent(event: string, listener: (sourceId: string, payload: unknown) => void): () => void {
      if (!eventListeners.has(event)) eventListeners.set(event, new Set());
      eventListeners.get(event)!.add(listener);
      return () => eventListeners.get(event)?.delete(listener);
    },

    async handleIncomingPost(body: unknown): Promise<unknown> {
      const msg = body as any;
      if (msg.type === "call") {
        const definition = methodHandlers.get(msg.method);
        if (!definition) return { error: `No handler for method '${msg.method}'` };
        try {
          const previousCaller = currentRpcCaller;
          const ctx =
            typeof msg.sourceId === "string"
              ? ({ sourceId: msg.sourceId } satisfies RpcCallerContext)
              : null;
          currentRpcCaller = ctx;
          try {
            if (!ctx) {
              const err = new Error("Missing RPC caller context");
              (err as any).code = "RPC_MISSING_CALLER_CONTEXT";
              throw err;
            }
            const allowed = await definition.access(ctx);
            if (!allowed) {
              const err = new Error(`RPC access denied for method "${msg.method}"`);
              (err as any).code = "RPC_ACCESS_DENIED";
              throw err;
            }
            const result = await definition.handler(ctx, ...(msg.args ?? []));
            return { result };
          } finally {
            currentRpcCaller = previousCaller;
          }
        } catch (err: any) {
          return { error: err.message, errorCode: err.code };
        }
      }
      if (msg.type === "emit") {
        const listeners = eventListeners.get(msg.event);
        if (listeners) {
          for (const listener of listeners) {
            try {
              listener(msg.sourceId ?? "", msg.payload);
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
