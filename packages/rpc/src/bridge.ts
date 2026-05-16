import type {
  ExposedMethods,
  RpcBridgeConfig,
  RpcBridgeInternal,
  RpcMessage,
  RpcRequest,
  RpcResponse,
  RpcEvent,
  RpcEventListener,
} from "./types.js";

function generateRequestId(): string {
  return crypto.randomUUID();
}

export function createRpcBridge(config: RpcBridgeConfig): RpcBridgeInternal {
  let exposedMethods: ExposedMethods = {};

  const pendingRequests = new Map<
    string,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
    }
  >();

  const eventListeners = new Map<string, Set<RpcEventListener>>();

  const handleRequest = (sourceId: string, request: RpcRequest) => {
    const handler = exposedMethods[request.method];
    if (!handler) {
      const response: RpcResponse = {
        type: "response",
        requestId: request.requestId,
        error: `Method "${request.method}" is not exposed by this endpoint`,
      };
      void config.transport.send(sourceId, response).catch?.(() => {});
      return;
    }

    Promise.resolve()
      .then(() => handler(...request.args))
      .then((result) => {
        const response: RpcResponse = {
          type: "response",
          requestId: request.requestId,
          result,
        };
        return config.transport.send(sourceId, response);
      })
      .catch((error) => {
        const response: RpcResponse = {
          type: "response",
          requestId: request.requestId,
          error: error instanceof Error ? error.message : String(error),
        };
        return config.transport.send(sourceId, response).catch?.(() => {});
      });
  };

  const handleResponse = (response: RpcResponse) => {
    const pending = pendingRequests.get(response.requestId);
    if (!pending) {
      return;
    }
    pendingRequests.delete(response.requestId);

    if ("error" in response) {
      const err = new Error(response.error) as NodeJS.ErrnoException;
      if (response.errorCode) {
        err.code = response.errorCode;
      }
      pending.reject(err);
      return;
    }
    pending.resolve(response.result);
  };

  const handleEvent = (sourceId: string, event: RpcEvent) => {
    const listeners = eventListeners.get(event.event);
    if (!listeners) return;

    for (const listener of listeners) {
      try {
        listener(sourceId, event.payload);
      } catch (error) {
        console.error(`Error in RPC event listener for "${event.event}":`, error);
      }
    }
  };

  const bridge: RpcBridgeInternal = {
    selfId: config.selfId,

    exposeMethod<TArgs extends unknown[], TReturn>(
      method: string,
      handler: (...args: TArgs) => TReturn | Promise<TReturn>
    ): void {
      // Cast is safe: we're widening the type for storage, but runtime behavior is unchanged
      exposedMethods[method] = handler as (...args: unknown[]) => unknown | Promise<unknown>;
    },

    expose(methods: Record<string, (...args: any[]) => any>): void {
      for (const [name, handler] of Object.entries(methods)) {
        exposedMethods[name] = handler as (...args: unknown[]) => unknown | Promise<unknown>;
      }
    },

    async call<T = unknown>(targetId: string, method: string, ...args: unknown[]): Promise<T> {
      const requestId = generateRequestId();
      const request: RpcRequest = {
        type: "request",
        requestId,
        fromId: config.selfId,
        method,
        args,
      };

      return new Promise<T>((resolve, reject) => {
        pendingRequests.set(requestId, {
          resolve: resolve as (value: unknown) => void,
          reject,
        });

        void Promise.resolve(config.transport.send(targetId, request)).catch((err) => {
          pendingRequests.delete(requestId);
          reject(err);
        });
      });
    },

    /**
     * Streaming call over a transport-based bridge.
     *
     * Today this is a uniform API wrapper, not a protocol-level
     * streaming implementation: the underlying `call` round-trip
     * returns the buffered wire shape produced by `credentials.proxyFetch`
     * (status / headerPairs / finalUrl / bodyBase64), and the result is
     * wrapped in a `Response` whose body is a synthetic ReadableStream.
     *
     * This is intentional. The transport-based bridge runs over
     * Electron IPC or WebSocket, and adding protocol-level streaming
     * (new stream-request / stream-frame messages, server-side
     * streaming dispatch, frame routing on the bridge) is a separate
     * piece of infrastructure work. The API surface is what callers
     * actually depend on; making `streamCall` available uniformly on
     * every bridge lets the shared credentials client drop its
     * "supportsStreaming" duck-typing and call `streamCall`
     * unconditionally. When real IPC streaming lands, this method
     * will switch to it transparently.
     */
    async streamCall(
      targetId: string,
      method: string,
      args: unknown[],
      _options?: { signal?: AbortSignal },
    ): Promise<Response> {
      const result = await (this as { call<T>(targetId: string, method: string, ...args: unknown[]): Promise<T> }).call<{
        status: number;
        statusText: string;
        headerPairs?: Array<[string, string]>;
        finalUrl?: string;
        bodyBase64?: string;
      }>(targetId, method, ...args);
      const bytes = result.bodyBase64
        ? (() => {
            const binary = atob(result.bodyBase64!);
            const buf = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; i++) buf[i] = binary.charCodeAt(i);
            return buf;
          })()
        : new Uint8Array(0);
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          if (bytes.byteLength > 0) controller.enqueue(bytes);
          controller.close();
        },
      });
      const response = new Response(body as BodyInit, {
        status: result.status,
        statusText: result.statusText,
        headers: new Headers(result.headerPairs ?? []),
      });
      if (result.finalUrl) {
        try {
          Object.defineProperty(response, "url", {
            value: result.finalUrl,
            writable: false,
            configurable: true,
          });
        } catch {
          // ignore — runtime locked the descriptor
        }
      }
      return response;
    },

    async emit(targetId: string, event: string, payload: unknown): Promise<void> {
      const message: RpcEvent = {
        type: "event",
        fromId: config.selfId,
        event,
        payload,
      };
      await config.transport.send(targetId, message);
    },

    onEvent(event: string, listener: RpcEventListener): () => void {
      let listeners = eventListeners.get(event);
      if (!listeners) {
        listeners = new Set();
        eventListeners.set(event, listeners);
      }
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) {
          eventListeners.delete(event);
        }
      };
    },

    _handleMessage(sourceId: string, message: RpcMessage): void {
      switch (message.type) {
        case "request":
          handleRequest(sourceId, message);
          return;
        case "response":
          handleResponse(message);
          return;
        case "event":
          handleEvent(sourceId, message);
          return;
      }
    },
  };

  config.transport.onAnyMessage((sourceId, message) => {
    bridge._handleMessage(sourceId, message);
  });

  return bridge;
}
