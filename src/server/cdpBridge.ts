/**
 * CdpBridge — Server-side relay between Playwright CDP clients and the
 * active host provider's Electron webContents.debugger API.
 *
 * Architecture:
 *   Runtime (Playwright) → Server CDP WebSocket → Host provider → webContents.debugger → Panel
 *
 * Two WebSocket paths:
 * - `/api/cdp-host` — Electron host provider connection
 * - `/cdp/{targetId}` — per-panel Playwright client connections
 *
 * Both paths authenticate with a first WebSocket message:
 * `{ "type": "natstack:cdp-auth", "token": "..." }`.
 *
 * The client ↔ server protocol is standard CDP, so Playwright connects
 * identically regardless of backend.
 */

import { WebSocket, type WebSocketServer } from "ws";
import type { IncomingMessage } from "http";
import type { Duplex } from "stream";
import { constantTimeStringEqual } from "@natstack/shared/tokenManager";
import { CdpGrantService } from "@natstack/shared/cdpGrants";
import type { PanelRuntimeLeaseChangedEvent } from "@natstack/shared/panel/panelLease";
import { createDevLogger } from "@natstack/dev-log";
import { assertPresent } from "../lintHelpers";

const log = createDevLogger("CdpBridge");

const NAV_COMMAND_TIMEOUT_MS = 30_000;
const MODEL_AWARE_HOST_COMMANDS = new Set(["navigatePanel", "navigatePanelHistory", "reloadPanel"]);

interface CdpBridgeOptions {
  adminToken: string;
  cdpGrants?: CdpGrantService;
  authenticateHostProvider?: (token: string, hostConnectionId: string) => boolean;
  canRegisterHostProvider?: (hostConnectionId: string) => boolean;
  resolveHostForTarget?: (targetId: string) => string | null;
  getTargetInfo?: (targetId: string) => CdpTargetInfo | null | Promise<CdpTargetInfo | null>;
  /** Check if a targetId corresponds to a known panel in the registry. */
  isPanelKnown?: (targetId: string) => boolean | Promise<boolean>;
  protocol?: "http" | "https";
  externalHost?: string;
  port: number;
}

export interface CdpEndpoint {
  wsEndpoint: string;
  token: string;
}

interface PendingCommand {
  ws: WebSocket;
  clientId: number;
  targetId: string;
  sessionId?: string;
}

interface PendingNavCommand {
  resolve: (value?: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  targetId: string;
  providerHostConnectionId?: string;
  resilientToTargetClose?: boolean;
}

interface ProviderBridgeMessage {
  type?: string;
  targetId?: string;
  tabId?: number;
  reason?: string;
  requestId?: string;
  action?: string;
  args?: unknown[];
  result?: unknown;
  error?: string;
  method?: string;
  params?: unknown;
  sessionId?: string;
}

interface RegisteredTarget {
  tabId: number;
  hostConnectionId?: string;
  kind?: string;
  source?: string;
}

interface CdpTargetInfo {
  kind?: string;
  source?: string;
}

function isModelAwareHostCommand(action: string): boolean {
  return MODEL_AWARE_HOST_COMMANDS.has(action);
}

export class CdpBridge {
  private adminToken: string;
  private cdpGrants: CdpGrantService;
  private authenticateHostProvider: (token: string, hostConnectionId: string) => boolean;
  private canRegisterHostProvider: (hostConnectionId: string) => boolean;
  private resolveHostForTarget?: (targetId: string) => string | null;
  private getTargetInfo?: (
    targetId: string
  ) => CdpTargetInfo | null | Promise<CdpTargetInfo | null>;
  private isPanelKnown: (targetId: string) => boolean | Promise<boolean>;
  private protocol: "http" | "https";
  private externalHost: string;
  private port: number;

  /** Host provider WebSocket connections: stable hostConnectionId → provider WS */
  private providers = new Map<string, WebSocket>();

  /** Registered targets from providers: targetId → provider metadata */
  private targetRegistry = new Map<string, RegisteredTarget>();

  /** Active client connections: targetId → Set<WebSocket> */
  private clientConnections = new Map<string, Set<WebSocket>>();

  /** Pending CDP commands: requestId → pending info */
  private pendingCommands = new Map<string, PendingCommand>();

  /** Pending navigation commands: requestId → {resolve, reject, timer} */
  private pendingNavCommands = new Map<string, PendingNavCommand>();

  /** Counter for unique bridge request IDs (shared across CDP and nav) */
  private nextRequestId = 1;

  constructor(options: CdpBridgeOptions) {
    this.adminToken = options.adminToken;
    this.cdpGrants = options.cdpGrants ?? new CdpGrantService();
    this.authenticateHostProvider =
      options.authenticateHostProvider ??
      ((token) => constantTimeStringEqual(token, this.adminToken));
    this.canRegisterHostProvider = options.canRegisterHostProvider ?? (() => true);
    this.resolveHostForTarget = options.resolveHostForTarget;
    this.getTargetInfo = options.getTargetInfo;
    this.isPanelKnown = options.isPanelKnown ?? (() => true);
    this.protocol = options.protocol ?? "http";
    this.externalHost = options.externalHost ?? "127.0.0.1";
    this.port = options.port;
  }

  // =========================================================================
  // Public API
  // =========================================================================

  private authenticateConnection(
    ws: WebSocket,
    validate: (token: string) => boolean
  ): Promise<boolean> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        cleanup();
        ws.close(4001, "CDP auth required");
        resolve(false);
      }, 5_000);
      const cleanup = () => {
        clearTimeout(timer);
        ws.off("message", handleMessage);
        ws.off("close", handleClose);
        ws.off("error", handleClose);
      };
      const handleClose = () => {
        cleanup();
        resolve(false);
      };
      const handleMessage = (data: Buffer) => {
        let parsed: { type?: unknown; token?: unknown };
        try {
          parsed = JSON.parse(data.toString()) as { type?: unknown; token?: unknown };
        } catch {
          cleanup();
          ws.close(4001, "Invalid CDP auth frame");
          resolve(false);
          return;
        }
        if (
          parsed.type !== "natstack:cdp-auth" ||
          typeof parsed.token !== "string" ||
          !validate(parsed.token)
        ) {
          cleanup();
          ws.close(4001, "Invalid CDP token");
          resolve(false);
          return;
        }
        cleanup();
        resolve(true);
      };
      ws.once("message", handleMessage);
      ws.once("close", handleClose);
      ws.once("error", handleClose);
    });
  }

  /**
   * Route WebSocket upgrade requests by URL path.
   */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, wss: WebSocketServer): void {
    const url = new URL(req.url ?? "/", `http://localhost`);
    const pathname = url.pathname;

    if (pathname === "/api/cdp-host") {
      const hostConnectionId = url.searchParams.get("hostConnectionId") ?? "";
      if (!hostConnectionId || !this.canRegisterHostProvider(hostConnectionId)) {
        socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        void this.authenticateConnection(ws, (token) =>
          this.authenticateHostProvider(token, hostConnectionId)
        ).then((ok) => {
          if (!ok) return;
          this.handleProviderConnection(hostConnectionId, ws);
          ws.send(JSON.stringify({ type: "natstack:cdp-auth-ok" }));
        });
      });
    } else if (pathname.startsWith("/cdp/")) {
      const targetId = pathname.slice("/cdp/".length);

      if (!this.targetRegistry.has(targetId)) {
        socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
        socket.destroy();
        return;
      }

      wss.handleUpgrade(req, socket, head, (ws) => {
        void this.authenticateConnection(ws, (token) => {
          const grant = this.cdpGrants.redeem(token, targetId);
          return Boolean(grant);
        }).then((ok) => {
          if (!ok) return;
          if (!this.providerForTarget(targetId)) {
            ws.close(1011, "CDP provider not connected");
            return;
          }
          this.handleClientConnection(ws, targetId);
          ws.send(JSON.stringify({ type: "natstack:cdp-auth-ok" }));
        });
      });
    } else {
      socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
      socket.destroy();
    }
  }

  /**
   * Mint a single-use CDP handshake token for a registered target. Access has
   * already been approved by the panelCdp service before this is called.
   */
  getCdpEndpoint(targetId: string, requesterId: string): CdpEndpoint | null {
    if (!this.targetRegistry.has(targetId)) {
      return null;
    }
    if (!this.providerForTarget(targetId)) {
      return null;
    }

    const { token } = this.cdpGrants.grant(requesterId, targetId);
    const wsProtocol = this.protocol === "https" ? "wss" : "ws";
    return {
      wsEndpoint: `${wsProtocol}://${this.externalHost}:${this.port}/cdp/${targetId}`,
      token,
    };
  }

  /**
   * Send an approved navigation command to the target's active host provider.
   */
  async sendTargetCommand(
    targetId: string,
    _requesterId: string,
    command: string,
    args: unknown[]
  ): Promise<unknown> {
    const provider = this.providerForTarget(targetId);
    if (!provider) {
      throw new Error("CDP provider not connected");
    }

    if (!this.targetRegistry.has(targetId)) {
      throw new Error(`Target not found: ${targetId}`);
    }

    const requestId = String(this.nextRequestId++);

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingNavCommands.delete(requestId);
        reject(new Error(`Navigation command timed out: ${command}`));
      }, NAV_COMMAND_TIMEOUT_MS);

      this.pendingNavCommands.set(requestId, {
        resolve,
        reject,
        timer,
        targetId,
        providerHostConnectionId: this.targetRegistry.get(targetId)?.hostConnectionId,
      });

      const msg: Record<string, unknown> = {
        type: "nav:command",
        requestId,
        targetId,
        action: command,
      };

      // navigate takes a URL argument
      if (command === "navigate" && args.length > 0) {
        msg["url"] = args[0];
      }

      try {
        provider.send(JSON.stringify(msg));
      } catch (err) {
        clearTimeout(timer);
        this.pendingNavCommands.delete(requestId);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /**
   * Send an approved host-control command to the active provider for a target.
   * These are not CDP commands; they drive Electron-hosted operations such as
   * opening DevTools or rebuilding a panel on the host that owns the lease.
   */
  async sendHostCommand(targetId: string, action: string, args: unknown[] = []): Promise<unknown> {
    const provider = this.providerForTarget(targetId);
    if (!provider) {
      throw new Error("CDP provider not connected");
    }

    if (!this.targetRegistry.has(targetId)) {
      throw new Error(`Target not found: ${targetId}`);
    }

    const requestId = String(this.nextRequestId++);

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingNavCommands.delete(requestId);
        reject(new Error(`Host command timed out: ${action}`));
      }, NAV_COMMAND_TIMEOUT_MS);

      this.pendingNavCommands.set(requestId, {
        resolve,
        reject,
        timer,
        targetId,
        providerHostConnectionId: this.targetRegistry.get(targetId)?.hostConnectionId,
        resilientToTargetClose: isModelAwareHostCommand(action),
      });

      try {
        provider.send(
          JSON.stringify({
            type: "host:command",
            requestId,
            targetId,
            action,
            args,
          })
        );
      } catch (err) {
        clearTimeout(timer);
        this.pendingNavCommands.delete(requestId);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  isProviderConnected(hostConnectionId: string): boolean {
    return this.providers.get(hostConnectionId)?.readyState === WebSocket.OPEN;
  }

  isTargetRegistered(targetId: string): boolean {
    return this.targetRegistry.has(targetId);
  }

  isTargetRegisteredForHost(targetId: string, hostConnectionId: string): boolean {
    return this.targetRegistry.get(targetId)?.hostConnectionId === hostConnectionId;
  }

  handleRuntimeLeaseChanged(event: PanelRuntimeLeaseChangedEvent): void {
    if (!event.previous && !event.next) return;
    if (
      event.previous &&
      event.next &&
      event.previous.hostConnectionId === event.next.hostConnectionId
    ) {
      return;
    }
    if (event.previous) {
      this.detachTargetFromHost(
        event.slotId,
        event.previous.hostConnectionId,
        "CDP target host changed"
      );
    }
    this.closeTargetConnections(event.slotId, "CDP target host changed");
  }

  /**
   * Shut down the CDP bridge: close all connections, reject pending commands.
   */
  async stop(): Promise<void> {
    // Reject all pending nav commands
    for (const [requestId, pending] of this.pendingNavCommands) {
      clearTimeout(pending.timer);
      pending.reject(new Error("CDP bridge shutting down"));
      this.pendingNavCommands.delete(requestId);
    }

    // Flush pending CDP commands with errors
    for (const [requestId, pending] of this.pendingCommands) {
      this.sendErrorToClient(
        pending.ws,
        pending.clientId,
        "CDP bridge shutting down",
        pending.sessionId
      );
      this.pendingCommands.delete(requestId);
    }

    // Close all client connections
    for (const [, connections] of this.clientConnections) {
      for (const ws of connections) {
        ws.close(1000, "CDP bridge shutting down");
      }
    }
    this.clientConnections.clear();

    for (const [, provider] of this.providers) {
      provider.close(1000, "CDP bridge shutting down");
    }
    this.providers.clear();

    this.targetRegistry.clear();
    this.cdpGrants.stop();
    log.info("CdpBridge stopped");
  }

  private handleProviderConnection(hostConnectionId: string, ws: WebSocket): void {
    const existing = this.providers.get(hostConnectionId);
    if (existing && existing !== ws) {
      this.flushProvider(hostConnectionId, "CDP host provider reconnected");
      existing.close(1000, "Replaced by new CDP host provider connection");
    }

    this.providers.set(hostConnectionId, ws);
    log.info(`CDP host provider connected: ${hostConnectionId}`);

    let providerMessageQueue = Promise.resolve();
    ws.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString()) as ProviderBridgeMessage;
        providerMessageQueue = providerMessageQueue
          .then(() => this.handleProviderMessage(msg, ws, hostConnectionId))
          .catch((err: unknown) => {
            log.warn(
              `Failed to handle host provider message: ${
                err instanceof Error ? err.message : String(err)
              }`
            );
          });
      } catch (err) {
        log.warn(`Failed to parse host provider message: ${err}`);
      }
    });

    ws.on("close", () => {
      if (this.providers.get(hostConnectionId) !== ws) return;
      log.info(`CDP host provider disconnected: ${hostConnectionId}`);
      this.providers.delete(hostConnectionId);
      this.flushProvider(hostConnectionId, "CDP host provider disconnected");
      for (const [targetId, registration] of this.targetRegistry) {
        if (registration.hostConnectionId === hostConnectionId) {
          this.targetRegistry.delete(targetId);
        }
      }
    });

    ws.on("error", (err) => {
      log.info(`CDP host provider WebSocket error (${hostConnectionId}): ${err}`);
    });
  }

  private async handleProviderMessage(
    msg: ProviderBridgeMessage,
    providerWs: WebSocket,
    hostConnectionId?: string
  ): Promise<void> {
    switch (msg.type) {
      case "cdp:register": {
        if (typeof msg.targetId !== "string" || typeof msg.tabId !== "number") break;
        // Reject registrations for panels that don't exist (e.g. rolled back
        // after open-tab timeout, or stale mappings from a previous session)
        if (!(await this.isPanelKnown(msg.targetId))) {
          log.info(`Rejecting cdp:register for unknown panel: ${msg.targetId}`);
          if (providerWs.readyState === WebSocket.OPEN) {
            providerWs.send(
              JSON.stringify({
                type: "cdp:register-rejected",
                targetId: msg.targetId,
                tabId: msg.tabId,
                reason: "unknown_panel",
              })
            );
          }
          break;
        }
        if (!this.isActiveProvider(hostConnectionId, providerWs)) {
          break;
        }
        const leaseHostId = this.resolveHostForTarget?.(msg.targetId);
        if (this.resolveHostForTarget && !leaseHostId) {
          log.info(`Rejecting cdp:register for ${msg.targetId}: no active CDP-capable lease`);
          if (providerWs.readyState === WebSocket.OPEN) {
            providerWs.send(
              JSON.stringify({
                type: "cdp:register-rejected",
                targetId: msg.targetId,
                tabId: msg.tabId,
                reason: "no_cdp_capable_lease",
              })
            );
          }
          break;
        }
        if (leaseHostId && hostConnectionId && leaseHostId !== hostConnectionId) {
          log.info(
            `Rejecting cdp:register for ${msg.targetId}: host ${hostConnectionId} does not hold lease ${leaseHostId}`
          );
          if (providerWs.readyState === WebSocket.OPEN) {
            providerWs.send(
              JSON.stringify({
                type: "cdp:register-rejected",
                targetId: msg.targetId,
                tabId: msg.tabId,
                reason: "lease_mismatch",
              })
            );
          }
          break;
        }
        const targetInfo = (await this.getTargetInfo?.(msg.targetId)) ?? {};
        this.targetRegistry.set(msg.targetId, {
          tabId: msg.tabId,
          hostConnectionId,
          kind: targetInfo.kind,
          source: targetInfo.source,
        });
        log.info(
          `Target registered: ${msg.targetId} (tab ${msg.tabId}${
            hostConnectionId ? `, host ${hostConnectionId}` : ""
          })`
        );
        break;
      }

      case "cdp:unregister": {
        if (typeof msg.targetId !== "string") break;
        const registration = this.targetRegistry.get(msg.targetId);
        if (registration?.hostConnectionId !== hostConnectionId) break;
        this.targetRegistry.delete(msg.targetId);
        log.info(`Target unregistered: ${msg.targetId}`);

        // Flush pending commands for this target.
        for (const [requestId, pending] of this.pendingCommands) {
          if (pending.targetId === msg.targetId) {
            this.sendErrorToClient(
              pending.ws,
              pending.clientId,
              "CDP target closed",
              pending.sessionId
            );
            this.pendingCommands.delete(requestId);
          }
        }
        this.rejectPendingTargetCommands(msg.targetId, "CDP target closed");

        // Close client connections for this target.
        const connections = this.clientConnections.get(msg.targetId);
        if (connections) {
          for (const ws of connections) {
            ws.close(1000, "CDP target closed");
          }
          this.clientConnections.delete(msg.targetId);
        }
        break;
      }

      case "cdp:result": {
        if (typeof msg.requestId !== "string") break;
        const pending = this.pendingCommands.get(msg.requestId);
        if (pending) {
          if (!this.isMessageFromTargetProvider(pending.targetId, hostConnectionId)) break;
          const response: Record<string, unknown> = { id: pending.clientId, result: msg.result };
          if (pending.sessionId) response["sessionId"] = pending.sessionId;
          if (pending.ws.readyState === WebSocket.OPEN) {
            pending.ws.send(JSON.stringify(response));
          }
          this.pendingCommands.delete(msg.requestId);
        }
        break;
      }

      case "cdp:error": {
        if (typeof msg.requestId !== "string") break;
        const pending = this.pendingCommands.get(msg.requestId);
        if (pending) {
          if (!this.isMessageFromTargetProvider(pending.targetId, hostConnectionId)) break;
          this.sendErrorToClient(
            pending.ws,
            pending.clientId,
            msg.error ?? "CDP provider error",
            pending.sessionId
          );
          this.pendingCommands.delete(msg.requestId);
        }
        break;
      }

      case "cdp:event": {
        if (typeof msg.targetId !== "string" || typeof msg.method !== "string") break;
        if (!this.isMessageFromTargetProvider(msg.targetId, hostConnectionId)) break;
        // Broadcast CDP event to all client connections for this target.
        const connections = this.clientConnections.get(msg.targetId);
        if (connections) {
          const event: Record<string, unknown> = { method: msg.method, params: msg.params };
          if (msg.sessionId) event["sessionId"] = msg.sessionId;
          const eventStr = JSON.stringify(event);
          for (const ws of connections) {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(eventStr);
            }
          }
        }
        break;
      }

      case "nav:result": {
        if (typeof msg.requestId !== "string") break;
        const pending = this.pendingNavCommands.get(msg.requestId);
        if (pending) {
          if (!this.isMessageFromTargetProvider(pending.targetId, hostConnectionId)) break;
          clearTimeout(pending.timer);
          pending.resolve();
          this.pendingNavCommands.delete(msg.requestId);
        }
        break;
      }

      case "nav:error": {
        if (typeof msg.requestId !== "string") break;
        const pending = this.pendingNavCommands.get(msg.requestId);
        if (pending) {
          if (!this.isMessageFromTargetProvider(pending.targetId, hostConnectionId)) break;
          clearTimeout(pending.timer);
          pending.reject(new Error(msg.error ?? "Navigation failed"));
          this.pendingNavCommands.delete(msg.requestId);
        }
        break;
      }

      case "host:result": {
        if (typeof msg.requestId !== "string") break;
        const pending = this.pendingNavCommands.get(msg.requestId);
        if (pending) {
          if (!this.isPendingCommandProvider(pending, hostConnectionId)) break;
          clearTimeout(pending.timer);
          pending.resolve(msg.result);
          this.pendingNavCommands.delete(msg.requestId);
        }
        break;
      }

      case "host:error": {
        if (typeof msg.requestId !== "string") break;
        const pending = this.pendingNavCommands.get(msg.requestId);
        if (pending) {
          if (!this.isPendingCommandProvider(pending, hostConnectionId)) break;
          clearTimeout(pending.timer);
          pending.reject(new Error(msg.error ?? "Host command failed"));
          this.pendingNavCommands.delete(msg.requestId);
        }
        break;
      }
    }
  }

  // =========================================================================
  // Client connection handling
  // =========================================================================

  private handleClientConnection(ws: WebSocket, targetId: string): void {
    // Track connection
    if (!this.clientConnections.has(targetId)) {
      this.clientConnections.set(targetId, new Set());
    }
    assertPresent(this.clientConnections.get(targetId)).add(ws);

    log.info(`Client connected for target ${targetId}`);

    ws.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString()) as {
          id: number;
          method: string;
          params?: Record<string, unknown>;
          sessionId?: string;
        };

        const provider = this.providerForTarget(targetId);
        if (!provider) {
          this.sendErrorToClient(ws, msg.id, "CDP provider not connected", msg.sessionId);
          return;
        }

        if (this.rejectWorkspacePanelNavigationCdp(ws, targetId, msg)) {
          return;
        }

        const requestId = String(this.nextRequestId++);
        this.pendingCommands.set(requestId, {
          ws,
          clientId: msg.id,
          targetId,
          sessionId: msg.sessionId,
        });

        try {
          provider.send(
            JSON.stringify({
              type: "cdp:command",
              requestId,
              targetId,
              method: msg.method,
              params: msg.params,
              sessionId: msg.sessionId,
            })
          );
        } catch {
          this.pendingCommands.delete(requestId);
          this.sendErrorToClient(ws, msg.id, "Failed to send to CDP provider", msg.sessionId);
        }
      } catch (err) {
        log.warn(`Failed to parse client message: ${err}`);
      }
    });

    ws.on("close", () => {
      log.info(`Client disconnected for target ${targetId}`);

      // Remove from tracked connections
      const connections = this.clientConnections.get(targetId);
      if (connections) {
        connections.delete(ws);
        if (connections.size === 0) {
          this.clientConnections.delete(targetId);

          // Last connection closed — tell the provider to detach its debugger
          const provider = this.providerForTarget(targetId);
          if (provider) {
            provider.send(
              JSON.stringify({
                type: "cdp:detach",
                targetId,
              })
            );
          }
        }
      }

      // Clean up pending commands for this client
      for (const [requestId, pending] of this.pendingCommands) {
        if (pending.ws === ws) {
          this.pendingCommands.delete(requestId);
        }
      }
    });

    ws.on("error", (err) => {
      log.info(`Client WebSocket error for target ${targetId}: ${err}`);
    });
  }

  // =========================================================================
  // Helpers
  // =========================================================================

  private providerForTarget(targetId: string): WebSocket | null {
    const registration = this.targetRegistry.get(targetId);
    if (!registration) return null;

    if (this.resolveHostForTarget) {
      const resolvedHostId = this.resolveHostForTarget(targetId);
      if (!resolvedHostId) return null;
      if (registration.hostConnectionId !== resolvedHostId) return null;
      const provider = this.providers.get(resolvedHostId);
      return provider?.readyState === WebSocket.OPEN ? provider : null;
    }

    const registeredHostId = registration.hostConnectionId;
    if (registeredHostId) {
      const provider = this.providers.get(registeredHostId);
      return provider?.readyState === WebSocket.OPEN ? provider : null;
    }

    return null;
  }

  private isMessageFromTargetProvider(
    targetId: string,
    hostConnectionId: string | undefined
  ): boolean {
    if (!hostConnectionId) return false;
    return this.targetRegistry.get(targetId)?.hostConnectionId === hostConnectionId;
  }

  private isActiveProvider(hostConnectionId: string | undefined, providerWs: WebSocket): boolean {
    if (!hostConnectionId) return false;
    return (
      this.providers.get(hostConnectionId) === providerWs &&
      providerWs.readyState === WebSocket.OPEN
    );
  }

  private rejectWorkspacePanelNavigationCdp(
    ws: WebSocket,
    targetId: string,
    msg: {
      id: number;
      method: string;
      params?: Record<string, unknown>;
      sessionId?: string;
    }
  ): boolean {
    if (!this.isWorkspaceTarget(targetId)) return false;
    // NOTE: no frameId carve-out. CDP honors Page.navigate with a frameId for
    // the MAIN frame too, so exempting frameId requests let a panel/agent yank
    // its own top frame to an arbitrary URL (the no-state-yank rule). Workspace
    // panels navigate only via panelTree.navigate; reject all raw CDP navigation.
    const navigationMethods = new Set([
      "Page.navigate",
      "Page.reload",
      "Page.stopLoading",
      "Page.navigateToHistoryEntry",
      "Page.resetNavigationHistory",
    ]);
    if (!navigationMethods.has(msg.method)) return false;
    this.sendErrorToClient(
      ws,
      msg.id,
      "CDP navigation is only available for browser panel targets. Use panelTree.navigate only when intentionally replacing a workspace panel.",
      msg.sessionId
    );
    return true;
  }

  private isWorkspaceTarget(targetId: string): boolean {
    const target = this.targetRegistry.get(targetId);
    if (!target) return false;
    if (target.kind === "workspace") return true;
    if (target.source && !target.source.startsWith("browser:")) return true;
    return false;
  }

  private isPendingCommandProvider(
    pending: PendingNavCommand,
    hostConnectionId: string | undefined
  ): boolean {
    if (this.isMessageFromTargetProvider(pending.targetId, hostConnectionId)) return true;
    return pending.providerHostConnectionId === hostConnectionId;
  }

  private flushProvider(hostConnectionId: string, reason: string): void {
    for (const [requestId, pending] of this.pendingNavCommands) {
      if (pending.providerHostConnectionId !== hostConnectionId) continue;
      clearTimeout(pending.timer);
      pending.reject(new Error(reason));
      this.pendingNavCommands.delete(requestId);
    }

    for (const [requestId, pending] of this.pendingCommands) {
      const registration = this.targetRegistry.get(pending.targetId);
      if (registration?.hostConnectionId !== hostConnectionId) continue;
      this.sendErrorToClient(pending.ws, pending.clientId, reason, pending.sessionId);
      this.pendingCommands.delete(requestId);
    }

    for (const [targetId, registration] of this.targetRegistry) {
      if (registration.hostConnectionId !== hostConnectionId) continue;
      this.rejectPendingTargetCommands(targetId, reason);
      const connections = this.clientConnections.get(targetId);
      if (connections) {
        for (const ws of connections) ws.close(1000, reason);
        this.clientConnections.delete(targetId);
      }
    }
  }

  private closeTargetConnections(targetId: string, reason: string): void {
    for (const [requestId, pending] of this.pendingCommands) {
      if (pending.targetId !== targetId) continue;
      this.sendErrorToClient(pending.ws, pending.clientId, reason, pending.sessionId);
      this.pendingCommands.delete(requestId);
    }
    this.rejectPendingTargetCommands(targetId, reason);

    const connections = this.clientConnections.get(targetId);
    if (!connections) return;
    for (const ws of connections) ws.close(1000, reason);
    this.clientConnections.delete(targetId);
  }

  private detachTargetFromHost(targetId: string, hostConnectionId: string, reason: string): void {
    const registration = this.targetRegistry.get(targetId);
    if (registration?.hostConnectionId !== hostConnectionId) return;
    const provider = this.providers.get(hostConnectionId);
    if (provider?.readyState === WebSocket.OPEN) {
      provider.send(
        JSON.stringify({
          type: "cdp:detach",
          targetId,
          reason,
        })
      );
    }
    this.targetRegistry.delete(targetId);
  }

  private rejectPendingTargetCommands(targetId: string, reason: string): void {
    for (const [requestId, pending] of this.pendingNavCommands) {
      if (pending.targetId !== targetId) continue;
      if (pending.resilientToTargetClose && reason === "CDP target closed") continue;
      clearTimeout(pending.timer);
      pending.reject(new Error(reason));
      this.pendingNavCommands.delete(requestId);
    }
  }

  private sendErrorToClient(ws: WebSocket, id: number, message: string, sessionId?: string): void {
    if (ws.readyState !== WebSocket.OPEN) return;
    const response: Record<string, unknown> = { id, error: { message } };
    if (sessionId) response["sessionId"] = sessionId;
    ws.send(JSON.stringify(response));
  }
}
