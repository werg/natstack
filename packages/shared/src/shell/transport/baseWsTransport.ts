import type {
  RpcCallOptions,
  RpcEvent,
  RpcEventListener,
  RpcMessage,
  RpcRequest,
  RpcResponse,
} from "@natstack/rpc";
import type { WsClientMessage, WsServerMessage } from "../../ws/protocol.js";
import type { RecoveryKind } from "../recoveryCoordinator.js";
import type { WsTransportAdapter, WsLike } from "./adapter.js";

export type ConnectionStatus = "connected" | "connecting" | "disconnected";

export interface BaseWsTransportConfig {
  selfId: string;
  getWsUrl: () => string;
  adapter: WsTransportAdapter;
  connectionId?: string;
  reconnect?: boolean;
  terminalCloseCodes?: number[];
  routeTarget?: (targetId: string) => string;
  translateEvent?: (event: string, payload: unknown, deliver: (message: RpcMessage) => void) => boolean;
  onConnectionStatusChanged?: (status: ConnectionStatus) => void;
  onEvent?: (event: string, payload: unknown) => void;
  onDisconnect?: () => void;
  onRecovery?: (kind: RecoveryKind) => void | Promise<void>;
  logPrefix?: string;
}

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout> | null;
  abortCleanup: (() => void) | null;
}

const OPEN = 1;

function randomId(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function errorWithCode(message: string, code: string): Error {
  return Object.assign(new Error(message), { code });
}

export class BaseWsTransport {
  readonly selfId: string;
  readonly connectionId: string;

  private readonly config: BaseWsTransportConfig;
  private socket: WsLike | null = null;
  private authenticated = false;
  private closed = false;
  private status: ConnectionStatus = "disconnected";
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private generation = 0;
  private hasConnectedBefore = false;
  private lastSeenBootId: string | null = null;
  private sessionDirty = false;
  private authToken: string | null = null;
  private firstConnectPromise: Promise<void> | null = null;
  private firstConnectResolve: (() => void) | null = null;
  private firstConnectReject: ((error: Error) => void) | null = null;

  private readonly pendingCalls = new Map<string, PendingCall>();
  private readonly messageListeners = new Set<(fromId: string, message: RpcMessage) => void>();
  private readonly eventListeners = new Map<string, Set<RpcEventListener>>();
  private readonly recoveryListeners = new Map<RecoveryKind, Set<() => void | Promise<void>>>();

  constructor(config: BaseWsTransportConfig) {
    this.config = config;
    this.selfId = config.selfId;
    this.connectionId = config.connectionId ?? randomId();
  }

  connect(): void {
    this.closed = false;
    this.clearReconnectTimer();
    this.openSocket();
  }

  connectAndWait(timeoutMs = 10_000): Promise<void> {
    if (this.isConnected()) return Promise.resolve();
    if (!this.firstConnectPromise) {
      this.firstConnectPromise = new Promise<void>((resolve, reject) => {
        this.firstConnectResolve = resolve;
        this.firstConnectReject = reject;
      });
    }
    this.connect();
    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`Server WS connection timeout (${timeoutMs}ms): ${this.config.getWsUrl()}`));
      }, timeoutMs);
      this.firstConnectPromise!.then(
        () => {
          clearTimeout(timeout);
          resolve();
        },
        (err) => {
          clearTimeout(timeout);
          reject(err);
        },
      );
    });
  }

  reconnect(): void {
    this.reconnectAttempt = 0;
    this.connect();
  }

  async close(): Promise<void> {
    this.closed = true;
    this.clearReconnectTimer();
    this.rejectAllPending(errorWithCode("Disconnected", "CONNECTION_LOST"));
    const socket = this.socket;
    this.socket = null;
    this.authenticated = false;
    this.setStatus("disconnected");
    if (!socket || socket.readyState !== OPEN) return;
    await new Promise<void>((resolve) => {
      const done = (): void => resolve();
      socket.onclose = done;
      socket.close(1000, "Client closing");
      setTimeout(done, 2000);
    });
  }

  isConnected(): boolean {
    return this.socket?.readyState === OPEN && this.authenticated;
  }

  getConnectionStatus(): ConnectionStatus {
    return this.status;
  }

  onConnectionStatusChanged(listener: (status: ConnectionStatus) => void): () => void {
    const previous = this.config.onConnectionStatusChanged;
    const wrapped = (status: ConnectionStatus): void => {
      previous?.(status);
      listener(status);
    };
    (this.config as { onConnectionStatusChanged?: (status: ConnectionStatus) => void }).onConnectionStatusChanged = wrapped;
    return () => {
      (this.config as { onConnectionStatusChanged?: (status: ConnectionStatus) => void }).onConnectionStatusChanged = previous;
    };
  }

  onMessage(handler: (fromId: string, message: RpcMessage) => void): () => void {
    this.messageListeners.add(handler);
    return () => this.messageListeners.delete(handler);
  }

  onEvent(event: string, listener: RpcEventListener): () => void {
    let listeners = this.eventListeners.get(event);
    if (!listeners) {
      listeners = new Set();
      this.eventListeners.set(event, listeners);
    }
    listeners.add(listener);
    return () => {
      listeners?.delete(listener);
      if (listeners?.size === 0) this.eventListeners.delete(event);
    };
  }

  onRecovery(kind: RecoveryKind, handler: () => void | Promise<void>): () => void {
    let listeners = this.recoveryListeners.get(kind);
    if (!listeners) {
      listeners = new Set();
      this.recoveryListeners.set(kind, listeners);
    }
    listeners.add(handler);
    return () => {
      listeners?.delete(handler);
      if (listeners?.size === 0) this.recoveryListeners.delete(kind);
    };
  }

  async send(targetId: string, message: RpcMessage): Promise<void> {
    const socket = this.socket;
    if (!socket || socket.readyState !== OPEN || !this.authenticated) {
      throw errorWithCode("Not connected to server", "CONNECTION_LOST");
    }

    const normalized = this.config.routeTarget?.(targetId) ?? targetId;
    const envelope: WsClientMessage =
      normalized === "main"
        ? { type: "ws:rpc", message }
        : { type: "ws:route", targetId: normalized, message };
    socket.send(JSON.stringify(envelope));
  }

  async emit(targetId: string, event: string, payload: unknown): Promise<void> {
    await this.send(targetId, { type: "event", fromId: this.selfId, event, payload });
  }

  async call<T = unknown>(
    targetId: string,
    method: string,
    args: unknown[],
    options?: RpcCallOptions,
  ): Promise<T> {
    if (options?.signal?.aborted) {
      throw errorWithCode("RPC call aborted by caller", "ABORT_ERR");
    }
    const requestId = randomId();
    const request: RpcRequest = {
      type: "request",
      requestId,
      fromId: this.selfId,
      method,
      args,
    };

    return new Promise<T>((resolve, reject) => {
      let timeout: ReturnType<typeof setTimeout> | null = null;
      let abortCleanup: (() => void) | null = null;
      const rejectPending = (err: Error): void => {
        const pending = this.pendingCalls.get(requestId);
        if (!pending) return;
        this.pendingCalls.delete(requestId);
        if (pending.timeout) clearTimeout(pending.timeout);
        pending.abortCleanup?.();
        pending.reject(err);
      };
      if (typeof options?.timeoutMs === "number" && options.timeoutMs >= 0) {
        timeout = setTimeout(() => {
          rejectPending(errorWithCode(`RPC call timed out after ${options.timeoutMs}ms`, "ETIMEDOUT"));
        }, options.timeoutMs);
      }
      if (options?.signal) {
        const onAbort = (): void => rejectPending(errorWithCode("RPC call aborted by caller", "ABORT_ERR"));
        options.signal.addEventListener("abort", onAbort, { once: true });
        abortCleanup = () => options.signal?.removeEventListener("abort", onAbort);
      }

      this.pendingCalls.set(requestId, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timeout,
        abortCleanup,
      });

      this.send(targetId, request).catch((err) => {
        const pending = this.pendingCalls.get(requestId);
        this.pendingCalls.delete(requestId);
        if (pending?.timeout) clearTimeout(pending.timeout);
        pending?.abortCleanup?.();
        reject(err);
      });
    });
  }

  callMain<T = unknown>(method: string, args: unknown[], options?: RpcCallOptions): Promise<T> {
    return this.call<T>("main", method, args, options);
  }

  private async openSocket(): Promise<void> {
    const generation = ++this.generation;
    const prefix = this.config.logPrefix ?? "BaseWsTransport";
    this.setStatus("connecting");
    this.authenticated = false;

    let token: string;
    try {
      token = this.authToken ?? await this.config.adapter.getAuthToken();
      this.authToken = token;
    } catch (error) {
      console.warn(`[${prefix}] Failed to get auth token:`, error);
      this.scheduleReconnect(generation);
      return;
    }

    const socket = this.config.adapter.createSocket(this.config.getWsUrl());
    this.socket = socket;

    socket.onopen = () => {
      if (generation !== this.generation || this.socket !== socket) return;
      socket.send(JSON.stringify({ type: "ws:auth", token, connectionId: this.connectionId } satisfies WsClientMessage));
    };

    socket.onmessage = (event) => {
      if (generation !== this.generation || this.socket !== socket) return;
      try {
        this.handleServerMessage(JSON.parse(String(event.data)) as WsServerMessage);
      } catch (error) {
        console.warn(`[${prefix}] Malformed message from server:`, error);
      }
    };

    socket.onerror = (event) => {
      if (generation !== this.generation || this.socket !== socket) return;
      console.warn(`[${prefix}] WebSocket error`, event);
      if (!this.hasConnectedBefore && this.firstConnectReject) {
        const message =
          event instanceof Error
            ? event.message
            : String((event as { message?: unknown })?.message ?? "WebSocket error");
        this.firstConnectReject(new Error(message));
        this.firstConnectReject = null;
        this.firstConnectResolve = null;
        this.closed = true;
      }
    };

    socket.onclose = (event) => {
      if (generation !== this.generation || this.socket !== socket) return;
      this.authenticated = false;
      this.rejectAllPending(errorWithCode("Connection lost", "CONNECTION_LOST"));
      const terminalCodes = new Set(this.config.terminalCloseCodes ?? []);
      if (this.closed || terminalCodes.has(event.code ?? 0)) {
        this.setStatus("disconnected");
        this.config.onDisconnect?.();
        return;
      }
      if (this.config.reconnect === false) {
        this.setStatus("disconnected");
        this.config.onDisconnect?.();
        return;
      }
      this.scheduleReconnect(generation);
    };
  }

  private handleServerMessage(msg: WsServerMessage): void {
    switch (msg.type) {
      case "ws:auth-result": {
        if (!msg.success) {
          void this.handleAuthFailure();
          return;
        }
        const previousBootId = this.lastSeenBootId;
        const nextBootId = msg.serverBootId ?? null;
        const isReconnect = this.hasConnectedBefore;
        this.sessionDirty = msg.sessionDirty === true;
        this.authenticated = true;
        this.hasConnectedBefore = true;
        this.firstConnectResolve?.();
        this.firstConnectResolve = null;
        this.firstConnectReject = null;
        this.lastSeenBootId = nextBootId;
        this.reconnectAttempt = 0;
        this.setStatus("connected");
        if (this.sessionDirty || (isReconnect && previousBootId && nextBootId && previousBootId !== nextBootId)) {
          this.emitRecovery("cold-recover");
        } else {
          this.emitRecovery("resubscribe");
        }
        break;
      }
      case "ws:rpc":
        this.handleRpcMessage("main", msg.message);
        break;
      case "ws:routed":
        this.handleRpcMessage(msg.fromId, msg.message);
        break;
      case "ws:event": {
        const delivered = this.config.translateEvent?.(msg.event, msg.payload, (message) => {
          this.deliverMessage("main", message);
        });
        if (!delivered) {
          this.config.onEvent?.(msg.event, msg.payload);
          this.deliverMessage("main", { type: "event", fromId: "main", event: msg.event, payload: msg.payload });
          this.deliverEvent("main", msg.event, msg.payload);
        }
        break;
      }
      case "ws:routed-event-error":
        this.deliverEvent("main", "runtime:routed-event-error", {
          targetId: msg.targetId,
          event: msg.event,
          error: msg.error,
          errorCode: msg.errorCode,
        });
        break;
      case "ws:routed-response-error":
        this.deliverEvent("main", "runtime:routed-response-error", {
          targetId: msg.targetId,
          requestId: msg.requestId,
          error: msg.error,
          errorCode: msg.errorCode,
        });
        break;
    }
  }

  private handleRpcMessage(fromId: string, message: RpcMessage): void {
    if (message.type === "response") {
      const response = message as RpcResponse;
      const pending = this.pendingCalls.get(response.requestId);
      if (pending) {
        this.pendingCalls.delete(response.requestId);
        if (pending.timeout) clearTimeout(pending.timeout);
        pending.abortCleanup?.();
        if ("error" in response) {
          const err = new Error(response.error) as NodeJS.ErrnoException;
          if (response.errorCode) err.code = response.errorCode;
          if (response.errorStack) err.stack = response.errorStack;
          pending.reject(err);
        } else {
          pending.resolve(response.result);
        }
        return;
      }
    }
    this.deliverMessage(fromId, message);
  }

  private deliverMessage(fromId: string, message: RpcMessage): void {
    for (const listener of this.messageListeners) {
      try {
        listener(fromId, message);
      } catch (error) {
        console.error("[BaseWsTransport] Message listener failed:", error);
      }
    }
  }

  private deliverEvent(fromId: string, event: string, payload: unknown): void {
    for (const listener of this.eventListeners.get(event) ?? []) {
      try {
        listener(fromId, payload);
      } catch (error) {
        console.error(`[BaseWsTransport] Event listener failed for ${event}:`, error);
      }
    }
  }

  private async handleAuthFailure(): Promise<void> {
    if (!this.config.adapter.refreshAuthToken) {
      this.firstConnectReject?.(new Error("Server auth failed"));
      this.firstConnectReject = null;
      this.firstConnectResolve = null;
      if (!this.hasConnectedBefore) this.closed = true;
      this.socket?.close(4006, "Authentication failed");
      return;
    }
    try {
      this.authToken = await this.config.adapter.refreshAuthToken();
      const oldSocket = this.socket;
      const nextGeneration = ++this.generation;
      oldSocket?.close(4000, "Refreshing auth token");
      this.reconnectAttempt = 0;
      setTimeout(() => {
        if (this.closed || nextGeneration !== this.generation) return;
        void this.openSocket();
      }, 0);
    } catch (error) {
      console.warn("[BaseWsTransport] Auth refresh failed:", error);
      this.socket?.close(4006, "Authentication failed");
    }
  }

  private scheduleReconnect(generation: number): void {
    if (this.closed) return;
    this.clearReconnectTimer();
    const jitter = Math.random() * 500;
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempt) + jitter, 30_000);
    this.reconnectAttempt += 1;
    this.setStatus("connecting");
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.closed || generation !== this.generation) return;
      void this.openSocket();
    }, delay);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private setStatus(status: ConnectionStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.config.onConnectionStatusChanged?.(status);
  }

  private emitRecovery(kind: RecoveryKind): void {
    void this.config.onRecovery?.(kind);
    for (const listener of this.recoveryListeners.get(kind) ?? []) {
      try {
        void listener();
      } catch (error) {
        console.error(`[BaseWsTransport] Recovery listener failed for ${kind}:`, error);
      }
    }
  }

  private rejectAllPending(error: Error): void {
    for (const pending of this.pendingCalls.values()) {
      if (pending.timeout) clearTimeout(pending.timeout);
      pending.abortCleanup?.();
      pending.reject(error);
    }
    this.pendingCalls.clear();
  }
}
