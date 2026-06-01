import type {
  AuthenticatedCaller,
  CallerKind,
  EnvelopeRpcTransport,
  EventMap,
  MethodMap,
  RpcCallOptions,
  RpcClient,
  RpcClientConfig,
  RpcConnectionStatus,
  RpcContextMethods,
  RpcContextStreamingHandler,
  RpcEnvelope,
  RpcEvent,
  RpcEventContext,
  RpcMessage,
  RpcPeer,
  RpcRequest,
  RpcRequestContext,
  RpcResponse,
  RpcStreamCancel,
  RpcStreamFrameMessage,
  RpcStreamRequest,
  StreamingMethodFrame,
  TypedCallProxy,
} from "./types.js";
import { originOfEnvelope, responseEnvelopeFor } from "./envelope.js";

const FRAME_HEAD = 0x01;
const FRAME_DATA = 0x02;
const FRAME_END = 0x03;
const FRAME_ERROR = 0x04;

function generateRequestId(): string {
  return crypto.randomUUID();
}

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

function callerForSelf(selfId: string, callerKind: CallerKind | "unknown" = "unknown"): AuthenticatedCaller {
  return { callerId: selfId, callerKind };
}

function appendSelf(
  provenance: AuthenticatedCaller[],
  self: AuthenticatedCaller,
): AuthenticatedCaller[] {
  if (provenance.length === 0) return [self];
  const last = provenance[provenance.length - 1];
  if (last?.callerId === self.callerId && last.callerKind === self.callerKind) return provenance;
  return [...provenance, self];
}

function createCallProxy<TMethods extends MethodMap>(
  invoke: (method: string, args: unknown[]) => Promise<unknown>,
): TypedCallProxy<TMethods> {
  return new Proxy(
    {},
    {
      get(_target, prop) {
        if (typeof prop !== "string") return undefined;
        return (...args: unknown[]) => invoke(prop, args);
      },
    },
  ) as TypedCallProxy<TMethods>;
}

export function defineContract<const TContract extends Record<string, unknown>>(
  contract: TContract,
): TContract {
  return contract;
}

export function createRpcClient(config: RpcClientConfig): RpcClient {
  const selfCaller = callerForSelf(config.selfId, config.callerKind);
  const baseProvenance = config.provenance?.length ? config.provenance : [selfCaller];
  const exposedMethods = new Map<string, (request: RpcRequestContext) => unknown | Promise<unknown>>();
  const streamingHandlers = new Map<string, RpcContextStreamingHandler>();
  const eventListeners = new Map<string, Set<(event: RpcEventContext) => void>>();
  const pendingRequests = new Map<
    string,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timeout: ReturnType<typeof setTimeout> | null;
      abortCleanup: (() => void) | null;
    }
  >();
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
      idleTimer: ReturnType<typeof setTimeout> | null;
      cleanup: () => void;
    }
  >();
  const activeStreamingHandlers = new Map<string, AbortController>();
  const streamIdleTimeoutMs = config.streamIdleTimeoutMs ?? 90_000;

  function makeEnvelope(
    targetId: string,
    message: RpcMessage,
    options?: { idempotencyKey?: string },
    provenance: AuthenticatedCaller[] = baseProvenance,
  ): RpcEnvelope {
    return {
      from: config.selfId,
      target: targetId,
      delivery: {
        caller: selfCaller,
        ...(options?.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {}),
      },
      provenance,
      message,
    };
  }

  function scopedClientFor(inbound: RpcEnvelope): RpcClient {
    const scopedProvenance = appendSelf(
      inbound.provenance.length ? inbound.provenance : [inbound.delivery.caller],
      selfCaller,
    );
    return {
      ...client,
      call: (targetId, method, args, options) => callWithProvenance(scopedProvenance, targetId, method, args, options),
      stream: (targetId, method, args, options) => streamWithProvenance(scopedProvenance, targetId, method, args, options),
      emit: (targetId, event, payload, options) => emitWithProvenance(scopedProvenance, targetId, event, payload, options),
      peer: (targetId) => peer(targetId, scopedProvenance),
    };
  }

  function requestContext(envelope: RpcEnvelope, message: RpcRequest | RpcStreamRequest, signal: AbortSignal): RpcRequestContext {
    return {
      caller: envelope.delivery.caller,
      origin: originOfEnvelope(envelope),
      method: message.method,
      args: message.args,
      signal,
      rpc: scopedClientFor(envelope),
    };
  }

  async function send(
    targetId: string,
    message: RpcMessage,
    options?: { idempotencyKey?: string },
    provenance?: AuthenticatedCaller[],
  ): Promise<void> {
    const envelope = makeEnvelope(targetId, message, options, provenance);
    await deliverEnvelope(envelope);
  }

  async function deliverEnvelope(envelope: RpcEnvelope): Promise<void> {
    if (envelope.target === config.selfId) {
      queueMicrotask(() => handleEnvelope(envelope));
      return;
    }
    await config.transport.send(envelope);
  }

  function clearPendingStream(requestId: string): void {
    const entry = pendingStreams.get(requestId);
    if (!entry) return;
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    try {
      entry.cleanup();
    } catch {
      // best effort
    }
    pendingStreams.delete(requestId);
  }

  function rearmStreamIdleTimer(requestId: string): void {
    const entry = pendingStreams.get(requestId);
    if (!entry) return;
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    entry.idleTimer = setTimeout(() => {
      const current = pendingStreams.get(requestId);
      if (!current || current.bodyClosed) return;
      const err = new Error("Streaming RPC timed out - no frames received");
      if (current.headEmitted) {
        current.bodyClosed = true;
        current.controller.error(err);
      } else {
        current.rejectHead(err);
      }
      pendingStreams.delete(requestId);
    }, streamIdleTimeoutMs);
  }

  function handleResponse(response: RpcResponse): void {
    const pending = pendingRequests.get(response.requestId);
    if (!pending) return;
    pendingRequests.delete(response.requestId);
    if (pending.timeout) clearTimeout(pending.timeout);
    pending.abortCleanup?.();
    if ("error" in response) {
      const err = new Error(response.error) as NodeJS.ErrnoException;
      if (response.errorCode) err.code = response.errorCode;
      if (response.errorStack) err.stack = response.errorStack;
      pending.reject(err);
      return;
    }
    pending.resolve(response.result);
  }

  function handleEvent(envelope: RpcEnvelope, event: RpcEvent): void {
    const listeners = eventListeners.get(event.event);
    if (!listeners) return;
    const context: RpcEventContext = {
      caller: envelope.delivery.caller,
      origin: originOfEnvelope(envelope),
      event: event.event,
      payload: event.payload,
    };
    for (const listener of listeners) listener(context);
  }

  function handleStreamFrame(frame: RpcStreamFrameMessage): void {
    const entry = pendingStreams.get(frame.requestId);
    if (!entry || entry.bodyClosed) return;
    rearmStreamIdleTimer(frame.requestId);
    if (frame.frameType === FRAME_HEAD) {
      try {
        entry.headEmitted = true;
        entry.resolveHead(JSON.parse(frame.payload));
      } catch (err) {
        entry.rejectHead(err);
        clearPendingStream(frame.requestId);
      }
      return;
    }
    if (frame.frameType === FRAME_DATA) {
      entry.controller.enqueue(base64ToBytes(frame.payload));
      return;
    }
    if (frame.frameType === FRAME_END) {
      entry.bodyClosed = true;
      entry.controller.close();
      clearPendingStream(frame.requestId);
      return;
    }
    if (frame.frameType === FRAME_ERROR) {
      let parsed: { message: string; code?: string };
      try {
        parsed = JSON.parse(frame.payload);
      } catch {
        parsed = { message: "Streaming RPC error" };
      }
      const err = new Error(parsed.message) as Error & { code?: string };
      err.code = parsed.code;
      if (entry.headEmitted) {
        entry.bodyClosed = true;
        entry.controller.error(err);
      } else {
        entry.rejectHead(err);
      }
      clearPendingStream(frame.requestId);
    }
  }

  function handleStreamCancel(cancel: RpcStreamCancel): void {
    activeStreamingHandlers.get(cancel.requestId)?.abort();
  }

  function handleRequest(envelope: RpcEnvelope, request: RpcRequest): void {
    const handler = exposedMethods.get(request.method);
    if (!handler) {
      void deliverEnvelope(responseEnvelopeFor(envelope, selfCaller, {
        type: "response",
        requestId: request.requestId,
        error: `Method "${request.method}" is not exposed by this endpoint`,
      })).catch(() => {});
      return;
    }
    const abort = new AbortController();
    Promise.resolve()
      .then(() => handler(requestContext(envelope, request, abort.signal)))
      .then((result) =>
        deliverEnvelope(responseEnvelopeFor(envelope, selfCaller, {
          type: "response",
          requestId: request.requestId,
          result,
        })),
      )
      .catch((error) =>
        deliverEnvelope(responseEnvelopeFor(envelope, selfCaller, {
          type: "response",
          requestId: request.requestId,
          error: error instanceof Error ? error.message : String(error),
          ...(error instanceof Error && error.stack ? { errorStack: error.stack } : {}),
          ...(error instanceof Error && typeof (error as NodeJS.ErrnoException).code === "string"
            ? { errorCode: (error as NodeJS.ErrnoException).code }
            : {}),
        })).catch(() => {}),
      );
  }

  function handleStreamRequest(envelope: RpcEnvelope, request: RpcStreamRequest): void {
    const handler = streamingHandlers.get(request.method);
    const sendFrame = (frameType: number, payload: string): Promise<void> =>
      send(envelope.from, {
        type: "stream-frame",
        requestId: request.requestId,
        fromId: config.selfId,
        frameType,
        payload,
      });
    if (!handler) {
      void sendFrame(
        FRAME_ERROR,
        JSON.stringify({ status: 404, message: `No streaming handler for method "${request.method}"` }),
      ).catch(() => {});
      return;
    }
    const abort = new AbortController();
    activeStreamingHandlers.set(request.requestId, abort);
    const sink = (frame: StreamingMethodFrame): Promise<void> | void => {
      if (frame.kind === "head") {
        return sendFrame(
          FRAME_HEAD,
          JSON.stringify({
            status: frame.status,
            statusText: frame.statusText,
            headerPairs: frame.headerPairs,
            finalUrl: frame.finalUrl,
          }),
        );
      }
      if (frame.kind === "chunk") return sendFrame(FRAME_DATA, bytesToBase64(frame.bytes));
      if (frame.kind === "end") return sendFrame(FRAME_END, JSON.stringify({ bytesIn: frame.bytesIn }));
      return sendFrame(FRAME_ERROR, JSON.stringify({ status: frame.status, message: frame.message, code: frame.code }));
    };
    Promise.resolve()
      .then(() => handler(requestContext(envelope, request, abort.signal), sink))
      .catch((error) =>
        sendFrame(
          FRAME_ERROR,
          JSON.stringify({ status: 502, message: error instanceof Error ? error.message : String(error) }),
        ).catch(() => {}),
      )
      .finally(() => activeStreamingHandlers.delete(request.requestId));
  }

  function handleEnvelope(envelope: RpcEnvelope): void {
    const message = envelope.message;
    switch (message.type) {
      case "request":
        handleRequest(envelope, message);
        return;
      case "response":
        handleResponse(message);
        return;
      case "event":
        handleEvent(envelope, message);
        return;
      case "stream-request":
        handleStreamRequest(envelope, message);
        return;
      case "stream-frame":
        handleStreamFrame(message);
        return;
      case "stream-cancel":
        handleStreamCancel(message);
        return;
    }
  }

  function callWithProvenance<T = unknown>(
    provenance: AuthenticatedCaller[],
    targetId: string,
    method: string,
    args: unknown[],
    options?: RpcCallOptions,
  ): Promise<T> {
    if (options?.signal?.aborted) return Promise.reject(new Error("RPC call aborted by caller"));
    const requestId = generateRequestId();
    const request: RpcRequest = { type: "request", requestId, fromId: config.selfId, method, args };
    return new Promise<T>((resolve, reject) => {
      let timeout: ReturnType<typeof setTimeout> | null = null;
      let abortCleanup: (() => void) | null = null;
      const rejectPending = (err: Error): void => {
        const pending = pendingRequests.get(requestId);
        if (!pending) return;
        pendingRequests.delete(requestId);
        if (pending.timeout) clearTimeout(pending.timeout);
        pending.abortCleanup?.();
        pending.reject(err);
      };
      if (typeof options?.timeoutMs === "number" && options.timeoutMs >= 0) {
        timeout = setTimeout(() => rejectPending(new Error(`RPC call timed out after ${options.timeoutMs}ms`)), options.timeoutMs);
      }
      if (options?.signal) {
        const onAbort = (): void => rejectPending(new Error("RPC call aborted by caller"));
        options.signal.addEventListener("abort", onAbort, { once: true });
        abortCleanup = () => options.signal?.removeEventListener("abort", onAbort);
      }
      pendingRequests.set(requestId, { resolve: resolve as (value: unknown) => void, reject, timeout, abortCleanup });
      void send(targetId, request, options, provenance).catch((error) => {
        const pending = pendingRequests.get(requestId);
        pendingRequests.delete(requestId);
        if (pending?.timeout) clearTimeout(pending.timeout);
        pending?.abortCleanup?.();
        reject(error);
      });
    });
  }

  function emitWithProvenance(
    provenance: AuthenticatedCaller[],
    targetId: string,
    event: string,
    payload: unknown,
    options?: RpcCallOptions,
  ): Promise<void> {
    const message: RpcEvent = { type: "event", fromId: config.selfId, event, payload };
    return send(targetId, message, options, provenance);
  }

  function streamWithProvenance(
    provenance: AuthenticatedCaller[],
    targetId: string,
    method: string,
    args: unknown[],
    options?: { signal?: AbortSignal; idempotencyKey?: string },
  ): Promise<Response> {
    return streamImpl(provenance, targetId, method, args, options);
  }

  function peer<
    TMethods extends MethodMap = MethodMap,
    TEvents extends EventMap = EventMap,
    TEmitEvents extends EventMap = TEvents,
  >(
    targetId: string,
    provenance: AuthenticatedCaller[] = baseProvenance,
  ): RpcPeer<TMethods, TEvents, TEmitEvents> {
    const result: RpcPeer<TMethods, TEvents, TEmitEvents> = {
      id: targetId,
      call: createCallProxy<TMethods>((method, args) => callWithProvenance(provenance, targetId, method, args)),
      on(event, listener) {
        return client.on(event, (ev) => {
          if (ev.caller.callerId === targetId) listener(ev as never);
        });
      },
      emit(event, payload) {
        return emitWithProvenance(provenance, targetId, event, payload);
      },
      withContract(_contract, _role) {
        return peer(targetId, provenance) as never;
      },
    };
    return result;
  }

  async function streamImpl(
    provenance: AuthenticatedCaller[],
    targetId: string,
    method: string,
    args: unknown[],
    options?: { signal?: AbortSignal; idempotencyKey?: string },
  ): Promise<Response> {
    if (options?.signal?.aborted) throw new Error("Streaming RPC aborted by caller");
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
      void send(targetId, { type: "stream-cancel", requestId, fromId: config.selfId }, undefined, provenance).catch(() => {});
    };
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        bodyController = controller;
      },
      cancel() {
        const entry = pendingStreams.get(requestId);
        if (entry) entry.bodyClosed = true;
        clearPendingStream(requestId);
        sendCancel();
      },
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
      clearPendingStream(requestId);
      sendCancel();
    };
    const signal = options?.signal;
    signal?.addEventListener("abort", onAbort, { once: true });
    pendingStreams.set(requestId, {
      controller: bodyController!,
      resolveHead,
      rejectHead,
      headEmitted: false,
      bodyClosed: false,
      idleTimer: null,
      cleanup: () => signal?.removeEventListener("abort", onAbort),
    });
    rearmStreamIdleTimer(requestId);
    try {
      await send(
        targetId,
        { type: "stream-request", requestId, fromId: config.selfId, method, args },
        options,
        provenance,
      );
    } catch (error) {
      clearPendingStream(requestId);
      signal?.removeEventListener("abort", onAbort);
      throw error;
    }
    const head = await headPromise;
    const response = new Response(stream as unknown as ConstructorParameters<typeof Response>[0], {
      status: head.status,
      statusText: head.statusText,
      headers: new Headers(head.headerPairs),
    });
    if (head.finalUrl) {
      try {
        Object.defineProperty(response, "url", { value: head.finalUrl, writable: false, configurable: true });
      } catch {
        // ignore
      }
    }
    return response;
  }

  const client: RpcClient = {
    selfId: config.selfId,
    expose(method, handler): void {
      exposedMethods.set(method, handler as (request: RpcRequestContext) => unknown | Promise<unknown>);
    },
    exposeAll(methods: RpcContextMethods): void {
      for (const [name, handler] of Object.entries(methods)) {
        exposedMethods.set(name, handler as (request: RpcRequestContext) => unknown | Promise<unknown>);
      }
    },
    exposeStreaming(method, handler): void {
      streamingHandlers.set(method, handler);
    },
    async call<T = unknown>(
      targetId: string,
      method: string,
      args: unknown[],
      options?: RpcCallOptions,
    ): Promise<T> {
      return callWithProvenance(baseProvenance, targetId, method, args, options);
    },
    async stream(targetId, method, args, options): Promise<Response> {
      return streamWithProvenance(baseProvenance, targetId, method, args, options);
    },
    emit(targetId, event, payload, options): Promise<void> {
      return emitWithProvenance(baseProvenance, targetId, event, payload, options);
    },
    on(event, listener): () => void {
      let listeners = eventListeners.get(event);
      if (!listeners) {
        listeners = new Set();
        eventListeners.set(event, listeners);
      }
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) eventListeners.delete(event);
      };
    },
    peer,
    status(): RpcConnectionStatus {
      return config.transport.status?.() ?? "connected";
    },
    ready(): Promise<void> {
      return config.transport.ready?.() ?? Promise.resolve();
    },
    onStatusChange(handler): () => void {
      return config.transport.onStatusChange?.(handler) ?? (() => {});
    },
    async parent() {
      const id = await config.topology?.parent?.();
      return id ? peer(id) : null;
    },
    async children() {
      const ids = await config.topology?.children?.();
      return (ids ?? []).map((id) => peer(id));
    },
    tree: {
      async root() {
        const id = await config.topology?.root?.();
        return id ? peer(id) : null;
      },
      self() {
        return peer(config.selfId);
      },
      async siblings() {
        const ids = await config.topology?.siblings?.();
        return (ids ?? []).map((id) => peer(id));
      },
    },
    automation(targetId) {
      if (!config.automation) throw new Error("RPC automation adapter is not configured");
      return config.automation.automation(targetId) as never;
    },
  };

  config.transport.onMessage(handleEnvelope);
  return client;
}
