import { WebSocket, type WebSocketServer } from "ws";
import type { IncomingMessage } from "http";
import type { Duplex } from "stream";
import { createDevLogger } from "@natstack/dev-log";

const log = createDevLogger("CdpService");

type Caller = NonNullable<IncomingMessage["natstackCaller"]>;

interface IpcResponse {
  error?: unknown;
}

interface OwnershipResponse extends IpcResponse {
  ownerCallerId?: string;
  allowedCallers?: string[];
}

interface CdpMessage {
  type: "cdp-message";
  browserId: string;
  method: string;
  params?: Record<string, unknown>;
  sessionId?: string;
}

interface CommandResponse extends IpcResponse {
  result?: unknown;
}

export class CdpService {
  private readonly activeConnections = new Map<string, Set<WebSocket>>();

  constructor(
    private readonly deps: {
      requestMain: <T = unknown>(
        type: string,
        payload?: Record<string, unknown>,
        timeoutMs?: number
      ) => Promise<T | null>;
    }
  ) {}

  async upgradeWebSocket(
    caller: Caller,
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    wss: WebSocketServer,
    browserId: string
  ): Promise<void> {
    const allowed = await this.canAccessBrowser(caller, browserId);
    if (!allowed) {
      socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      this.handleConnection(ws, browserId);
    });
  }

  handleMainMessage(message: CdpMessage): void {
    if (message.type !== "cdp-message") return;
    const connections = this.activeConnections.get(message.browserId);
    if (!connections) return;

    const payload = JSON.stringify({
      method: message.method,
      params: message.params ?? {},
      ...(message.sessionId ? { sessionId: message.sessionId } : {}),
    });
    for (const ws of connections) {
      if (ws.readyState === WebSocket.OPEN) ws.send(payload);
    }
  }

  private async canAccessBrowser(caller: Caller, browserId: string): Promise<boolean> {
    const ownership = await this.deps.requestMain<OwnershipResponse>(
      "cdp-ownership-request",
      { browserId },
      5_000
    );
    if (!ownership || ownership.error || typeof ownership.ownerCallerId !== "string") {
      return false;
    }

    const allowedCallers = Array.isArray(ownership.allowedCallers)
      ? ownership.allowedCallers.filter((value): value is string => typeof value === "string")
      : [];

    if (allowedCallers.includes(caller.callerId)) return true;

    if (caller.callerKind === "worker") return false;

    return (
      ownership.ownerCallerId === caller.callerId ||
      ownership.ownerCallerId.startsWith(`${caller.callerId}/`)
    );
  }

  private handleConnection(ws: WebSocket, browserId: string): void {
    let connections = this.activeConnections.get(browserId);
    if (!connections) {
      connections = new Set();
      this.activeConnections.set(browserId, connections);
    }
    connections.add(ws);

    void this.attach(browserId, ws);

    ws.on("message", (data) => {
      void this.handleClientMessage(ws, browserId, data);
    });

    ws.on("close", () => {
      const active = this.activeConnections.get(browserId);
      if (!active) return;
      active.delete(ws);
      if (active.size === 0) {
        this.activeConnections.delete(browserId);
        void this.deps.requestMain<IpcResponse>("cdp-detach-request", { browserId }, 5_000);
      }
    });

    ws.on("error", (err) => {
      log.warn(`CDP websocket error for ${browserId}: ${err.message}`);
    });
  }

  private async attach(browserId: string, ws: WebSocket): Promise<void> {
    const response = await this.deps.requestMain<IpcResponse>(
      "cdp-attach-request",
      { browserId },
      10_000
    );
    if (!response || response.error) {
      ws.close(4004, String(response?.error ?? "Browser webContents not found"));
    }
  }

  private async handleClientMessage(
    ws: WebSocket,
    browserId: string,
    data: WebSocket.RawData
  ): Promise<void> {
    let msgId: number | undefined;
    let sessionId: string | undefined;
    try {
      const msg = JSON.parse(data.toString()) as {
        id?: number;
        method?: string;
        params?: Record<string, unknown>;
        sessionId?: string;
      };
      msgId = msg.id;
      sessionId = msg.sessionId;

      if (typeof msg.id !== "number" || typeof msg.method !== "string") {
        throw new Error("Invalid CDP command");
      }

      const response = await this.deps.requestMain<CommandResponse>(
        "cdp-command-request",
        {
          browserId,
          method: msg.method,
          params: msg.params,
          sessionId: msg.sessionId,
        },
        60_000
      );
      if (!response) throw new Error("CDP command timed out");
      if (response.error) throw new Error(String(response.error));

      ws.send(
        JSON.stringify({
          id: msg.id,
          result: response.result,
          ...(sessionId ? { sessionId } : {}),
        })
      );
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      if (msgId !== undefined) {
        ws.send(
          JSON.stringify({
            id: msgId,
            error: { message: errorMessage },
            ...(sessionId ? { sessionId } : {}),
          })
        );
      } else {
        log.warn(`Invalid CDP message for ${browserId}: ${errorMessage}`);
      }
    }
  }
}
