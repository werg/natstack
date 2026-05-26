/**
 * MobileTransport -- WebSocket RPC transport for React Native.
 */

import type {
  RpcBridge,
  RpcCallOptions,
  RpcEventListener,
  RpcMessage,
  StreamingMethodHandler,
} from "@natstack/rpc";
import {
  BaseWsTransport,
  type ConnectionStatus,
  type WsLike,
} from "@natstack/shared/shell/transport";
import type { RecoveryKind } from "@natstack/shared/shell/recoveryCoordinator";
import { isWorkspaceMobileAppCallerId } from "./auth";

export type { ConnectionStatus };

export interface MobileConnectionGrant {
  connectionGrant: string;
  callerId: string;
}

export interface MobileTransportConfig {
  /** Server URL, e.g. "https://natstack.example.com" or "http://192.168.1.5:3000" */
  serverUrl: string;
  /** Mint a fresh one-time app-scoped connection grant from the native host. */
  issueConnectionGrant: () => Promise<MobileConnectionGrant>;
}

export function createMobileTransport(config: MobileTransportConfig): MobileTransport {
  return new MobileTransport(config);
}

class BrowserWsLike implements WsLike {
  constructor(private readonly ws: WebSocket) {}
  get readyState(): number {
    return this.ws.readyState;
  }
  get onopen(): (() => void) | null {
    return this.ws.onopen as (() => void) | null;
  }
  set onopen(handler: (() => void) | null) {
    this.ws.onopen = handler;
  }
  get onmessage(): ((event: { data: unknown }) => void) | null {
    return this.ws.onmessage as ((event: { data: unknown }) => void) | null;
  }
  set onmessage(handler: ((event: { data: unknown }) => void) | null) {
    this.ws.onmessage = handler as unknown as WebSocket["onmessage"];
  }
  get onclose(): ((event: { code?: number; reason?: string }) => void) | null {
    return this.ws.onclose as ((event: { code?: number; reason?: string }) => void) | null;
  }
  set onclose(handler: ((event: { code?: number; reason?: string }) => void) | null) {
    this.ws.onclose = handler as unknown as WebSocket["onclose"];
  }
  get onerror(): ((event: unknown) => void) | null {
    return this.ws.onerror as ((event: unknown) => void) | null;
  }
  set onerror(handler: ((event: unknown) => void) | null) {
    this.ws.onerror = handler as unknown as WebSocket["onerror"];
  }
  send(data: string): void {
    this.ws.send(data);
  }
  close(code?: number, reason?: string): void {
    this.ws.close(code, reason);
  }
}

export class MobileTransport implements RpcBridge {
  private config: MobileTransportConfig;
  private transport: BaseWsTransport | null = null;
  private lastCloseInfo: { code?: number; reason?: string } | null = null;
  private currentCallerId: string | null = null;
  private preissuedGrant: string | null = null;
  private statusState: ConnectionStatus = "disconnected";
  private readonly statusListeners = new Set<(status: ConnectionStatus) => void>();
  private readonly recoveryListeners = new Map<RecoveryKind, Set<() => void | Promise<void>>>();
  private readonly eventListeners = new Map<string, Set<RpcEventListener>>();

  constructor(config: MobileTransportConfig) {
    this.config = config;
  }

  get selfId(): string {
    return this.currentCallerId ?? "app:mobile:pending";
  }

  get status(): ConnectionStatus {
    return this.transport?.getConnectionStatus() ?? this.statusState;
  }

  getLastCloseInfo(): { code?: number; reason?: string } | null {
    return this.lastCloseInfo;
  }

  connect(): void {
    this.setStatus("connecting");
    void this.ensureTransport().then(
      (transport) => transport.connect(),
      (error) => {
        console.warn("[MobileTransport] Failed to initialize native app principal:", error);
        this.setStatus("disconnected");
      }
    );
  }

  reconnect(): void {
    if (this.transport) {
      this.transport.reconnect();
      return;
    }
    this.connect();
  }

  disconnect(): void {
    if (!this.transport) {
      this.setStatus("disconnected");
      return;
    }
    void this.transport.close();
  }

  onStatusChange(callback: (status: ConnectionStatus) => void): () => void {
    this.statusListeners.add(callback);
    return () => {
      this.statusListeners.delete(callback);
    };
  }

  updateConfig(config: MobileTransportConfig): void {
    this.config = config;
    if (this.transport) {
      void this.transport.close();
    }
    this.transport = null;
    this.currentCallerId = null;
    this.preissuedGrant = null;
    this.setStatus("disconnected");
  }

  call<T = unknown>(
    targetId: string,
    method: string,
    args: unknown[],
    options?: RpcCallOptions
  ): Promise<T> {
    return this.ensureTransport().then((transport) =>
      transport.call<T>(targetId, method, args, options)
    );
  }

  emit(targetId: string, event: string, payload: unknown): Promise<void> {
    return this.ensureTransport().then((transport) => transport.emit(targetId, event, payload));
  }

  onReconnect(listener: () => void): () => void {
    return this.onRecovery("resubscribe", listener);
  }

  onRecovery(kind: RecoveryKind, listener: () => void | Promise<void>): () => void {
    let listeners = this.recoveryListeners.get(kind);
    if (!listeners) {
      listeners = new Set();
      this.recoveryListeners.set(kind, listeners);
    }
    listeners.add(listener);
    return () => {
      listeners?.delete(listener);
    };
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
    };
  }

  exposeMethod<TArgs extends unknown[], TReturn>(
    _method: string,
    _handler: (...args: TArgs) => TReturn | Promise<TReturn>
  ): void {
    // Mobile workspace apps do not expose methods to the server.
  }

  expose(_methods: Record<string, (...args: never[]) => unknown>): void {
    // Mobile workspace apps do not expose methods to the server.
  }

  exposeStreamingMethod(_method: string, _handler: StreamingMethodHandler): void {
    throw new Error("streaming RPC is not supported by MobileTransport");
  }

  streamCall(): Promise<Response> {
    return Promise.reject(new Error("streaming RPC is not supported by MobileTransport"));
  }

  _handleMessage(_sourceId: string, _message: RpcMessage): void {
    // MobileTransport receives messages directly from the WebSocket.
  }

  private async ensureTransport(): Promise<BaseWsTransport> {
    if (this.transport) return this.transport;
    const grant = await this.issueNativeGrant();
    this.currentCallerId = grant.callerId;
    this.preissuedGrant = grant.connectionGrant;
    this.transport = this.createBaseTransport(grant.callerId);
    return this.transport;
  }

  private async issueNativeGrant(): Promise<MobileConnectionGrant> {
    const grant = await this.config.issueConnectionGrant();
    if (
      typeof grant.connectionGrant !== "string" ||
      !grant.connectionGrant ||
      typeof grant.callerId !== "string" ||
      !isWorkspaceMobileAppCallerId(grant.callerId)
    ) {
      throw new Error("Native host returned an invalid app connection grant");
    }
    if (this.currentCallerId && grant.callerId !== this.currentCallerId) {
      throw new Error("Native host returned a different app principal for this connection");
    }
    return grant;
  }

  private async nextGrantToken(): Promise<string> {
    const preissued = this.preissuedGrant;
    if (preissued) {
      this.preissuedGrant = null;
      return preissued;
    }
    return (await this.issueNativeGrant()).connectionGrant;
  }

  private createBaseTransport(callerId: string): BaseWsTransport {
    return new BaseWsTransport({
      selfId: callerId,
      getWsUrl: () => buildWsUrl(this.config.serverUrl),
      terminalCloseCodes: [4001, 4005, 4006],
      logPrefix: "MobileTransport",
      onConnectionStatusChanged: (status) => this.setStatus(status),
      onRecovery: (kind) => {
        for (const listener of this.recoveryListeners.get(kind) ?? []) {
          void listener();
        }
      },
      onEvent: (event, payload) => {
        for (const listener of this.eventListeners.get(event) ?? []) {
          listener("main", payload);
        }
      },
      adapter: {
        now: () => Date.now(),
        getAuthToken: () => this.nextGrantToken(),
        refreshAuthToken: () => this.nextGrantToken(),
        createSocket: (url) => {
          this.lastCloseInfo = null;
          const ws = new WebSocket(url);
          const wrapped = new BrowserWsLike(ws);
          const originalClose = Object.getOwnPropertyDescriptor(
            BrowserWsLike.prototype,
            "onclose"
          )?.set;
          Object.defineProperty(wrapped, "onclose", {
            set: (handler: ((event: { code?: number; reason?: string }) => void) | null) => {
              originalClose?.call(wrapped, (event: { code?: number; reason?: string }) => {
                this.lastCloseInfo = { code: event.code, reason: event.reason };
                handler?.(event);
              });
            },
            get: () => null,
          });
          return wrapped;
        },
      },
    });
  }

  private setStatus(status: ConnectionStatus): void {
    this.statusState = status;
    for (const listener of this.statusListeners) listener(status);
  }
}

export function buildWsUrl(serverUrl: string): string {
  let url: URL;
  try {
    url = new URL(serverUrl);
  } catch {
    throw new Error(`Invalid server URL: ${serverUrl}`);
  }
  if (
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    url.username ||
    url.password ||
    (url.pathname !== "" && url.pathname !== "/") ||
    url.search ||
    url.hash
  ) {
    throw new Error(`Invalid server URL: ${serverUrl}`);
  }
  const protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${url.host}/rpc`;
}
