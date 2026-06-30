/**
 * IPC Dispatcher — replaces Electron-side RpcServer for shell communication.
 *
 * Listens on ipcMain for RPC messages from the shell renderer. Electron-local
 * services dispatch in-process; everything else forwards to the server.
 */

import { ipcMain, type WebContents } from "electron";
import {
  ELECTRON_LOCAL_SERVICE_NAMES,
  responseEnvelopeFor,
  type RpcCallOptions,
  type RpcEnvelope,
  type RpcMessage,
  type RpcRequest,
  type RpcResponse,
} from "@natstack/rpc";
import {
  createVerifiedCaller,
  type ServiceDispatcher,
  type VerifiedCodeIdentity,
} from "@natstack/shared/serviceDispatcher";
import type { PanelSession, ServerClient } from "./serverClient.js";
import type { EventService, Subscriber } from "@natstack/shared/eventsService";
import type { CallerKind } from "@natstack/shared/serviceDispatcher";
import type { WebSocket } from "ws";
import { assertPresent } from "../lintHelpers";

/** Electron-main services that are not owned by the NatStack server process. */
const ELECTRON_LOCAL_SERVICES: ReadonlySet<string> = new Set(ELECTRON_LOCAL_SERVICE_NAMES);

const MAIN_CALLER = { callerId: "main", callerKind: "server" as const };

function envelopeFor(target: string, from: string, message: RpcMessage): RpcEnvelope {
  const caller = {
    callerId: from,
    callerKind: from === "main" ? ("server" as const) : ("unknown" as const),
  };
  return {
    from,
    target,
    delivery: { caller },
    provenance: [caller],
    message,
  };
}

function callOptionsFromEnvelope(envelope: RpcEnvelope): RpcCallOptions | undefined {
  const options: RpcCallOptions = {};
  if (envelope.delivery.idempotencyKey) options.idempotencyKey = envelope.delivery.idempotencyKey;
  if (envelope.delivery.readOnly === true) options.readOnly = true;
  return options.idempotencyKey || options.readOnly ? options : undefined;
}

function callServer(
  serverClient: ServerClient,
  service: string,
  method: string,
  args: unknown[],
  options: RpcCallOptions | undefined
): Promise<unknown> {
  return options
    ? serverClient.call(service, method, args, options)
    : serverClient.call(service, method, args);
}

function callServerAs(
  serverClient: ServerClient,
  caller: { callerId: string; callerKind: CallerKind },
  service: string,
  method: string,
  args: unknown[],
  options: RpcCallOptions | undefined
): Promise<unknown> {
  return options
    ? serverClient.callAs(caller, service, method, args, options)
    : serverClient.callAs(caller, service, method, args);
}

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
  /**
   * Runtime entity id + lease connectionId for a panel, used to open its
   * per-panel relay session. Undefined until the panel's runtime lease exists.
   */
  getPanelRuntimeConnection?: (
    panelId: string
  ) => { runtimeEntityId: string; connectionId: string } | undefined;
  authorizeAppServerCall?: (
    callerId: string,
    service: string,
    method: string,
    args: readonly unknown[]
  ) => void;
  onServerRpcResult?: (event: {
    callerId: string;
    callerKind: CallerKind;
    service: string;
    method: string;
    args: readonly unknown[];
    result: unknown;
  }) => Promise<void> | void;
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
    private readonly callerId: string,
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
    wc.send(
      "natstack:rpc:message",
      envelopeFor(this.callerId, "main", {
        type: "event",
        fromId: "main",
        event: channel,
        payload,
      })
    );
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
  /** One relay session per panel principal (callerId = panel view id). */
  private readonly panelSessions = new Map<string, Promise<PanelSession>>();
  /** webContents ids with a destroy teardown attached (so we attach it once). */
  private readonly panelDestroyHooked = new Set<number>();

  constructor(deps: IpcDispatcherDeps) {
    this.deps = deps;

    // Register an IPC-backed subscriber for the shell so EventService can push
    // events to it without requiring a WebSocket connection.
    const shellSubscriber = new IpcSubscriber(deps.getShellWebContents, "shell", "shell");
    deps.eventService.registerSubscriber("shell", shellSubscriber);

    ipcMain.on("natstack:rpc:send", (event, envelope: RpcEnvelope) => {
      const caller = this.deps.resolveCallerForWebContents(event.sender.id);
      if (!caller) {
        console.warn(
          `[IpcDispatcher] Rejecting natstack:rpc:send from unresolved sender ` +
            `(webContentsId=${event.sender.id})`
        );
        return;
      }
      if (caller.callerKind === "panel") {
        // A panel's FULL RPC surface (requests, routed DO calls, events, streams)
        // rides a dedicated panel-principal session — handleEnvelope's request→main
        // path is shell/app only. Desktop analogue of the mobile bridge relay.
        this.relayPanelEnvelope(event.sender, caller.callerId, envelope);
        return;
      }
      if (caller.callerKind !== "shell" && caller.callerKind !== "app") {
        console.warn(
          `[IpcDispatcher] Rejecting natstack:rpc:send from unauthorized sender ` +
            `(webContentsId=${event.sender.id}, kind=${caller.callerKind})`
        );
        return;
      }
      if (caller.callerKind === "app") {
        this.ensureAppMessageBridge(caller.callerId);
        this.ensureAppEventSubscriber(caller.callerId);
      }
      this.handleEnvelope(event.sender, caller.callerId, caller.callerKind, envelope);
    });
  }

  /**
   * Send an event to the shell renderer.
   */
  sendToShell(fromId: string, message: RpcMessage): void {
    const wc = this.deps.getShellWebContents();
    if (wc && !wc.isDestroyed()) {
      wc.send("natstack:rpc:message", envelopeFor("shell", fromId, message));
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

  private async handleEnvelope(
    sender: WebContents,
    callerId: string,
    callerKind: CallerKind,
    envelope: RpcEnvelope
  ): Promise<void> {
    const message = envelope.message;
    const targetId = envelope.target;
    if (message.type === "request" && targetId === "main") {
      const req = message as RpcRequest;
      const callOptions = callOptionsFromEnvelope(envelope);
      const dotIndex = req.method.indexOf(".");
      if (dotIndex === -1) {
        this.sendResponse(sender, envelope, {
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
            requestId: req.requestId,
            ...(callOptions?.idempotencyKey ? { idempotencyKey: callOptions.idempotencyKey } : {}),
            ...(callOptions?.readOnly ? { readOnly: true } : {}),
          };
          result = await this.deps.dispatcher.dispatch(ctx, service, method, req.args);
        } else {
          // Server is the default owner so newly registered userland/workerd
          // services are reachable without a shared routing-list update.
          if (callerKind === "shell") {
            // electron-main / bootstrap launch gate are native-host `shell`
            // principals — they reach the server on the admin connection. The
            // workspace shell renderer is an `app` (apps/shell) and takes the
            // app branch below; there is no longer a shell→app panelTree proxy.
            result = await callServer(
              this.deps.serverClient,
              service,
              method,
              req.args,
              callOptions
            );
          } else if (callerKind === "app") {
            this.deps.authorizeAppServerCall?.(callerId, service, method, req.args);
            result = await callServerAs(
              this.deps.serverClient,
              { callerId, callerKind },
              service,
              method,
              req.args,
              callOptions
            );
          } else {
            throw new Error(`Server RPC relay is not available for ${callerKind} callers`);
          }
        }
        await this.deps.onServerRpcResult?.({
          callerId,
          callerKind,
          service,
          method,
          args: req.args,
          result,
        });
        this.sendResponse(sender, envelope, {
          type: "response",
          requestId: req.requestId,
          result,
        });
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        const errorCode = (err as { code?: string })?.code;
        this.sendResponse(sender, envelope, {
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
    requestEnvelope: RpcEnvelope,
    response: RpcResponse
  ): void {
    if (!sender.isDestroyed()) {
      sender.send(
        "natstack:rpc:message",
        responseEnvelopeFor(requestEnvelope, MAIN_CALLER, response)
      );
    }
  }

  /**
   * Relay one envelope from a panel webview onto its dedicated panel-principal
   * session — requests, routed DO calls, events, and streams all ride it.
   * server→panel messages return via the session's onMessage (see
   * {@link ensurePanelSession}). A relay failure surfaces as an error response so
   * the panel's pending request rejects rather than hanging.
   */
  private relayPanelEnvelope(sender: WebContents, callerId: string, envelope: RpcEnvelope): void {
    void this.ensurePanelSession(sender, callerId)
      .then((session) => session.send(envelope))
      .catch((err: unknown) => {
        const message = envelope.message;
        if (message?.type === "request") {
          this.sendResponse(sender, envelope, {
            type: "response",
            requestId: (message as RpcRequest).requestId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
        console.warn(
          `[IpcDispatcher] panel relay failed for ${callerId}: ` +
            `${err instanceof Error ? err.message : String(err)}`
        );
      });
  }

  /**
   * Open (or reuse) the relay session for a panel principal, redeeming its runtime
   * lease. A terminally-closed/disconnected session is dropped and re-opened on the
   * current lease (lease revoke / pipe drop). The session is closed when the panel
   * webview is destroyed.
   */
  private ensurePanelSession(sender: WebContents, callerId: string): Promise<PanelSession> {
    const existing = this.panelSessions.get(callerId);
    if (existing) {
      return existing.then((session) => {
        const live = !session.isClosed?.() && (session.status?.() ?? "connected") === "connected";
        if (live) return session;
        this.panelSessions.delete(callerId);
        session.close();
        return this.ensurePanelSession(sender, callerId);
      });
    }
    const conn = this.deps.getPanelRuntimeConnection?.(callerId);
    if (!conn) {
      return Promise.reject(new Error(`No runtime lease for panel ${callerId}`));
    }
    // Tear down the relay when the panel webview is destroyed — attached once per
    // webContents (not per session re-open), closing whichever session is current.
    if (!this.panelDestroyHooked.has(sender.id)) {
      this.panelDestroyHooked.add(sender.id);
      sender.once("destroyed", () => {
        this.panelDestroyHooked.delete(sender.id);
        const pending = this.panelSessions.get(callerId);
        this.panelSessions.delete(callerId);
        if (pending) void pending.then((s) => s.close()).catch(() => undefined);
      });
    }
    const opening = this.deps.serverClient
      .openPanelSession(conn.runtimeEntityId, conn.connectionId)
      .then((session) => {
        // Deliver server→panel messages (responses, events, stream frames) to the
        // panel's current webContents.
        session.onMessage((env) => {
          const wc = this.deps.getWebContentsForCaller(callerId);
          if (wc && !wc.isDestroyed()) wc.send("natstack:rpc:message", env);
        });
        return session;
      })
      .catch((err: unknown) => {
        this.panelSessions.delete(callerId);
        throw err;
      });
    this.panelSessions.set(callerId, opening);
    return opening;
  }

  private ensureAppMessageBridge(callerId: string): void {
    if (this.appMessageBridges.has(callerId)) return;
    const unsubscribe = this.deps.serverClient.addMessageListener(
      { callerId, callerKind: "app" },
      (envelope) => {
        const wc = this.deps.getWebContentsForCaller(callerId);
        if (!wc || wc.isDestroyed()) return;
        wc.send("natstack:rpc:message", envelope);
      }
    );
    this.appMessageBridges.set(callerId, unsubscribe);
  }

  private ensureAppEventSubscriber(callerId: string): void {
    const existing = this.appEventSubscribers.get(callerId);
    if (existing?.isAlive) return;
    existing?.destroy();
    const subscriber = new IpcSubscriber(
      () => this.deps.getWebContentsForCaller(callerId),
      callerId,
      "app"
    );
    subscriber.onDestroyed(() => this.appEventSubscribers.delete(callerId));
    this.appEventSubscribers.set(callerId, subscriber);
    this.deps.eventService.registerSubscriber(callerId, subscriber);
  }
}
