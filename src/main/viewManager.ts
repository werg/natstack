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
  type: "shell" | "panel" | "browser";
  /** Session partition (e.g., "persist:panelId"). Omit for default session. */
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
}

interface ManagedView {
  id: string;
  view: WebContentsView;
  type: "shell" | "panel" | "browser";
  parentId?: string;
  visible: boolean;
  bounds: ViewBounds;
  injectHostThemeVariables: boolean;
  themeCssKey?: string;
}

/**
 * ViewManager manages all WebContentsViews within a BaseWindow.
 *
 * The shell view (React UI) is created first and fills the window.
 * Panel and browser views are layered on top at specific bounds.
 */
export class ViewManager {
  private window: BaseWindow;
  private views = new Map<string, ManagedView>();
  private shellView: WebContentsView;
  private panelPreloadPath: string;
  private currentThemeCss: string | null = null;
  /** Per-view locks to prevent concurrent withViewVisible operations */
  private visibilityLocks = new Map<string, Promise<unknown>>();
  /** Track sessions that have had the protocol registered (by partition name or "default") */
  private registeredProtocolSessions = new Set<string>();

  constructor(options: {
    window: BaseWindow;
    shellPreload: string;
    panelPreload: string;
    shellHtmlPath: string;
    devTools?: boolean;
  }) {
    this.window = options.window;
    this.panelPreloadPath = options.panelPreload;

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

    // Update shell bounds when window resizes
    this.window.on("resize", () => this.updateShellBounds());
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
        console.log(`[ViewManager] Protocol already registered for session: ${sessionKey}`);
      }
    }

    // Build webPreferences based on view type
    const webPreferences: Electron.WebPreferences = {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      session: ses,
      webviewTag: false,
    };

    // Set preload: use provided preload, fall back to panel preload, or omit if null
    if (config.preload === null) {
      // Explicitly no preload (for browsers)
    } else if (config.preload) {
      webPreferences.preload = config.preload;
    } else {
      webPreferences.preload = this.panelPreloadPath;
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
    console.log(`[ViewManager] Created view for ${config.id}, type: ${config.type}, url: ${config.url?.slice(0, 80)}...`);

    // Load URL if provided
    if (config.url) {
      void view.webContents.loadURL(config.url);
    }

    // Apply theme CSS when ready
    view.webContents.on("dom-ready", () => {
      if (managed.injectHostThemeVariables && this.currentThemeCss) {
        this.applyThemeCss(config.id);
      }
    });

    // Set up standard browser context menu
    view.webContents.on("context-menu", (_event, params) => {
      const menuItems = this.buildContextMenuItems(params, view.webContents);
      if (menuItems.length > 0) {
        const menu = Menu.buildFromTemplate(menuItems);
        menu.popup();
      }
    });

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

    // When showing, ensure proper bounds and bring to front
    if (visible) {
      managed.view.setBounds(managed.bounds);
      this.bringToFront(id);
    }
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
      console.log(`[ViewManager] waitForRender: frame rendered after ${Date.now() - startTime}ms`);
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
    for (const id of this.views.keys()) {
      if (id !== "shell") {
        this.destroyView(id);
      }
    }

    // Shell is destroyed with window
    this.views.clear();
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
  panelPreload: string;
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
