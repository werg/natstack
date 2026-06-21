/**
 * ViewManager - Centralized WebContentsView management for panels and browsers.
 *
 * This replaces the <webview> tag approach with Electron's recommended
 * WebContentsView system. All views are managed from the main process, providing:
 *
 * - Stable lifecycle (no React lifecycle interference)
 * - Screenshot capability (hidden views are temporarily shown for capture)
 * - Unified CDP access for both panels and browsers
 * - Consistent view positioning via bounds updates from renderer
 *
 * Architecture:
 * - BaseWindow contains a root WebContentsView (shell) for React UI
 * - Shell reports bounds for panel/browser content areas
 * - ViewManager creates/positions child WebContentsViews accordingly
 */

import {
  app,
  BaseWindow,
  Menu,
  WebContentsView,
  clipboard,
  type MenuItemConstructorOptions,
  type WebContents,
  type NativeImage,
  session,
  shell,
  webContents as electronWebContents,
} from "electron";

import { createDevLogger } from "@natstack/dev-log";
import { ShellOverlayView, type ShellOverlayOptions } from "./shellOverlayView.js";
import type { AppCapability } from "@natstack/shared/unitManifest";
import { isAuthorizedChromeAppCaller } from "@natstack/shared/chromeTrust";

const log = createDevLogger("ViewManager");

export interface ViewBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ViewConfig {
  /** Unique view ID (typically panel ID) */
  id: string;
  /** View type for tracking */
  type: "shell" | "panel" | "app";
  /** Session partition for browser views (shared session for cookies/auth). Omit for default session. */
  partition?: string;
  /** Preload script path. Set to null to disable preload (for browsers). */
  preload?: string | null;
  /** Initial URL to load */
  url?: string;
  /** Parent view ID (for nesting) */
  parentId?: string;
  /** Whether to inject host theme CSS */
  injectHostThemeVariables?: boolean;
  /** App capabilities declared by the active app manifest. */
  appCapabilities?: readonly AppCapability[];
  /** Full-window host chrome app. These views are not panel content. */
  hostChrome?: boolean;
  /** Workspace source path and effective version for app principals. */
  appIdentity?: { source?: string; effectiveVersion?: string | null };
}

interface PanelDisplayDiagnostics {
  timestamp: string;
  window: {
    destroyed: boolean;
    visible: boolean;
    contentSize: [number, number];
  };
  manager: {
    visiblePanelId: string | null;
    shellOverlayActive: boolean;
    panelViewportBounds: ViewBounds | null;
  };
  nativePanelSlots: {
    hostedShellReady: boolean;
    activeHostedShellViewId: string | null;
    focusedNativeSlotId: string | null;
    hostedShellGeneration: number;
    slots: Array<NativePanelSlotState & { bounds: ViewBounds }>;
  };
  hostedShellSurfaces: Array<{
    nativeSlotId: string | null;
    panelId: string | null;
    bounds: ViewBounds;
  }>;
  views: Array<{
    id: string;
    type: "shell" | "panel" | "app";
    parentId?: string;
    managedVisible: boolean;
    trackedBounds: ViewBounds;
    nativeBounds: ViewBounds;
    hostChrome: boolean;
    webContents: {
      id: number;
      destroyed: boolean;
      url: string | null;
      title: string | null;
      loading: boolean | null;
      osProcessId: number | null;
      memoryMb: number | null;
    };
  }>;
  captures: Array<{
    id: string;
    ok: boolean;
    empty?: boolean;
    size?: { width: number; height: number };
    error?: string;
  }>;
  processMetrics: Array<{
    pid: number;
    type: string;
    memoryMb: number;
    cpuPercent: number;
  }>;
}

interface ManagedView {
  id: string;
  view: WebContentsView;
  type: "shell" | "panel" | "app";
  parentId?: string;
  visible: boolean;
  bounds: ViewBounds;
  /** Session partition the view was created with (undefined = default session). */
  partition?: string;
  injectHostThemeVariables: boolean;
  appCapabilities: readonly AppCapability[];
  hostChrome: boolean;
  appIdentity?: { source?: string; effectiveVersion?: string | null };
  themeCssKey?: string;
  /** Stored event handlers for proper cleanup */
  handlers?: {
    domReady: () => void;
    contextMenu: (event: Electron.Event, params: Electron.ContextMenuParams) => void;
    renderProcessGone: (event: Electron.Event, details: Electron.RenderProcessGoneDetails) => void;
  };
}

export type NativePanelSlotBounds = ViewBounds;
export type NativePanelSlotSyncResult =
  | { status: "bound" | "updated" }
  | { status: "missing"; reason: string };

interface NativePanelSlotState {
  nativeSlotId: string;
  panelId: string;
  bounds: ViewBounds;
  focused: boolean;
  ownerViewId: string;
  ownerGeneration: number;
}

interface NativePanelSlotModel {
  hostedShellReady: boolean;
  activeSlots: Map<string, NativePanelSlotState>;
  panelToSlot: Map<string, string>;
  focusedNativeSlotId: string | null;
  activeHostedShellViewId: string | null;
  hostedShellGeneration: number;
}

/**
 * ViewManager manages all WebContentsViews within a BaseWindow.
 *
 * The shell view (React UI) is created first and fills the window.
 * Panel and browser views are layered on top at specific bounds.
 */
/** Layout configuration for panel content area */
export interface LayoutState {
  titleBarHeight: number;
  sidebarVisible: boolean;
  sidebarWidth: number;
  /** Height of save-password bar (0 when hidden) */
  saveBarHeight: number;
  /** Height of notification bar (0 when hidden) */
  notificationBarHeight: number;
  /** Height of consent approval bar (0 when hidden) */
  consentBarHeight: number;
}

export class ViewManager {
  private window: BaseWindow;
  private views = new Map<string, ManagedView>();
  private shellView: WebContentsView;
  private nativeShellOverlay: ShellOverlayView;
  private currentThemeCss: string | null = null;
  /** Per-view locks to prevent concurrent withViewVisible operations */
  private visibilityLocks = new Map<string, Promise<unknown>>();
  /** Current layout state for calculating panel bounds */
  private layoutState: LayoutState = {
    titleBarHeight: 32,
    sidebarVisible: false,
    sidebarWidth: 260,
    saveBarHeight: 0,
    notificationBarHeight: 0,
    consentBarHeight: 0,
  };
  private panelViewportBounds: ViewBounds | null = null;
  /** ID of the currently visible panel (to apply bounds updates) */
  private visiblePanelId: string | null = null;
  private nativePanelSlots: NativePanelSlotModel = {
    hostedShellReady: false,
    activeSlots: new Map(),
    panelToSlot: new Map(),
    focusedNativeSlotId: null,
    activeHostedShellViewId: null,
    hostedShellGeneration: 0,
  };
  private readonly hidePanelViewsUntilHostedShellReady: boolean;
  /**
   * Slot bindings remembered across panel view destroy/recreate (same panelId).
   * The hosted shell believes these panels are still bound and will not issue
   * another bind on its own, so main re-applies the binding when the view
   * reappears.
   */
  private pendingSlotRestores = new Map<string, NativePanelSlotState>();
  /** Whether a shell overlay (dialog) is active — panel views are hidden while true */
  private shellOverlayActive = false;

  // View protection state
  private protectedViewIds = new Set<string>();
  private crashCallbacks: Array<(viewId: string, reason: string) => void> = [];
  private windowVisible = true;
  /** Reverse index for O(1) IPC sender webContents lookup */
  private webContentsIdToViewId = new Map<number, string>();
  /** Callbacks invoked after view z-order changes */
  private viewOrderChangedCallbacks: Array<() => void> = [];
  /** Callbacks invoked when a panel view is hidden */
  private viewHiddenCallbacks: Array<(viewId: string) => void> = [];
  /** Timer for periodic gentle compositor keepalive */
  private compositorKeepaliveTimer: ReturnType<typeof setInterval> | null = null;
  /** Timer for periodic compositor stall detection via capturePage */
  private compositorStallDetectorTimer: ReturnType<typeof setTimeout> | null = null;
  // capturePage is a real GPU readback; back off while probes keep coming
  // back healthy, reset on focus/stall so recovery stays prompt.
  private readonly STALL_PROBE_MIN_INTERVAL_MS = 10000;
  private readonly STALL_PROBE_MAX_INTERVAL_MS = 60000;
  private stallProbeIntervalMs = 10000;
  /** Timestamp of last visibility cycle per view, for cooldown to prevent feedback loops */
  private lastVisibilityCycleTimeByView = new Map<string, number>();

  constructor(options: {
    window: BaseWindow;
    shellPreload: string;
    shellOverlayPreload?: string;
    shellHtmlPath: string;
    shellAdditionalArguments?: string[];
    devTools?: boolean;
    showWindowOnShellLoad?: boolean;
    hidePanelViewsUntilHostedShellReady?: boolean;
  }) {
    this.window = options.window;
    this.hidePanelViewsUntilHostedShellReady = options.hidePanelViewsUntilHostedShellReady ?? false;
    // Create the minimal shipped bootstrap launch gate. The full shell is a
    // workspace app; this surface only owns host-target startup approval.
    this.shellView = new WebContentsView({
      webPreferences: {
        preload: options.shellPreload,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        additionalArguments: options.shellAdditionalArguments,
      },
    });
    this.nativeShellOverlay = new ShellOverlayView(
      options.shellOverlayPreload ?? options.shellPreload,
      (event) => {
        // Route overlay events (e.g. suggestion clicks) to the renderer that owns
        // the address bar — the hosted shell app view when ready, otherwise the
        // bootstrap shell. Sending only to the bootstrap shell meant clicks were
        // silently dropped while the hosted shell was active.
        this.getShellChromeWebContents()?.send("natstack:shell-overlay:event", event);
      }
    );
    this.nativeShellOverlay.setWindow(this.window);

    // Add shell to window and set it to fill
    this.window.contentView.addChildView(this.shellView);
    this.updateShellBounds();

    // Track shell view
    this.views.set("shell", {
      id: "shell",
      view: this.shellView,
      type: "shell",
      visible: true,
      bounds: { x: 0, y: 0, width: 0, height: 0 },
      injectHostThemeVariables: false,
      appCapabilities: [],
      hostChrome: false,
    });
    this.webContentsIdToViewId.set(this.shellView.webContents.id, "shell");

    // Load shell HTML
    void this.shellView.webContents.loadFile(options.shellHtmlPath);

    // Show window and finalize bounds after shell content loads
    this.shellView.webContents.on("did-finish-load", () => {
      this.updateShellBounds();
      // Show window now that content is ready (avoids layout flash)
      if (options.showWindowOnShellLoad !== false && !this.window.isVisible()) {
        this.window.show();
      }
    });

    if (options.devTools) {
      this.shellView.webContents.openDevTools();
    }

    // Set up standard browser context menu for shell
    this.shellView.webContents.on("context-menu", (_event, params) => {
      const menuItems = this.buildContextMenuItems(params, this.shellView.webContents);
      if (menuItems.length > 0) {
        const menu = Menu.buildFromTemplate(menuItems);
        this.popupWebContentsContextMenu(menu, params, this.views.get("shell")?.bounds);
      }
    });

    this.shellView.webContents.on("before-input-event", (event, input) => {
      if (this.hidePanelViewsUntilHostedShellReady && !this.nativePanelSlots.hostedShellReady) {
        return;
      }
      const panelId = this.getFocusedPanelId();
      if (!panelId || this.nativeShellOverlay.isVisible()) return;
      const focused = electronWebContents.getFocusedWebContents();
      if (focused && focused.id !== this.shellView.webContents.id) return;
      const managed = this.views.get(panelId);
      if (!managed || !managed.visible || managed.view.webContents.isDestroyed()) return;
      managed.view.webContents.focus();
      managed.view.webContents.sendInputEvent({
        type: input.type,
        keyCode: input.key,
        modifiers: input.modifiers,
        isAutoRepeat: input.isAutoRepeat,
      } as Electron.KeyboardInputEvent);
      event.preventDefault();
    });

    // Update shell and panel bounds when window resizes
    this.window.on("resize", () => {
      this.updateShellBounds();
      this.updateHostChromeBounds();
      this.refreshActivePanelSlots();
    });

    // Track window visibility for protected view management
    this.window.on("hide", () => this.handleWindowVisibility(false));
    this.window.on("show", () => this.handleWindowVisibility(true));
    this.window.on("minimize", () => this.handleWindowVisibility(false));
    this.window.on("restore", () => this.handleWindowVisibility(true));

    // Compositor probes are focus-gated (no GPU readbacks while the user is
    // elsewhere); on refocus, reset the probe backoff and check immediately
    // so a stall that happened in the background recovers right away.
    this.window.on("focus", () => {
      this.stallProbeIntervalMs = this.STALL_PROBE_MIN_INTERVAL_MS;
      this.keepCompositorAlive();
      void this.detectAndRecoverStall();
    });

    // Start compositor keepalive to prevent layer painting stalls
    this.startCompositorKeepalive();
    // Start stall detector — capturePage probe for aggressive recovery
    this.startCompositorStallDetector();
  }

  private handleWindowVisibility(visible: boolean): void {
    this.windowVisible = visible;
    // When window is hidden, force visibility on protected views to prevent throttling
    if (!visible) {
      this.applyProtectionToViews();
      return;
    }
    this.updateShellBounds();
    this.updateHostChromeBounds();
    this.refreshVisiblePanel();
  }

  private updateShellBounds(): void {
    const size = this.window.getContentSize();
    const width = size[0] ?? 0;
    const height = size[1] ?? 0;
    this.shellView.setBounds({ x: 0, y: 0, width, height });
  }

  private fullWindowBounds(): ViewBounds {
    const size = this.window.getContentSize();
    return { x: 0, y: 0, width: size[0] ?? 0, height: size[1] ?? 0 };
  }

  private updateHostChromeBounds(): void {
    const bounds = this.fullWindowBounds();
    for (const managed of this.views.values()) {
      if (!managed.hostChrome || !managed.visible) continue;
      managed.bounds = bounds;
      managed.view.setBounds(bounds);
    }
  }

  /**
   * Get the shell WebContents (for IPC communication with renderer).
   */
  getShellWebContents(): WebContents {
    return this.shellView.webContents;
  }

  /**
   * Create a new view for a panel or browser.
   *
   * The view starts invisible and positioned at 0,0 with 0x0 size.
   * Call setViewBounds() and setViewVisible() to position and show it.
   */
  createView(config: ViewConfig): WebContentsView {
    if (this.views.has(config.id)) {
      throw new Error(`View already exists: ${config.id}`);
    }

    // Create session - use partition if specified, otherwise default session.
    // Browser panels share BROWSER_SESSION_PARTITION for cookies/auth.
    // Workspace panels use the default session (no external sites).
    const ses = config.partition ? session.fromPartition(config.partition) : session.defaultSession;

    // All panels run in safe sandboxed mode
    const webPreferences: Electron.WebPreferences = {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      session: ses,
      webviewTag: false,
      // Allow Chromium to throttle hidden views (saves CPU/battery).
      // Compositor stalls on *visible* panels are handled by the periodic
      // keepalive and forceRepaint, not this setting.
      backgroundThrottling: true,
    };

    // Set preload if explicitly provided (e.g. adblock preload for browser panels)
    if (config.preload) {
      webPreferences.preload = config.preload;
    }

    const view = new WebContentsView({ webPreferences });

    // Start invisible at origin with zero size
    view.setBounds({ x: 0, y: 0, width: 0, height: 0 });
    view.setVisible(false);

    // Add to window's content view. This appends at the top of the stack, so
    // re-assert layer order below once the view is tracked.
    this.window.contentView.addChildView(view);

    const hostChrome =
      config.type === "app" &&
      (config.hostChrome ?? false) &&
      isAuthorizedChromeAppCaller(config.id, config.appIdentity?.source);

    // Track the managed view
    const managed: ManagedView = {
      id: config.id,
      view,
      type: config.type,
      parentId: config.parentId,
      visible: false,
      bounds: { x: 0, y: 0, width: 0, height: 0 },
      partition: config.partition,
      injectHostThemeVariables: config.injectHostThemeVariables ?? true,
      appCapabilities: config.type === "app" ? [...(config.appCapabilities ?? [])] : [],
      hostChrome,
      appIdentity: config.type === "app" ? config.appIdentity : undefined,
    };
    this.views.set(config.id, managed);
    this.webContentsIdToViewId.set(view.webContents.id, config.id);
    log.verbose(
      ` Created view for ${config.id}, type: ${config.type}, url: ${config.url?.slice(0, 80)}...`
    );

    // Load URL if provided
    if (config.url) {
      void view.webContents.loadURL(config.url);
    }

    // Create named handlers for proper cleanup in destroyView
    const handlers = {
      domReady: () => {
        if (managed.injectHostThemeVariables && this.currentThemeCss) {
          this.applyThemeCss(config.id);
        }
      },
      contextMenu: (_event: Electron.Event, params: Electron.ContextMenuParams) => {
        const menuItems = this.buildContextMenuItems(params, view.webContents);
        if (menuItems.length > 0) {
          const menu = Menu.buildFromTemplate(menuItems);
          this.popupWebContentsContextMenu(menu, params, managed.bounds);
        }
      },
      renderProcessGone: (_event: Electron.Event, details: Electron.RenderProcessGoneDetails) => {
        if (managed.type === "app" && this.nativePanelSlots.activeHostedShellViewId === config.id) {
          this.nativePanelSlots.hostedShellReady = false;
          this.clearAllPanelSlots();
          managed.visible = false;
          managed.view.setVisible(false);
          this.shellView.setVisible(true);
          this.reconcileNativeLayerOrder();
        }
        if (["crashed", "oom", "launch-failed"].includes(details.reason)) {
          for (const cb of this.crashCallbacks) {
            cb(config.id, details.reason);
          }
        }
      },
    };

    managed.handlers = handlers;

    // Apply theme CSS when ready
    view.webContents.on("dom-ready", handlers.domReady);

    // Set up standard browser context menu
    view.webContents.on("context-menu", handlers.contextMenu);

    // Listen for render process crashes
    view.webContents.on("render-process-gone", handlers.renderProcessGone);

    // Apply protection if this view is in the protected set
    // (handles case where view is recreated after crash while still protected)
    if (this.protectedViewIds.has(config.id)) {
      this.setViewProtection(config.id, true);
    }

    if (config.type === "panel") {
      this.restorePanelSlotIfPending(config.id, managed);
    }

    if (this.nativePanelSlots.activeSlots.size > 0 || this.visiblePanelId) {
      this.reconcileNativeLayerOrder();
    }

    return view;
  }

  /**
   * Re-apply a remembered slot binding to a recreated panel view. Without
   * this, a destroy/recreate (crash recovery, lease release, snapshot replace)
   * leaves the new view invisible while the hosted shell's surface still
   * believes it is bound and never rebinds.
   */
  private restorePanelSlotIfPending(panelId: string, managed: ManagedView): void {
    const slot = this.pendingSlotRestores.get(panelId);
    if (!slot) return;
    this.pendingSlotRestores.delete(panelId);

    if (
      !this.nativePanelSlots.hostedShellReady ||
      slot.ownerGeneration !== this.nativePanelSlots.hostedShellGeneration ||
      this.nativePanelSlots.activeSlots.has(slot.nativeSlotId)
    ) {
      return;
    }

    log.verbose(
      ` Restoring native panel slot ${slot.nativeSlotId} -> ${panelId} after view recreation`
    );
    this.nativePanelSlots.activeSlots.set(slot.nativeSlotId, slot);
    this.nativePanelSlots.panelToSlot.set(panelId, slot.nativeSlotId);
    this.visiblePanelId = panelId;

    managed.bounds = slot.bounds;
    managed.visible = true;
    managed.view.setBounds(slot.bounds);
    managed.view.setVisible(!this.shellOverlayActive);
    if (slot.focused) {
      this.setFocusedNativePanelSlot(slot.nativeSlotId);
    }
    this.reconcileNativeLayerOrder();
  }

  /**
   * Build standard browser context menu items based on the context.
   */
  private buildContextMenuItems(
    params: Electron.ContextMenuParams,
    contents: WebContents
  ): MenuItemConstructorOptions[] {
    const items: MenuItemConstructorOptions[] = [];

    // Undo/Redo for editable fields
    if (params.isEditable) {
      if (params.editFlags.canUndo) {
        items.push({ label: "Undo", role: "undo" });
      }
      if (params.editFlags.canRedo) {
        items.push({ label: "Redo", role: "redo" });
      }
      if (items.length > 0) {
        items.push({ type: "separator" });
      }
    }

    // Cut/Copy/Paste
    if (params.isEditable && params.editFlags.canCut) {
      items.push({ label: "Cut", role: "cut" });
    }
    if (params.selectionText && params.editFlags.canCopy) {
      items.push({ label: "Copy", role: "copy" });
    }
    if (params.isEditable && params.editFlags.canPaste) {
      items.push({ label: "Paste", role: "paste" });
    }
    if (params.isEditable && params.editFlags.canDelete) {
      items.push({ label: "Delete", role: "delete" });
    }

    // Select All
    if (params.editFlags.canSelectAll) {
      if (items.length > 0) {
        items.push({ type: "separator" });
      }
      items.push({ label: "Select All", role: "selectAll" });
    }

    if (params.linkURL) {
      if (items.length > 0) items.push({ type: "separator" });
      items.push(
        { label: "Copy Link", click: () => clipboard.writeText(params.linkURL) },
        {
          label: "Open Link Externally",
          click: () => {
            void shell.openExternal(params.linkURL);
          },
        }
      );
    }

    if (params.srcURL) {
      if (items.length > 0) items.push({ type: "separator" });
      items.push({ label: "Copy Media URL", click: () => clipboard.writeText(params.srcURL) });
    }

    if (!params.isEditable) {
      if (items.length > 0) items.push({ type: "separator" });
      items.push(
        {
          label: "Back",
          enabled: contents.navigationHistory.canGoBack(),
          click: () => contents.navigationHistory.goBack(),
        },
        {
          label: "Forward",
          enabled: contents.navigationHistory.canGoForward(),
          click: () => contents.navigationHistory.goForward(),
        },
        { label: "Reload", click: () => contents.reload() },
        { label: "Copy Page Address", click: () => clipboard.writeText(contents.getURL()) }
      );
    }

    // Inspect Element (always available)
    if (items.length > 0) {
      items.push({ type: "separator" });
    }
    items.push({
      label: "Inspect",
      click: () => {
        contents.inspectElement(params.x, params.y);
      },
    });

    return items;
  }

  private popupWebContentsContextMenu(
    menu: Menu,
    params: Electron.ContextMenuParams,
    bounds?: ViewBounds
  ): void {
    menu.popup({
      window: this.window,
      frame: params.frame ?? undefined,
      sourceType: params.menuSourceType,
      x: Math.round((bounds?.x ?? 0) + params.x),
      y: Math.round((bounds?.y ?? 0) + params.y),
    });
  }

  /**
   * Destroy a view and remove it from the window.
   */
  destroyView(id: string): void {
    const managed = this.views.get(id);
    if (!managed) {
      return;
    }

    if (managed.type === "app" && this.nativePanelSlots.activeHostedShellViewId === id) {
      this.setHostedShellReady(id, false);
    }
    if (managed.type === "panel") {
      const nativeSlotId = this.nativePanelSlots.panelToSlot.get(id);
      if (nativeSlotId) {
        // Remember the binding so a recreated view for the same panel is
        // re-slotted automatically — the hosted shell still believes the
        // panel is bound and will not issue another bind on its own.
        const slot = this.nativePanelSlots.activeSlots.get(nativeSlotId);
        if (slot) this.pendingSlotRestores.set(id, { ...slot, bounds: { ...slot.bounds } });
        this.clearPanelSlotInternal(nativeSlotId, { notifyHidden: false });
      }
    }

    this.webContentsIdToViewId.delete(managed.view.webContents.id);
    this.lastVisibilityCycleTimeByView.delete(id);

    // View destruction is a normal operation - no need to log

    // Remove only our specific handlers (not others' listeners)
    if (managed.handlers && !managed.view.webContents.isDestroyed()) {
      managed.view.webContents.off("dom-ready", managed.handlers.domReady);
      managed.view.webContents.off("context-menu", managed.handlers.contextMenu);
      managed.view.webContents.off("render-process-gone", managed.handlers.renderProcessGone);
    }

    // Remove from window
    this.window.contentView.removeChildView(managed.view);

    // Close the webContents
    if (!managed.view.webContents.isDestroyed()) {
      managed.view.webContents.close();
    }

    this.views.delete(id);
  }

  /**
   * Set bounds for a view. Called from renderer when layout changes.
   */
  setViewBounds(id: string, bounds: ViewBounds): void {
    const managed = this.views.get(id);
    if (!managed) {
      console.warn(`[ViewManager] View not found: ${id}`);
      return;
    }

    managed.bounds = bounds;
    managed.view.setBounds(
      this.shouldHidePanelViewForBootstrap(managed) ? this.hiddenBounds() : bounds
    );
  }

  setPanelViewportBounds(bounds: ViewBounds | null): void {
    this.panelViewportBounds = bounds ? this.normalizeBounds(bounds) : null;
    this.applyBoundsToVisiblePanel();
  }

  setHostedShellReady(ownerViewId: string, ready: boolean): void {
    const owner = this.views.get(ownerViewId);
    if (!owner || owner.type !== "app" || !owner.hostChrome) {
      throw new Error(`Hosted shell owner is not an active panel-hosting app: ${ownerViewId}`);
    }

    if (ready) {
      // Shell chrome (with the address bar) is up — create + load the hidden
      // suggestion overlay now so its first show doesn't create/load the view on
      // demand, which stole focus from the address input the first time.
      this.nativeShellOverlay.prewarm();
      if (
        this.nativePanelSlots.activeHostedShellViewId === ownerViewId &&
        this.nativePanelSlots.hostedShellReady
      ) {
        // Redundant readiness assertion from the already-active shell document
        // (e.g. a late effect after the shell's panel surfaces have bound).
        // Keep existing slots — clearing here hides bound panels the shell
        // still believes are bound, with no signal that would make it rebind.
        log.verbose(
          ` Hosted shell ready reasserted by ${ownerViewId} (gen ${this.nativePanelSlots.hostedShellGeneration}); keeping ${this.nativePanelSlots.activeSlots.size} slot(s)`
        );
        this.shellView.setVisible(false);
        this.setViewVisible(ownerViewId, true);
        this.refreshActivePanelSlots();
        return;
      }
      this.nativePanelSlots.hostedShellGeneration += 1;
      log.verbose(
        ` Hosted shell ready: ${ownerViewId} (gen ${this.nativePanelSlots.hostedShellGeneration}); clearing ${this.nativePanelSlots.activeSlots.size} slot(s)`
      );
      this.clearAllPanelSlots();
      this.nativePanelSlots.activeHostedShellViewId = ownerViewId;
      this.nativePanelSlots.hostedShellReady = true;
      this.shellView.setVisible(false);
      this.setViewVisible(ownerViewId, true);
      this.reconcileNativeLayerOrder();
      return;
    }

    if (
      this.nativePanelSlots.activeHostedShellViewId &&
      this.nativePanelSlots.activeHostedShellViewId !== ownerViewId
    ) {
      throw new Error(
        `Hosted shell owner mismatch: active=${this.nativePanelSlots.activeHostedShellViewId} caller=${ownerViewId}`
      );
    }

    log.verbose(
      ` Hosted shell not ready: ${ownerViewId}; clearing ${this.nativePanelSlots.activeSlots.size} slot(s)`
    );
    this.nativePanelSlots.hostedShellReady = false;
    this.clearAllPanelSlots();
    owner.visible = false;
    owner.view.setVisible(false);
    this.shellView.setVisible(true);
    this.reconcileNativeLayerOrder();
  }

  bindPanelSlot(
    ownerViewId: string,
    request: {
      nativeSlotId: string;
      panelId: string;
      bounds: NativePanelSlotBounds;
      focused?: boolean;
    }
  ): void {
    this.assertActiveHostedShellOwner(ownerViewId);
    const nativeSlotId = this.validateNonEmptyId(request.nativeSlotId, "nativeSlotId");
    const panelId = this.validateNonEmptyId(request.panelId, "panelId");
    const managed = this.views.get(panelId);
    if (!managed || managed.type !== "panel") {
      throw new Error(`Native panel slot target is not a panel view: ${panelId}`);
    }

    const existingSlotForPanel = this.nativePanelSlots.panelToSlot.get(panelId);
    if (existingSlotForPanel && existingSlotForPanel !== nativeSlotId) {
      const message = `Panel ${panelId} is already bound to native slot ${existingSlotForPanel}; cannot bind to ${nativeSlotId}`;
      console.warn(`[ViewManager] ${message}`);
      throw new Error(message);
    }

    // A fresh bind supersedes any remembered binding for this panel or slot.
    this.pendingSlotRestores.delete(panelId);
    for (const [pendingPanelId, pending] of this.pendingSlotRestores) {
      if (pending.nativeSlotId === nativeSlotId) this.pendingSlotRestores.delete(pendingPanelId);
    }

    const previousSlot = this.nativePanelSlots.activeSlots.get(nativeSlotId);
    if (previousSlot && previousSlot.panelId !== panelId) {
      this.clearPanelSlotInternal(nativeSlotId);
    }

    log.verbose(` Bind native panel slot ${nativeSlotId} -> ${panelId}`);
    const bounds = this.normalizeAndClampPanelSlotBounds(request.bounds);
    const generation = this.nativePanelSlots.hostedShellGeneration;
    const focused = request.focused === true;
    this.nativePanelSlots.activeSlots.set(nativeSlotId, {
      nativeSlotId,
      panelId,
      bounds,
      focused,
      ownerViewId,
      ownerGeneration: generation,
    });
    this.nativePanelSlots.panelToSlot.set(panelId, nativeSlotId);
    this.visiblePanelId = panelId;

    managed.bounds = bounds;
    managed.visible = true;
    managed.view.setBounds(bounds);
    managed.view.setVisible(!this.shellOverlayActive);

    if (focused) {
      this.setFocusedNativePanelSlot(nativeSlotId);
    } else if (this.nativePanelSlots.focusedNativeSlotId === nativeSlotId) {
      this.nativePanelSlots.focusedNativeSlotId = null;
    }
    this.reconcileNativeLayerOrder();
  }

  updatePanelSlot(
    ownerViewId: string,
    request: { nativeSlotId: string; bounds?: NativePanelSlotBounds; focused?: boolean }
  ): NativePanelSlotSyncResult {
    this.assertActiveHostedShellOwner(ownerViewId);
    const nativeSlotId = this.validateNonEmptyId(request.nativeSlotId, "nativeSlotId");
    const slot = this.nativePanelSlots.activeSlots.get(nativeSlotId);
    if (!slot) {
      const reason = `unknown native panel slot: ${nativeSlotId}`;
      log.verbose(`Ignoring update for ${reason}`);
      return { status: "missing", reason };
    }
    this.assertSlotOwner(slot, ownerViewId);

    const managed = this.views.get(slot.panelId);
    if (!managed || managed.type !== "panel") {
      this.clearPanelSlotInternal(nativeSlotId);
      return {
        status: "missing",
        reason: `native panel slot target is no longer a panel view: ${slot.panelId}`,
      };
    }

    if (request.bounds) {
      const bounds = this.normalizeAndClampPanelSlotBounds(request.bounds);
      slot.bounds = bounds;
      managed.bounds = bounds;
      managed.view.setBounds(bounds);
    }
    if (typeof request.focused === "boolean") {
      slot.focused = request.focused;
      if (request.focused) {
        this.setFocusedNativePanelSlot(nativeSlotId);
      } else if (this.nativePanelSlots.focusedNativeSlotId === nativeSlotId) {
        this.nativePanelSlots.focusedNativeSlotId = null;
      }
    }
    this.reconcileNativeLayerOrder();
    return { status: "updated" };
  }

  clearPanelSlot(ownerViewId: string, nativeSlotId: string): void {
    this.assertActiveHostedShellOwner(ownerViewId);
    const slot = this.nativePanelSlots.activeSlots.get(nativeSlotId);
    if (slot) this.assertSlotOwner(slot, ownerViewId);
    log.verbose(` Clear native panel slot ${nativeSlotId} (was ${slot?.panelId ?? "empty"})`);
    // The shell explicitly released this slot — drop any remembered binding.
    for (const [pendingPanelId, pending] of this.pendingSlotRestores) {
      if (pending.nativeSlotId === nativeSlotId) this.pendingSlotRestores.delete(pendingPanelId);
    }
    this.clearPanelSlotInternal(nativeSlotId);
    this.reconcileNativeLayerOrder();
  }

  clearAllPanelSlots(): void {
    if (this.nativePanelSlots.activeSlots.size > 0 || this.pendingSlotRestores.size > 0) {
      log.verbose(
        ` Clear all native panel slots (${this.nativePanelSlots.activeSlots.size} active, ${this.pendingSlotRestores.size} pending restore)`
      );
    }
    this.pendingSlotRestores.clear();
    for (const nativeSlotId of Array.from(this.nativePanelSlots.activeSlots.keys())) {
      this.clearPanelSlotInternal(nativeSlotId);
    }
    this.nativePanelSlots.focusedNativeSlotId = null;
    this.visiblePanelId = null;
    this.reconcileNativeLayerOrder();
  }

  /**
   * Forward a shell-layer click into an embedded view. This covers platforms
   * where a WebContentsView paints above the shell but native hit-testing still
   * leaves the shell WebContents as the click target.
   */
  forwardMouseClick(id: string, point: { x: number; y: number }): boolean {
    const managed = this.views.get(id);
    if (!managed || managed.view.webContents.isDestroyed()) return false;
    const { bounds } = managed;
    if (
      point.x < bounds.x ||
      point.y < bounds.y ||
      point.x >= bounds.x + bounds.width ||
      point.y >= bounds.y + bounds.height
    ) {
      return false;
    }
    const x = Math.round(point.x - bounds.x);
    const y = Math.round(point.y - bounds.y);
    const wc = managed.view.webContents;
    wc.focus();
    wc.sendInputEvent({ type: "mouseDown", x, y, button: "left", clickCount: 1 });
    wc.sendInputEvent({ type: "mouseUp", x, y, button: "left", clickCount: 1 });
    return true;
  }

  /**
   * Set visibility of a view.
   */
  setViewVisible(id: string, visible: boolean): void {
    const managed = this.views.get(id);
    if (!managed) {
      if (!visible) {
        return;
      }
      console.warn(`[ViewManager] View not found: ${id}`);
      return;
    }

    managed.visible = visible;

    if (visible && managed.hostChrome) {
      const bounds = this.fullWindowBounds();
      managed.bounds = bounds;
      managed.view.setBounds(bounds);
      managed.view.setVisible(true);
      this.reconcileNativeLayerOrder();
      this.focusVisibleView(managed);
    } else if (visible && managed.type !== "shell") {
      // Track visible panel and apply calculated bounds
      this.visiblePanelId = id;
      const bounds = this.calculatePanelBounds();
      managed.bounds = bounds;
      managed.view.setBounds(bounds);

      // Keep tracking the selected panel, but do not let startup panels paint
      // or reserve hit-test space above/below the launch gate.
      if (this.applyNativePanelVisibility(managed, bounds)) {
        this.focusVisibleView(managed);
      }
      this.reconcileNativeLayerOrder();
    } else {
      managed.view.setVisible(visible);
      if (!visible && this.visiblePanelId === id) {
        this.visiblePanelId = null;
        // Notify listeners (e.g., autofill overlay dismissal)
        for (const cb of this.viewHiddenCallbacks) {
          cb(id);
        }
      }
    }
  }

  /**
   * Toggle shell overlay mode. When active, the visible panel is hidden so
   * shell-rendered dialogs (workspace chooser, wizard, etc.) are not obscured
   * by the native-layer panel WebContentsView. When deactivated, the panel
   * is re-shown at its previous bounds.
   */
  setShellOverlayActive(active: boolean): void {
    if (this.shellOverlayActive === active) return;
    this.shellOverlayActive = active;

    if (this.nativePanelSlots.activeSlots.size > 0) {
      this.refreshActivePanelSlots();
      return;
    }
    this.applyBoundsToVisiblePanel();
    this.reconcileNativeLayerOrder();
  }

  private focusVisibleView(managed: ManagedView): void {
    if (this.nativeShellOverlay.isVisible()) return;
    const wc = managed.view.webContents;
    if (wc.isDestroyed()) return;
    wc.focus();
  }

  /**
   * The webContents that hosts the shell chrome (address bar, breadcrumbs): the
   * hosted shell app view when ready, otherwise the bootstrap shell view. Overlay
   * events and focus restoration must target this, not always the bootstrap shell.
   */
  private getShellChromeWebContents() {
    const hostId = this.nativePanelSlots.hostedShellReady
      ? this.nativePanelSlots.activeHostedShellViewId
      : null;
    const hosted = hostId ? this.views.get(hostId) : undefined;
    if (hosted && !hosted.view.webContents.isDestroyed()) return hosted.view.webContents;
    if (!this.shellView.webContents.isDestroyed()) return this.shellView.webContents;
    return null;
  }

  showNativeShellOverlay(options: ShellOverlayOptions): void {
    // Mirror the autofill overlay (which keeps the page input focused): just show
    // and raise the view. Running refreshActivePanelSlots()/reconcileNativeLayerOrder()
    // here re-stacks the managed views and steals focus from the hosted shell's
    // address input the moment the suggestion box appears.
    this.nativeShellOverlay.show(options);
  }

  updateNativeShellOverlay(options: Partial<ShellOverlayOptions> & { id?: string }): void {
    // Updates only push row data (and maybe resize) to the already-shown overlay.
    // No native re-stacking happens, so there's nothing to reconcile or refocus —
    // keeping this light is what stops the address input losing focus per keystroke.
    this.nativeShellOverlay.update(options);
  }

  hideNativeShellOverlay(id?: string): void {
    this.nativeShellOverlay.hide(id);
    this.refreshActivePanelSlots();
    this.reconcileNativeLayerOrder();
  }

  isNativeShellOverlayVisible(): boolean {
    return this.nativeShellOverlay.isVisible();
  }

  private shouldHidePanelViewForBootstrap(managed: ManagedView): boolean {
    return (
      this.hidePanelViewsUntilHostedShellReady &&
      managed.type === "panel" &&
      !this.nativePanelSlots.hostedShellReady
    );
  }

  private hiddenBounds(): ViewBounds {
    return { x: 0, y: 0, width: 0, height: 0 };
  }

  private applyNativePanelVisibility(managed: ManagedView, bounds: ViewBounds): boolean {
    if (this.shouldHidePanelViewForBootstrap(managed)) {
      managed.view.setBounds(this.hiddenBounds());
      managed.view.setVisible(false);
      return false;
    }
    managed.view.setBounds(bounds);
    if (this.shellOverlayActive) {
      managed.view.setVisible(false);
      return false;
    }
    managed.view.setVisible(true);
    return true;
  }

  /**
   * Calculate the bounds for the panel content area based on current layout state.
   */
  private calculatePanelBounds(): ViewBounds {
    if (this.panelViewportBounds) {
      return this.clampPanelBoundsToChrome(this.panelViewportBounds);
    }

    const size = this.window.getContentSize();
    const windowWidth = size[0] ?? 0;
    const windowHeight = size[1] ?? 0;
    const {
      titleBarHeight,
      sidebarVisible,
      sidebarWidth,
      saveBarHeight,
      notificationBarHeight,
      consentBarHeight,
    } = this.layoutState;
    const effectiveSidebarWidth = sidebarVisible ? sidebarWidth : 0;
    const topOffset = titleBarHeight + notificationBarHeight + saveBarHeight + consentBarHeight;

    return {
      x: effectiveSidebarWidth,
      y: topOffset,
      width: Math.max(0, windowWidth - effectiveSidebarWidth),
      height: Math.max(0, windowHeight - topOffset),
    };
  }

  /**
   * Update layout state and recalculate bounds for the visible panel.
   * Called from renderer when sidebar visibility or width changes.
   */
  updateLayout(update: Partial<LayoutState>): void {
    Object.assign(this.layoutState, update);
    this.applyBoundsToVisiblePanel();
  }

  private normalizeBounds(bounds: ViewBounds): ViewBounds {
    return {
      x: Math.max(0, Math.round(bounds.x)),
      y: Math.max(0, Math.round(bounds.y)),
      width: Math.max(0, Math.round(bounds.width)),
      height: Math.max(0, Math.round(bounds.height)),
    };
  }

  private validateNonEmptyId(id: string, label: string): string {
    if (typeof id !== "string" || id.trim().length === 0) {
      throw new Error(`${label} must be a non-empty string`);
    }
    return id;
  }

  private assertActiveHostedShellOwner(ownerViewId: string): void {
    if (!this.nativePanelSlots.hostedShellReady) {
      throw new Error("Hosted shell is not ready for native panel slots");
    }
    if (this.nativePanelSlots.activeHostedShellViewId !== ownerViewId) {
      throw new Error(
        `Native panel slot caller is not active hosted shell: active=${this.nativePanelSlots.activeHostedShellViewId} caller=${ownerViewId}`
      );
    }
  }

  private assertSlotOwner(slot: NativePanelSlotState, ownerViewId: string): void {
    if (
      slot.ownerViewId !== ownerViewId ||
      slot.ownerGeneration !== this.nativePanelSlots.hostedShellGeneration
    ) {
      throw new Error(
        `Native panel slot owner mismatch: slot=${slot.nativeSlotId} owner=${slot.ownerViewId}/${slot.ownerGeneration} caller=${ownerViewId}/${this.nativePanelSlots.hostedShellGeneration}`
      );
    }
  }

  private normalizeAndClampPanelSlotBounds(bounds: ViewBounds): ViewBounds {
    for (const [key, value] of Object.entries(bounds)) {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new Error(`Native panel slot bounds.${key} must be finite`);
      }
    }
    if (bounds.width <= 0 || bounds.height <= 0) {
      throw new Error("Native panel slot bounds must have positive width and height");
    }
    const normalized = this.normalizeBounds(bounds);
    const [windowWidth = 0, windowHeight = 0] = this.window.getContentSize();
    return {
      x: Math.min(normalized.x, Math.max(0, windowWidth)),
      y: Math.min(normalized.y, Math.max(0, windowHeight)),
      width: Math.min(normalized.width, Math.max(0, windowWidth - normalized.x)),
      height: Math.min(normalized.height, Math.max(0, windowHeight - normalized.y)),
    };
  }

  private clearPanelSlotInternal(
    nativeSlotId: string,
    options: { notifyHidden?: boolean } = {}
  ): void {
    const slot = this.nativePanelSlots.activeSlots.get(nativeSlotId);
    if (!slot) return;

    this.nativePanelSlots.activeSlots.delete(nativeSlotId);
    this.nativePanelSlots.panelToSlot.delete(slot.panelId);
    if (this.nativePanelSlots.focusedNativeSlotId === nativeSlotId) {
      this.nativePanelSlots.focusedNativeSlotId = null;
    }
    if (this.visiblePanelId === slot.panelId) {
      this.visiblePanelId = this.getFocusedPanelId();
    }

    const managed = this.views.get(slot.panelId);
    if (managed) {
      managed.visible = false;
      managed.view.setVisible(false);
      if (options.notifyHidden !== false) {
        for (const cb of this.viewHiddenCallbacks) {
          cb(slot.panelId);
        }
      }
    }
  }

  private setFocusedNativePanelSlot(nativeSlotId: string): void {
    for (const slot of this.nativePanelSlots.activeSlots.values()) {
      slot.focused = slot.nativeSlotId === nativeSlotId;
    }
    this.nativePanelSlots.focusedNativeSlotId = nativeSlotId;
    const slot = this.nativePanelSlots.activeSlots.get(nativeSlotId);
    if (!slot) return;
    const managed = this.views.get(slot.panelId);
    if (managed) {
      this.visiblePanelId = slot.panelId;
      this.focusVisibleView(managed);
    }
  }

  private getFocusedPanelId(): string | null {
    const focusedSlotId = this.nativePanelSlots.focusedNativeSlotId;
    if (focusedSlotId) {
      return this.nativePanelSlots.activeSlots.get(focusedSlotId)?.panelId ?? null;
    }
    return this.visiblePanelId;
  }

  private chromeTopOffset(): number {
    const { titleBarHeight, saveBarHeight, notificationBarHeight, consentBarHeight } =
      this.layoutState;
    return titleBarHeight + notificationBarHeight + saveBarHeight + consentBarHeight;
  }

  private clampPanelBoundsToChrome(bounds: ViewBounds): ViewBounds {
    const [windowWidth = 0, windowHeight = 0] = this.window.getContentSize();
    const minY = this.chromeTopOffset();
    const y = Math.max(bounds.y, minY);
    const lostHeight = Math.max(0, y - bounds.y);
    const maxWidth = Math.max(0, windowWidth - bounds.x);
    const maxHeight = Math.max(0, windowHeight - y);

    return {
      x: bounds.x,
      y,
      width: Math.min(bounds.width, maxWidth),
      height: Math.min(Math.max(0, bounds.height - lostHeight), maxHeight),
    };
  }

  /**
   * Apply calculated bounds to the currently visible panel.
   */
  private applyBoundsToVisiblePanel(): void {
    if (this.nativePanelSlots.activeSlots.size > 0) {
      return;
    }
    if (!this.visiblePanelId) {
      return;
    }

    const managed = this.views.get(this.visiblePanelId);
    if (!managed || !managed.visible) {
      return;
    }

    const bounds = this.calculatePanelBounds();
    managed.bounds = bounds;
    this.applyNativePanelVisibility(managed, bounds);
  }

  /**
   * Cycle a view's visibility off and on via Electron's raw API to wake a
   * suspended compositor. Both calls happen synchronously in the same tick,
   * so no frame renders between them (no visible flicker). We bypass the
   * managed.visible state tracker intentionally — only the compositor cares.
   */
  private cycleCompositorVisibility(managed: ManagedView): void {
    if (managed.view.webContents.isDestroyed()) return;
    // Cooldown: skip if called within the last 1000ms.
    // Breaks forceRepaint() → visibilitychange → forceRepaint() oscillation.
    const now = Date.now();
    const lastCycleTime = this.lastVisibilityCycleTimeByView.get(managed.id) ?? 0;
    if (now - lastCycleTime < 1000) return;
    this.lastVisibilityCycleTimeByView.set(managed.id, now);
    managed.view.setVisible(false);
    managed.view.setVisible(true);
  }

  /**
   * Single authority for native layer z-order. Every code path that shows,
   * raises, or creates a view routes through here instead of re-adding child
   * views directly — distributed remove/add calls are how the hosted shell
   * ended up stacked over slotted panels. Re-asserts, bottom to top:
   * host chrome app views, the legacy visible panel (no native slot), slotted
   * panels with the focused slot last, then the bootstrap launch gate while
   * the hosted shell is not ready. The gate must stay above fallback panels
   * until a hosted shell explicitly reports ready.
   */
  private reconcileNativeLayerOrder(): void {
    if (this.window.isDestroyed()) return;

    // Compute the desired top-of-stack ordering first (pure), so we can skip
    // the remove/add churn entirely when the layer tree is already correct.
    // Re-stacking is expensive native work and steals focus from input
    // elements, and this runs on every focus/visibility/overlay change.
    const raisedIds = new Set<string>();
    const desired: Electron.View[] = [];
    const plan = (id: string | null | undefined) => {
      if (!id || raisedIds.has(id)) return;
      const managed = this.views.get(id);
      if (!managed) return;
      raisedIds.add(id);
      desired.push(managed.view);
    };

    if (this.nativePanelSlots.hostedShellReady) {
      for (const managed of this.views.values()) {
        if (managed.hostChrome && managed.visible) plan(managed.id);
      }
      plan(this.nativePanelSlots.activeHostedShellViewId);
    }

    const allowFallbackPanels =
      this.nativePanelSlots.hostedShellReady || !this.hidePanelViewsUntilHostedShellReady;

    if (
      allowFallbackPanels &&
      this.visiblePanelId &&
      !this.nativePanelSlots.panelToSlot.has(this.visiblePanelId)
    ) {
      const managed = this.views.get(this.visiblePanelId);
      if (managed?.visible) plan(this.visiblePanelId);
    }

    if (allowFallbackPanels) {
      for (const slot of this.nativePanelSlots.activeSlots.values()) {
        if (slot.nativeSlotId === this.nativePanelSlots.focusedNativeSlotId) continue;
        plan(slot.panelId);
      }
      const focusedSlotId = this.nativePanelSlots.focusedNativeSlotId;
      if (focusedSlotId) {
        plan(this.nativePanelSlots.activeSlots.get(focusedSlotId)?.panelId);
      }
    }
    if (!this.nativePanelSlots.hostedShellReady) {
      plan("shell");
    }

    // No-op check: the layer tree is already correct when (a) the desired
    // views appear in the child list in the desired relative order, and
    // (b) no other *visible managed* view sits above them. Overlay views
    // (shell overlay, autofill dropdown) are unmanaged and always belong on
    // top, so they're ignored here.
    const children = this.window.contentView.children as Electron.View[] | undefined;
    if (children && desired.length > 0) {
      const childIndex = new Map<Electron.View, number>();
      children.forEach((view, i) => childIndex.set(view, i));
      let alreadyOrdered = true;
      let prevIndex = -1;
      for (const view of desired) {
        const idx = childIndex.get(view);
        if (idx === undefined || idx < prevIndex) {
          alreadyOrdered = false;
          break;
        }
        prevIndex = idx;
      }
      if (alreadyOrdered) {
        const firstDesired = desired[0];
        const firstDesiredIndex = firstDesired ? (childIndex.get(firstDesired) ?? 0) : 0;
        for (const managed of this.views.values()) {
          if (raisedIds.has(managed.id) || !managed.visible) continue;
          const idx = childIndex.get(managed.view);
          if (idx !== undefined && idx > firstDesiredIndex) {
            alreadyOrdered = false;
            break;
          }
        }
      }
      if (alreadyOrdered) return;
    }

    for (const view of desired) {
      this.window.contentView.removeChildView(view);
      this.window.contentView.addChildView(view);
    }

    for (const cb of this.viewOrderChangedCallbacks) {
      cb();
    }
    this.nativeShellOverlay.bringToFront();
  }

  /**
   * Register a callback invoked after every native layer-order change.
   * Used by AutofillManager to re-add the dropdown overlay on top.
   */
  onViewOrderChanged(callback: () => void): () => void {
    this.viewOrderChangedCallbacks.push(callback);
    return () => {
      const idx = this.viewOrderChangedCallbacks.indexOf(callback);
      if (idx !== -1) this.viewOrderChangedCallbacks.splice(idx, 1);
    };
  }

  /**
   * Register a callback invoked when a panel view is hidden.
   * Used by AutofillManager to dismiss overlays on panel switch.
   */
  onViewHidden(callback: (viewId: string) => void): () => void {
    this.viewHiddenCallbacks.push(callback);
    return () => {
      const idx = this.viewHiddenCallbacks.indexOf(callback);
      if (idx !== -1) this.viewHiddenCallbacks.splice(idx, 1);
    };
  }

  /**
   * Refresh the currently visible panel by re-establishing its z-order and bounds.
   * Called when a panel receives focus (even if it was already visible).
   * For compositor recovery, use forceRepaint() or forceRepaintVisiblePanel().
   */
  refreshVisiblePanel(): void {
    if (this.nativePanelSlots.activeSlots.size > 0) {
      this.refreshActivePanelSlots();
      return;
    }
    if (!this.visiblePanelId) {
      return;
    }

    const managed = this.views.get(this.visiblePanelId);
    if (!managed || !managed.visible) {
      return;
    }

    // Refresh bounds, raw visibility, and z-order. The tracked visible state can
    // be true while Chromium has dropped the native layer; reasserting
    // setVisible(true) recovers that case without a full visibility cycle.
    const bounds = this.calculatePanelBounds();
    managed.bounds = bounds;
    this.applyNativePanelVisibility(managed, bounds);
    this.reconcileNativeLayerOrder();
  }

  /**
   * Force a repaint of the currently visible panel.
   * Convenience method for menu items that don't know the panel ID.
   */
  forceRepaintVisiblePanel(): boolean {
    if (this.nativePanelSlots.activeSlots.size > 0) {
      let repainted = false;
      for (const slot of this.nativePanelSlots.activeSlots.values()) {
        repainted = this.forceRepaint(slot.panelId) || repainted;
      }
      return repainted;
    }
    const panelId = this.visiblePanelId;
    if (!panelId) return false;
    return this.forceRepaint(panelId);
  }

  refreshActivePanelSlots(): void {
    for (const slot of this.nativePanelSlots.activeSlots.values()) {
      const managed = this.views.get(slot.panelId);
      if (!managed || !managed.visible) continue;
      managed.bounds = slot.bounds;
      managed.view.setBounds(slot.bounds);
      managed.view.setVisible(!this.shellOverlayActive);
    }
    this.reconcileNativeLayerOrder();
  }

  /**
   * Get WebContents for a view (for CDP, IPC, etc.).
   */
  getWebContents(id: string): WebContents | null {
    const managed = this.views.get(id);
    if (!managed) {
      return null;
    }

    const contents = managed.view.webContents;
    return contents.isDestroyed() ? null : contents;
  }

  /**
   * Wait for a webContents to render a frame.
   * Uses requestAnimationFrame via executeJavaScript to ensure compositor has rendered.
   * Falls back to a short timeout if executeJavaScript fails.
   */
  private async waitForRender(contents: WebContents): Promise<void> {
    const startTime = Date.now();

    try {
      // Wait for two animation frames - first schedules, second confirms render
      await contents.executeJavaScript(
        "new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))"
      );
      log.verbose(` waitForRender: frame rendered after ${Date.now() - startTime}ms`);
    } catch (error) {
      // Fall back to a short timeout if executeJavaScript fails (e.g., page not ready)
      console.warn(
        `[ViewManager] waitForRender: executeJavaScript failed, using fallback timeout ` +
          `(webContentsId=${contents.id}, error=${error instanceof Error ? error.message : String(error)})`
      );
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  /**
   * Execute an async operation with a view temporarily made visible.
   * For hidden views, shows them briefly, executes the operation, then restores visibility.
   * This is useful for screenshots and other operations that require the view to be rendered.
   *
   * Uses per-view locking to prevent concurrent calls from interfering with each other.
   */
  async withViewVisible<T>(id: string, operation: () => Promise<T>): Promise<T | null> {
    const managed = this.views.get(id);
    if (!managed) {
      return null;
    }

    // Wait for any pending visibility operation on this view to complete
    const existingLock = this.visibilityLocks.get(id);
    if (existingLock) {
      await existingLock.catch(() => {}); // Ignore errors from previous operation
    }

    // Create a new lock for this operation
    const runOperation = async (): Promise<T | null> => {
      const wasVisible = managed.visible;
      const originalBounds = { ...managed.bounds };

      // If hidden, temporarily show the view
      if (!wasVisible) {
        // Use reasonable bounds if current bounds are zero
        const captureBounds =
          originalBounds.width > 0 && originalBounds.height > 0
            ? originalBounds
            : { x: 0, y: 0, width: 1280, height: 800 };

        managed.view.setBounds(captureBounds);
        managed.view.setVisible(true);

        // Wait for the compositor to render the view
        await this.waitForRender(managed.view.webContents);
      }

      try {
        return await operation();
      } finally {
        // Restore original visibility state
        if (!wasVisible) {
          managed.view.setVisible(false);
          managed.view.setBounds(originalBounds);
        }
      }
    };

    const lockPromise = runOperation();
    this.visibilityLocks.set(id, lockPromise);

    try {
      return await lockPromise;
    } finally {
      // Only clear the lock if it's still ours (another operation might have started)
      if (this.visibilityLocks.get(id) === lockPromise) {
        this.visibilityLocks.delete(id);
      }
    }
  }

  /**
   * Capture screenshot of a view using Electron's capturePage.
   * For hidden views, temporarily makes them visible for capture.
   */
  async captureView(id: string): Promise<NativeImage | null> {
    const managed = this.views.get(id);
    if (!managed) {
      return null;
    }

    const contents = managed.view.webContents;
    if (contents.isDestroyed()) {
      return null;
    }

    // An unslotted hidden panel (e.g. a programmatically-opened panel on the
    // headless host that was never slotted into the UI) has no composited
    // surface, so a raw capturePage would read back nothing. Force-paint it via
    // withViewVisible — it shows the view at bounds, waits for two animation
    // frames (waitForRender), captures, then restores visibility. This is the
    // headless host's screenshot path (cdpHostProvider routes
    // Page.captureScreenshot here), so it MUST render unslotted panels instead
    // of declining. The isDestroyed bail above keeps it correct.
    const image = await this.withViewVisible(id, async () => {
      return contents.capturePage();
    });

    return image;
  }

  /**
   * Check if a view is currently visible.
   */
  isViewVisible(id: string): boolean {
    const managed = this.views.get(id);
    return managed?.visible ?? false;
  }

  isPanelSlotted(id: string): boolean {
    return this.nativePanelSlots.panelToSlot.has(id);
  }

  getNativePanelSlotDebugInfo(): Array<{
    nativeSlotId: string;
    panelId: string;
    bounds: ViewBounds;
    focused: boolean;
    ownerViewId: string;
    ownerGeneration: number;
  }> {
    return Array.from(this.nativePanelSlots.activeSlots.values()).map((slot) => ({
      nativeSlotId: slot.nativeSlotId,
      panelId: slot.panelId,
      bounds: { ...slot.bounds },
      focused: slot.focused,
      ownerViewId: slot.ownerViewId,
      ownerGeneration: slot.ownerGeneration,
    }));
  }

  async getPanelDisplayDiagnostics(): Promise<PanelDisplayDiagnostics> {
    const metrics = this.safeAppMetrics();
    const metricsByPid = new Map(metrics.map((metric) => [metric.pid, metric]));
    const [contentWidth = 0, contentHeight = 0] = this.window.isDestroyed()
      ? []
      : this.window.getContentSize();
    const slots = Array.from(this.nativePanelSlots.activeSlots.values()).map((slot) => ({
      ...slot,
      bounds: { ...slot.bounds },
    }));

    const captureIds = new Set<string>();
    for (const slot of slots) captureIds.add(slot.panelId);
    if (this.visiblePanelId) captureIds.add(this.visiblePanelId);

    return {
      timestamp: new Date().toISOString(),
      window: {
        destroyed: this.window.isDestroyed(),
        visible: !this.window.isDestroyed() && this.window.isVisible(),
        contentSize: [contentWidth, contentHeight],
      },
      manager: {
        visiblePanelId: this.visiblePanelId,
        shellOverlayActive: this.shellOverlayActive,
        panelViewportBounds: this.panelViewportBounds ? { ...this.panelViewportBounds } : null,
      },
      nativePanelSlots: {
        hostedShellReady: this.nativePanelSlots.hostedShellReady,
        activeHostedShellViewId: this.nativePanelSlots.activeHostedShellViewId,
        focusedNativeSlotId: this.nativePanelSlots.focusedNativeSlotId,
        hostedShellGeneration: this.nativePanelSlots.hostedShellGeneration,
        slots,
      },
      hostedShellSurfaces: await this.getHostedShellSurfaceDiagnostics(),
      views: Array.from(this.views.values()).map((managed) =>
        this.describeManagedView(managed, metricsByPid)
      ),
      captures: await Promise.all(
        Array.from(captureIds).map((id) => this.captureViewDiagnostic(id))
      ),
      processMetrics: metrics.map((metric) => ({
        pid: metric.pid,
        type: metric.type,
        memoryMb: Math.round((metric.memory.workingSetSize / 1024) * 10) / 10,
        cpuPercent:
          Math.round(((metric.cpu as { percentCPUUsage?: number }).percentCPUUsage ?? 0) * 100) /
          100,
      })),
    };
  }

  async copyPanelDisplayDiagnosticsToClipboard(): Promise<boolean> {
    const diagnostics = await this.getPanelDisplayDiagnostics();
    clipboard.writeText(JSON.stringify(diagnostics, null, 2));
    log.info("Copied panel display diagnostics to clipboard");
    return true;
  }

  private safeAppMetrics(): Electron.ProcessMetric[] {
    try {
      return app.getAppMetrics();
    } catch {
      return [];
    }
  }

  private describeManagedView(
    managed: ManagedView,
    metricsByPid: Map<number, Electron.ProcessMetric>
  ): PanelDisplayDiagnostics["views"][number] {
    const contents = managed.view.webContents;
    const destroyed = contents.isDestroyed();
    const pid = destroyed ? null : contents.getOSProcessId();
    const metric = typeof pid === "number" ? metricsByPid.get(pid) : null;
    return {
      id: managed.id,
      type: managed.type,
      parentId: managed.parentId,
      managedVisible: managed.visible,
      trackedBounds: { ...managed.bounds },
      nativeBounds: managed.view.getBounds(),
      hostChrome: managed.hostChrome,
      webContents: {
        id: contents.id,
        destroyed,
        url: destroyed ? null : contents.getURL(),
        title: destroyed ? null : contents.getTitle(),
        loading: destroyed ? null : contents.isLoading(),
        osProcessId: pid,
        memoryMb: metric ? Math.round((metric.memory.workingSetSize / 1024) * 10) / 10 : null,
      },
    };
  }

  private async getHostedShellSurfaceDiagnostics(): Promise<
    PanelDisplayDiagnostics["hostedShellSurfaces"]
  > {
    const hostedShellId = this.nativePanelSlots.activeHostedShellViewId;
    const hostedShell = hostedShellId ? this.views.get(hostedShellId) : null;
    if (!hostedShell || hostedShell.view.webContents.isDestroyed()) return [];
    try {
      return (await hostedShell.view.webContents.executeJavaScript(
        `
          Array.from(document.querySelectorAll("[data-native-panel-slot-id]")).map((node) => {
            const rect = node.getBoundingClientRect();
            return {
              nativeSlotId: node.getAttribute("data-native-panel-slot-id"),
              panelId: node.getAttribute("data-panel-id"),
              bounds: {
                x: Math.round(rect.left),
                y: Math.round(rect.top),
                width: Math.round(rect.width),
                height: Math.round(rect.height),
              },
            };
          })
        `,
        true
      )) as PanelDisplayDiagnostics["hostedShellSurfaces"];
    } catch {
      return [];
    }
  }

  private async captureViewDiagnostic(
    id: string
  ): Promise<PanelDisplayDiagnostics["captures"][number]> {
    const managed = this.views.get(id);
    if (!managed) return { id, ok: false, error: "view-not-found" };
    const contents = managed.view.webContents;
    if (contents.isDestroyed()) return { id, ok: false, error: "webcontents-destroyed" };
    try {
      const image = await Promise.race([
        contents.capturePage(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("capture-timeout")), 1500)
        ),
      ]);
      return {
        id,
        ok: true,
        empty: image.isEmpty(),
        size: image.getSize(),
      };
    } catch (error) {
      return {
        id,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Check if a view exists.
   */
  hasView(id: string): boolean {
    return this.views.has(id);
  }

  /**
   * Get all view IDs.
   */
  getViewIds(): string[] {
    return Array.from(this.views.keys());
  }

  /**
   * Find view ID by webContents ID (for reverse lookup from IPC sender).
   * Returns null if no view with that webContents ID exists.
   */
  findViewIdByWebContentsId(webContentsId: number): string | null {
    const viewId = this.webContentsIdToViewId.get(webContentsId);
    if (!viewId) {
      return null;
    }
    const managed = this.views.get(viewId);
    if (!managed || managed.view.webContents.isDestroyed()) {
      this.webContentsIdToViewId.delete(webContentsId);
      return null;
    }
    return viewId;
  }

  /**
   * Get WebContents for a view by ID.
   * Returns null if view doesn't exist or is destroyed.
   */
  getViewContents(id: string): WebContents | null {
    const managed = this.views.get(id);
    if (!managed || managed.view.webContents.isDestroyed()) {
      return null;
    }
    return managed.view.webContents;
  }

  /**
   * Get view info for debugging.
   */
  /** Session partition a view was created with (null when the view doesn't
   *  exist; undefined = default session). Used to decide whether an existing
   *  view can be navigated in place instead of destroy/recreate. */
  getViewPartition(id: string): string | undefined | null {
    const managed = this.views.get(id);
    if (!managed) return null;
    return managed.partition;
  }

  getViewInfo(id: string): {
    type: string;
    visible: boolean;
    hostChrome: boolean;
    bounds: ViewBounds;
    capabilities: readonly AppCapability[];
    appIdentity?: { source?: string; effectiveVersion?: string | null };
  } | null {
    const managed = this.views.get(id);
    if (!managed) {
      return null;
    }

    return {
      type: managed.type,
      visible: managed.visible,
      hostChrome: managed.hostChrome,
      bounds: managed.bounds,
      capabilities: managed.appCapabilities,
      appIdentity: managed.appIdentity,
    };
  }

  getVisibleHostChromeAppId(): string | null {
    for (const [id, managed] of this.views) {
      if (managed.type === "app" && managed.hostChrome && managed.visible) {
        return id;
      }
    }
    return null;
  }

  openHostChromeAppDevTools(mode: "detach" | "right" | "bottom" = "detach"): boolean {
    const appId = this.getVisibleHostChromeAppId();
    if (!appId) return false;
    this.openDevTools(appId, mode);
    return true;
  }

  /**
   * Set the current theme CSS to inject into views.
   * Call this when theme changes.
   */
  setThemeCss(css: string): void {
    this.currentThemeCss = css;

    // Apply to all views that want theme injection
    for (const [id, managed] of this.views) {
      if (managed.injectHostThemeVariables && id !== "shell") {
        this.applyThemeCss(id);
      }
    }
  }

  /**
   * Apply theme CSS to a specific view.
   */
  private async applyThemeCss(id: string): Promise<void> {
    const managed = this.views.get(id);
    if (!managed || !this.currentThemeCss) {
      return;
    }

    const contents = managed.view.webContents;
    if (contents.isDestroyed()) {
      return;
    }

    try {
      // Remove previous CSS if any
      if (managed.themeCssKey) {
        await contents.removeInsertedCSS(managed.themeCssKey);
      }

      // Insert new CSS
      const key = await contents.insertCSS(this.currentThemeCss, {
        cssOrigin: "author",
      });
      managed.themeCssKey = key;
    } catch (error) {
      console.error(`[ViewManager] Failed to apply theme CSS to ${id}:`, error);
    }
  }

  /**
   * Open DevTools for a view.
   */
  openDevTools(id: string, mode: "detach" | "right" | "bottom" = "detach"): void {
    const contents = this.getWebContents(id);
    if (contents) {
      contents.openDevTools({ mode });
    }
  }

  /**
   * Get the underlying BaseWindow.
   */
  getWindow(): BaseWindow {
    return this.window;
  }

  /**
   * Navigate a view to a URL.
   */
  async navigateView(id: string, url: string): Promise<void> {
    const contents = this.getWebContents(id);
    if (!contents) {
      throw new Error(`View not found: ${id}`);
    }

    await contents.loadURL(url);
  }

  async updateAppView(
    id: string,
    url: string,
    capabilities?: readonly AppCapability[],
    identity?: { source?: string; effectiveVersion?: string | null }
  ): Promise<void> {
    const managed = this.views.get(id);
    if (!managed) throw new Error(`View not found: ${id}`);
    if (managed.type !== "app") throw new Error(`View is not an app view: ${id}`);
    managed.appCapabilities = [...(capabilities ?? [])];
    const nextIdentity = identity;
    managed.hostChrome =
      capabilities?.includes("panel-hosting") === true &&
      isAuthorizedChromeAppCaller(id, nextIdentity?.source);
    if (!managed.hostChrome && this.nativePanelSlots.activeHostedShellViewId === id) {
      this.nativePanelSlots.hostedShellReady = false;
      this.clearAllPanelSlots();
      managed.visible = false;
      managed.view.setVisible(false);
      this.shellView.setVisible(true);
      this.reconcileNativeLayerOrder();
    }
    managed.appIdentity = nextIdentity;
    await managed.view.webContents.loadURL(url);
    if (managed.visible) this.updateLayout({});
  }

  /**
   * Get current URL of a view.
   */
  getViewUrl(id: string): string | null {
    const contents = this.getWebContents(id);
    if (!contents) {
      return null;
    }

    return contents.getURL();
  }

  /**
   * Check if view can go back in history.
   */
  canGoBack(id: string): boolean {
    const contents = this.getWebContents(id);
    return contents?.navigationHistory.canGoBack() ?? false;
  }

  /**
   * Check if view can go forward in history.
   */
  canGoForward(id: string): boolean {
    const contents = this.getWebContents(id);
    return contents?.navigationHistory.canGoForward() ?? false;
  }

  /**
   * Go back in view history.
   */
  goBack(id: string): void {
    const contents = this.getWebContents(id);
    if (contents?.navigationHistory.canGoBack()) {
      contents.navigationHistory.goBack();
    }
  }

  /**
   * Go forward in view history.
   */
  goForward(id: string): void {
    const contents = this.getWebContents(id);
    if (contents?.navigationHistory.canGoForward()) {
      contents.navigationHistory.goForward();
    }
  }

  /**
   * Reload a view.
   */
  reload(id: string): void {
    const contents = this.getWebContents(id);
    contents?.reload();
  }

  /**
   * Reload a view while bypassing Chromium's HTTP cache.
   */
  forceReload(id: string): void {
    const contents = this.getWebContents(id);
    contents?.reloadIgnoringCache();
  }

  /**
   * Stop loading a view.
   */
  stop(id: string): void {
    const contents = this.getWebContents(id);
    contents?.stop();
  }

  /**
   * Clean up all views.
   */
  destroy(): void {
    this.stopCompositorKeepalive();
    this.stopCompositorStallDetector();
    this.nativeShellOverlay.destroy();

    for (const id of this.views.keys()) {
      if (id !== "shell") {
        this.destroyView(id);
      }
    }

    // Shell is destroyed with window
    this.views.clear();
    this.webContentsIdToViewId.clear();

    // Clear all callbacks
    this.viewOrderChangedCallbacks.length = 0;
    this.viewHiddenCallbacks.length = 0;
    this.crashCallbacks.length = 0;
  }

  // =========================================================================
  // Compositor Keepalive
  // =========================================================================

  /**
   * Start periodic compositor keepalive.
   * Nudges the visible panel's compositor with invalidate() + a bounds
   * re-apply every few seconds. This is a gentle keepalive that doesn't
   * steal focus from input elements (unlike layer re-stacking or visibility
   * cycling). For full compositor recovery from an active stall, the user
   * can use the "Refresh Panel Display" menu item or forceRepaint().
   */
  private startCompositorKeepalive(intervalMs = 5000): void {
    this.stopCompositorKeepalive();
    this.compositorKeepaliveTimer = setInterval(() => {
      this.keepCompositorAlive();
    }, intervalMs);
  }

  /**
   * Gentle compositor keepalive — invalidate + re-apply bounds.
   * Avoids re-stacking (removeChildView/addChildView steals focus) and
   * visibility cycling (setVisible toggle may steal focus).
   */
  private keepCompositorAlive(): void {
    if (this.window.isDestroyed()) return;
    if (!this.windowVisible) return;
    // Skip the periodic invalidate while the window is unfocused: forcing
    // repaints fights OS-level occlusion throttling and burns GPU/battery in
    // the background. A focus listener nudges the compositor on return.
    if (!this.window.isFocused()) return;

    const slots = Array.from(this.nativePanelSlots.activeSlots.values());
    if (slots.length > 0) {
      this.ensureSlotLayerOrder();
      for (const slot of slots) {
        const managed = this.views.get(slot.panelId);
        if (!managed || !managed.visible || managed.view.webContents.isDestroyed()) continue;
        managed.bounds = slot.bounds;
        managed.view.setBounds(slot.bounds);
        managed.view.webContents.invalidate();
      }
      return;
    }

    const panelId = this.visiblePanelId;
    if (!panelId) return;
    const managed = this.views.get(panelId);
    if (!managed || !managed.visible || managed.view.webContents.isDestroyed()) return;
    const bounds = this.calculatePanelBounds();
    managed.bounds = bounds;
    managed.view.setBounds(bounds);
    managed.view.webContents.invalidate();
  }

  /**
   * Detect slotted panel views layered below the opaque hosted shell and
   * restack them. capturePage-based stall detection cannot see this state:
   * the panel renderer keeps producing frames, it is just occluded in the
   * window's layer tree. Returns true if a restack was performed.
   */
  private ensureSlotLayerOrder(): boolean {
    const hostedShellId = this.nativePanelSlots.activeHostedShellViewId;
    if (!hostedShellId || this.nativePanelSlots.activeSlots.size === 0) return false;
    const children = this.window.contentView.children as Electron.View[] | undefined;
    if (!children) return false;
    const hostedShell = this.views.get(hostedShellId);
    if (!hostedShell) return false;
    const shellIndex = children.indexOf(hostedShell.view);
    if (shellIndex === -1) return false;

    for (const slot of this.nativePanelSlots.activeSlots.values()) {
      const managed = this.views.get(slot.panelId);
      if (!managed || !managed.visible) continue;
      const panelIndex = children.indexOf(managed.view);
      if (panelIndex !== -1 && panelIndex < shellIndex) {
        log.verbose(
          ` Slotted panel ${slot.panelId} is layered below the hosted shell — restacking`
        );
        this.reconcileNativeLayerOrder();
        return true;
      }
    }
    return false;
  }

  /**
   * Stop the compositor keepalive timer.
   */
  private stopCompositorKeepalive(): void {
    if (this.compositorKeepaliveTimer) {
      clearInterval(this.compositorKeepaliveTimer);
      this.compositorKeepaliveTimer = null;
    }
  }

  /**
   * Start periodic compositor stall detection using capturePage().
   * Unlike rAF probes (which fire in the renderer thread even when the
   * compositor isn't painting), capturePage() goes through the actual
   * compositing pipeline. An empty capture on a visible panel means the
   * compositor surface is gone → stall confirmed → aggressive recovery.
   * Aggressive recovery (layer re-stack + visibility cycle) is acceptable
   * here because a blank panel has no focused input to steal focus from.
   */
  private startCompositorStallDetector(intervalMs = 10000): void {
    this.stopCompositorStallDetector();
    this.stallProbeIntervalMs = Math.max(intervalMs, this.STALL_PROBE_MIN_INTERVAL_MS);
    const schedule = () => {
      this.compositorStallDetectorTimer = setTimeout(async () => {
        await this.detectAndRecoverStall();
        if (this.compositorStallDetectorTimer === null) return; // stopped mid-probe
        schedule();
      }, this.stallProbeIntervalMs);
    };
    schedule();
  }

  private stopCompositorStallDetector(): void {
    if (this.compositorStallDetectorTimer) {
      clearTimeout(this.compositorStallDetectorTimer);
      this.compositorStallDetectorTimer = null;
    }
  }

  /**
   * Detect compositor stall via capturePage and recover aggressively.
   * Only triggers when the capture is empty (panel is already blank),
   * so the aggressive recovery won't disrupt user interaction.
   */
  private async detectAndRecoverStall(): Promise<void> {
    if (this.window.isDestroyed()) return;
    if (!this.windowVisible) return;
    if (!this.window.isFocused()) return;

    const slots = Array.from(this.nativePanelSlots.activeSlots.values());
    if (slots.length > 0) {
      let anyStalled = false;
      for (const slot of slots) {
        if (await this.detectAndRecoverPanelSlotStall(slot)) anyStalled = true;
      }
      this.adjustStallProbeBackoff(anyStalled);
      return;
    }

    const panelId = this.visiblePanelId;
    if (!panelId) return;
    const managed = this.views.get(panelId);
    if (!managed || !managed.visible || managed.view.webContents.isDestroyed()) return;
    try {
      const image = await managed.view.webContents.capturePage();

      // Re-check panel is still the visible one after async capture
      if (this.visiblePanelId !== panelId || !managed.visible) return;

      if (image.isEmpty()) {
        log.verbose(` Compositor stall detected on ${panelId} (empty capture) — recovering`);
        // Aggressive recovery: re-attach view + refresh bounds + visibility cycle
        this.reconcileNativeLayerOrder();
        const bounds = this.calculatePanelBounds();
        managed.bounds = bounds;
        managed.view.setBounds(bounds);
        managed.view.webContents.invalidate();
        this.cycleCompositorVisibility(managed);
        this.adjustStallProbeBackoff(true);
      } else {
        this.adjustStallProbeBackoff(false);
      }
    } catch {
      // capturePage failed (webContents navigating, destroyed, etc.) — skip
    }
  }

  /** Healthy probes back off toward the max interval; stalls reset to min. */
  private adjustStallProbeBackoff(stalled: boolean): void {
    this.stallProbeIntervalMs = stalled
      ? this.STALL_PROBE_MIN_INTERVAL_MS
      : Math.min(this.stallProbeIntervalMs * 2, this.STALL_PROBE_MAX_INTERVAL_MS);
  }

  private async detectAndRecoverPanelSlotStall(slot: NativePanelSlotState): Promise<boolean> {
    const managed = this.views.get(slot.panelId);
    if (!managed || !managed.visible || managed.view.webContents.isDestroyed()) return false;

    try {
      const image = await managed.view.webContents.capturePage();
      if (this.nativePanelSlots.activeSlots.get(slot.nativeSlotId)?.panelId !== slot.panelId) {
        return false;
      }
      if (image.isEmpty()) {
        log.verbose(` Compositor stall detected on ${slot.panelId} (empty capture) — recovering`);
        this.reconcileNativeLayerOrder();
        managed.bounds = slot.bounds;
        managed.view.setBounds(slot.bounds);
        managed.view.webContents.invalidate();
        this.cycleCompositorVisibility(managed);
        return true;
      }
    } catch {
      // capturePage failed (webContents navigating, destroyed, etc.) — skip
    }
    return false;
  }

  // =========================================================================
  // View Protection API
  // =========================================================================

  /**
   * Set which views should be protected from throttling/disposal.
   * ViewManager handles all the mechanics internally (background throttling,
   * visibility state when window is hidden).
   */
  setProtectedViews(viewIds: Set<string>): void {
    const previousIds = this.protectedViewIds;
    this.protectedViewIds = viewIds;

    // Re-enable throttling for views no longer protected
    for (const id of previousIds) {
      if (!viewIds.has(id)) {
        this.setViewProtection(id, false);
      }
    }

    // Protect newly added views
    for (const id of viewIds) {
      if (!previousIds.has(id)) {
        this.setViewProtection(id, true);
      }
    }
  }

  private setViewProtection(viewId: string, protect: boolean): void {
    const contents = this.getWebContents(viewId);
    if (!contents || contents.isDestroyed()) return;

    try {
      contents.setBackgroundThrottling(!protect);
    } catch {
      // Frame may be disposed
    }
  }

  private applyProtectionToViews(): void {
    for (const viewId of this.protectedViewIds) {
      this.setViewProtection(viewId, true);
    }
  }

  /**
   * Register callback for when a view's renderer crashes.
   * Only called for 'crashed', 'oom', and 'launch-failed' reasons.
   * Returns a cleanup function to unregister the callback.
   */
  onViewCrashed(callback: (viewId: string, reason: string) => void): () => void {
    this.crashCallbacks.push(callback);
    return () => {
      const idx = this.crashCallbacks.indexOf(callback);
      if (idx >= 0) this.crashCallbacks.splice(idx, 1);
    };
  }

  /**
   * Reload a view's content. Returns true if reload was initiated.
   */
  reloadView(viewId: string): boolean {
    const contents = this.getWebContents(viewId);
    if (!contents || contents.isDestroyed()) {
      console.error(`[ViewManager] Cannot reload ${viewId}: webContents destroyed or missing`);
      return false;
    }

    try {
      contents.reload();
      return true;
    } catch (error) {
      console.error(
        `[ViewManager] Failed to reload ${viewId}:`,
        error instanceof Error ? error.message : error
      );
      return false;
    }
  }

  /**
   * Force a repaint of a view. Used to recover from compositor stalls where
   * the content exists but isn't being painted to screen.
   */
  forceRepaint(viewId: string): boolean {
    const managed = this.views.get(viewId);
    if (!managed) {
      console.warn(`[ViewManager] forceRepaint: view not found: ${viewId}`);
      return false;
    }

    const contents = managed.view.webContents;
    if (contents.isDestroyed()) {
      console.warn(`[ViewManager] forceRepaint: webContents destroyed: ${viewId}`);
      return false;
    }

    log.verbose(` Forcing repaint for view: ${viewId}`);

    try {
      // Invalidate the frame to trigger a repaint (belt-and-suspenders for non-stalled cases)
      contents.invalidate();

      // Cycle visibility to wake a suspended compositor
      if (managed.visible) {
        this.cycleCompositorVisibility(managed);
      }

      return true;
    } catch (error) {
      console.error(
        `[ViewManager] Failed to force repaint for ${viewId}:`,
        error instanceof Error ? error.message : error
      );
      return false;
    }
  }
}
