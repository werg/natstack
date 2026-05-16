import type {
  ExposedMethods,
  RpcBridgeConfig,
  RpcBridgeInternal,
  RpcMessage,
  RpcRequest,
  RpcResponse,
  RpcEvent,
  RpcEventListener,
  RpcAccessPolicy,
  RpcCallerContext,
  RpcMethodDefinition,
  RpcMethodHandler,
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
    const method = exposedMethods[request.method];
    if (!method) {
      const response: RpcResponse = {
        type: "response",
        requestId: request.requestId,
        error: `Method "${request.method}" is not exposed by this endpoint`,
      };
      void config.transport.send(sourceId, response).catch?.(() => {});
      return;
    }

    const ctx: RpcCallerContext = { sourceId };
    Promise.resolve()
      .then(async () => {
        const allowed = await method.access(ctx);
        if (!allowed) {
          const error = new Error(`RPC access denied for method "${request.method}"`);
          (error as NodeJS.ErrnoException).code = "RPC_ACCESS_DENIED";
          throw error;
        }
        return method.handler(ctx, ...request.args);
      })
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
          ...(error instanceof Error && (error as NodeJS.ErrnoException).code
            ? { errorCode: (error as NodeJS.ErrnoException).code }
            : {}),
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
      access: RpcAccessPolicy,
      handler: RpcMethodHandler<TArgs, TReturn>
    ): void {
      exposedMethods[method] = {
        access,
        handler: handler as RpcMethodHandler<unknown[], unknown>,
      };
    },

    expose(methods: Record<string, RpcMethodDefinition<any[], any>>): void {
      for (const [name, definition] of Object.entries(methods)) {
        exposedMethods[name] = {
          access: definition.access,
          handler: definition.handler as RpcMethodHandler<unknown[], unknown>,
        };
      }
    },

    async call<T = unknown>(targetId: string, method: string, ...args: unknown[]): Promise<T> {
      const requestId = generateRequestId();
      const request: RpcRequest = {
        type: "request",
        requestId,
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

    async emit(targetId: string, event: string, payload: unknown): Promise<void> {
      const message: RpcEvent = {
        type: "event",
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
