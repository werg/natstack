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

export type { ConnectionStatus };

export interface MobileTransportConfig {
  /** Server URL, e.g. "https://natstack.example.com" or "http://192.168.1.5:3000" */
  serverUrl: string;
  /** Mint a fresh shell token from the durable device credential. */
  refreshShellToken: () => Promise<string>;
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
    this.ws.onmessage = handler as ((event: MessageEvent) => void) | null;
  }
  get onclose(): ((event: { code?: number; reason?: string }) => void) | null {
    return this.ws.onclose as ((event: { code?: number; reason?: string }) => void) | null;
  }
  set onclose(handler: ((event: { code?: number; reason?: string }) => void) | null) {
    this.ws.onclose = handler as ((event: CloseEvent) => void) | null;
  }
  get onerror(): ((event: unknown) => void) | null {
    return this.ws.onerror as ((event: unknown) => void) | null;
  }
  set onerror(handler: ((event: unknown) => void) | null) {
    this.ws.onerror = handler as ((event: Event) => void) | null;
  }
  send(data: string): void {
    this.ws.send(data);
  }
  close(code?: number, reason?: string): void {
    this.ws.close(code, reason);
  }
}

export class MobileTransport implements RpcBridge {
  readonly selfId = "mobile-shell";

  private config: MobileTransportConfig;
  private transport: BaseWsTransport;
  private lastCloseInfo: { code?: number; reason?: string } | null = null;

  constructor(config: MobileTransportConfig) {
    this.config = config;
    this.transport = this.createBaseTransport();
  }

  get status(): ConnectionStatus {
    return this.transport.getConnectionStatus();
  }

  getLastCloseInfo(): { code?: number; reason?: string } | null {
    return this.lastCloseInfo;
  }

  connect(): void {
    this.transport.connect();
  }

  reconnect(): void {
    this.transport.reconnect();
  }

  disconnect(): void {
    void this.transport.close();
  }

  onStatusChange(callback: (status: ConnectionStatus) => void): () => void {
    return this.transport.onConnectionStatusChanged(callback);
  }

  updateConfig(config: MobileTransportConfig): void {
    this.config = config;
  }

  call<T = unknown>(
    targetId: string,
    method: string,
    args: unknown[],
    options?: RpcCallOptions,
  ): Promise<T> {
    return this.transport.call<T>(targetId, method, args, options);
  }

  emit(targetId: string, event: string, payload: unknown): Promise<void> {
    return this.transport.emit(targetId, event, payload);
  }

  onReconnect(listener: () => void): () => void {
    return this.onRecovery("resubscribe", listener);
  }

  onRecovery(kind: RecoveryKind, listener: () => void | Promise<void>): () => void {
    return this.transport.onRecovery(kind, listener);
  }

  onEvent(event: string, listener: RpcEventListener): () => void {
    return this.transport.onEvent(event, listener);
  }

  exposeMethod<TArgs extends unknown[], TReturn>(
    _method: string,
    _handler: (...args: TArgs) => TReturn | Promise<TReturn>,
  ): void {
    // Mobile shell does not expose methods to the server.
  }

  expose(_methods: Record<string, (...args: never[]) => unknown>): void {
    // Mobile shell does not expose methods to the server.
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

  private createBaseTransport(): BaseWsTransport {
    return new BaseWsTransport({
      selfId: this.selfId,
      getWsUrl: () => buildWsUrl(this.config.serverUrl),
      terminalCloseCodes: [4001, 4005, 4006],
      logPrefix: "MobileTransport",
      onConnectionStatusChanged: () => {},
      adapter: {
        now: () => Date.now(),
        getAuthToken: () => this.config.refreshShellToken(),
        refreshAuthToken: () => this.config.refreshShellToken(),
        createSocket: (url) => {
          this.lastCloseInfo = null;
          const ws = new WebSocket(url);
          const wrapped = new BrowserWsLike(ws);
          const originalClose = Object.getOwnPropertyDescriptor(BrowserWsLike.prototype, "onclose")?.set;
          Object.defineProperty(wrapped, "onclose", {
            set: (handler: ((event: { code?: number; reason?: string }) => void) | null) => {
              originalClose?.call(wrapped, (event) => {
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
}

function buildWsUrl(serverUrl: string): string {
  const match = serverUrl.match(/^(https?):\/\/(.+?)(?:\/|$)/);
  if (!match) throw new Error(`Invalid server URL: ${serverUrl}`);
  const protocol = match[1] === "https" ? "wss:" : "ws:";
  return `${protocol}//${match[2]}/rpc`;
}
