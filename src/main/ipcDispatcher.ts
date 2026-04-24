/**
 * IPC Dispatcher — replaces Electron-side RpcServer for shell communication.
 *
 * Listens on ipcMain for RPC messages from the shell renderer, dispatches
 * to the Electron ServiceDispatcher for Electron-local services, and forwards
 * server-service calls to the server via serverClient.
 */

import { ipcMain, type WebContents } from "electron";
import { SERVER_SERVICE_NAMES } from "@natstack/rpc";
import type { ServiceDispatcher } from "@natstack/shared/serviceDispatcher";
import type { RpcMessage, RpcRequest, RpcResponse } from "@natstack/rpc";
import type { ServerClient } from "./serverClient.js";
import type { EventService, Subscriber } from "@natstack/shared/eventsService";
import type { CallerKind } from "@natstack/shared/serviceDispatcher";
import type { WebSocket } from "ws";

/** Server services that should be forwarded to the server process */
const SERVER_SERVICES: ReadonlySet<string> = new Set(SERVER_SERVICE_NAMES);

export interface IpcDispatcherDeps {
  /** Electron-local service dispatcher */
  dispatcher: ServiceDispatcher;
  /** Server client for forwarding server-service calls */
  serverClient: ServerClient;
  getShellWebContents: () => WebContents | null;
  /** EventService for registering IPC-backed shell subscriber */
  eventService: EventService;
}

/**
 * IPC-backed subscriber for shell event delivery.
 * Implements the Subscriber interface used by EventService, delivering
 * events via webContents.send instead of WebSocket.
 */
class IpcSubscriber implements Subscriber {
  private destroyed = false;
  private destroyHandlers: (() => void)[] = [];
  callerKind: CallerKind = "shell";

  constructor(private getWebContents: () => WebContents | null) {}

  get isAlive(): boolean {
    const wc = this.getWebContents();
    return !this.destroyed && !!wc && !wc.isDestroyed();
  }

  send(channel: string, payload: unknown): void {
    if (!this.isAlive) return;
    const wc = this.getWebContents()!;
    // Deliver as an RPC event message that the shell transport understands
    wc.send("natstack:rpc:message", "main", {
      type: "event",
      fromId: "main",
      event: channel,
      payload,
    });
  }

  isBoundTo(_ws: WebSocket): boolean {
    // IPC subscriber is never bound to a WebSocket
    return false;
  }

  onDestroyed(handler: () => void): void {
    this.destroyHandlers.push(handler);
  }

  destroy(): void {
    this.destroyed = true;
    for (const handler of this.destroyHandlers) handler();
  }
}

export class IpcDispatcher {
  private deps: IpcDispatcherDeps;

  constructor(deps: IpcDispatcherDeps) {
    this.deps = deps;

    // Register an IPC-backed subscriber for the shell so EventService can push
    // events to it without requiring a WebSocket connection.
    const shellSubscriber = new IpcSubscriber(deps.getShellWebContents);
    deps.eventService.registerSubscriber("shell", shellSubscriber);

    ipcMain.on("natstack:rpc:send", (event, targetId: string, message: unknown) => {
      // Derive callerKind from the IPC sender's webContents id (audit #19).
      // Only the shell webContents may speak this generic relay channel
      // ("shell" callerKind). Every other webContents (panels, browser
      // panels, autofill overlay, devtools) is rejected outright.
      const shellWc = this.deps.getShellWebContents();
      const isShell = !!shellWc && !shellWc.isDestroyed() && shellWc.id === event.sender.id;
      if (!isShell) {
        console.warn(
          `[IpcDispatcher] Rejecting natstack:rpc:send from non-shell sender ` +
          `(webContentsId=${event.sender.id})`,
        );
        return;
      }
      this.handleMessage(event.sender, "shell", "shell", targetId, message as RpcMessage);
    });
  }

  /**
   * Send an event to the shell renderer.
   */
  sendToShell(fromId: string, message: RpcMessage): void {
    const wc = this.deps.getShellWebContents();
    if (wc && !wc.isDestroyed()) {
      wc.send("natstack:rpc:message", fromId, message);
    }
  }

  /**
   * Broadcast a server event to the shell (e.g., build:complete).
   */
  broadcastEvent(event: string, payload: unknown): void {
    this.sendToShell("main", {
      type: "event",
      fromId: "main",
      event,
      payload,
    });
  }

  private async handleMessage(
    sender: WebContents,
    callerId: string,
    callerKind: CallerKind,
    targetId: string,
    message: RpcMessage,
  ): Promise<void> {
    if (message.type === "request" && targetId === "main") {
      const req = message as RpcRequest;
      const dotIndex = req.method.indexOf(".");
      if (dotIndex === -1) {
        this.sendResponse(sender, req.requestId, {
          type: "response",
          requestId: req.requestId,
          error: `Invalid method format: ${req.method}`,
        });
        return;
      }
      const service = req.method.slice(0, dotIndex);
      const method = req.method.slice(dotIndex + 1);

      try {
        let result: unknown;
        // Forward server-owned services to the server process.
        const forwardToServer = SERVER_SERVICES.has(service);
        if (forwardToServer) {
          // Forward to server process via serverClient
          result = await this.deps.serverClient.call(service, method, req.args);
        } else {
          // Dispatch locally to Electron services. The dispatcher itself
          // enforces policy via checkServiceAccess (single choke-point).
          const ctx = { callerId, callerKind };
          result = await this.deps.dispatcher.dispatch(ctx, service, method, req.args);
        }
        this.sendResponse(sender, req.requestId, {
          type: "response",
          requestId: req.requestId,
          result,
        });
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        const errorCode = (err as { code?: string })?.code;
        this.sendResponse(sender, req.requestId, {
          type: "response",
          requestId: req.requestId,
          error,
          ...(errorCode ? { errorCode } : {}),
        });
      }
    }
  }

  private sendResponse(
    sender: WebContents,
    _requestId: string,
    response: RpcResponse,
  ): void {
    if (!sender.isDestroyed()) {
      sender.send("natstack:rpc:message", "main", response);
    }
  }
}
