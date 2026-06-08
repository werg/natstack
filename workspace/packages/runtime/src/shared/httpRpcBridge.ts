/**
 * HTTP POST-based RPC client for Cloudflare Workers/DOs.
 *
 * Used by environments that do not maintain persistent connections.
 */

import type {
  AuthenticatedCaller,
  RpcContextHandler,
  RpcContextMethods,
  RpcCallOptions,
  RpcClient,
  RpcEventContext,
  RpcRequestContext,
} from "@natstack/rpc";

const rpcFetch = globalThis.fetch.bind(globalThis);
const RPC_RUNTIME_ID_HEADER = "X-Natstack-Runtime-Id";

export interface HttpRpcClientConfig {
  selfId: string;
  serverUrl: string;
  authToken: string;
}

/**
 * Outcome of a deferrable call. `completed` carries the inline result for the
 * fast path; `deferred` means the result will arrive later via an inbound
 * `onDeferredResult(requestId, ...)` POST — the caller must persist whatever it
 * needs to resume, keyed by `requestId`, before relying on this.
 */
export type DeferredCallAck =
  | { status: "deferred"; requestId: string }
  | { status: "completed"; result: unknown };

/** Extra methods the HTTP bridge exposes beyond the standard `RpcClient`. */
export interface HttpRpcExtensions {
  handleIncomingPost(body: unknown): Promise<unknown>;
  /**
   * Issue a call that may complete out-of-band. Use for human-gated server
   * methods (approvals, credential use) where holding an inbound request open
   * across a hibernation would lose the continuation.
   */
  callDeferred(
    targetId: string,
    method: string,
    args: unknown[],
    options?: { requestId?: string; idempotencyKey?: string },
  ): Promise<DeferredCallAck>;
}

export type HttpRpcClient = RpcClient & HttpRpcExtensions;

export function createHttpRpcClient(config: HttpRpcClientConfig): HttpRpcClient {
  const { selfId, serverUrl, authToken } = config;
  const selfCaller: AuthenticatedCaller = { callerId: selfId, callerKind: "unknown" };
  const methodHandlers = new Map<string, (request: RpcRequestContext) => Promise<unknown>>();
  const eventListeners = new Map<string, Set<(event: RpcEventContext) => void>>();

  // Returns the raw `/rpc` JSON envelope. The envelope is one of:
  //   { result }                  — normal completion
  //   { error, errorCode? }       — failure
  //   { deferred: true, requestId } — parked; result arrives via onDeferredResult
  // Callers decide how to interpret it (`call` unwraps result; `callDeferred`
  // inspects `deferred`).
  async function postToServer(payload: object): Promise<Record<string, unknown>> {
    const maxRetries = 3;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      let res: Response;
      try {
        res = await rpcFetch(`${serverUrl}/rpc`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${authToken}`,
            [RPC_RUNTIME_ID_HEADER]: selfId,
          },
          body: JSON.stringify(payload),
        });
      } catch (err) {
        if (attempt < maxRetries - 1) {
          await new Promise((resolve) => setTimeout(resolve, 100 * Math.pow(2, attempt)));
          continue;
        }
        throw err;
      }

      if (res.status >= 500 && attempt < maxRetries - 1) {
        await new Promise((resolve) => setTimeout(resolve, 100 * Math.pow(2, attempt)));
        continue;
      }
      if (res.status === 401) throw new Error("RPC authentication failed");

      return (await res.json()) as Record<string, unknown>;
    }
    throw new Error("RPC request failed after retries");
  }

  function throwIfError(json: Record<string, unknown>): void {
    if (json["error"]) {
      const err = new Error(json["error"] as string);
      if (json["errorCode"]) (err as Error & { code?: unknown }).code = json["errorCode"];
      throw err;
    }
  }

  async function callAndUnwrap<T>(payload: object): Promise<T> {
    const json = await postToServer(payload);
    throwIfError(json);
    return json["result"] as T;
  }

  const client: HttpRpcClient = {
    selfId,

    expose<TArgs extends unknown[], TReturn>(
      method: string,
      handler: RpcContextHandler<TArgs, TReturn>,
    ): void {
      methodHandlers.set(method, async (request) => handler(request as RpcRequestContext & { args: TArgs }));
    },

    exposeAll(methods: RpcContextMethods): void {
      for (const [name, handler] of Object.entries(methods)) {
        methodHandlers.set(name, async (request) => handler(request));
      }
    },

    exposeStreaming(method: string): void {
      throw new Error(
        `exposeStreaming("${method}") is not supported on the HTTP RPC client; ` +
          `register the handler on the server-side RpcServer or a transport-based RpcClient.`,
      );
    },

    async call<T>(
      targetId: string,
      method: string,
      args: unknown[],
      options?: RpcCallOptions,
    ): Promise<T> {
      if (options?.signal?.aborted) throw new Error("RPC call aborted by caller");
      if (targetId === selfId) {
        const handler = methodHandlers.get(method);
        if (!handler) throw new Error(`No handler for method '${method}'`);
        return handler({
          caller: selfCaller,
          origin: selfCaller,
          method,
          args,
          signal: options?.signal ?? new AbortController().signal,
          rpc: client,
        }) as Promise<T>;
      }

      // Blanket requestId on every wire call (correlation key for deferred replies,
      // dedup, and tracing). Caller-generated so the caller knows it before any reply.
      const requestId = crypto.randomUUID();
      const request = callAndUnwrap<T>({
        type: "call",
        requestId,
        targetId,
        method,
        args,
        ...(options?.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {}),
      });
      if (!options?.timeoutMs && !options?.signal) return request;

      return new Promise<T>((resolve, reject) => {
        let settled = false;
        let timeout: ReturnType<typeof setTimeout> | null = null;
        const cleanup = (): void => {
          if (timeout) clearTimeout(timeout);
          options?.signal?.removeEventListener("abort", onAbort);
        };
        const settle = (fn: () => void): void => {
          if (settled) return;
          settled = true;
          cleanup();
          fn();
        };
        const onAbort = (): void => settle(() => reject(new Error("RPC call aborted by caller")));
        if (typeof options?.timeoutMs === "number" && options.timeoutMs >= 0) {
          timeout = setTimeout(
            () => settle(() => reject(new Error(`RPC call timed out after ${options.timeoutMs}ms`))),
            options.timeoutMs,
          );
        }
        options?.signal?.addEventListener("abort", onAbort, { once: true });
        request.then(
          (value) => settle(() => resolve(value)),
          (err) => settle(() => reject(err)),
        );
      });
    },

    async stream(
      targetId: string,
      method: string,
      args: unknown[],
      options?: { signal?: AbortSignal; idempotencyKey?: string },
    ): Promise<Response> {
      if (targetId === selfId) throw new Error("stream is not supported for local dispatch");
      const requestId = crypto.randomUUID();
      const wireResponse = await rpcFetch(`${serverUrl}/rpc/stream`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${authToken}`,
          [RPC_RUNTIME_ID_HEADER]: selfId,
        },
        body: JSON.stringify({
          requestId,
          targetId,
          method,
          args,
          ...(options?.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {}),
        }),
        signal: options?.signal,
      });
      if (wireResponse.status === 401) {
        await wireResponse.text().catch(() => "");
        throw new Error("RPC streaming authentication failed");
      }
      if (!wireResponse.ok) {
        const detail = await wireResponse.text().catch(() => "");
        throw new Error(
          `RPC streaming endpoint returned HTTP ${wireResponse.status}${detail ? `: ${detail}` : ""}`,
        );
      }
      if (!wireResponse.body) throw new Error("RPC streaming response has no body");
      const { decodeFramedResponseToStreaming } = await import("@natstack/rpc/protocol/streamCodec");
      return decodeFramedResponseToStreaming(wireResponse.body, "", options?.signal ?? null);
    },

    async emit(targetId: string, event: string, payload: unknown): Promise<void> {
      throwIfError(await postToServer({ type: "emit", targetId, event, payload }));
    },

    async callDeferred(
      targetId: string,
      method: string,
      args: unknown[],
      options?: { requestId?: string; idempotencyKey?: string },
    ): Promise<DeferredCallAck> {
      // Caller-provided requestId lets a DO persist its continuation before the
      // reply can arrive; otherwise generate one.
      const requestId = options?.requestId ?? crypto.randomUUID();
      const json = await postToServer({
        type: "call",
        requestId,
        // Explicit opt-in: only callDeferred callers may be completed out-of-band.
        // Plain `call` never sets this, so the server keeps holding it inline.
        deferrable: true,
        targetId,
        method,
        args,
        ...(options?.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {}),
      });
      if (json["deferred"] === true) {
        return { status: "deferred", requestId: (json["requestId"] as string) ?? requestId };
      }
      throwIfError(json);
      return { status: "completed", result: json["result"] };
    },

    on(event: string, listener: (event: RpcEventContext) => void): () => void {
      if (!eventListeners.has(event)) eventListeners.set(event, new Set());
      eventListeners.get(event)!.add(listener);
      return () => eventListeners.get(event)?.delete(listener);
    },

    peer(targetId: string) {
      return {
        id: targetId,
        call: new Proxy({}, {
          get(_target, method) {
            if (typeof method !== "string") return undefined;
            return (...args: unknown[]) => client.call(targetId, method, args);
          },
        }) as never,
        on: (event: string, listener: (event: never) => void): (() => void) =>
          client.on(event, (ev: RpcEventContext) => {
            if (ev.caller.callerId === targetId) listener(ev as never);
          }),
        emit: (event: string, payload: unknown) => client.emit(targetId, event, payload),
        withContract: () => client.peer(targetId) as never,
      };
    },

    status: () => "connected" as const,
    ready: () => Promise.resolve(),
    onStatusChange: () => () => {},
    parent: async () => null,
    children: async () => [],
    tree: {
      root: async () => null,
      self: () => client.peer(selfId),
      siblings: async () => [],
    },
    automation() {
      throw new Error("RPC automation adapter is not configured");
    },

    async handleIncomingPost(body: unknown): Promise<unknown> {
      const msg = body as {
        type?: string;
        fromId?: string;
        method?: string;
        args?: unknown[];
        event?: string;
        payload?: unknown;
      };
      if (msg.type === "call") {
        const handler = methodHandlers.get(msg.method ?? "");
        if (!handler) return { error: `No handler for method '${msg.method}'` };
        const caller: AuthenticatedCaller = {
          callerId: msg.fromId ?? "",
          callerKind: "unknown",
        };
        try {
          const result = await handler({
            caller,
            origin: caller,
            method: msg.method ?? "",
            args: msg.args ?? [],
            signal: new AbortController().signal,
            rpc: client,
          });
          return { result };
        } catch (err) {
          const error = err as Error & { code?: string };
          return { error: error.message, errorCode: error.code };
        }
      }
      if (msg.type === "emit") {
        const listeners = eventListeners.get(msg.event ?? "");
        const caller: AuthenticatedCaller = { callerId: msg.fromId ?? "", callerKind: "unknown" };
        if (listeners) {
          for (const listener of listeners) {
            try {
              listener({ caller, origin: caller, event: msg.event ?? "", payload: msg.payload });
            } catch (err) {
              console.error(`[HttpRpcClient] Event listener error for '${msg.event}':`, err);
            }
          }
        }
        return { result: "ok" };
      }
      return { error: "Unknown message type" };
    },
  };

  return client;
}
