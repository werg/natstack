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
  const cryptoObj = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (cryptoObj?.randomUUID) {
    return cryptoObj.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function getTimeoutMs(config: RpcBridgeConfig, method: string): number {
  const defaultTimeout = config.callTimeoutMs ?? 30000;
  const aiTimeout = config.aiCallTimeoutMs ?? 300000;
  if (method.startsWith("ai.")) return aiTimeout;
  return defaultTimeout;
}

export function createRpcBridge(config: RpcBridgeConfig): RpcBridgeInternal {
  let exposedMethods: ExposedMethods = {};

  const pendingRequests = new Map<
    string,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timeout: ReturnType<typeof setTimeout>;
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
      void config.transport.send(sourceId, response);
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
        return config.transport.send(sourceId, response);
      });
  };

  const handleResponse = (response: RpcResponse) => {
    const pending = pendingRequests.get(response.requestId);
    if (!pending) {
      return;
    }
    pendingRequests.delete(response.requestId);
    clearTimeout(pending.timeout);

    if ("error" in response) {
      pending.reject(new Error(response.error));
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
        const timeout = setTimeout(() => {
          pendingRequests.delete(requestId);
          reject(new Error(`RPC call to ${targetId}.${method} timed out`));
        }, getTimeoutMs(config, method));

        pendingRequests.set(requestId, {
          resolve: resolve as (value: unknown) => void,
          reject,
          timeout,
        });

        void config.transport.send(targetId, request);
      });
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
