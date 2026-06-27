/**
 * PageHost — per-lease panel pages inside headless Chromium.
 *
 * Each panel gets:
 *  - a browser context per contextId (storage isolation matching Electron's
 *    per-context partitions),
 *  - a management session (init injection, navigation, AX tree, console
 *    capture — domains enabled only here),
 *  - a separate relay session, lazily attached on the first bridge command
 *    and detached on cdp:detach, so automation clients get fresh CDP domain
 *    state per attach, mirroring Electron's webContents.debugger lifecycle.
 */
import { createDevLogger } from "@natstack/dev-log";
import { CdpConnection } from "./browser/cdpConnection.js";
import {
  ConsoleHistoryStore,
  levelFromConsoleType,
  type ConsoleHistoryEntry,
} from "./consoleHistory.js";

const log = createDevLogger("HeadlessHost:pages");

interface PanelPage {
  slotId: string;
  contextId: string;
  targetId: string;
  mgmtSessionId: string;
  relaySessionId: string | null;
  panelUrl: string;
  lastUsedAt: number;
}

export interface LoadPanelInput {
  slotId: string;
  contextId: string;
  panelUrl: string;
  /** Full bootstrap payload incl. connectionId; injected pre-navigation. */
  panelInit: unknown;
  tabId: number;
}

export class PageHost {
  private readonly pages = new Map<string, PanelPage>();
  private readonly contextsById = new Map<string, string>(); // contextId → browserContextId
  private readonly relayEventListeners = new Set<
    (slotId: string, method: string, params: unknown, sessionId?: string) => void
  >();

  constructor(
    private readonly cdp: CdpConnection,
    private readonly consoleHistory: ConsoleHistoryStore
  ) {
    cdp.onEvent((event) => this.routeEvent(event));
  }

  slots(): string[] {
    return [...this.pages.keys()];
  }

  lastUsedAt(slotId: string): number | undefined {
    return this.pages.get(slotId)?.lastUsedAt;
  }

  touch(slotId: string): void {
    const page = this.pages.get(slotId);
    if (page) page.lastUsedAt = Date.now();
  }

  onRelayEvent(
    listener: (slotId: string, method: string, params: unknown, sessionId?: string) => void
  ): () => void {
    this.relayEventListeners.add(listener);
    return () => this.relayEventListeners.delete(listener);
  }

  private async ensureBrowserContext(contextId: string): Promise<string> {
    const existing = this.contextsById.get(contextId);
    if (existing) return existing;
    const result = (await this.cdp.send("Target.createBrowserContext", {
      disposeOnDetach: false,
    })) as { browserContextId: string };
    this.contextsById.set(contextId, result.browserContextId);
    return result.browserContextId;
  }

  async loadPanel(input: LoadPanelInput): Promise<void> {
    await this.unloadPanel(input.slotId).catch(() => undefined);
    const browserContextId = await this.ensureBrowserContext(input.contextId);
    const created = (await this.cdp.send("Target.createTarget", {
      url: "about:blank",
      browserContextId,
    })) as { targetId: string };
    const attached = (await this.cdp.send("Target.attachToTarget", {
      targetId: created.targetId,
      flatten: true,
    })) as { sessionId: string };
    const mgmtSessionId = attached.sessionId;
    this.cdp.claimSession(mgmtSessionId, `__mgmt:${input.slotId}`);

    const page: PanelPage = {
      slotId: input.slotId,
      contextId: input.contextId,
      targetId: created.targetId,
      mgmtSessionId,
      relaySessionId: null,
      panelUrl: input.panelUrl,
      lastUsedAt: Date.now(),
    };
    this.pages.set(input.slotId, page);

    const initScript = `globalThis.__natstackPanelInit = ${JSON.stringify(input.panelInit)}; globalThis.__natstackHostPlatform = "headless";`;
    await this.cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: initScript }, mgmtSessionId);
    await Promise.allSettled([
      this.cdp.send("Page.enable", undefined, mgmtSessionId),
      this.cdp.send("Runtime.enable", undefined, mgmtSessionId),
      this.cdp.send("Log.enable", undefined, mgmtSessionId),
    ]);
    const nav = (await this.cdp.send("Page.navigate", { url: input.panelUrl }, mgmtSessionId)) as {
      errorText?: string;
    };
    if (nav.errorText && nav.errorText !== "net::ERR_ABORTED") {
      this.consoleHistory.recordLifecycle(input.slotId, `did-fail-load: ${nav.errorText}`, {
        url: input.panelUrl,
      });
      throw new Error(`panel navigation failed: ${nav.errorText}`);
    }
    log.info(`loaded panel ${input.slotId} (${input.panelUrl})`);
  }

  async reloadPanel(slotId: string, panelUrl: string, panelInit: unknown): Promise<void> {
    const page = this.requirePage(slotId);
    page.panelUrl = panelUrl;
    const initScript = `globalThis.__natstackPanelInit = ${JSON.stringify(panelInit)}; globalThis.__natstackHostPlatform = "headless";`;
    await this.cdp.send(
      "Page.addScriptToEvaluateOnNewDocument",
      { source: initScript },
      page.mgmtSessionId
    );
    const nav = (await this.cdp.send("Page.navigate", { url: panelUrl }, page.mgmtSessionId)) as {
      errorText?: string;
    };
    if (nav.errorText && nav.errorText !== "net::ERR_ABORTED") {
      throw new Error(`panel reload failed: ${nav.errorText}`);
    }
  }

  async unloadPanel(slotId: string): Promise<void> {
    const page = this.pages.get(slotId);
    if (!page) return;
    this.pages.delete(slotId);
    this.cdp.releaseSession(page.mgmtSessionId);
    this.cdp.releaseSlotSessions(slotId);
    this.consoleHistory.clear(slotId);
    await this.cdp.send("Target.closeTarget", { targetId: page.targetId }).catch(() => undefined);
    log.info(`unloaded panel ${slotId}`);
  }

  async navigate(
    slotId: string,
    action: "navigate" | "reload" | "goBack" | "goForward" | "stop",
    url?: string
  ): Promise<void> {
    const page = this.requirePage(slotId);
    page.lastUsedAt = Date.now();
    const session = page.mgmtSessionId;
    switch (action) {
      case "navigate": {
        if (!url) throw new Error("navigate requires a url");
        const nav = (await this.cdp.send("Page.navigate", { url }, session)) as {
          errorText?: string;
        };
        if (nav.errorText && nav.errorText !== "net::ERR_ABORTED") {
          throw new Error(`navigate failed: ${nav.errorText}`);
        }
        return;
      }
      case "reload":
        await this.cdp.send("Page.reload", undefined, session);
        return;
      case "goBack":
      case "goForward": {
        const history = (await this.cdp.send("Page.getNavigationHistory", undefined, session)) as {
          currentIndex: number;
          entries: Array<{ id: number }>;
        };
        const targetIndex = history.currentIndex + (action === "goBack" ? -1 : 1);
        const entry = history.entries[targetIndex];
        if (!entry) return; // nothing to navigate to — match Electron's no-op
        await this.cdp.send("Page.navigateToHistoryEntry", { entryId: entry.id }, session);
        return;
      }
      case "stop":
        await this.cdp.send("Page.stopLoading", undefined, session);
        return;
    }
  }

  async accessibilityTree(slotId: string): Promise<unknown[]> {
    const page = this.requirePage(slotId);
    await this.cdp.send("Accessibility.enable", undefined, page.mgmtSessionId).catch(() => undefined);
    try {
      const result = (await this.cdp.send(
        "Accessibility.getFullAXTree",
        undefined,
        page.mgmtSessionId
      )) as { nodes?: unknown[] };
      return result.nodes ?? [];
    } finally {
      await this.cdp.send("Accessibility.disable", undefined, page.mgmtSessionId).catch(() => undefined);
    }
  }

  /** Relay a bridge cdp:command into the page's relay session tree. */
  async relaySend(
    slotId: string,
    method: string,
    params: Record<string, unknown> | undefined,
    sessionId?: string
  ): Promise<unknown> {
    const page = this.requirePage(slotId);
    page.lastUsedAt = Date.now();
    if (sessionId) {
      // Explicit session routing (nested sessions the client attached).
      return this.cdp.send(method, params, sessionId);
    }
    const relaySessionId = await this.ensureRelaySession(page);
    return this.cdp.send(method, params, relaySessionId);
  }

  /** cdp:detach — drop the relay session so the next client starts fresh. */
  async detachRelay(slotId: string): Promise<void> {
    const page = this.pages.get(slotId);
    if (!page?.relaySessionId) return;
    const sessionId = page.relaySessionId;
    page.relaySessionId = null;
    this.cdp.releaseSession(sessionId);
    await this.cdp.send("Target.detachFromTarget", { sessionId }).catch(() => undefined);
  }

  private async ensureRelaySession(page: PanelPage): Promise<string> {
    if (page.relaySessionId) return page.relaySessionId;
    const attached = (await this.cdp.send("Target.attachToTarget", {
      targetId: page.targetId,
      flatten: true,
    })) as { sessionId: string };
    page.relaySessionId = attached.sessionId;
    this.cdp.claimSession(attached.sessionId, page.slotId);
    return attached.sessionId;
  }

  private requirePage(slotId: string): PanelPage {
    const page = this.pages.get(slotId);
    if (!page) throw new Error(`no page hosted for panel ${slotId}`);
    return page;
  }

  private routeEvent(event: { method: string; params: unknown; sessionId?: string }): void {
    const owner = this.cdp.ownerOf(event.sessionId);
    if (!owner) return;

    if (owner.startsWith("__mgmt:")) {
      this.handleMgmtEvent(owner.slice("__mgmt:".length), event);
      return;
    }

    // Relay-session tree event → forward to the bridge. Events on the relay
    // root session are forwarded without a sessionId (the bridge client
    // treats the root as the default session, matching Electron); nested
    // session events keep their sessionId.
    const page = this.pages.get(owner);
    const isRoot = page?.relaySessionId === event.sessionId;
    for (const listener of this.relayEventListeners) {
      listener(owner, event.method, event.params, isRoot ? undefined : event.sessionId);
    }
  }

  private handleMgmtEvent(
    slotId: string,
    event: { method: string; params: unknown; sessionId?: string }
  ): void {
    switch (event.method) {
      case "Runtime.consoleAPICalled": {
        const params = event.params as {
          type?: string;
          args?: Array<{ value?: unknown; description?: string }>;
          stackTrace?: { callFrames?: Array<{ url?: string; lineNumber?: number }> };
          timestamp?: number;
        };
        const message = (params.args ?? [])
          .map((arg) =>
            Object.prototype.hasOwnProperty.call(arg, "value")
              ? String(arg.value)
              : (arg.description ?? "")
          )
          .join(" ");
        const frame = params.stackTrace?.callFrames?.[0];
        const entry: ConsoleHistoryEntry = {
          timestamp: params.timestamp ?? Date.now(),
          level: levelFromConsoleType(params.type ?? "log"),
          message,
          line: frame?.lineNumber ?? 0,
          sourceId: frame?.url ?? "",
          url: frame?.url ?? "",
          source: "console",
        };
        this.consoleHistory.record(slotId, entry);
        return;
      }
      case "Runtime.exceptionThrown": {
        const params = event.params as {
          exceptionDetails?: { text?: string; exception?: { description?: string }; url?: string; lineNumber?: number };
          timestamp?: number;
        };
        const details = params.exceptionDetails;
        this.consoleHistory.record(slotId, {
          timestamp: params.timestamp ?? Date.now(),
          level: "error",
          message: details?.exception?.description ?? details?.text ?? "Uncaught exception",
          line: details?.lineNumber ?? 0,
          sourceId: details?.url ?? "",
          url: details?.url ?? "",
          source: "console",
        });
        return;
      }
      case "Inspector.targetCrashed":
        this.consoleHistory.recordLifecycle(slotId, "render-process-gone: target crashed");
        return;
      default:
        return;
    }
  }
}
