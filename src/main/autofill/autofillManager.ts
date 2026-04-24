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
import type { WebContents } from "electron";
import type { ServiceDefinition } from "@natstack/shared/serviceDefinition";
import type { EventService } from "@natstack/shared/eventsService";
import type { ViewManager } from "../viewManager.js";
import type { StoredPassword } from "@natstack/browser-data";
import {
  AUTOFILL_WORLD_ID,
  getContentScript,
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
  /**
   * Sub-frame origins for which we've already logged a "rejected" warning
   * during the current page load. Reset on navigation. Audit S3.
   */
  warnedSubFrameOrigins: Set<string>;
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

    // Handle argless ping from content script.
    // Sender attribution: only accept pings from webContents that autofill
    // is currently attached to (i.e., tracked in panelState). Otherwise any
    // panel could spoof a ping to drive credential matching for itself or
    // other panels. Audit finding 01-HIGH-2 / #44.
    //
    // Top-frame-only policy (audit S3): the ping must originate from the
    // webContents' main frame. Sub-frame pings (e.g. from a stale iframe
    // injection prior to deployment of this policy, or from a future
    // preload that ends up exposed in sub-frames) are dropped with a
    // single warn per (page-load, sub-frame-origin).
    ipcMain.on("natstack:autofill:ping", (event) => {
      const wcId = event.sender.id;
      const state = this.panelState.get(wcId);
      if (!state) {
        log.warn(` Rejected autofill:ping from unattached sender id=${wcId}`);
        return;
      }
      const senderFrame = event.senderFrame;
      const wc = event.sender;
      if (senderFrame && senderFrame !== wc.mainFrame) {
        const subOrigin = senderFrame.origin || senderFrame.url || "<unknown>";
        if (!state.warnedSubFrameOrigins.has(subOrigin)) {
          state.warnedSubFrameOrigins.add(subOrigin);
          log.warn(
            ` Autofill sub-frame request ignored — top-frame-only policy. wc=${wcId} subOrigin=${subOrigin}`,
          );
        }
        return;
      }
      void this.handlePing(wcId, wc);
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
      warnedSubFrameOrigins: new Set<string>(),
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
      state.warnedSubFrameOrigins.clear();
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

    // Top-frame-only policy (audit S3): we no longer attach a
    // did-frame-finish-load handler, because the only thing it did was
    // enumerate sub-frames and inject scanning/fill scripts into them.
    // Sub-frame login flows simply do not autofill.

    // Store handlers for cleanup
    (webContents as any).__autofillHandlers = {
      domReady: domReadyHandler,
      didNavigate: didNavigateHandler,
      inPageNav: inPageNavHandler,
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
   * Execute a script in the top frame only, in the autofill isolated world.
   *
   * Top-frame-only policy (audit S3): autofill never injects credentials
   * (or fill-related state queries) into sub-frames. The `_state` parameter
   * is preserved for call-site symmetry with the historical signature but
   * is no longer used to dispatch onto a sub-frame.
   */
  private async executeInActiveFrame(
    wc: WebContents,
    _state: AutofillPanelState,
    code: string,
  ): Promise<unknown> {
    return wc.executeJavaScriptInIsolatedWorld(AUTOFILL_WORLD_ID, [{ code }]);
  }

  private async handlePing(wcId: number, wc: WebContents): Promise<void> {
    const state = this.panelState.get(wcId);
    if (!state) return;
    if (wc.isDestroyed()) return;

    // Pull state from the top frame's isolated world only (audit S3:
    // top-frame-only policy — sub-frames are never scanned or injected).
    let pulled: PulledState;
    try {
      const results = await this.executeInActiveFrame(wc, state, getPullStateScript());
      pulled = results as PulledState;
    } catch {
      return;
    }

    if (!pulled) return;

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

    // Origin verification (audit S3): re-derive the live top-frame origin
    // immediately before the fill and confirm it still matches both the
    // origin we matched the credential against and the credential's saved
    // origin. Protects against a navigation race between credential lookup
    // and the actual injection.
    if (!this.verifyTopFrameOriginForFill(wc, state, credential)) return;

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

    // Origin verification (audit S3): same race protection as fillCredential.
    // Even though no password is injected here, the username may itself be
    // sensitive (e.g. an email used as account identifier).
    if (!this.verifyTopFrameOriginForFill(wc, state, credential)) return;

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

  /**
   * Verify that the top frame's *live* origin still matches both the
   * credential's saved origin and the panel state's matched origin.
   *
   * Audit S3: protects against navigation races where credentials were
   * matched against one origin but the top frame has since navigated to
   * another. Returns true when fill should proceed.
   *
   * `wcId` is intentionally unused — passed by callers for symmetry.
   */
  private verifyTopFrameOriginForFill(
    wc: WebContents,
    state: AutofillPanelState,
    credential: StoredPassword,
  ): boolean {
    const liveOrigin = this.deriveOrigin(wc);
    if (!liveOrigin) {
      log.warn(" Aborting fill — could not derive live top-frame origin.");
      return false;
    }
    if (liveOrigin !== state.origin) {
      log.warn(
        ` Aborting fill — top frame navigated since credential match (matched=${state.origin} live=${liveOrigin}).`,
      );
      return false;
    }
    const credentialOrigin = this.originFromUrl(credential.origin_url);
    if (!credentialOrigin || credentialOrigin !== liveOrigin) {
      log.warn(
        ` Aborting fill — credential origin does not match live top frame (cred=${credentialOrigin ?? "<invalid>"} live=${liveOrigin}).`,
      );
      return false;
    }
    return true;
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
