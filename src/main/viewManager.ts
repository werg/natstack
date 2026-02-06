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
  BaseWindow,
  Menu,
  WebContentsView,
  type MenuItemConstructorOptions,
  type WebContents,
  type NativeImage,
  session,
} from "electron";
import { handleProtocolRequest } from "./panelProtocol.js";
import { getAdBlockManager } from "./adblock/index.js";
import { createDevLogger } from "./devLog.js";

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
  type: "shell" | "panel" | "browser" | "worker";
  /** Session partition (e.g., "persist:safe_auto_tree~panels~editor"). Omit for default session. */
  partition?: string;
  /** Preload script path. Set to null to disable preload (for browsers). */
  preload?: string | null;
  /** Initial URL to load */
  url?: string;
  /** Parent view ID (for nesting) */
  parentId?: string;
  /** Whether to inject host theme CSS */
  injectHostThemeVariables?: boolean;
  /** Additional arguments to pass to the preload script */
  additionalArguments?: string[];
  /**
   * Run panel with full Node.js API access.
   * - `true`: Unsafe mode with default scoped filesystem
   * - `string`: Unsafe mode with custom filesystem root (e.g., "/" for full access)
   */
  unsafe?: boolean | string;
}

interface ManagedView {
  id: string;
  view: WebContentsView;
  type: "shell" | "panel" | "browser" | "worker";
  parentId?: string;
  visible: boolean;
  bounds: ViewBounds;
  injectHostThemeVariables: boolean;
  themeCssKey?: string;
  /** Stored event handlers for proper cleanup */
  handlers?: {
    domReady: () => void;
    contextMenu: (event: Electron.Event, params: Electron.ContextMenuParams) => void;
    renderProcessGone: (event: Electron.Event, details: Electron.RenderProcessGoneDetails) => void;
  };
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
}

export class ViewManager {
  private window: BaseWindow;
  private views = new Map<string, ManagedView>();
  private shellView: WebContentsView;
  private safePreloadPath: string;
  private unsafePreloadPath: string;
  private adblockPreloadPath: string;
  private currentThemeCss: string | null = null;
  /** Per-view locks to prevent concurrent withViewVisible operations */
  private visibilityLocks = new Map<string, Promise<unknown>>();
  /** Track sessions that have had the protocol registered (by partition name or "default") */
  private registeredProtocolSessions = new Set<string>();
  /** Current layout state for calculating panel bounds */
  private layoutState: LayoutState = {
    titleBarHeight: 32,
    sidebarVisible: false,
    sidebarWidth: 260,
  };
  /** ID of the currently visible panel (to apply bounds updates) */
  private visiblePanelId: string | null = null;

  // View protection state
  private protectedViewIds = new Set<string>();
  private crashCallback: ((viewId: string, reason: string) => void) | null = null;
  private windowVisible = true;
  /** Timer for periodic compositor keepalive to prevent stalls */
  private compositorKeepaliveTimer: ReturnType<typeof setInterval> | null = null;
  /** Timestamp of last visibility cycle, for cooldown to prevent feedback loops */
  private lastVisibilityCycleTime = 0;

  constructor(options: {
    window: BaseWindow;
    shellPreload: string;
    safePreload: string;
    shellHtmlPath: string;
    devTools?: boolean;
  }) {
    this.window = options.window;
    this.safePreloadPath = options.safePreload;
    // Calculate unsafe preload path (same directory, different file)
    this.unsafePreloadPath = options.safePreload.replace(
      /safePreload\.(c?js)$/,
      "unsafePreload.$1"
    );
    // Calculate adblock preload path for browser panels
    this.adblockPreloadPath = options.safePreload.replace(
      /safePreload\.(c?js)$/,
      "adblockPreload.$1"
    );

    // Create shell view (React UI) - fills entire window
    // nodeIntegration enabled for direct fs/git access (shell is trusted app UI)
    this.shellView = new WebContentsView({
      webPreferences: {
        preload: options.shellPreload,
        nodeIntegration: true,
        contextIsolation: false,
        sandbox: false,
      },
    });

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
    });

    // Load shell HTML
    void this.shellView.webContents.loadFile(options.shellHtmlPath);

    // Show window and finalize bounds after shell content loads
    this.shellView.webContents.on("did-finish-load", () => {
      this.updateShellBounds();
      // Show window now that content is ready (avoids layout flash)
      if (!this.window.isVisible()) {
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
        menu.popup();
      }
    });

    // Update shell and panel bounds when window resizes
    this.window.on("resize", () => {
      this.updateShellBounds();
      this.applyBoundsToVisiblePanel();
    });

    // Track window visibility for protected view management
    this.window.on("hide", () => this.handleWindowVisibility(false));
    this.window.on("show", () => this.handleWindowVisibility(true));
    this.window.on("minimize", () => this.handleWindowVisibility(false));
    this.window.on("restore", () => this.handleWindowVisibility(true));

    // Start compositor keepalive to prevent layer painting stalls
    this.startCompositorKeepalive();
  }

  private handleWindowVisibility(visible: boolean): void {
    this.windowVisible = visible;
    // When window is hidden, force visibility on protected views to prevent throttling
    if (!visible) {
      this.applyProtectionToViews();
    }
  }

  private updateShellBounds(): void {
    const size = this.window.getContentSize();
    const width = size[0] ?? 0;
    const height = size[1] ?? 0;
    this.shellView.setBounds({ x: 0, y: 0, width, height });
  }

  /**
   * Get the shell WebContents (for IPC communication with renderer).
   */
  getShellWebContents(): WebContents {
    return this.shellView.webContents;
  }

  /**
   * Get the adblock preload path for browser panels.
   */
  getAdblockPreloadPath(): string {
    return this.adblockPreloadPath;
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

    // Create session - use partition if specified, otherwise default session
    // Browser panels share a session for cookies/auth; app panels are isolated
    const ses = config.partition
      ? session.fromPartition(config.partition)
      : session.defaultSession;

    // Register natstack-panel:// protocol for this partition's session.
    // Track registered sessions to avoid duplicate registration attempts.
    // For browser views using defaultSession, the protocol is already registered at app startup.
    const sessionKey = config.partition ?? "default";
    if (!this.registeredProtocolSessions.has(sessionKey)) {
      try {
        ses.protocol.handle("natstack-panel", handleProtocolRequest);
        this.registeredProtocolSessions.add(sessionKey);
      } catch {
        // Protocol might already be registered (e.g., defaultSession at app startup)
        // Mark as registered to avoid future attempts
        this.registeredProtocolSessions.add(sessionKey);
        log.verbose(` Protocol already registered for session: ${sessionKey}`);
      }
    }

    // Build webPreferences based on view type and unsafe flag
    const isUnsafe = Boolean(config.unsafe);
    const webPreferences: Electron.WebPreferences = {
      nodeIntegration: isUnsafe,
      contextIsolation: !isUnsafe,
      sandbox: !isUnsafe,
      session: ses,
      webviewTag: false,
      // Allow Chromium to throttle hidden views (saves CPU/battery).
      // Compositor stalls on *visible* panels are handled by the health probe
      // and forceRepaint, not this setting.
      backgroundThrottling: true,
    };

    // Set preload: use provided preload, fall back to safe/unsafe preload, or omit if null
    if (config.preload === null) {
      // Explicitly no preload (for browsers)
    } else if (config.preload) {
      webPreferences.preload = config.preload;
    } else {
      // Both panels and workers use consolidated preloads (kind is passed via --natstack-kind)
      webPreferences.preload = isUnsafe
        ? this.unsafePreloadPath
        : this.safePreloadPath;
    }

    // Pass additional arguments to preload script
    if (config.additionalArguments && config.additionalArguments.length > 0) {
      webPreferences.additionalArguments = config.additionalArguments;
    }

    const view = new WebContentsView({ webPreferences });

    // Start invisible at origin with zero size
    view.setBounds({ x: 0, y: 0, width: 0, height: 0 });
    view.setVisible(false);

    // Add to window's content view
    this.window.contentView.addChildView(view);

    // Track the managed view
    const managed: ManagedView = {
      id: config.id,
      view,
      type: config.type,
      parentId: config.parentId,
      visible: false,
      bounds: { x: 0, y: 0, width: 0, height: 0 },
      injectHostThemeVariables: config.injectHostThemeVariables ?? true,
    };
    this.views.set(config.id, managed);
    log.verbose(` Created view for ${config.id}, type: ${config.type}, url: ${config.url?.slice(0, 80)}...`);

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
          menu.popup();
        }
      },
      renderProcessGone: (_event: Electron.Event, details: Electron.RenderProcessGoneDetails) => {
        if (this.crashCallback && ["crashed", "oom", "launch-failed"].includes(details.reason)) {
          this.crashCallback(config.id, details.reason);
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

    return view;
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

  /**
   * Destroy a view and remove it from the window.
   */
  destroyView(id: string): void {
    const managed = this.views.get(id);
    if (!managed) {
      return;
    }

    // Clean up adblock main frame URL tracking for browser views
    if (managed.type === "browser" && !managed.view.webContents.isDestroyed()) {
      try {
        getAdBlockManager().clearMainFrameUrl(managed.view.webContents.id);
      } catch {
        // AdBlockManager might not be initialized yet
      }
    }
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
    managed.view.setBounds(bounds);
  }

  /**
   * Set visibility of a view.
   */
  setViewVisible(id: string, visible: boolean): void {
    const managed = this.views.get(id);
    if (!managed) {
      console.warn(`[ViewManager] View not found: ${id}`);
      return;
    }

    managed.visible = visible;
    managed.view.setVisible(visible);

    // Track visible panel and apply calculated bounds
    if (visible && managed.type !== "shell") {
      this.visiblePanelId = id;
      const bounds = this.calculatePanelBounds();
      managed.bounds = bounds;
      managed.view.setBounds(bounds);
      this.bringToFront(id);
    } else if (!visible && this.visiblePanelId === id) {
      this.visiblePanelId = null;
    }
  }

  /**
   * Calculate the bounds for the panel content area based on current layout state.
   */
  private calculatePanelBounds(): ViewBounds {
    const size = this.window.getContentSize();
    const windowWidth = size[0] ?? 0;
    const windowHeight = size[1] ?? 0;
    const { titleBarHeight, sidebarVisible, sidebarWidth } = this.layoutState;
    const effectiveSidebarWidth = sidebarVisible ? sidebarWidth : 0;

    return {
      x: effectiveSidebarWidth,
      y: titleBarHeight,
      width: Math.max(0, windowWidth - effectiveSidebarWidth),
      height: Math.max(0, windowHeight - titleBarHeight),
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

  /**
   * Apply calculated bounds to the currently visible panel.
   */
  private applyBoundsToVisiblePanel(): void {
    if (!this.visiblePanelId) {
      return;
    }

    const managed = this.views.get(this.visiblePanelId);
    if (!managed || !managed.visible) {
      return;
    }

    const bounds = this.calculatePanelBounds();
    managed.bounds = bounds;
    managed.view.setBounds(bounds);
  }

  private static readonly PROBE_TIMEOUT = Symbol("timeout");

  /**
   * Probe whether the compositor is alive by executing a requestAnimationFrame
   * in the renderer and racing it against a 3s timeout.
   * Returns true if healthy (rAF fired or executeJavaScript failed — not a stall).
   * Returns false if the timeout wins (compositor is stalled).
   */
  private async probeCompositorHealth(managed: ManagedView): Promise<boolean> {
    const contents = managed.view.webContents;
    if (contents.isDestroyed()) return true;
    try {
      const result = await Promise.race([
        contents
          .executeJavaScript("new Promise(r => requestAnimationFrame(r))")
          .then(() => true as const),
        new Promise<typeof ViewManager.PROBE_TIMEOUT>((resolve) =>
          setTimeout(() => resolve(ViewManager.PROBE_TIMEOUT), 3000)
        ),
      ]);
      return result !== ViewManager.PROBE_TIMEOUT;
    } catch {
      // executeJavaScript failure (page loading, navigating, context destroyed)
      // — not a compositor stall, skip recovery
      return true;
    }
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
    if (now - this.lastVisibilityCycleTime < 1000) return;
    this.lastVisibilityCycleTime = now;
    managed.view.setVisible(false);
    managed.view.setVisible(true);
  }

  /**
   * Bring a view to the front (above other views but below shell).
   */
  bringToFront(id: string): void {
    const managed = this.views.get(id);
    if (!managed) {
      return;
    }

    // Re-add to move to top of z-order (shell is always below)
    this.window.contentView.removeChildView(managed.view);
    this.window.contentView.addChildView(managed.view);

    // Ensure shell stays on top for UI overlay elements
    // Actually, shell should be behind content views so panels show on top
    // This is correct - panels render above shell
  }

  /**
   * Refresh the currently visible panel by re-establishing its z-order and bounds.
   * Called when a panel receives focus (even if it was already visible).
   * For compositor recovery, use forceRepaint() or forceRepaintVisiblePanel().
   */
  refreshVisiblePanel(): void {
    if (!this.visiblePanelId) {
      return;
    }

    const managed = this.views.get(this.visiblePanelId);
    if (!managed || !managed.visible) {
      return;
    }

    // Refresh bounds and z-order (compositor recovery handled by stall detector
    // and forceRepaint — not here, to avoid operating on the wrong panel during switches)
    const bounds = this.calculatePanelBounds();
    managed.bounds = bounds;
    managed.view.setBounds(bounds);
    this.bringToFront(this.visiblePanelId);
  }

  /**
   * Force a repaint of the currently visible panel.
   * Convenience method for menu items that don't know the panel ID.
   */
  forceRepaintVisiblePanel(): boolean {
    if (!this.visiblePanelId) return false;
    return this.forceRepaint(this.visiblePanelId);
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
    for (const [id, managed] of this.views) {
      if (!managed.view.webContents.isDestroyed() && managed.view.webContents.id === webContentsId) {
        return id;
      }
    }
    return null;
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
  getViewInfo(id: string): { type: string; visible: boolean; bounds: ViewBounds } | null {
    const managed = this.views.get(id);
    if (!managed) {
      return null;
    }

    return {
      type: managed.type,
      visible: managed.visible,
      bounds: managed.bounds,
    };
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
    return contents?.canGoBack() ?? false;
  }

  /**
   * Check if view can go forward in history.
   */
  canGoForward(id: string): boolean {
    const contents = this.getWebContents(id);
    return contents?.canGoForward() ?? false;
  }

  /**
   * Go back in view history.
   */
  goBack(id: string): void {
    const contents = this.getWebContents(id);
    if (contents?.canGoBack()) {
      contents.goBack();
    }
  }

  /**
   * Go forward in view history.
   */
  goForward(id: string): void {
    const contents = this.getWebContents(id);
    if (contents?.canGoForward()) {
      contents.goForward();
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

    for (const id of this.views.keys()) {
      if (id !== "shell") {
        this.destroyView(id);
      }
    }

    // Shell is destroyed with window
    this.views.clear();
  }

  // =========================================================================
  // Compositor Keepalive
  // =========================================================================

  /**
   * Start periodic compositor health probe.
   * Every intervalMs, runs a requestAnimationFrame probe on the visible panel.
   * If the compositor is stalled (rAF doesn't fire within 3s), cycles visibility
   * to wake it up.
   */
  private startCompositorKeepalive(intervalMs = 10000): void {
    this.stopCompositorKeepalive();
    this.compositorKeepaliveTimer = setInterval(() => {
      void this.checkCompositorHealth();
    }, intervalMs);
  }

  /**
   * Check whether the visible panel's compositor is healthy.
   * If the rAF probe times out, cycle visibility to recover.
   */
  private async checkCompositorHealth(): Promise<void> {
    const panelId = this.visiblePanelId;
    if (!panelId || !this.windowVisible) return;
    const managed = this.views.get(panelId);
    if (!managed || !managed.visible || managed.view.webContents.isDestroyed())
      return;

    const healthy = await this.probeCompositorHealth(managed);

    // Re-check panel is still visible after async probe
    if (!healthy && this.visiblePanelId === panelId && managed.visible) {
      this.cycleCompositorVisibility(managed);
    }
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
   */
  onViewCrashed(callback: (viewId: string, reason: string) => void): void {
    this.crashCallback = callback;
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

// Singleton instance
let viewManager: ViewManager | null = null;

/**
 * Initialize the ViewManager singleton.
 * Must be called once during app startup with BaseWindow.
 */
export function initViewManager(options: {
  window: BaseWindow;
  shellPreload: string;
  safePreload: string;
  shellHtmlPath: string;
  devTools?: boolean;
}): ViewManager {
  if (viewManager) {
    throw new Error("ViewManager already initialized");
  }

  viewManager = new ViewManager(options);
  return viewManager;
}

/**
 * Get the ViewManager singleton.
 * Throws if not initialized.
 */
export function getViewManager(): ViewManager {
  if (!viewManager) {
    throw new Error("ViewManager not initialized");
  }
  return viewManager;
}

/**
 * Check if ViewManager is initialized.
 */
export function isViewManagerInitialized(): boolean {
  return viewManager !== null;
}

/**
 * Reset ViewManager singleton. Only for testing.
 * @internal
 */
export function _resetViewManagerForTesting(): void {
  viewManager = null;
}
