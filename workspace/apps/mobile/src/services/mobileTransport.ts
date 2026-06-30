/**
 * Mobile RPC client for React Native — WebRTC transport.
 *
 * After the native bootstrap pairs over WebRTC and reloads onto this workspace
 * app, the JS pipe is gone but the signaling room + the server answerer persist.
 * This client re-pairs to the SAME room with the stored shell credential
 * (`@natstack/mobile-webrtc` `reconnectViaWebRtc`) and drives ALL RPC over that
 * `WebRtcSession`. There is no WebSocket transport on mobile anymore — the
 * server is only reachable through the pinned, fail-closed DTLS pipe.
 */

import type {
  RpcCallOptions,
  RpcClient,
  RpcConnectionStatus,
  RpcEventContext,
} from "@natstack/rpc";
import type { RecoveryKind } from "@natstack/rpc/protocol/recoveryCoordinator";
import type { WebRtcSession } from "@natstack/rpc/transports/webrtcClient";
import type { PanelEntityId } from "@natstack/shared/panel/ids";
import {
  loadShellCredential,
  reconnectViaWebRtc,
  type WebRtcConnection,
} from "@natstack/mobile-webrtc";

function smokePhase(phase: string, details?: Record<string, unknown>): void {
  const suffix = details ? ` ${JSON.stringify(details)}` : "";
  console.log(`[NatStackMobileSmoke] phase=${phase}${suffix}`);
}

export type ConnectionStatus = RpcConnectionStatus;

export interface MobileRpcClientConfig {
  initialConnectionRetry?: {
    maxMs?: number;
    delayMs?: number;
    maxDelayMs?: number;
  };
}

export function createMobileRpcClient(config: MobileRpcClientConfig = {}): MobileRpcClient {
  return new MobileRpcClient(config);
}

export class MobileRpcClient
  implements Pick<RpcClient, "selfId" | "call" | "emit" | "on" | "stream" | "streamReadable">
{
  private config: MobileRpcClientConfig;
  private connection: WebRtcConnection | null = null;
  private rpc: RpcClient | null = null;
  // Dedupes concurrent connect attempts: the WebRTC handshake is eager + async,
  // so a stray call() racing connectAndWait() must not open a second pipe.
  private connecting: Promise<RpcClient> | null = null;
  private currentCallerId: string | null = null;
  private statusState: ConnectionStatus = "disconnected";
  private readonly statusListeners = new Set<(status: ConnectionStatus) => void>();
  private readonly recoveryListeners = new Map<RecoveryKind, Set<() => void | Promise<void>>>();
  private readonly eventSubscriptions = new Map<string, Set<(event: RpcEventContext) => void>>();
  private readonly activeEventUnsubs = new Map<string, () => void>();

  constructor(config: MobileRpcClientConfig) {
    this.config = config;
  }

  get selfId(): string {
    return this.currentCallerId ?? "shell:pending";
  }

  get status(): ConnectionStatus {
    return this.connection?.session.status?.() ?? this.statusState;
  }

  connect(): void {
    this.setStatus("connecting");
    void this.ensureRpc().catch((error) => {
      console.warn("[MobileRpcClient] Failed to connect WebRTC pipe:", error);
      this.setStatus("disconnected");
    });
  }

  async connectAndWait(timeoutMs?: number | null): Promise<void> {
    this.setStatus("connecting");
    try {
      await this.connectAndWaitWithRetry(timeoutMs);
    } catch (error) {
      console.warn("[MobileRpcClient] Failed to connect mobile RPC transport:", error);
      this.setStatus("disconnected");
      throw error;
    }
  }

  reconnect(): void {
    void this.teardown().finally(() => this.connect());
  }

  disconnect(): void {
    if (!this.connection && !this.connecting) {
      this.setStatus("disconnected");
      return;
    }
    void this.teardown();
  }

  onStatusChange(callback: (status: ConnectionStatus) => void): () => void {
    this.statusListeners.add(callback);
    return () => {
      this.statusListeners.delete(callback);
    };
  }

  updateConfig(config: MobileRpcClientConfig): void {
    this.config = config;
    void this.teardown();
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

  /**
   * Like {@link stream} but yields the decoded head + a raw `ReadableStream`
   * body — RN's whatwg-fetch `Response` cannot consume a ReadableStream. The
   * panel-asset façade (B2) reads panel bundles through this.
   */
  async streamReadable(
    targetId: string,
    method: string,
    args: unknown[],
    options?: { signal?: AbortSignal }
  ): ReturnType<RpcClient["streamReadable"]> {
    return (await this.ensureRpc()).streamReadable(targetId, method, args, options);
  }

  /**
   * Open a dedicated per-panel "panel" session over the existing pipe. The
   * server attributes calls by the authenticated SESSION principal, so a panel
   * needs its OWN grant-redeemed "panel" session — relaying over the shell
   * session makes its calls show up as "shell", which capability-gated services
   * (e.g. PubSub `subscribe`, allowed: panel/do) reject. This rides the SAME pipe
   * (a logical session, not a 2nd connection), so it does not trip the runtime
   * lease gate (that gates panel HOSTING, not sessions). The grant is one-shot,
   * so `getToken` refetches a fresh one on every (re)open.
   */
  async openPanelSession(runtimeEntityId: PanelEntityId, connectionId: string): Promise<WebRtcSession> {
    await this.ensureRpc();
    const connection = this.connection;
    if (!connection) throw new Error("WebRTC connection not established");
    const session = connection.transport.openSession({
      // Reuse the lease's connectionId and grant for the runtime ENTITY id (not
      // the slot id) so the server's authorizePanelConnection(callerId,
      // connectionId) matches the materializer's lease (keyed by entity id +
      // that connectionId). The grant principal becomes this session's callerId,
      // which equals the panel bundle's RPC `from` (cfg.entityId) so routed
      // responses match their recorded origin.
      connectionId,
      callerKind: "panel",
      clientPlatform: "mobile",
      getToken: async () => {
        const grant = await this.call<{ token: string }>("main", "auth.grantConnection", [
          runtimeEntityId,
        ]);
        return grant.token;
      },
    });
    await session.ready?.();
    return session;
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
    if (this.connecting) return this.connecting;
    this.connecting = this.establishConnection();
    try {
      return await this.connecting;
    } finally {
      this.connecting = null;
    }
  }

  private async establishConnection(): Promise<RpcClient> {
    const stored = await loadShellCredential();
    if (!stored) {
      throw new Error("No stored WebRTC shell credential — re-pair this device");
    }
    smokePhase("workspace-webrtc-connect-start", {
      room: stored.pairing.room,
      ice: stored.pairing.ice ?? "all",
    });
    const connection = await reconnectViaWebRtc(stored, (kind) => this.emitRecovery(kind));
    this.connection = connection;
    this.currentCallerId = connection.callerId;
    this.rpc = connection.rpc;
    // The session reports keepalive/ICE state (hardened in Part A); surface it as
    // the client's connection status so the UI + the recovery hook react to drops.
    connection.session.onStatusChange?.((status) => this.setStatus(status));
    for (const event of this.eventSubscriptions.keys()) this.attachEventSubscription(event);
    this.setStatus(connection.session.status?.() ?? "connected");
    smokePhase("workspace-webrtc-connected", { callerId: connection.callerId });
    return this.rpc;
  }

  private async connectAndWaitWithRetry(timeoutMs?: number | null): Promise<void> {
    const retry = this.config.initialConnectionRetry ?? {};
    const startedAt = Date.now();
    const maxMs =
      typeof timeoutMs === "number"
        ? timeoutMs
        : typeof retry.maxMs === "number"
          ? retry.maxMs
          : 120_000;
    const deadline = startedAt + maxMs;
    const baseDelayMs =
      typeof retry.delayMs === "number" && retry.delayMs >= 0 ? retry.delayMs : 750;
    const maxDelayMs =
      typeof retry.maxDelayMs === "number" && retry.maxDelayMs >= 0 ? retry.maxDelayMs : 5_000;
    let attempt = 0;
    let lastError: unknown = null;

    while (Date.now() < deadline) {
      attempt += 1;
      this.setStatus("connecting");
      try {
        await this.ensureRpc();
        if (attempt > 1) {
          smokePhase("workspace-webrtc-retry-connected", { attempt });
        }
        return;
      } catch (error) {
        lastError = error;
        await this.teardown();
        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0) break;
        const delayMs = Math.min(
          baseDelayMs * 2 ** Math.max(0, attempt - 1),
          maxDelayMs,
          remainingMs
        );
        smokePhase("workspace-webrtc-retry", {
          attempt,
          delayMs,
          message: errorMessage(error),
        });
        console.warn(
          `[MobileRpcClient] Initial WebRTC connection failed; retrying in ${delayMs}ms`,
          error
        );
        await sleep(delayMs);
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new Error(`WebRTC connection timeout (${maxMs}ms) — re-pair this device`);
  }

  private async teardown(): Promise<void> {
    const connection = this.connection;
    this.connection = null;
    this.rpc = null;
    this.currentCallerId = null;
    this.activeEventUnsubs.clear();
    await connection?.close().catch(() => undefined);
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

  /**
   * Fire the recovery listeners for `kind`. Driven by the WebRtcSession's
   * post-auth onRecovery signal (wired into reconnectViaWebRtc): "resubscribe" on
   * a normal reconnect, "cold-recover" when the server restarted (serverBootId
   * changed) / the session was dirty — so ShellClient's cold-recover listener
   * actually fires instead of only ever running the lighter resubscribe.
   */
  private emitRecovery(kind: RecoveryKind): void {
    for (const listener of this.recoveryListeners.get(kind) ?? []) void listener();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
