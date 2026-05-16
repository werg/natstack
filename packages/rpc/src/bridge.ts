import type {
  ExposedMethods,
  RpcBridgeConfig,
  RpcBridgeInternal,
  RpcMessage,
  RpcRequest,
  RpcResponse,
  RpcEvent,
  RpcEventListener,
  RpcStreamRequest,
  RpcStreamFrameMessage,
  RpcStreamCancel,
  StreamingMethodHandler,
} from "./types.js";

function generateRequestId(): string {
  return crypto.randomUUID();
}

/**
 * Frame type codes mirror `@natstack/shared/credentials/streamFraming`.
 * Duplicated here as plain constants to keep the rpc package
 * dependency-light — adding `@natstack/shared` as a dep would create
 * a cycle since shared transitively depends on rpc.
 */
const FRAME_HEAD = 0x01;
const FRAME_DATA = 0x02;
const FRAME_END = 0x03;
const FRAME_ERROR = 0x04;

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function createRpcBridge(config: RpcBridgeConfig): RpcBridgeInternal {
  let exposedMethods: ExposedMethods = {};
  const streamingHandlers = new Map<string, StreamingMethodHandler>();

  const pendingRequests = new Map<
    string,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
    }
  >();

  /**
   * Active inbound streams — calls we initiated where frames are
   * still arriving from the peer. Keyed by the requestId we generated
   * when calling `streamCall`. The bridge routes incoming
   * `stream-frame` messages to the matching entry.
   */
  const pendingStreams = new Map<
    string,
    {
      controller: ReadableStreamDefaultController<Uint8Array>;
      resolveHead: (head: {
        status: number;
        statusText: string;
        headerPairs: Array<[string, string]>;
        finalUrl: string;
      }) => void;
      rejectHead: (err: unknown) => void;
      headEmitted: boolean;
      bodyClosed: boolean;
    }
  >();

  /**
   * Active outbound streams — calls our peer is making to us that
   * we're currently fulfilling. Keyed by the requestId from the
   * incoming `stream-request`. Stored so an incoming `stream-cancel`
   * can abort the handler.
   */
  const activeStreamingHandlers = new Map<string, AbortController>();

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

  /**
   * Handle an incoming `stream-frame` — route to whichever in-flight
   * stream initiated by this bridge has the matching `requestId`.
   * Unknown requestIds (e.g. after a cancel race) are silently dropped.
   */
  const handleStreamFrame = (frame: RpcStreamFrameMessage): void => {
    const entry = pendingStreams.get(frame.requestId);
    if (!entry) return;
    if (entry.bodyClosed) return;

    if (frame.frameType === FRAME_HEAD) {
      try {
        const head = JSON.parse(frame.payload) as {
          status: number;
          statusText: string;
          headerPairs: Array<[string, string]>;
          finalUrl: string;
        };
        entry.headEmitted = true;
        entry.resolveHead(head);
      } catch (err) {
        entry.rejectHead(err);
        pendingStreams.delete(frame.requestId);
      }
      return;
    }

    if (frame.frameType === FRAME_DATA) {
      const bytes = base64ToBytes(frame.payload);
      entry.controller.enqueue(bytes);
      return;
    }

    if (frame.frameType === FRAME_END) {
      entry.bodyClosed = true;
      entry.controller.close();
      pendingStreams.delete(frame.requestId);
      return;
    }

    if (frame.frameType === FRAME_ERROR) {
      let parsed: { status: number; message: string; code?: string };
      try {
        parsed = JSON.parse(frame.payload);
      } catch {
        parsed = { status: 502, message: "Streaming RPC error" };
      }
      const err = new Error(parsed.message) as Error & { code?: string };
      err.code = parsed.code;
      if (entry.headEmitted) {
        entry.bodyClosed = true;
        entry.controller.error(err);
      } else {
        entry.rejectHead(err);
      }
      pendingStreams.delete(frame.requestId);
      return;
    }
    // Unknown frame type — drop (forward-compatible).
  };

  /**
   * Handle an incoming `stream-request` — look up the streaming
   * handler registered via `exposeStreamingMethod` and run it, piping
   * each emitted frame back to the caller as a `stream-frame` message.
   * No handler → emit an ERROR frame so the caller's `streamCall`
   * promise rejects with a clear message.
   */
  const handleStreamRequest = (sourceId: string, request: RpcStreamRequest): void => {
    const handler = streamingHandlers.get(request.method);

    const sendFrame = async (frameType: number, payload: string): Promise<void> => {
      const message: RpcStreamFrameMessage = {
        type: "stream-frame",
        requestId: request.requestId,
        fromId: config.selfId,
        frameType,
        payload,
      };
      await config.transport.send(sourceId, message);
    };

    if (!handler) {
      void sendFrame(
        FRAME_ERROR,
        JSON.stringify({
          status: 404,
          message: `No streaming handler for method "${request.method}"`,
        }),
      ).catch(() => {});
      return;
    }

    const abortController = new AbortController();
    activeStreamingHandlers.set(request.requestId, abortController);

    const sink = async (frame: import("./types.js").StreamingMethodFrame): Promise<void> => {
      if (frame.kind === "head") {
        await sendFrame(
          FRAME_HEAD,
          JSON.stringify({
            status: frame.status,
            statusText: frame.statusText,
            headerPairs: frame.headerPairs,
            finalUrl: frame.finalUrl,
          }),
        );
      } else if (frame.kind === "chunk") {
        await sendFrame(FRAME_DATA, bytesToBase64(frame.bytes));
      } else if (frame.kind === "end") {
        await sendFrame(FRAME_END, JSON.stringify({ bytesIn: frame.bytesIn }));
      } else if (frame.kind === "error") {
        await sendFrame(
          FRAME_ERROR,
          JSON.stringify({
            status: frame.status,
            message: frame.message,
            code: frame.code,
          }),
        );
      }
    };

    void Promise.resolve()
      .then(() => handler(request.args, sink, abortController.signal))
      .catch((err) =>
        sendFrame(
          FRAME_ERROR,
          JSON.stringify({
            status: 502,
            message: err instanceof Error ? err.message : String(err),
          }),
        ).catch(() => {}),
      )
      .finally(() => {
        activeStreamingHandlers.delete(request.requestId);
      });
  };

  const handleStreamCancel = (cancel: RpcStreamCancel): void => {
    const controller = activeStreamingHandlers.get(cancel.requestId);
    if (controller) controller.abort();
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
     * Streaming call: sends a `stream-request` message and reassembles
     * incoming `stream-frame` messages into a `Response` whose body
     * is a real `ReadableStream<Uint8Array>`. The Promise resolves as
     * soon as the HEAD frame arrives, so the caller has status /
     * headers immediately while the body keeps draining.
     *
     * Cancellation (via `options.signal` or `response.body.cancel()`)
     * propagates as a `stream-cancel` message to the peer, who
     * aborts the in-flight handler.
     */
    async streamCall(
      targetId: string,
      method: string,
      args: unknown[],
      options?: { signal?: AbortSignal },
    ): Promise<Response> {
      const requestId = generateRequestId();

      let resolveHead!: (head: {
        status: number;
        statusText: string;
        headerPairs: Array<[string, string]>;
        finalUrl: string;
      }) => void;
      let rejectHead!: (err: unknown) => void;
      const headPromise = new Promise<{
        status: number;
        statusText: string;
        headerPairs: Array<[string, string]>;
        finalUrl: string;
      }>((resolve, reject) => {
        resolveHead = resolve;
        rejectHead = reject;
      });

      let bodyController: ReadableStreamDefaultController<Uint8Array> | null = null;
      const sendCancel = (): void => {
        const cancel: RpcStreamCancel = {
          type: "stream-cancel",
          requestId,
          fromId: config.selfId,
        };
        void Promise.resolve(config.transport.send(targetId, cancel)).catch(() => {});
      };
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          bodyController = controller;
        },
        cancel() {
          const entry = pendingStreams.get(requestId);
          if (entry) {
            entry.bodyClosed = true;
            pendingStreams.delete(requestId);
          }
          sendCancel();
        },
      });

      // Register the entry BEFORE sending the request — otherwise an
      // unusually fast peer could send the HEAD frame back before the
      // Map has the lookup key.
      pendingStreams.set(requestId, {
        controller: bodyController!,
        resolveHead,
        rejectHead,
        headEmitted: false,
        bodyClosed: false,
      });

      const onAbort = (): void => {
        const entry = pendingStreams.get(requestId);
        if (!entry) return;
        const err = new Error("Streaming RPC aborted by caller");
        if (entry.headEmitted) {
          entry.bodyClosed = true;
          entry.controller.error(err);
        } else {
          entry.rejectHead(err);
        }
        pendingStreams.delete(requestId);
        sendCancel();
      };
      options?.signal?.addEventListener("abort", onAbort);

      const request: RpcStreamRequest = {
        type: "stream-request",
        requestId,
        fromId: config.selfId,
        method,
        args,
      };
      try {
        await config.transport.send(targetId, request);
      } catch (err) {
        pendingStreams.delete(requestId);
        options?.signal?.removeEventListener("abort", onAbort);
        throw err;
      }

      try {
        const head = await headPromise;
        const response = new Response(stream as BodyInit, {
          status: head.status,
          statusText: head.statusText,
          headers: new Headers(head.headerPairs),
        });
        if (head.finalUrl) {
          try {
            Object.defineProperty(response, "url", {
              value: head.finalUrl,
              writable: false,
              configurable: true,
            });
          } catch {
            // ignore — runtime locked the descriptor
          }
        }
        return response;
      } finally {
        // Abort listener stays registered while the body is draining;
        // it'll fire on a late abort to propagate cancel to the peer.
      }
    },

    exposeStreamingMethod(method: string, handler: StreamingMethodHandler): void {
      streamingHandlers.set(method, handler);
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
        case "stream-request":
          handleStreamRequest(sourceId, message);
          return;
        case "stream-frame":
          handleStreamFrame(message);
          return;
        case "stream-cancel":
          handleStreamCancel(message);
          return;
      }
    },
  };

  config.transport.onAnyMessage((sourceId, message) => {
    bridge._handleMessage(sourceId, message);
  });

  return bridge;
}
