/**
 * Mobile RPC client for React Native.
 */

import {
  createRpcClient,
  type RpcCallOptions,
  type RpcClient,
  type RpcConnectionStatus,
  type RpcEventContext,
} from "@natstack/rpc";
import { wsClientTransport } from "@natstack/rpc/transports/wsClient";
import type { WsLike } from "@natstack/rpc/protocol/wsAdapter";
import type { RecoveryKind } from "@natstack/rpc/protocol/recoveryCoordinator";
import { isWorkspaceMobileAppCallerId, isWorkspaceMobileHostCallerId } from "./auth";

function smokePhase(phase: string, details?: Record<string, unknown>): void {
  const suffix = details ? ` ${JSON.stringify(details)}` : "";
  console.log(`[NatStackMobileSmoke] phase=${phase}${suffix}`);
}

export type ConnectionStatus = RpcConnectionStatus;

export interface MobileConnectionGrant {
  connectionGrant: string;
  callerId: string;
}

export interface MobileRpcClientConfig {
  /** Server URL, e.g. "https://natstack.example.com" or "http://192.168.1.5:3000" */
  serverUrl: string;
  /** Mint a fresh one-time app-scoped connection grant from the native host. */
  issueConnectionGrant: () => Promise<MobileConnectionGrant>;
}

export function createMobileRpcClient(config: MobileRpcClientConfig): MobileRpcClient {
  return new MobileRpcClient(config);
}

class BrowserWsLike implements WsLike {
  constructor(
    private readonly ws: WebSocket,
    private readonly url: string
  ) {}
  get readyState(): number {
    return this.ws.readyState;
  }
  get onopen(): (() => void) | null {
    return this.ws.onopen as (() => void) | null;
  }
  set onopen(handler: (() => void) | null) {
    this.ws.onopen = (() => {
      smokePhase("workspace-ws-opened", { url: this.url });
      handler?.();
    }) as WebSocket["onopen"];
  }
  get onmessage(): ((event: { data: unknown }) => void) | null {
    return this.ws.onmessage as ((event: { data: unknown }) => void) | null;
  }
  set onmessage(handler: ((event: { data: unknown }) => void) | null) {
    this.ws.onmessage = ((event: { data: unknown }) => {
      const data = typeof event.data === "string" ? event.data : "";
      if (data.includes('"type":"ws:auth-result"')) {
        try {
          const parsed = JSON.parse(data) as { success?: unknown; error?: unknown };
          smokePhase("workspace-ws-auth-result", {
            success: parsed.success === true,
            ...(typeof parsed.error === "string" ? { error: parsed.error } : {}),
          });
        } catch {
          smokePhase("workspace-ws-auth-result", { parseError: true });
        }
      }
      handler?.(event);
    }) as unknown as WebSocket["onmessage"];
  }
  get onclose(): ((event: { code?: number; reason?: string }) => void) | null {
    return this.ws.onclose as ((event: { code?: number; reason?: string }) => void) | null;
  }
  set onclose(handler: ((event: { code?: number; reason?: string }) => void) | null) {
    this.ws.onclose = ((event: { code?: number; reason?: string }) => {
      smokePhase("workspace-ws-close", {
        code: event.code ?? null,
        reason: event.reason ?? "",
      });
      handler?.(event);
    }) as unknown as WebSocket["onclose"];
  }
  get onerror(): ((event: unknown) => void) | null {
    return this.ws.onerror as ((event: unknown) => void) | null;
  }
  set onerror(handler: ((event: unknown) => void) | null) {
    this.ws.onerror = ((event: unknown) => {
      smokePhase("workspace-ws-error", describeWebSocketEvent(event));
      handler?.(event);
    }) as unknown as WebSocket["onerror"];
  }
  send(data: string): void {
    this.ws.send(data);
  }
  close(code?: number, reason?: string): void {
    this.ws.close(code, reason);
  }
}

function describeWebSocketEvent(event: unknown): Record<string, unknown> {
  if (event instanceof Error) return { message: event.message };
  if (!event || typeof event !== "object") return { type: typeof event };
  const maybe = event as { message?: unknown; type?: unknown; code?: unknown; reason?: unknown };
  return {
    ...(typeof maybe.type === "string" ? { type: maybe.type } : {}),
    ...(typeof maybe.message === "string" ? { message: maybe.message } : {}),
    ...(typeof maybe.code === "number" ? { code: maybe.code } : {}),
    ...(typeof maybe.reason === "string" ? { reason: maybe.reason } : {}),
  };
}

type MobileWsTransport = ReturnType<typeof wsClientTransport>;

export class MobileRpcClient implements Pick<RpcClient, "selfId" | "call" | "emit" | "on" | "stream"> {
  private config: MobileRpcClientConfig;
  private transport: MobileWsTransport | null = null;
  private rpc: RpcClient | null = null;
  private currentCallerId: string | null = null;
  private preissuedGrant: string | null = null;
  private statusState: ConnectionStatus = "disconnected";
  private readonly statusListeners = new Set<(status: ConnectionStatus) => void>();
  private readonly recoveryListeners = new Map<RecoveryKind, Set<() => void | Promise<void>>>();
  private readonly eventSubscriptions = new Map<
    string,
    Set<(event: RpcEventContext) => void>
  >();
  private readonly activeEventUnsubs = new Map<string, () => void>();

  constructor(config: MobileRpcClientConfig) {
    this.config = config;
  }

  get selfId(): string {
    return this.currentCallerId ?? "app:mobile:pending";
  }

  get status(): ConnectionStatus {
    return this.transport?.status?.() ?? this.statusState;
  }

  connect(): void {
    this.setStatus("connecting");
    void this.ensureRpc()
      .then(() => this.transport?.connect())
      .catch((error) => {
        console.warn("[MobileRpcClient] Failed to initialize mobile host principal:", error);
        this.setStatus("disconnected");
      });
  }

  async connectAndWait(timeoutMs?: number | null): Promise<void> {
    this.setStatus("connecting");
    try {
      await this.ensureRpc();
    } catch (error) {
      console.warn("[MobileRpcClient] Failed to initialize mobile host principal:", error);
      this.setStatus("disconnected");
      throw error;
    }
    await this.transport?.connectAndWait(timeoutMs);
  }

  reconnect(): void {
    void this.transport?.close().finally(() => {
      this.transport = null;
      this.rpc = null;
      this.connect();
    });
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

  updateConfig(config: MobileRpcClientConfig): void {
    this.config = config;
    void this.transport?.close();
    this.transport = null;
    this.rpc = null;
    this.currentCallerId = null;
    this.preissuedGrant = null;
    this.activeEventUnsubs.clear();
    this.setStatus("disconnected");
  }

  async call<T = unknown>(
    targetId: string,
    method: string,
    args: unknown[],
    options?: RpcCallOptions
  ): Promise<T> {
    return (await this.ensureRpc()).call<T>(targetId, method, args, options);
  }

  async stream(
    targetId: string,
    method: string,
    args: unknown[],
    options?: { signal?: AbortSignal }
  ): Promise<Response> {
    return (await this.ensureRpc()).stream(targetId, method, args, options);
  }

  async emit(targetId: string, event: string, payload: unknown): Promise<void> {
    return (await this.ensureRpc()).emit(targetId, event, payload);
  }

  on(event: string, listener: (event: RpcEventContext) => void): () => void {
    let listeners = this.eventSubscriptions.get(event);
    if (!listeners) {
      listeners = new Set();
      this.eventSubscriptions.set(event, listeners);
    }
    listeners.add(listener);
    this.attachEventSubscription(event);
    return () => {
      listeners?.delete(listener);
      if (listeners?.size === 0) {
        this.eventSubscriptions.delete(event);
        this.activeEventUnsubs.get(event)?.();
        this.activeEventUnsubs.delete(event);
      }
    };
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

  private async ensureRpc(): Promise<RpcClient> {
    if (this.rpc) return this.rpc;
    const grant = await this.issueNativeGrant();
    this.currentCallerId = grant.callerId;
    this.preissuedGrant = grant.connectionGrant;
    this.transport = this.createTransport(grant.callerId);
    this.rpc = createRpcClient({
      selfId: grant.callerId,
      callerKind: isWorkspaceMobileAppCallerId(grant.callerId) ? "app" : "shell-remote",
      transport: this.transport,
    });
    for (const event of this.eventSubscriptions.keys()) this.attachEventSubscription(event);
    return this.rpc;
  }

  private async issueNativeGrant(): Promise<MobileConnectionGrant> {
    const grant = await this.config.issueConnectionGrant();
    if (
      typeof grant.connectionGrant !== "string" ||
      !grant.connectionGrant ||
      typeof grant.callerId !== "string" ||
      !isWorkspaceMobileHostCallerId(grant.callerId)
    ) {
      throw new Error("Native host returned an invalid mobile host connection grant");
    }
    if (this.currentCallerId && grant.callerId !== this.currentCallerId) {
      throw new Error("Native host returned a different mobile host principal for this connection");
    }
    smokePhase("workspace-grant-issued", { callerId: grant.callerId });
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

  private createTransport(callerId: string): MobileWsTransport {
    const wsUrl = buildWsUrl(this.config.serverUrl);
    smokePhase("workspace-ws-url", { url: wsUrl });
    const transport = wsClientTransport({
      selfId: callerId,
      getWsUrl: () => wsUrl,
      terminalCloseCodes: [4001, 4005, 4006],
      logPrefix: "MobileRpcClient",
      onRecovery: (kind) => {
        for (const listener of this.recoveryListeners.get(kind) ?? []) {
          void listener();
        }
      },
      adapter: {
        now: () => Date.now(),
        getAuthToken: () => this.nextGrantToken(),
        refreshAuthToken: () => this.nextGrantToken(),
        createSocket: (url) => {
          smokePhase("workspace-ws-create", { url });
          return new BrowserWsLike(new WebSocket(url), url);
        },
      },
    });
    transport.onStatusChange?.((status) => this.setStatus(status));
    return transport;
  }

  private attachEventSubscription(event: string): void {
    if (!this.rpc || this.activeEventUnsubs.has(event)) return;
    const unsubscribe = this.rpc.on(event, (ev) => {
      for (const listener of this.eventSubscriptions.get(event) ?? []) listener(ev);
    });
    this.activeEventUnsubs.set(event, unsubscribe);
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
