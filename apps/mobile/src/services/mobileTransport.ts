/**
 * MobileTransport -- WebSocket RPC transport for React Native.
 *
 * Ports the createServerClient() pattern from src/main/serverClient.ts for
 * mobile use. Authenticates with the shell token (not admin token) and
 * provides an RpcBridge-compatible call() interface for PanelShell.
 *
 * React Native's built-in WebSocket is browser-compatible, so the ws:auth
 * protocol works the same as in the Electron preload transport.
 */

import type { RpcBridge, RpcMessage, RpcResponse, RpcEventListener } from "@natstack/rpc";
import type { WsClientMessage, WsServerMessage } from "@natstack/shared/ws/protocol";
import type { RecoveryKind } from "@natstack/shared/shell/recoveryCoordinator";

/** Connection status reported via onStatusChange */
export type ConnectionStatus = "connected" | "connecting" | "disconnected";

export interface MobileTransportConfig {
  /** Server URL, e.g. "https://natstack.example.com" or "http://192.168.1.5:3000" */
  serverUrl: string;
  /** Mint a fresh shell token from the durable device credential. */
  refreshShellToken: () => Promise<string>;
}

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

/**
 * Create a mobile transport that connects to the NatStack server via WebSocket.
 *
 * Returns an RpcBridge-compatible object plus lifecycle methods for mobile
 * (reconnect, disconnect, onStatusChange).
 */
export function createMobileTransport(config: MobileTransportConfig): MobileTransport {
  return new MobileTransport(config);
}

export class MobileTransport implements RpcBridge {
  readonly selfId = "mobile-shell";

  private config: MobileTransportConfig;
  private ws: WebSocket | null = null;
  private authenticated = false;
  private pendingCalls = new Map<string, PendingCall>();
  private statusListeners = new Set<(status: ConnectionStatus) => void>();
  private eventListeners = new Map<string, Set<RpcEventListener>>();
  private reconnectListeners = new Set<() => void>();
  private recoveryListeners = new Map<RecoveryKind, Set<() => void | Promise<void>>>();
  private hasConnectedBefore = false;
  private lastSeenBootId: string | null = null;
  private readonly connectionId = generateId();
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private intentionalClose = false;
  private _status: ConnectionStatus = "disconnected";
  private lastCloseInfo: { code?: number; reason?: string } | null = null;
  private connectionGeneration = 0;

  constructor(config: MobileTransportConfig) {
    this.config = config;
  }

  // === Connection lifecycle ===

  get status(): ConnectionStatus {
    return this._status;
  }

  /** Reason the last WebSocket was closed, if any. Useful for surfacing
   *  connection errors up to UI layers — RN's onerror carries no detail. */
  getLastCloseInfo(): { code?: number; reason?: string } | null {
    return this.lastCloseInfo;
  }

  /**
   * Connect (or reconnect) to the server.
   * Safe to call multiple times -- tears down existing connection first.
   */
  connect(): void {
    this.intentionalClose = false;
    this.clearReconnectTimer();
    this.teardownWs();
    this.setStatus("connecting");
    this.openWebSocket();
  }

  /**
   * Reconnect to the server (e.g., after app resume).
   * Resets the reconnect backoff counter.
   */
  reconnect(): void {
    this.reconnectAttempt = 0;
    this.connect();
  }

  /**
   * Disconnect from the server. Rejects all pending calls.
   * Does not auto-reconnect.
   */
  disconnect(): void {
    this.intentionalClose = true;
    this.clearReconnectTimer();
    this.teardownWs();
    this.rejectAllPending("Disconnected");
    this.setStatus("disconnected");
  }

  /**
   * Register a callback for connection status changes.
   * Returns an unsubscribe function.
   */
  onStatusChange(callback: (status: ConnectionStatus) => void): () => void {
    this.statusListeners.add(callback);
    return () => this.statusListeners.delete(callback);
  }

  /**
   * Update server credentials without reconnecting.
   */
  updateConfig(config: MobileTransportConfig): void {
    this.config = config;
  }

  // === RpcBridge interface ===

  call<T = unknown>(_targetId: string, method: string, ...args: unknown[]): Promise<T> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN || !this.authenticated) {
      return Promise.reject(new Error("Not connected to server"));
    }

    const requestId = generateId();

    return new Promise<T>((resolve, reject) => {
      this.pendingCalls.set(requestId, {
        resolve: resolve as (value: unknown) => void,
        reject,
      });

      const rpcMsg: RpcMessage = {
        type: "request",
        requestId,
        fromId: this.selfId,
        method,
        args,
      };
      const envelope: WsClientMessage = { type: "ws:rpc", message: rpcMsg };
      ws.send(JSON.stringify(envelope));
    });
  }

  /**
   * Emit an event to a target. Not typically used by mobile shell
   * but required by the RpcBridge interface.
   */
  async emit(_targetId: string, event: string, payload: unknown): Promise<void> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.authenticated) {
      throw new Error("Not connected to server");
    }

    const rpcMsg: RpcMessage = {
      type: "event",
      fromId: this.selfId,
      event,
      payload,
    };
    const envelope: WsClientMessage = { type: "ws:rpc", message: rpcMsg };
    this.ws.send(JSON.stringify(envelope));
  }

  /**
   * Register a callback that fires after a successful reconnection.
   * Used to re-subscribe to server events (subscriptions are lost on reconnect
   * because the server destroys the old WsSubscriber with the old WebSocket).
   */
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
      if (listeners?.size === 0) {
        this.recoveryListeners.delete(kind);
      }
    };
  }

  /**
   * Listen for server events.
   * Returns an unsubscribe function.
   */
  onEvent(event: string, listener: RpcEventListener): () => void {
    let listeners = this.eventListeners.get(event);
    if (!listeners) {
      listeners = new Set();
      this.eventListeners.set(event, listeners);
    }
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) {
        this.eventListeners.delete(event);
      }
    };
  }

  /**
   * Not used by mobile shell -- PanelShell only calls call().
   * Stubbed to satisfy RpcBridge interface.
   */
  exposeMethod<TArgs extends unknown[], TReturn>(
    _method: string,
    _handler: (...args: TArgs) => TReturn | Promise<TReturn>,
  ): void {
    // Mobile shell does not expose methods to the server
  }

  /**
   * Not used by mobile shell.
   * Stubbed to satisfy RpcBridge interface.
   */
  expose(_methods: Record<string, (...args: never[]) => unknown>): void {
    // Mobile shell does not expose methods to the server
  }

  // === Internal ===

  private openWebSocket(): void {
    // Convert HTTP(S) URL to WS(S) URL with /rpc path
    const wsUrl = buildWsUrl(this.config.serverUrl);
    const generation = ++this.connectionGeneration;
    this.lastCloseInfo = null;
    console.log(`[MobileTransport] Connecting WebSocket to ${wsUrl}`);
    const ws = new WebSocket(wsUrl);
    this.ws = ws;

    ws.onopen = () => {
      if (generation !== this.connectionGeneration || this.ws !== ws) return;
      console.log(`[MobileTransport] WebSocket open, sending auth`);
      void this.config.refreshShellToken().then((shellToken) => {
        if (generation !== this.connectionGeneration) return;
        if (this.ws !== ws || ws.readyState !== WebSocket.OPEN) return;
        ws.send(JSON.stringify({ type: "ws:auth", token: shellToken, connectionId: this.connectionId }));
      }).catch((error) => {
        if (generation !== this.connectionGeneration) return;
        console.error("[MobileTransport] Failed to refresh shell token:", error);
        this.intentionalClose = true;
        ws.close(4001, "Shell token refresh failed");
        this.setStatus("disconnected");
      });
    };

    ws.onmessage = (event) => {
      if (generation !== this.connectionGeneration || this.ws !== ws) return;
      try {
        const msg = JSON.parse(event.data as string) as WsServerMessage;
        this.handleServerMessage(msg);
      } catch (error) {
        console.error("[MobileTransport] Failed to parse server message:", error);
      }
    };

    ws.onclose = (event: { code?: number; reason?: string }) => {
      if (generation !== this.connectionGeneration || this.ws !== ws) return;
      this.authenticated = false;
      // Stash details so waitForConnection can surface a meaningful reason.
      this.lastCloseInfo = { code: event?.code, reason: event?.reason };
      console.warn(
        `[MobileTransport] WebSocket closed code=${event?.code ?? "?"} reason=${event?.reason || "<none>"} url=${wsUrl}`,
      );
      if (this.intentionalClose) {
        return;
      }
      this.rejectAllPending("Connection lost");
      this.setStatus("disconnected");
      this.scheduleReconnect();
    };

    ws.onerror = (event: unknown) => {
      if (generation !== this.connectionGeneration || this.ws !== ws) return;
      // RN's WebSocket onerror doesn't carry native error details, but logging
      // confirms we at least reached the error path.
      const message = (event as { message?: string })?.message;
      console.warn(`[MobileTransport] WebSocket error${message ? `: ${message}` : ""} url=${wsUrl}`);
    };
  }

  private handleServerMessage(msg: WsServerMessage): void {
    switch (msg.type) {
      case "ws:auth-result": {
        if (msg.success) {
          const isReconnect = this.hasConnectedBefore;
          const previousBootId = this.lastSeenBootId;
          const nextBootId = msg.serverBootId ?? null;
          this.authenticated = true;
          this.hasConnectedBefore = true;
          this.lastSeenBootId = nextBootId;
          this.reconnectAttempt = 0;
          this.setStatus("connected");
          this.emitRecovery("resubscribe");
          if (isReconnect && previousBootId && nextBootId && previousBootId !== nextBootId) {
            this.emitRecovery("cold-recover");
          }
        } else {
          console.error("[MobileTransport] Auth failed:", msg.error);
          // Don't reconnect on auth failure; the device credential must be refreshed or re-paired.
          this.intentionalClose = true;
          this.ws?.close();
          this.setStatus("disconnected");
        }
        break;
      }

      case "ws:rpc": {
        const rpcMsg = msg.message as RpcResponse;
        if (rpcMsg.type === "response") {
          const pending = this.pendingCalls.get(rpcMsg.requestId);
          if (pending) {
            this.pendingCalls.delete(rpcMsg.requestId);
            if ("error" in rpcMsg) {
              pending.reject(new Error(rpcMsg.error));
            } else {
              pending.resolve(rpcMsg.result);
            }
          }
        }
        break;
      }

      case "ws:event": {
        const eventMsg = msg as { type: "ws:event"; event: string; payload: unknown };
        const listeners = this.eventListeners.get(eventMsg.event);
        if (listeners) {
          for (const listener of listeners) {
            try {
              listener(this.selfId, eventMsg.payload);
            } catch (error) {
              console.error("[MobileTransport] Event listener error:", error);
            }
          }
        }
        break;
      }

      // Stream/tool messages not needed for mobile shell (no panel hosting yet)
      default:
        break;
    }
  }

  private emitRecovery(kind: RecoveryKind): void {
    const listeners = this.recoveryListeners.get(kind);
    if (!listeners) return;
    for (const listener of listeners) {
      try {
        void listener();
      } catch {
        // Recovery failures are handled by coordinators when present.
      }
    }
    if (kind === "resubscribe") {
      for (const listener of this.reconnectListeners) {
        try { listener(); } catch { /* ignore */ }
      }
    }
  }

  private scheduleReconnect(): void {
    this.clearReconnectTimer();
    if (this.intentionalClose) return;
    const generation = this.connectionGeneration;
    const jitter = Math.random() * 500;
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempt) + jitter, 30_000);
    this.reconnectAttempt++;
    this.setStatus("connecting");
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.intentionalClose || generation !== this.connectionGeneration) return;
      this.openWebSocket();
    }, delay);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private teardownWs(): void {
    this.connectionGeneration++;
    if (this.ws) {
      // Prevent reconnect from old socket's close handler
      this.ws.onopen = null;
      this.ws.onmessage = null;
      this.ws.onclose = null;
      this.ws.onerror = null;
      if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
        this.ws.close(1000, "Client closing");
      }
      this.ws = null;
    }
    this.authenticated = false;
  }

  private rejectAllPending(reason: string): void {
    for (const [, pending] of this.pendingCalls) {
      pending.reject(new Error(reason));
    }
    this.pendingCalls.clear();
  }

  private setStatus(status: ConnectionStatus): void {
    if (this._status === status) return;
    this._status = status;
    for (const listener of this.statusListeners) {
      try {
        listener(status);
      } catch (error) {
        console.error("[MobileTransport] Status listener error:", error);
      }
    }
  }
}

// === Helpers ===

/**
 * Convert an HTTP(S) server URL to a WebSocket URL with /rpc path.
 * e.g. "https://example.com" -> "wss://example.com/rpc"
 *      "http://192.168.1.5:3000" -> "ws://192.168.1.5:3000/rpc"
 */
function buildWsUrl(serverUrl: string): string {
  // Manual parsing instead of `new URL()` — Hermes doesn't fully implement URL API
  const match = serverUrl.match(/^(https?):\/\/(.+?)(?:\/|$)/);
  if (!match) throw new Error(`Invalid server URL: ${serverUrl}`);
  const protocol = match[1] === "https" ? "wss:" : "ws:";
  return `${protocol}//${match[2]}/rpc`;
}

/**
 * Generate a simple unique ID for RPC requests.
 * Uses crypto.randomUUID() if available (iOS 15.4+, Android varies),
 * falls back to timestamp + random.
 */
function generateId(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  // Fallback for older RN environments
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
