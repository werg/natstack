/**
 * IPC Dispatcher — replaces Electron-side RpcServer for shell communication.
 *
 * Listens on ipcMain for RPC messages from the shell renderer. Electron-local
 * services dispatch in-process; everything else forwards to the server.
 */

import { ipcMain, type WebContents } from "electron";
import { ELECTRON_LOCAL_SERVICE_NAMES } from "@natstack/rpc";
import {
  createVerifiedCaller,
  type ServiceDispatcher,
  type VerifiedCodeIdentity,
} from "@natstack/shared/serviceDispatcher";
import type { RpcMessage, RpcRequest, RpcResponse } from "@natstack/rpc";
import type { ServerClient } from "./serverClient.js";
import type { EventService, Subscriber } from "@natstack/shared/eventsService";
import type { CallerKind } from "@natstack/shared/serviceDispatcher";
import type { WebSocket } from "ws";
import { assertPresent } from "../lintHelpers";

/** Electron-main services that are not owned by the NatStack server process. */
const ELECTRON_LOCAL_SERVICES: ReadonlySet<string> = new Set(ELECTRON_LOCAL_SERVICE_NAMES);

export interface IpcDispatcherDeps {
  /** Electron-local service dispatcher */
  dispatcher: ServiceDispatcher;
  /** Server client for forwarding server-service calls */
  serverClient: ServerClient;
  getShellWebContents: () => WebContents | null;
  resolveCallerForWebContents: (
    webContentsId: number
  ) => { callerId: string; callerKind: "shell" | "panel" | "app" } | null;
  getCodeIdentityForCaller?: (callerId: string) => VerifiedCodeIdentity | null;
  getWebContentsForCaller: (callerId: string) => WebContents | null;
  authorizeAppServerCall?: (
    callerId: string,
    service: string,
    method: string,
    args: readonly unknown[]
  ) => void;
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

  constructor(
    private getWebContents: () => WebContents | null,
    readonly callerKind: CallerKind
  ) {}

  get isAlive(): boolean {
    const wc = this.getWebContents();
    return !this.destroyed && !!wc && !wc.isDestroyed();
  }

  send(channel: string, payload: unknown): void {
    if (!this.isAlive) return;
    const wc = assertPresent(this.getWebContents());
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
  private readonly appMessageBridges = new Map<string, () => void>();
  private readonly appEventSubscribers = new Map<string, IpcSubscriber>();

  constructor(deps: IpcDispatcherDeps) {
    this.deps = deps;

    // Register an IPC-backed subscriber for the shell so EventService can push
    // events to it without requiring a WebSocket connection.
    const shellSubscriber = new IpcSubscriber(deps.getShellWebContents, "shell");
    deps.eventService.registerSubscriber("shell", shellSubscriber);

    ipcMain.on("natstack:rpc:send", (event, targetId: string, message: unknown) => {
      const caller = this.deps.resolveCallerForWebContents(event.sender.id);
      if (!caller || (caller.callerKind !== "shell" && caller.callerKind !== "app")) {
        console.warn(
          `[IpcDispatcher] Rejecting natstack:rpc:send from unauthorized sender ` +
            `(webContentsId=${event.sender.id})`
        );
        return;
      }
      if (caller.callerKind === "app") {
        this.ensureAppMessageBridge(caller.callerId);
        this.ensureAppEventSubscriber(caller.callerId);
      }
      this.handleMessage(
        event.sender,
        caller.callerId,
        caller.callerKind,
        targetId,
        message as RpcMessage
      );
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
    message: RpcMessage
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
        if (ELECTRON_LOCAL_SERVICES.has(service)) {
          // Dispatch locally to Electron services. The dispatcher itself
          // enforces policy via checkServiceAccess (single choke-point).
          const ctx = {
            caller: createVerifiedCaller(
              callerId,
              callerKind,
              this.deps.getCodeIdentityForCaller?.(callerId) ?? null
            ),
          };
          result = await this.deps.dispatcher.dispatch(ctx, service, method, req.args);
        } else {
          // Server is the default owner so newly registered userland/workerd
          // services are reachable without a shared routing-list update.
          if (callerKind === "shell") {
            result = await this.deps.serverClient.call(service, method, req.args);
          } else if (callerKind === "app") {
            this.deps.authorizeAppServerCall?.(callerId, service, method, req.args);
            result = await this.deps.serverClient.callAs(
              { callerId, callerKind },
              service,
              method,
              req.args
            );
          } else {
            throw new Error(`Server RPC relay is not available for ${callerKind} callers`);
          }
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

  private sendResponse(sender: WebContents, _requestId: string, response: RpcResponse): void {
    if (!sender.isDestroyed()) {
      sender.send("natstack:rpc:message", "main", response);
    }
  }

  private ensureAppMessageBridge(callerId: string): void {
    if (this.appMessageBridges.has(callerId)) return;
    const unsubscribe = this.deps.serverClient.addMessageListener(
      { callerId, callerKind: "app" },
      (fromId, message) => {
        const wc = this.deps.getWebContentsForCaller(callerId);
        if (!wc || wc.isDestroyed()) return;
        wc.send("natstack:rpc:message", fromId, message);
      }
    );
    this.appMessageBridges.set(callerId, unsubscribe);
  }

  private ensureAppEventSubscriber(callerId: string): void {
    const existing = this.appEventSubscribers.get(callerId);
    if (existing?.isAlive) return;
    existing?.destroy();
    const subscriber = new IpcSubscriber(() => this.deps.getWebContentsForCaller(callerId), "app");
    subscriber.onDestroyed(() => this.appEventSubscribers.delete(callerId));
    this.appEventSubscribers.set(callerId, subscriber);
    this.deps.eventService.registerSubscriber(callerId, subscriber);
  }
}
