/**
 * HeadlessHost — orchestrator. Startup order matters:
 *   rpc connect → panelRuntime.registerClient → event subscribe →
 *   browser launch → cdp-host bridge connect → snapshot reconcile.
 * (The bridge upgrade is rejected until registerClient exists server-side.)
 */
import { randomUUID } from "crypto";
import { createDevLogger } from "@natstack/dev-log";
import type {
  PanelRuntimeLeaseChangedEvent,
  RuntimeLeaseSnapshot,
} from "@natstack/shared/panel/panelLease";
import type { HeadlessHostConfig } from "./config.js";
import { connectToServer, type ServerConnection } from "./serverConnection.js";
import { PanelInitClient } from "./panelInitClient.js";
import { LeaseTracker, type LeaseIntent } from "./leaseTracker.js";
import { resolveChromium } from "./browser/acquire.js";
import { launchChromium, type LaunchedChromium } from "./browser/launch.js";
import { CdpConnection } from "./browser/cdpConnection.js";
import { PageHost } from "./pageHost.js";
import { ConsoleHistoryStore } from "./consoleHistory.js";
import { CdpHostBridgeClient } from "./hostBridge.js";

const log = createDevLogger("HeadlessHost");

const IDLE_CHECK_INTERVAL_MS = 30_000;

export class HeadlessHost {
  private connection: ServerConnection | null = null;
  private panelInit: PanelInitClient | null = null;
  private tracker: LeaseTracker;
  private browser: LaunchedChromium | null = null;
  private cdp: CdpConnection | null = null;
  private pages: PageHost | null = null;
  private bridge: CdpHostBridgeClient | null = null;
  private readonly consoleHistory = new ConsoleHistoryStore();
  private tabCounter = 0;
  private readonly tabIds = new Map<string, number>();
  private intentQueue: Promise<void> = Promise.resolve();
  private idleTimer: ReturnType<typeof setInterval> | null = null;
  private idleExitSince: number | null = null;
  private stopped = false;
  private browserRelaunches = 0;
  private browserGeneration = 0;
  private browserRecovery: Promise<void> | null = null;
  /** Resolves when stop() completes; main.ts awaits this. */
  readonly done: Promise<void>;
  private resolveDone!: () => void;

  constructor(private readonly config: HeadlessHostConfig) {
    this.tracker = new LeaseTracker(config.clientSessionId);
    this.done = new Promise((resolve) => {
      this.resolveDone = resolve;
    });
  }

  async start(): Promise<void> {
    const connection = await connectToServer(this.config);
    this.connection = connection;
    this.panelInit = new PanelInitClient(
      connection.rpc,
      this.config.serverUrl,
      this.config.label,
      this.config.clientSessionId
    );

    await this.registerClient();
    connection.onServerEvent((event, payload) => {
      if (event === "panel:runtimeLeaseChanged") {
        this.enqueueIntents(() =>
          this.tracker.apply(payload as PanelRuntimeLeaseChangedEvent)
        );
      }
    });
    await connection.rpc.call("main", "events.subscribe", ["panel:runtimeLeaseChanged"]);
    connection.onResubscribe(async () => {
      try {
        await this.registerClient();
        await connection.rpc.call("main", "events.subscribe", ["panel:runtimeLeaseChanged"]);
        await this.reconcile();
      } catch (error) {
        log.warn(`resubscribe recovery failed: ${String(error)}`);
      }
    });

    await this.startBrowser();
    this.startBridge();
    await this.reconcile();

    this.idleTimer = setInterval(() => this.checkIdle(), IDLE_CHECK_INTERVAL_MS);
    this.idleTimer.unref?.();
    log.info(
      `headless host ready (session ${this.config.clientSessionId}, max ${this.config.maxPanels} panels)`
    );
  }

  async stop(reason: string): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    log.info(`stopping: ${reason}`);
    if (this.idleTimer) clearInterval(this.idleTimer);
    try {
      await this.connection?.rpc.call("main", "panelRuntime.unregisterClient", [
        this.config.clientSessionId,
      ]);
    } catch {
      // Server may be gone — leases expire via the reconnect grace anyway.
    }
    this.bridge?.stop();
    try {
      await this.cdp?.send("Browser.close");
    } catch {
      // Fall through to SIGKILL.
    }
    this.cdp?.close();
    this.browser?.kill();
    await this.connection?.close();
    this.resolveDone();
  }

  // ── internals ────────────────────────────────────────────────────────────

  private async registerClient(): Promise<void> {
    await this.connection!.rpc.call("main", "panelRuntime.registerClient", [
      {
        clientSessionId: this.config.clientSessionId,
        hostConnectionId: this.config.clientSessionId,
        label: this.config.label,
        platform: "headless",
        supportsCdp: true,
        loadOnLeaseAssignment: true,
      },
    ]);
  }

  private async startBrowser(): Promise<void> {
    const generation = ++this.browserGeneration;
    const resolved = await resolveChromium({
      chromiumPath: this.config.chromiumPath,
      cacheDir: this.config.cacheDir,
      leanBrowser: this.config.leanBrowser,
    });
    log.info(`using chromium (${resolved.source}): ${resolved.executablePath}`);
    this.browser = await launchChromium({
      executablePath: resolved.executablePath,
      profileDir: this.config.profileDir,
    });
    this.cdp = await CdpConnection.connect(this.browser.wsEndpoint);
    this.pages = new PageHost(this.cdp, this.consoleHistory);
    this.pages.onRelayEvent((slotId, method, params, sessionId) => {
      this.bridge?.sendEvent(slotId, method, params, sessionId);
    });
    this.cdp.onClose(() => void this.handleBrowserGone(generation));
    this.browser.process.once("exit", () => void this.handleBrowserGone(generation));
  }

  private async handleBrowserGone(generation: number): Promise<void> {
    if (this.stopped) return;
    if (generation !== this.browserGeneration) return;
    if (this.browserRecovery) return this.browserRecovery;
    this.browserRecovery = this.recoverBrowser(generation).finally(() => {
      if (this.browserGeneration === generation) this.browserRecovery = null;
    });
    return this.browserRecovery;
  }

  private async recoverBrowser(generation: number): Promise<void> {
    if (this.stopped || generation !== this.browserGeneration) return;
    this.browserRelaunches += 1;
    if (this.browserRelaunches > 1) {
      log.warn("chromium died twice — giving up");
      await this.stop("chromium crash loop");
      process.exitCode = 1;
      return;
    }
    log.warn("chromium died — relaunching");
    for (const slotId of this.tabIds.keys()) this.bridge?.unregisterTarget(slotId);
    this.tabIds.clear();
    try {
      await this.startBrowser();
      // Reset relaunch counter after 60s of stability.
      setTimeout(() => {
        this.browserRelaunches = 0;
      }, 60_000).unref?.();
      await this.reconcile({ forceReload: true });
    } catch (error) {
      log.warn(`chromium relaunch failed: ${String(error)}`);
      await this.stop("chromium relaunch failed");
      process.exitCode = 1;
    }
  }

  private startBridge(): void {
    this.bridge = new CdpHostBridgeClient({
      serverUrl: this.config.serverUrl,
      hostConnectionId: this.config.clientSessionId,
      getToken: () => this.connection!.getToken(),
      handlers: {
        cdpCommand: (targetId, method, params, sessionId) =>
          this.pages!.relaySend(targetId, method, params, sessionId),
        navCommand: (targetId, action, url) =>
          this.pages!.navigate(
            targetId,
            action as "navigate" | "reload" | "goBack" | "goForward" | "stop",
            url
          ),
        hostCommand: (targetId, action, args) => this.handleHostCommand(targetId, action, args),
        detach: (targetId) => this.pages!.detachRelay(targetId),
        registerRejected: (targetId, reason) => {
          void this.releaseAndUnload(targetId, `register rejected: ${reason}`);
          log.warn(`dropped panel ${targetId} after register rejection (${reason})`);
        },
      },
    });
    this.bridge.start();
  }

  private async handleHostCommand(
    slotId: string,
    action: string,
    args: unknown[]
  ): Promise<unknown> {
    switch (action) {
      case "accessibilityTree":
        return this.pages!.accessibilityTree(slotId);
      case "consoleHistory":
        return this.consoleHistory.query(
          slotId,
          (args[0] ?? {}) as Parameters<ConsoleHistoryStore["query"]>[1]
        );
      case "rebuildPanel":
      case "rebuildAndReload": {
        const lease = this.tracker.heldLease(slotId);
        if (!lease) throw new Error(`no lease held for panel ${slotId}`);
        const info = await this.panelInit!.getPanelLoadInfo(slotId, lease.connectionId);
        await this.pages!.reloadPanel(slotId, info.panelUrl, info.panelInit);
        return { action, status: "reloaded" };
      }
      case "reloadPanel": {
        const lease = this.tracker.heldLease(slotId);
        if (!lease) throw new Error(`no lease held for panel ${slotId}`);
        const info = await this.panelInit!.getPanelLoadInfo(slotId, lease.connectionId);
        await this.pages!.reloadPanel(slotId, info.panelUrl, info.panelInit);
        return {
          panelId: slotId,
          operation: "reload",
          status: "reloaded",
          loaded: true,
          rebuilt: false,
          reloaded: true,
        };
      }
      case "navigatePanel": {
        if (!this.tracker.heldLease(slotId)) throw new Error(`no lease held for panel ${slotId}`);
        const source = typeof args[0] === "string" ? args[0] : "";
        if (!source) throw new Error("navigatePanel requires a source");
        const options =
          args[1] && typeof args[1] === "object"
            ? (args[1] as {
                ref?: string;
                contextId?: string;
                env?: Record<string, string>;
                stateArgs?: Record<string, unknown>;
              })
            : undefined;
        const connectionId = `navigate-${slotId}-${randomUUID()}`;
        const result = await this.panelInit!.navigatePanel(
          slotId,
          source,
          options,
          connectionId
        );
        await this.reconcile();
        return { id: result.panelId, title: result.title };
      }
      case "navigatePanelHistory": {
        if (!this.tracker.heldLease(slotId)) throw new Error(`no lease held for panel ${slotId}`);
        const delta = args[0] === -1 || args[0] === 1 ? args[0] : 0;
        if (!delta) throw new Error("navigatePanelHistory requires delta -1 or 1");
        const connectionId = `history-${slotId}-${randomUUID()}`;
        const result = await this.panelInit!.navigatePanelHistory(slotId, delta, connectionId);
        await this.reconcile();
        return result;
      }
      case "openDevTools":
        throw new Error("openDevTools is not supported on a headless host");
      default:
        throw new Error(`Unknown host command: ${action}`);
    }
  }

  private async reconcile(opts?: { forceReload?: boolean }): Promise<void> {
    const snapshot = await this.connection!.rpc.call<RuntimeLeaseSnapshot>(
      "main",
      "panelRuntime.getSnapshot",
      []
    );
    this.enqueueIntents(() => {
      const intents = this.tracker.reconcile(snapshot);
      if (opts?.forceReload) {
        // After a browser relaunch every held lease needs a fresh page even
        // though the tracker considers it converged.
        const held = new Set(intents.filter((i) => i.kind === "load").map((i) => i.slotId));
        for (const slotId of this.tracker.heldSlots()) {
          if (held.has(slotId)) continue;
          const lease = this.tracker.heldLease(slotId)!;
          intents.push({
            kind: "load",
            slotId,
            runtimeEntityId: lease.runtimeEntityId,
            connectionId: lease.connectionId,
          });
        }
      }
      return intents;
    });
    await this.intentQueue;
  }

  /** Serialize intent processing — lease events and reconciles never interleave. */
  private enqueueIntents(produce: () => LeaseIntent[]): void {
    this.intentQueue = this.intentQueue.then(async () => {
      for (const intent of produce()) {
        try {
          await this.processIntent(intent);
        } catch (error) {
          log.warn(`intent ${intent.kind} for ${intent.slotId} failed: ${String(error)}`);
          if (intent.kind === "load") {
            await this.releaseAndUnload(intent.slotId, "load failed");
          }
        }
      }
    });
  }

  private async processIntent(intent: LeaseIntent): Promise<void> {
    if (this.stopped || !this.pages) return;
    if (intent.kind === "unload") {
      this.bridge?.unregisterTarget(intent.slotId);
      this.tabIds.delete(intent.slotId);
      await this.pages.unloadPanel(intent.slotId);
      return;
    }

    await this.enforcePanelCap();
    // Fetch init fresh each load — the embedded gateway token is single-use.
    const info = await this.panelInit!.getPanelLoadInfo(intent.slotId, intent.connectionId);
    const tabId = ++this.tabCounter;
    await this.pages.loadPanel({
      slotId: intent.slotId,
      contextId: info.contextId,
      panelUrl: info.panelUrl,
      panelInit: info.panelInit,
      tabId,
    });
    this.tabIds.set(intent.slotId, tabId);
    this.bridge?.registerTarget(intent.slotId, tabId);
  }

  private async enforcePanelCap(): Promise<void> {
    const slots = this.pages!.slots();
    if (slots.length < this.config.maxPanels) return;
    let oldest: { slotId: string; at: number } | null = null;
    for (const slotId of slots) {
      const at = this.pages!.lastUsedAt(slotId) ?? 0;
      if (!oldest || at < oldest.at) oldest = { slotId, at };
    }
    if (oldest) await this.releaseAndUnload(oldest.slotId, "panel cap");
  }

  private async releaseAndUnload(slotId: string, why: string): Promise<void> {
    log.info(`releasing panel ${slotId} (${why})`);
    const lease = this.tracker.heldLease(slotId);
    this.tracker.drop(slotId);
    this.bridge?.unregisterTarget(slotId);
    this.tabIds.delete(slotId);
    await this.pages?.unloadPanel(slotId);
    if (lease) {
      await this.connection?.rpc
        .call("main", "panelRuntime.release", [lease.runtimeEntityId, lease.connectionId])
        .catch(() => undefined);
    }
  }

  private checkIdle(): void {
    if (this.stopped || !this.pages) return;
    const now = Date.now();
    for (const slotId of this.pages.slots()) {
      const lastUsed = this.pages.lastUsedAt(slotId) ?? now;
      if (now - lastUsed > this.config.idleUnloadMs) {
        void this.releaseAndUnload(slotId, "idle");
      }
    }
    if (this.config.idleExitMs && this.config.idleExitMs > 0) {
      if (this.tracker.heldSlots().length === 0) {
        this.idleExitSince ??= now;
        if (now - this.idleExitSince > this.config.idleExitMs) {
          void this.stop("idle exit");
        }
      } else {
        this.idleExitSince = null;
      }
    }
  }
}
