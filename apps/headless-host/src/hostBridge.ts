/**
 * CdpHostBridgeClient — the host side of the server's CDP bridge protocol
 * (src/server/cdpBridge.ts), a port of Electron's CdpHostProvider transport
 * (src/main/cdpHostProvider.ts) without the webContents specifics.
 *
 * Connects to ws(s)://server[/_workspace/name]/api/cdp-host?hostConnectionId=..., authenticates
 * with {"type":"natstack:cdp-auth", token}, re-registers all targets on every
 * auth-ok (reconnects), and dispatches server commands to injected handlers.
 */
import { WebSocket } from "ws";
import { createDevLogger } from "@natstack/dev-log";
import { serverCdpHostWsUrl } from "@natstack/shared/connect";

const log = createDevLogger("HeadlessHost:bridge");

const RECONNECT_DELAY_MS = 1_000;

export interface HostBridgeHandlers {
  cdpCommand(
    targetId: string,
    method: string,
    params: Record<string, unknown> | undefined,
    sessionId?: string
  ): Promise<unknown>;
  navCommand(targetId: string, action: string, url?: string): Promise<void>;
  hostCommand(targetId: string, action: string, args: unknown[]): Promise<unknown>;
  detach(targetId: string): Promise<void>;
  /** Server rejected our registration for this target (lease moved etc.). */
  registerRejected(targetId: string, reason: string): void;
}

interface BridgeMessage {
  type?: string;
  requestId?: string;
  targetId?: string;
  method?: string;
  params?: Record<string, unknown>;
  sessionId?: string;
  action?: string;
  args?: unknown[];
  url?: string;
  reason?: string;
}

export class CdpHostBridgeClient {
  private ws: WebSocket | null = null;
  private stopped = false;
  private authenticated = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly targets = new Map<string, number>(); // targetId(slotId) → tabId

  constructor(
    private readonly opts: {
      serverUrl: string;
      hostConnectionId: string;
      getToken: () => string | Promise<string>;
      handlers: HostBridgeHandlers;
      onAuthenticated?: () => void;
    }
  ) {}

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.ws?.close(1000, "host shutting down");
    this.ws = null;
    this.authenticated = false;
  }

  isConnected(): boolean {
    return this.authenticated && this.ws?.readyState === WebSocket.OPEN;
  }

  registerTarget(targetId: string, tabId: number): void {
    this.targets.set(targetId, tabId);
    this.send({ type: "cdp:register", targetId, tabId });
  }

  unregisterTarget(targetId: string): void {
    this.targets.delete(targetId);
    this.send({ type: "cdp:unregister", targetId });
  }

  sendEvent(targetId: string, method: string, params: unknown, sessionId?: string): void {
    this.send({ type: "cdp:event", targetId, method, params, ...(sessionId ? { sessionId } : {}) });
  }

  private wsUrl(): string {
    return serverCdpHostWsUrl(this.opts.serverUrl, this.opts.hostConnectionId);
  }

  private connect(): void {
    if (this.stopped) return;
    const ws = new WebSocket(this.wsUrl(), { maxPayload: 256 * 1024 * 1024 });
    this.ws = ws;
    this.authenticated = false;

    ws.on("open", () => {
      void (async () => {
        try {
          const token = await this.opts.getToken();
          ws.send(JSON.stringify({ type: "natstack:cdp-auth", token }));
        } catch (error) {
          log.warn(`failed to get bridge token: ${String(error)}`);
          ws.close();
        }
      })();
    });
    ws.on("message", (data) => {
      void this.handleMessage(String(data));
    });
    ws.on("close", () => {
      this.authenticated = false;
      if (this.ws === ws) this.ws = null;
      this.scheduleReconnect();
    });
    ws.on("error", (error) => {
      log.warn(`bridge socket error: ${String(error)}`);
    });
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, RECONNECT_DELAY_MS);
  }

  private send(message: Record<string, unknown>): void {
    if (!this.isConnected()) return;
    this.ws?.send(JSON.stringify(message));
  }

  private async handleMessage(raw: string): Promise<void> {
    let message: BridgeMessage;
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }
    switch (message.type) {
      case "natstack:cdp-auth-ok": {
        this.authenticated = true;
        // Re-register every hosted target (initial connect and reconnects).
        for (const [targetId, tabId] of this.targets) {
          this.send({ type: "cdp:register", targetId, tabId });
        }
        this.opts.onAuthenticated?.();
        return;
      }
      case "cdp:command": {
        const { requestId, targetId, method, params, sessionId } = message;
        if (!requestId || !targetId || !method) return;
        try {
          const result = await this.opts.handlers.cdpCommand(targetId, method, params, sessionId);
          this.send({ type: "cdp:result", requestId, targetId, result });
        } catch (error) {
          this.send({
            type: "cdp:error",
            requestId,
            targetId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        return;
      }
      case "cdp:detach": {
        if (message.targetId) await this.opts.handlers.detach(message.targetId).catch(() => undefined);
        return;
      }
      case "cdp:register-rejected": {
        if (message.targetId) {
          log.warn(`register rejected for ${message.targetId}: ${message.reason ?? "unknown"}`);
          this.targets.delete(message.targetId);
          this.opts.handlers.registerRejected(message.targetId, message.reason ?? "unknown");
        }
        return;
      }
      case "nav:command": {
        const { requestId, targetId, action, url } = message;
        if (!requestId || !targetId || !action) return;
        try {
          await this.opts.handlers.navCommand(targetId, action, url);
          this.send({ type: "nav:result", requestId, targetId });
        } catch (error) {
          this.send({
            type: "nav:error",
            requestId,
            targetId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        return;
      }
      case "host:command": {
        const { requestId, targetId, action, args } = message;
        if (!requestId || !targetId || !action) return;
        try {
          const result = await this.opts.handlers.hostCommand(targetId, action, args ?? []);
          this.send({ type: "host:result", requestId, targetId, result });
        } catch (error) {
          this.send({
            type: "host:error",
            requestId,
            targetId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        return;
      }
      default:
        return;
    }
  }
}
