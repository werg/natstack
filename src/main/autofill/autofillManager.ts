/**
 * AutofillManager — main process autofill orchestrator.
 *
 * Manages per-webContents state: form detection, credential matching,
 * auto-fill, credential dropdown, and save/update prompts.
 *
 * All data flows through executeJavaScriptInIsolatedWorld — never through
 * the preload bridge (which only carries argless ping() notifications).
 */

import { ipcMain } from "electron";
import { z } from "zod";
import type { WebContents, WebFrameMain } from "electron";
import type { ServiceDefinition } from "@natstack/shared/serviceDefinition";
import type { EventService } from "@natstack/shared/eventsService";
import type { ViewManager } from "../viewManager.js";
import type { StoredPassword } from "@natstack/browser-data";
import {
  AUTOFILL_WORLD_ID,
  getContentScript,
  getIframeContentScript,
  getFrameScanScript,
  getPullStateScript,
  getReadSnapshotScript,
  getFillScript,
  getInjectKeyIconScript,
} from "./contentScript.js";
import { AutofillOverlay } from "./autofillOverlay.js";
import { createDevLogger } from "@natstack/dev-log";

const log = createDevLogger("Autofill");

/** Narrow interface for the password store — avoids deep import */
interface PasswordStoreLike {
  getForOrigin(origin: string): StoredPassword[];
  updateLastUsed(id: number): void;
  update(id: number, partial: Partial<{ username: string; password: string; actionUrl: string; realm: string }>): void;
  add(password: { url: string; username: string; password: string; actionUrl?: string; realm?: string }): number;
  addNeverSave(origin: string): void;
  isNeverSave(origin: string): boolean;
}

interface FieldInfo {
  type: "login" | "username-only";
  usernameSelector: string | null;
  passwordSelector?: string;
  formSelector?: string | null;
  actionUrl?: string | null;
  passwordRect?: { x: number; y: number; width: number; height: number; viewportX: number; viewportY: number };
  usernameRect?: { x: number; y: number; width: number; height: number; viewportX: number; viewportY: number } | null;
}

interface FocusInfo {
  fieldType: "username" | "password";
  rect: { x: number; y: number; width: number; height: number; viewportX: number; viewportY: number };
}

interface PendingSnapshot {
  username: string;
  password: string;
  timestamp: number;
  pageUrl: string;
  actionUrl: string | null;
}

interface PulledState {
  fields: FieldInfo | null;
  focus: FocusInfo | null;
  pending: PendingSnapshot | null;
  fieldsRemoved: boolean;
  usernameSnapshot: string | null;
}

interface AutofillPanelState {
  credentials: StoredPassword[];
  usernameContext?: string;
  origin: string;
  signalCounts: { strong: number; medium: number; weak: number };
  webRequestCleanup?: () => void;
  dismissedAt?: number;
  fields?: FieldInfo;
  hasInjected: boolean;
  hasPendingSnapshot: boolean;
  /** Whether auto-fill has already been performed for the current field set */
  hasAutoFilled: boolean;
  /** Sub-frame that contains the login form (null = main frame) */
  activeFrame: WebFrameMain | null;
  /** Whether sub-frames have been scanned for this page load */
  iframesScanned: boolean;
}

interface PendingCredential {
  username: string;
  password: string;
  origin: string;
  isUpdate: boolean;
  existingId?: number;
}

export class AutofillManager {
  private panelState = new Map<number, AutofillPanelState>();
  private pendingCredentials = new Map<string, PendingCredential>(); // panelId -> pending
  private passwordStore: PasswordStoreLike;
  private eventService: EventService;
  private getViewManager: () => ViewManager;
  private overlay: AutofillOverlay;
  private activeOverlayWcId: number | null = null;
  /** Active webRequest watchers by wcId, for multiplexed handler */
  private webRequestWatchers = new Map<number, { origin: string; actionUrl?: string }>();
  /** Sessions that already have a webRequest.onCompleted handler installed */
  private webRequestSessions = new Set<Electron.Session>();

  constructor(deps: {
    passwordStore: PasswordStoreLike;
    eventService: EventService;
    getViewManager: () => ViewManager;
    autofillOverlayPreloadPath: string;
  }) {
    this.passwordStore = deps.passwordStore;
    this.eventService = deps.eventService;
    this.getViewManager = deps.getViewManager;
    this.overlay = new AutofillOverlay(deps.autofillOverlayPreloadPath);

    this.overlay.setCallbacks({
      onSelect: (credentialId) => this.handleOverlaySelect(credentialId),
      onDismiss: () => this.hideOverlay(),
    });

    // Handle argless ping from content script
    ipcMain.on("natstack:autofill:ping", (event) => {
      const wcId = event.sender.id;
      void this.handlePing(wcId, event.sender);
    });
  }

  setWindow(window: Electron.BaseWindow): void {
    this.overlay.setWindow(window);
  }

  /**
   * Attach autofill tracking to a webContents (browser panel).
   * Registers listeners unconditionally — origin and credentials are
   * resolved lazily on dom-ready when the page has actually committed.
   */
  attachToWebContents(webContentsId: number, webContents: WebContents): void {
    // Initialize state without origin — will be populated on first dom-ready
    this.panelState.set(webContentsId, {
      credentials: [],
      origin: "",
      signalCounts: { strong: 0, medium: 0, weak: 0 },
      hasInjected: false,
      hasPendingSnapshot: false,
      hasAutoFilled: false,
      activeFrame: null,
      iframesScanned: false,
    });

    // Inject content script on dom-ready and resolve origin if needed
    const domReadyHandler = () => {
      const state = this.panelState.get(webContentsId);
      if (!state) return;

      // Resolve origin on first load or if it changed
      const currentOrigin = this.deriveOrigin(webContents);
      if (currentOrigin && currentOrigin !== state.origin) {
        state.origin = currentOrigin;
        state.credentials = this.passwordStore.getForOrigin(currentOrigin);
      }

      this.injectContentScript(webContentsId, webContents);
    };
    webContents.on("dom-ready", domReadyHandler);

    // Re-inject on navigation
    const didNavigateHandler = (_event: Electron.Event, url: string) => {
      const state = this.panelState.get(webContentsId);
      if (!state) return;

      const newOrigin = this.originFromUrl(url);
      if (newOrigin && newOrigin !== state.origin) {
        // New origin — refresh credentials
        state.origin = newOrigin;
        state.credentials = this.passwordStore.getForOrigin(newOrigin);
        state.signalCounts = { strong: 0, medium: 0, weak: 0 };
        state.hasPendingSnapshot = false;
        state.hasInjected = false;
        state.fields = undefined;
        this.cleanupWebRequest(webContentsId, state);
      } else if (newOrigin === state.origin && state.hasPendingSnapshot) {
        // Same origin, full navigation after snapshot = strong signal
        this.addSignal(webContentsId, "strong");
      }

      // Reset for new page — fields will be re-detected by content script
      state.hasInjected = false;
      state.fields = undefined;
      state.hasAutoFilled = false;
      state.activeFrame = null;
      state.iframesScanned = false;
      if (this.activeOverlayWcId === webContentsId) {
        this.hideOverlay();
      }
      this.injectContentScript(webContentsId, webContents);
    };
    webContents.on("did-navigate", didNavigateHandler);

    // SPA navigation = medium signal
    const inPageNavHandler = () => {
      const state = this.panelState.get(webContentsId);
      if (state?.hasPendingSnapshot) {
        this.addSignal(webContentsId, "medium");
      }
    };
    webContents.on("did-navigate-in-page", inPageNavHandler);

    // Full navigation after submit = strong signal
    const willNavigateHandler = () => {
      const state = this.panelState.get(webContentsId);
      if (state?.hasPendingSnapshot) {
        this.addSignal(webContentsId, "strong");
      }
    };
    webContents.on("will-navigate", willNavigateHandler);

    // Scan sub-frames for login forms when they finish loading
    const frameLoadHandler = (_event: Electron.Event, isMainFrame: boolean) => {
      if (isMainFrame) return;
      const state = this.panelState.get(webContentsId);
      if (!state || state.fields) return; // already found fields in main frame
      void this.scanSubFrames(webContentsId, webContents);
    };
    webContents.on("did-frame-finish-load", frameLoadHandler);

    // Store handlers for cleanup
    (webContents as any).__autofillHandlers = {
      domReady: domReadyHandler,
      didNavigate: didNavigateHandler,
      inPageNav: inPageNavHandler,
      frameLoad: frameLoadHandler,
      willNavigate: willNavigateHandler,
    };
  }

  /**
   * Detach autofill tracking from a webContents.
   */
  detachFromWebContents(webContentsId: number, webContents?: WebContents): void {
    const state = this.panelState.get(webContentsId);
    if (state) {
      this.cleanupWebRequest(webContentsId, state);
      this.panelState.delete(webContentsId);
    }

    // Clear pending credentials for this panel (avoid leaking plaintext secrets)
    const vm = this.getViewManager();
    const viewId = vm.findViewIdByWebContentsId(webContentsId);
    if (viewId) {
      this.pendingCredentials.delete(viewId);
    }

    // Remove event listeners
    if (webContents && !webContents.isDestroyed()) {
      const handlers = (webContents as any).__autofillHandlers;
      if (handlers) {
        webContents.off("dom-ready", handlers.domReady);
        webContents.off("did-navigate", handlers.didNavigate);
        webContents.off("did-navigate-in-page", handlers.inPageNav);
        webContents.off("will-navigate", handlers.willNavigate);
        if (handlers.frameLoad) webContents.off("did-frame-finish-load", handlers.frameLoad);
        delete (webContents as any).__autofillHandlers;
      }
    }

    if (this.activeOverlayWcId === webContentsId) {
      this.hideOverlay();
    }
  }

  /**
   * Get the autofill service definition for RPC registration.
   */
  getServiceDefinition(): ServiceDefinition {
    return {
      name: "autofill",
      description: "Password autofill management",
      policy: { allowed: ["shell"] },
      methods: {
        confirmSave: {
          args: z.tuple([z.string(), z.enum(["save", "never", "dismiss"])]),
        },
      },
      handler: async (_ctx, method, args) => {
        switch (method) {
          case "confirmSave": {
            const [panelId, action] = args as [string, "save" | "never" | "dismiss"];
            this.handleConfirmSave(panelId, action);
            return;
          }
          default:
            throw new Error(`Unknown autofill method: ${method}`);
        }
      },
    };
  }

  /**
   * Called by ViewManager after z-order changes.
   */
  onViewOrderChanged(): void {
    this.overlay.bringToFront();
  }

  /**
   * Called when a panel becomes hidden (e.g., panel switch).
   * Hides the overlay if it belongs to the hidden panel's webContents.
   */
  onPanelHidden(panelId: string): void {
    if (!this.activeOverlayWcId) return;
    const vm = this.getViewManager();
    const viewId = vm.findViewIdByWebContentsId(this.activeOverlayWcId);
    if (viewId === panelId) {
      this.hideOverlay();
    }
  }

  // ===========================================================================
  // Internal
  // ===========================================================================

  private async injectContentScript(wcId: number, wc: WebContents): Promise<void> {
    const state = this.panelState.get(wcId);
    if (!state || state.hasInjected) return;
    if (wc.isDestroyed()) return;

    state.hasInjected = true;

    try {
      await wc.executeJavaScriptInIsolatedWorld(AUTOFILL_WORLD_ID, [
        { code: getContentScript() },
      ]);
      log.verbose(` Injected content script into wc ${wcId}`);
    } catch (err) {
      log.verbose(` Failed to inject content script: ${err}`);
    }
  }

  /**
   * Execute a script in the active frame (main frame isolated world or sub-frame main world).
   */
  private async executeInActiveFrame(wc: WebContents, state: AutofillPanelState, code: string): Promise<unknown> {
    if (state.activeFrame && !state.activeFrame.isDestroyed()) {
      return state.activeFrame.executeJavaScript(code);
    }
    return wc.executeJavaScriptInIsolatedWorld(AUTOFILL_WORLD_ID, [{ code }]);
  }

  /**
   * Scan sub-frames for login fields and inject content script if found.
   */
  private async scanSubFrames(wcId: number, wc: WebContents): Promise<void> {
    const state = this.panelState.get(wcId);
    if (!state || state.fields || wc.isDestroyed()) return;

    try {
      const mainFrame = wc.mainFrame;
      if (!mainFrame || mainFrame.isDestroyed()) return;

      for (const frame of mainFrame.framesInSubtree) {
        if (frame === mainFrame || frame.isDestroyed()) continue;

        try {
          const hasFields = await frame.executeJavaScript(getFrameScanScript());
          if (hasFields) {
            // Inject the iframe content script
            await frame.executeJavaScript(getIframeContentScript());
            state.activeFrame = frame;
            state.iframesScanned = true;
            log.verbose(` Found login form in sub-frame of wc ${wcId}`);

            // Pull state immediately from the iframe
            const pulled = await frame.executeJavaScript(getPullStateScript()) as PulledState | null;
            if (pulled?.fields) {
              // Process like a normal ping with these fields
              await this.processPulledState(wcId, wc, state, pulled);
            }
            return;
          }
        } catch {
          // Frame may have been destroyed or be cross-origin restricted
        }
      }

      state.iframesScanned = true;
    } catch {
      // mainFrame access can fail if webContents is being destroyed
    }
  }

  private async handlePing(wcId: number, wc: WebContents): Promise<void> {
    const state = this.panelState.get(wcId);
    if (!state) return;
    if (wc.isDestroyed()) return;

    // Pull state from the active frame (main or sub-frame)
    let pulled: PulledState;
    try {
      const results = await this.executeInActiveFrame(wc, state, getPullStateScript());
      pulled = results as PulledState;
    } catch {
      return;
    }

    if (!pulled) return;

    // If main frame has no fields and we haven't scanned sub-frames yet, do so
    if (!pulled.fields && !state.fields && !state.iframesScanned) {
      await this.scanSubFrames(wcId, wc);
      return; // scanSubFrames handles processing if fields are found
    }

    await this.processPulledState(wcId, wc, state, pulled);
  }

  private async processPulledState(
    wcId: number,
    wc: WebContents,
    state: AutofillPanelState,
    pulled: PulledState,
  ): Promise<void> {
    // Update origin from actual URL
    const currentOrigin = this.deriveOrigin(wc);
    if (currentOrigin && currentOrigin !== state.origin) {
      state.origin = currentOrigin;
      state.credentials = this.passwordStore.getForOrigin(currentOrigin);
    }

    // Handle field detection — accept new fields or field type changes (SPA transitions)
    const fieldsChanged = pulled.fields && (
      !state.fields ||
      pulled.fields.type !== state.fields.type ||
      pulled.fields.passwordSelector !== state.fields.passwordSelector ||
      pulled.fields.usernameSelector !== state.fields.usernameSelector
    );
    if (pulled.fields && fieldsChanged) {
      state.fields = pulled.fields;
      state.hasAutoFilled = false; // Reset for new field set

      if (pulled.fields.type === "login" && state.credentials.length > 0) {
        if (state.credentials.length === 1) {
          // Auto-fill single credential
          await this.fillCredential(wcId, wc, state.credentials[0]!, pulled.fields);
          state.hasAutoFilled = true;
        }
        // Inject key icon on the password field
        if (pulled.fields.passwordSelector) {
          await this.injectKeyIcon(wc, state, pulled.fields.passwordSelector);
        }
      }

      if (pulled.fields.type === "username-only" && state.credentials.length > 0) {
        // Multi-step: auto-fill username
        const matchedCred = state.usernameContext
          ? state.credentials.find((c) => c.username === state.usernameContext)
          : state.credentials.length === 1 ? state.credentials[0] : null;
        if (matchedCred && pulled.fields.usernameSelector) {
          await this.fillUsernameOnly(wcId, wc, state, matchedCred, pulled.fields.usernameSelector);
          state.hasAutoFilled = true;
        }
      }

      // Multi-step step 2: if we have usernameContext, use it to disambiguate
      if (pulled.fields.type === "login" && state.usernameContext && state.credentials.length > 1) {
        const matched = state.credentials.find((c) => c.username === state.usernameContext);
        if (matched) {
          await this.fillCredential(wcId, wc, matched, pulled.fields);
          state.hasAutoFilled = true;
        }
      }
    }

    // Handle field focus -> show dropdown or re-fill
    if (pulled.focus && state.credentials.length >= 2) {
      this.showOverlay(wcId, wc, state, pulled.focus);
    } else if (pulled.focus && state.credentials.length === 1 && state.fields && !state.hasAutoFilled) {
      // Single credential + first focus (before auto-fill) -> fill now
      await this.fillCredential(wcId, wc, state.credentials[0]!, state.fields);
      state.hasAutoFilled = true;
    }

    // Hide overlay when focus is lost
    if (!pulled.focus && this.activeOverlayWcId === wcId) {
      this.hideOverlay();
    }

    // Handle pending snapshot
    if (pulled.pending && !state.hasPendingSnapshot) {
      state.hasPendingSnapshot = true;
      this.startWebRequestWatch(wcId, wc, state.origin, pulled.pending.actionUrl ?? undefined);
    }

    // Handle field removal (SPA signal)
    if (pulled.fieldsRemoved && state.hasPendingSnapshot) {
      this.addSignal(wcId, "medium");
    }

    // Handle username snapshot for multi-step
    if (pulled.usernameSnapshot) {
      state.usernameContext = pulled.usernameSnapshot;
    }
  }

  private async fillCredential(
    wcId: number,
    wc: WebContents,
    credential: StoredPassword,
    fields: FieldInfo,
  ): Promise<void> {
    if (wc.isDestroyed() || !fields.passwordSelector) return;
    const state = this.panelState.get(wcId);
    if (!state) return;

    const script = getFillScript(
      fields.usernameSelector,
      fields.passwordSelector,
      credential.username,
      credential.password,
    );

    try {
      await this.executeInActiveFrame(wc, state, script);
      this.passwordStore.updateLastUsed(credential.id);
      log.verbose(` Filled credential for ${credential.origin_url}`);
    } catch (err) {
      log.verbose(` Fill failed: ${err}`);
    }
  }

  private async fillUsernameOnly(
    wcId: number,
    wc: WebContents,
    state: AutofillPanelState,
    credential: StoredPassword,
    usernameSelector: string,
  ): Promise<void> {
    if (wc.isDestroyed()) return;

    const script = getFillScript(
      usernameSelector,
      "___nonexistent___",
      credential.username,
      "",
    );

    try {
      await this.executeInActiveFrame(wc, state, script);
    } catch (err) {
      log.verbose(` Username fill failed: ${err}`);
    }
  }

  private showOverlay(
    wcId: number,
    wc: WebContents,
    state: AutofillPanelState,
    focus: FocusInfo,
  ): void {
    const vm = this.getViewManager();
    const viewId = vm.findViewIdByWebContentsId(wcId);
    if (!viewId) return;

    const viewInfo = vm.getViewInfo(viewId);
    if (!viewInfo) return;

    // Convert viewport-relative rect to window coordinates
    const bounds = {
      x: viewInfo.bounds.x + focus.rect.viewportX,
      y: viewInfo.bounds.y + focus.rect.viewportY,
      width: focus.rect.width,
      height: focus.rect.height,
    };

    const credentialItems = state.credentials.map((c) => ({
      id: c.id,
      username: c.username,
      origin: c.origin_url,
    }));

    this.activeOverlayWcId = wcId;
    this.overlay.show(credentialItems, bounds);
  }

  private hideOverlay(): void {
    this.overlay.hide();
    this.activeOverlayWcId = null;
  }

  private async handleOverlaySelect(credentialId: number): Promise<void> {
    this.hideOverlay();

    // Find which webContents this credential belongs to
    for (const [wcId, state] of this.panelState) {
      const credential = state.credentials.find((c) => c.id === credentialId);
      if (!credential || !state.fields) continue;

      const vm = this.getViewManager();
      const viewId = vm.findViewIdByWebContentsId(wcId);
      if (!viewId) continue;

      const wc = vm.getWebContents(viewId);
      if (!wc || wc.isDestroyed()) continue;

      await this.fillCredential(wcId, wc, credential, state.fields);
      break;
    }
  }

  // ===========================================================================
  // Save/Update Detection
  // ===========================================================================

  private addSignal(wcId: number, tier: "strong" | "medium" | "weak"): void {
    const state = this.panelState.get(wcId);
    if (!state || !state.hasPendingSnapshot) return;

    // Permanently suppressed
    if (this.passwordStore.isNeverSave(state.origin)) return;

    // Suppress if user recently dismissed save for this origin
    if (state.dismissedAt && Date.now() - state.dismissedAt < 10 * 60 * 1000) return;

    state.signalCounts[tier]++;

    const { strong, medium, weak } = state.signalCounts;
    const shouldSave =
      strong >= 1 ||
      medium >= 2 ||
      (medium >= 1 && weak >= 1);

    // Single medium with no other signals: check if credential changed (update existing only)
    const shouldCheckChange = medium === 1 && strong === 0 && weak === 0;

    if (shouldSave) {
      void this.triggerSave(wcId, false);
    } else if (shouldCheckChange) {
      void this.triggerSave(wcId, true);
    }
  }

  private async triggerSave(wcId: number, onlyIfChanged: boolean): Promise<void> {
    const state = this.panelState.get(wcId);
    if (!state) return;

    const vm = this.getViewManager();
    const viewId = vm.findViewIdByWebContentsId(wcId);
    if (!viewId) return;

    const wc = vm.getWebContents(viewId);
    if (!wc || wc.isDestroyed()) return;

    // For check-only (single medium), peek at the snapshot without clearing it
    // so a second medium signal can still trigger a full save
    const readScript = onlyIfChanged ? getPullStateScript() : getReadSnapshotScript();
    let snapshot: PendingSnapshot | null;
    try {
      const result = await this.executeInActiveFrame(wc, state, readScript);
      snapshot = onlyIfChanged ? (result as PulledState)?.pending : result as PendingSnapshot | null;
    } catch {
      return;
    }

    if (!snapshot || !snapshot.password) return;

    const origin = state.origin;

    // Check store for existing credential
    const existing = state.credentials.find(
      (c) => c.username === snapshot!.username,
    );

    if (existing) {
      if (existing.password === snapshot.password) {
        // Same credentials — silently update last used, clean up
        this.passwordStore.updateLastUsed(existing.id);
        state.hasPendingSnapshot = false;
        state.signalCounts = { strong: 0, medium: 0, weak: 0 };
        this.cleanupWebRequest(wcId, state);
        return;
      }
      // Password changed — always offer update
      state.hasPendingSnapshot = false;
      state.signalCounts = { strong: 0, medium: 0, weak: 0 };
      this.cleanupWebRequest(wcId, state);
      // Clear snapshot from content script if we haven't already
      if (onlyIfChanged) {
        try { await this.executeInActiveFrame(wc, state, getReadSnapshotScript()); } catch {}
      }
      this.pendingCredentials.set(viewId, {
        username: snapshot.username,
        password: snapshot.password,
        origin,
        isUpdate: true,
        existingId: existing.id,
      });
      this.eventService.emit("autofill:save-prompt", {
        panelId: viewId,
        origin,
        username: snapshot.username,
        isUpdate: true,
      });
    } else {
      // New credential — if onlyIfChanged (single medium signal), don't prompt yet.
      // Leave the snapshot intact so a second medium signal can trigger a full save.
      if (onlyIfChanged) return;

      // Full save — clean up
      state.hasPendingSnapshot = false;
      state.signalCounts = { strong: 0, medium: 0, weak: 0 };
      this.cleanupWebRequest(wcId, state);
      this.pendingCredentials.set(viewId, {
        username: snapshot.username,
        password: snapshot.password,
        origin,
        isUpdate: false,
      });
      this.eventService.emit("autofill:save-prompt", {
        panelId: viewId,
        origin,
        username: snapshot.username,
        isUpdate: false,
      });
    }
  }

  /**
   * Install a multiplexed webRequest.onCompleted handler on a session.
   * Electron only supports one listener per event per session, so we
   * multiplex across all active watchers in a single handler.
   * Each unique session gets its own handler installed once.
   */
  private ensureWebRequestHandler(ses: Electron.Session): void {
    if (this.webRequestSessions.has(ses)) return;
    this.webRequestSessions.add(ses);

    ses.webRequest.onCompleted((details) => {
      if (details.method !== "POST") return;
      if (details.statusCode < 200 || details.statusCode >= 400) return;

      // Narrow to the specific webContents that made the request
      const sourceWcId = (details as any).webContentsId as number | undefined;

      for (const [wcId, watcher] of this.webRequestWatchers) {
        // Only attribute signal to the panel that actually made the request
        if (sourceWcId !== undefined && sourceWcId !== wcId) continue;

        // Check origin match
        if (!details.url.startsWith(watcher.origin)) continue;

        // Header names can vary in casing across servers/Electron versions
        const setsCookie = details.responseHeaders != null &&
          Object.keys(details.responseHeaders).some(
            (k) => k.toLowerCase() === "set-cookie" && details.responseHeaders![k]!.length > 0,
          );

        const matchesAction = watcher.actionUrl
          ? details.url === watcher.actionUrl || details.url.startsWith(watcher.actionUrl)
          : true;

        if (setsCookie && matchesAction) {
          this.addSignal(wcId, "strong");
        } else if (matchesAction) {
          this.addSignal(wcId, "medium");
        }
      }
    });
  }

  private startWebRequestWatch(
    wcId: number,
    wc: WebContents,
    origin: string,
    actionUrl?: string,
  ): void {
    const state = this.panelState.get(wcId);
    if (!state) return;

    // Clean up previous watcher for this wcId
    this.cleanupWebRequest(wcId, state);

    this.webRequestWatchers.set(wcId, { origin, actionUrl });
    // Install handler on the webContents' own session (may be a partition)
    this.ensureWebRequestHandler(wc.session);

    // Auto-remove after 30 seconds (snapshot expiry)
    const timeout = setTimeout(() => {
      this.cleanupWebRequest(wcId, state);
    }, 30000);

    state.webRequestCleanup = () => {
      clearTimeout(timeout);
      this.webRequestWatchers.delete(wcId);
      state.webRequestCleanup = undefined;
    };
  }

  private cleanupWebRequest(wcId: number, state: AutofillPanelState): void {
    if (state.webRequestCleanup) {
      state.webRequestCleanup();
    }
    this.webRequestWatchers.delete(wcId);
  }

  private handleConfirmSave(panelId: string, action: "save" | "never" | "dismiss"): void {
    const pending = this.pendingCredentials.get(panelId);
    if (!pending) return;

    this.pendingCredentials.delete(panelId);

    if (action === "save") {
      if (pending.isUpdate && pending.existingId !== undefined) {
        this.passwordStore.update(pending.existingId, {
          password: pending.password,
        });
      } else {
        this.passwordStore.add({
          url: pending.origin,
          username: pending.username,
          password: pending.password,
        });
      }
      // Refresh in-memory credential cache for all panels on this origin
      this.refreshCredentialsForOrigin(pending.origin);
      this.eventService.emit("browser-data-changed", { dataType: "passwords" });
    } else if (action === "never") {
      // Permanently suppress saves for this origin
      this.passwordStore.addNeverSave(pending.origin);
    } else if (action === "dismiss") {
      // Temporarily suppress for 10 minutes
      for (const state of this.panelState.values()) {
        if (state.origin === pending.origin) {
          state.dismissedAt = Date.now();
        }
      }
    }
  }

  private async injectKeyIcon(wc: WebContents, state: AutofillPanelState, fieldSelector: string): Promise<void> {
    if (wc.isDestroyed()) return;
    try {
      await this.executeInActiveFrame(wc, state, getInjectKeyIconScript(fieldSelector));
    } catch {
      // Non-critical — icon injection is cosmetic
    }
  }

  // ===========================================================================
  // Helpers
  // ===========================================================================

  private refreshCredentialsForOrigin(origin: string): void {
    const freshCredentials = this.passwordStore.getForOrigin(origin);
    for (const state of this.panelState.values()) {
      if (state.origin === origin) {
        state.credentials = freshCredentials;
      }
    }
  }

  private deriveOrigin(wc: WebContents): string | null {
    if (wc.isDestroyed()) return null;
    return this.originFromUrl(wc.getURL());
  }

  private originFromUrl(url: string): string | null {
    try {
      const parsed = new URL(url);
      return parsed.origin;
    } catch {
      return null;
    }
  }

  destroy(): void {
    this.overlay.destroy();
    ipcMain.removeAllListeners("natstack:autofill:ping");
  }
}
