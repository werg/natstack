import { webContents } from "electron";
import { createDevLogger } from "@natstack/dev-log";
import type { ViewManager } from "./viewManager.js";

const log = createDevLogger("CdpServer");

export interface CdpEndpoint {
  wsEndpoint: string;
}

export interface CdpOwnership {
  ownerCallerId: string;
  allowedCallers: string[];
}

export interface CdpDebuggerMessage {
  type: "cdp-message";
  browserId: string;
  method: string;
  params: Record<string, unknown>;
  sessionId?: string;
}

export class CdpServer {
  private readonly getCdpWebSocketBaseUrl: () => string;
  private readonly sendIpcMessage?: (message: CdpDebuggerMessage) => void;

  // browserId -> webContentsId
  private browserRegistry = new Map<string, number>();
  // panelId -> Set<browserId> (which browser children this panel owns)
  private panelBrowsers = new Map<string, Set<string>>();
  // browserId -> debugger attached flag
  private debuggerAttached = new Map<string, boolean>();
  // browserId -> debugger attach in progress (prevents race condition)
  private debuggerAttaching = new Map<string, Promise<void>>();
  private debuggerMessageHandlers = new Map<
    string,
    (
      event: Electron.Event,
      method: string,
      params: Record<string, unknown>,
      sessionId?: string
    ) => void
  >();

  private viewManager: ViewManager | null = null;

  constructor(options: {
    getCdpWebSocketBaseUrl: () => string;
    sendIpcMessage?: (message: CdpDebuggerMessage) => void;
  }) {
    this.getCdpWebSocketBaseUrl = options.getCdpWebSocketBaseUrl;
    this.sendIpcMessage = options.sendIpcMessage;
  }

  setViewManager(viewManager: ViewManager): void {
    this.viewManager = viewManager;
  }

  registerBrowser(browserId: string, webContentsId: number, parentPanelId: string): void {
    const existingWebContentsId = this.browserRegistry.get(browserId);
    if (existingWebContentsId === webContentsId) return;

    if (existingWebContentsId !== undefined) {
      log.verbose(
        `Browser ${browserId} webContents changed: ${existingWebContentsId} -> ${webContentsId}`
      );
    } else {
      log.verbose(
        `Registered browser ${browserId} (webContents ${webContentsId}) for parent ${parentPanelId}`
      );
    }

    this.browserRegistry.set(browserId, webContentsId);

    if (!this.panelBrowsers.has(parentPanelId)) {
      this.panelBrowsers.set(parentPanelId, new Set());
    }
    this.panelBrowsers.get(parentPanelId)!.add(browserId);
  }

  unregisterBrowser(browserId: string): void {
    this.browserRegistry.delete(browserId);

    for (const [panelId, browsers] of this.panelBrowsers) {
      if (!browsers.has(browserId)) continue;
      browsers.delete(browserId);
      if (browsers.size === 0) this.panelBrowsers.delete(panelId);
      break;
    }

    void this.detach(browserId);
    log.verbose(`Unregistered browser ${browserId}`);
  }

  revokeAccessForPanel(panelId: string): void {
    this.panelBrowsers.delete(panelId);
  }

  getBrowserOwnership(browserId: string): CdpOwnership | null {
    for (const [ownerCallerId, browsers] of this.panelBrowsers) {
      if (browsers.has(browserId)) {
        return { ownerCallerId, allowedCallers: [ownerCallerId] };
      }
    }
    return null;
  }

  private canAccessBrowser(panelId: string, browserId: string): boolean {
    const ownership = this.getBrowserOwnership(browserId);
    if (!ownership) return false;
    return (
      ownership.ownerCallerId === panelId ||
      ownership.ownerCallerId.startsWith(`${panelId}/`) ||
      ownership.allowedCallers.includes(panelId)
    );
  }

  getCdpEndpoint(browserId: string, requestingPanelId: string): CdpEndpoint | null {
    if (!this.canAccessBrowser(requestingPanelId, browserId)) return null;
    return {
      wsEndpoint: `${this.getCdpWebSocketBaseUrl()}/cdp/${encodeURIComponent(browserId)}`,
    };
  }

  getBrowserWebContents(browserId: string): Electron.WebContents | null {
    if (this.viewManager) return this.viewManager.getWebContents(browserId);
    const webContentsId = this.browserRegistry.get(browserId);
    return webContentsId ? (webContents.fromId(webContentsId) ?? null) : null;
  }

  panelOwnsBrowser(panelId: string, browserId: string): boolean {
    return this.panelBrowsers.get(panelId)?.has(browserId) ?? false;
  }

  async attach(browserId: string): Promise<void> {
    const contents = this.getBrowserWebContents(browserId);
    if (!contents || contents.isDestroyed()) {
      throw new Error(`Browser webContents not found for ${browserId}`);
    }

    await this.ensureDebuggerAttached(browserId, contents);
  }

  async detach(browserId: string): Promise<void> {
    const contents = this.getBrowserWebContents(browserId);
    const handler = this.debuggerMessageHandlers.get(browserId);
    if (contents && handler) {
      try {
        contents.debugger.off("message", handler);
      } catch {
        // Already detached/destroyed.
      }
    }
    this.debuggerMessageHandlers.delete(browserId);

    if (contents && this.debuggerAttached.get(browserId)) {
      try {
        contents.debugger.detach();
      } catch {
        // Already detached.
      }
    }
    this.debuggerAttached.delete(browserId);
    this.debuggerAttaching.delete(browserId);
  }

  async sendCommand(args: {
    browserId: string;
    method: string;
    params?: Record<string, unknown>;
    sessionId?: string;
  }): Promise<unknown> {
    const contents = this.getBrowserWebContents(args.browserId);
    if (!contents || contents.isDestroyed()) {
      throw new Error(`Browser webContents not found for ${args.browserId}`);
    }
    await this.ensureDebuggerAttached(args.browserId, contents);

    if (args.method === "Page.captureScreenshot") {
      const capture = () =>
        contents.debugger.sendCommand(args.method, args.params, args.sessionId);
      if (this.viewManager) {
        return (await this.viewManager.withViewVisible(args.browserId, capture)) ?? capture();
      }
      return capture();
    }

    return contents.debugger.sendCommand(args.method, args.params, args.sessionId);
  }

  async stop(): Promise<void> {
    for (const browserId of Array.from(this.debuggerAttached.keys())) {
      await this.detach(browserId);
    }
  }

  private async ensureDebuggerAttached(
    browserId: string,
    contents: Electron.WebContents
  ): Promise<void> {
    if (this.debuggerAttached.get(browserId)) return;

    const existingPromise = this.debuggerAttaching.get(browserId);
    if (existingPromise) {
      await existingPromise;
      return;
    }

    const attachPromise = (async () => {
      try {
        contents.debugger.attach("1.3");
      } catch {
        // Already attached by another debugger client.
      }

      const handler = (
        _event: Electron.Event,
        method: string,
        params: Record<string, unknown>,
        sessionId?: string
      ) => {
        this.sendIpcMessage?.({
          type: "cdp-message",
          browserId,
          method,
          params,
          ...(sessionId ? { sessionId } : {}),
        });
      };

      const oldHandler = this.debuggerMessageHandlers.get(browserId);
      if (oldHandler) {
        try {
          contents.debugger.off("message", oldHandler);
        } catch {
          // Already detached/destroyed.
        }
      }
      contents.debugger.on("message", handler);
      this.debuggerMessageHandlers.set(browserId, handler);
      this.debuggerAttached.set(browserId, true);
      this.debuggerAttaching.delete(browserId);
    })();

    this.debuggerAttaching.set(browserId, attachPromise);
    await attachPromise;
  }
}
