import * as path from "path";
import { randomBytes } from "crypto";
import { PanelBuilder } from "./panelBuilder.js";
import type { PanelEventPayload, Panel, PanelManifest, BrowserPanel } from "./panelTypes.js";
import { getActiveWorkspace } from "./paths.js";
import type { GitServer } from "./gitServer.js";
import { normalizeRelativePanelPath } from "./pathUtils.js";
import * as SharedPanel from "../shared/ipc/types.js";
import { getClaudeCodeConversationManager } from "./ai/claudeCodeConversationManager.js";
import {
  storeProtocolPanel,
  removeProtocolPanel,
  isProtocolPanel,
} from "./panelProtocol.js";
import { getWorkerManager } from "./workerManager.js";
import { getCdpServer } from "./cdpServer.js";
import type { ViewManager } from "./viewManager.js";

export class PanelManager {
  private builder: PanelBuilder;
  private viewManager: ViewManager | null = null;
  private panels: Map<string, Panel> = new Map();
  private reservedPanelIds: Set<string> = new Set();
  private rootPanels: Panel[] = [];
  private currentTheme: "light" | "dark" = "light";
  private panelsRoot: string;
  private gitServer: GitServer;

  // Debounce state for panel tree updates
  private treeUpdatePending = false;
  private treeUpdateTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly TREE_UPDATE_DEBOUNCE_MS = 16; // ~1 frame at 60fps

  private initialRootPanelPath: string | null = null;

  constructor(initialRootPanelPath: string, gitServer: GitServer) {
    this.gitServer = gitServer;
    const workspace = getActiveWorkspace();
    this.panelsRoot = workspace?.path ?? path.resolve(process.cwd());
    this.builder = new PanelBuilder();
    // Defer root panel initialization until ViewManager is set
    this.initialRootPanelPath = initialRootPanelPath;
  }

  /**
   * Set the ViewManager for creating and managing panel views.
   * Must be called after window creation. This triggers deferred root panel initialization.
   */
  setViewManager(vm: ViewManager): void {
    this.viewManager = vm;

    // Now that ViewManager is set, initialize the root panel if deferred
    if (this.initialRootPanelPath) {
      const rootPath = this.initialRootPanelPath;
      this.initialRootPanelPath = null; // Clear to prevent re-initialization
      this.initializeRootPanel(rootPath).catch((error) => {
        console.error("[PanelManager] Failed to initialize root panel:", error);
        // Notify shell about the failure so user sees feedback
        const shellContents = vm.getShellWebContents();
        if (!shellContents.isDestroyed()) {
          shellContents.send("panel:initialization-error", {
            path: rootPath,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      });
    }
  }

  /**
   * Get the ViewManager (throws if not set).
   */
  getViewManager(): ViewManager {
    if (!this.viewManager) {
      throw new Error("ViewManager not set - call setViewManager first");
    }
    return this.viewManager;
  }

  /**
   * Create a WebContentsView for a panel or browser.
   * Called when panel build is ready or browser is created.
   * @throws Error if ViewManager is not set
   */
  createViewForPanel(panelId: string, url: string, type: "panel" | "browser"): void {
    if (!this.viewManager) {
      throw new Error(`[PanelManager] ViewManager not set, cannot create view for ${panelId}`);
    }

    if (this.viewManager.hasView(panelId)) {
      // View already exists, navigate if URL changed
      const currentUrl = this.viewManager.getViewUrl(panelId);
      if (currentUrl !== url) {
        void this.viewManager.navigateView(panelId, url);
      }
      return; // View exists and is handled
    }

    const panel = this.panels.get(panelId);
    const parentId = this.findParentId(panelId);

    if (type === "browser") {
      // Browser panels: no preload, shared session for cookies/auth
      const view = this.viewManager.createView({
        id: panelId,
        type: "browser",
        // No partition = default session (shared across browsers)
        preload: null, // No preload for browsers
        url: url,
        parentId: parentId ?? undefined,
        injectHostThemeVariables: false,
      });

      // Register with CDP server when dom-ready
      if (parentId) {
        view.webContents.on("dom-ready", () => {
          getCdpServer().registerBrowser(panelId, view.webContents.id, parentId);
        });
      }

      // Track browser state changes
      this.setupBrowserStateTracking(panelId, view.webContents);
    } else {
      // App panels: isolated partition, panel preload with auth token and env
      const authToken = randomBytes(32).toString("hex");
      this.pendingAuthTokens.set(panelId, { token: authToken, createdAt: Date.now() });

      // Periodic cleanup of expired tokens (runs lazily on each panel creation)
      this.cleanupExpiredAuthTokens();

      // Build additional arguments for preload
      const additionalArgs: string[] = [
        `--natstack-panel-id=${panelId}`,
        `--natstack-auth-token=${authToken}`,
      ];

      // Add panel env if available
      if (panel?.env && Object.keys(panel.env).length > 0) {
        try {
          const encodedEnv = Buffer.from(JSON.stringify(panel.env), "utf-8").toString("base64");
          additionalArgs.push(`--natstack-panel-env=${encodedEnv}`);
        } catch (error) {
          console.error(`[PanelManager] Failed to encode env for panel ${panelId}`, error);
        }
      }

      this.viewManager.createView({
        id: panelId,
        type: "panel",
        partition: `persist:${panelId}`, // Isolated partition for app panels
        url: url,
        parentId: parentId ?? undefined,
        injectHostThemeVariables: panel?.type === "app" ? (panel as SharedPanel.AppPanel).injectHostThemeVariables : true,
        additionalArguments: additionalArgs,
      });
    }
  }

  /**
   * Setup webContents event tracking for browser state (URL, loading, navigation).
   */
  private setupBrowserStateTracking(browserId: string, contents: Electron.WebContents): void {
    let pendingState: Partial<SharedPanel.BrowserState & { url?: string }> = {};
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    let destroyed = false;

    const flushPendingState = () => {
      if (destroyed) return; // Don't update after destruction
      if (Object.keys(pendingState).length > 0) {
        this.updateBrowserState(browserId, pendingState);
        pendingState = {};
      }
      debounceTimer = null;
    };

    const queueStateUpdate = (update: typeof pendingState) => {
      if (destroyed) return; // Don't queue after destruction
      Object.assign(pendingState, update);
      if (!debounceTimer) {
        debounceTimer = setTimeout(flushPendingState, 50);
      }
    };

    // Clean up debounce timer when webContents is destroyed
    contents.once("destroyed", () => {
      destroyed = true;
      if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }
    });

    contents.on("did-navigate", (_event, url) => {
      queueStateUpdate({ url });
    });

    contents.on("did-navigate-in-page", (_event, url) => {
      queueStateUpdate({ url });
    });

    contents.on("did-start-loading", () => {
      queueStateUpdate({ isLoading: true });
    });

    contents.on("did-stop-loading", () => {
      // Guard against destroyed webContents (can happen if event fires during destruction)
      if (contents.isDestroyed()) return;
      queueStateUpdate({
        isLoading: false,
        canGoBack: contents.canGoBack(),
        canGoForward: contents.canGoForward(),
      });
    });

    contents.on("page-title-updated", (_event, title) => {
      queueStateUpdate({ pageTitle: title });
    });
  }

  private normalizePanelPath(panelPath: string): { relativePath: string; absolutePath: string } {
    return normalizeRelativePanelPath(panelPath, this.panelsRoot);
  }

  private sanitizeIdSegment(segment: string): string {
    const trimmed = segment.trim();
    if (!trimmed || trimmed === "." || trimmed.includes("/") || trimmed.includes("\\")) {
      throw new Error(`Invalid panel identifier segment: ${segment}`);
    }
    return trimmed;
  }

  private generatePanelNonce(): string {
    return `${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
  }

  private computePanelId(params: {
    relativePath: string;
    parent?: Panel | null;
    requestedId?: string;
    singletonState?: boolean;
    isRoot?: boolean;
  }): string {
    const { relativePath, parent, requestedId, singletonState, isRoot } = params;

    // Escape slashes in path to avoid collisions (e.g., children of singletons)
    const escapedPath = relativePath.replace(/\//g, "~");

    if (singletonState) {
      return `singleton/${escapedPath}`;
    }

    if (isRoot) {
      return `tree/${escapedPath}`;
    }

    // Parent prefix: use parent's full ID, or "tree" for root panels
    const parentPrefix = parent?.id ?? "tree";

    if (requestedId) {
      const segment = this.sanitizeIdSegment(requestedId);
      return `${parentPrefix}/${segment}`;
    }

    const autoSegment = this.generatePanelNonce();
    return `${parentPrefix}/${escapedPath}/${autoSegment}`;
  }

  // Public methods for RPC services

  /**
   * Build env for a panel, injecting git credentials for non-worker panels.
   */
  private buildPanelEnv(
    panelId: string,
    isWorker: boolean,
    baseEnv?: Record<string, string>
  ): Record<string, string> | undefined {
    if (isWorker) {
      return baseEnv ? { ...baseEnv } : undefined;
    }

    const gitToken = this.gitServer.getTokenForPanel(panelId);
    return {
      ...baseEnv,
      __GIT_SERVER_URL: this.gitServer.getBaseUrl(),
      __GIT_TOKEN: gitToken,
    };
  }

  /**
   * Shared creation path for both root and child panels.
   */
  private createPanelFromManifest(params: {
    manifest: PanelManifest;
    relativePath: string;
    parent: Panel | null;
    spec?: SharedPanel.AppChildSpec | SharedPanel.WorkerChildSpec;
    isRoot?: boolean;
  }): string {
    const { manifest, relativePath, parent, spec, isRoot } = params;

    const isSingleton = manifest.singletonState === true;
    const isWorker = manifest.runtime === "worker";

    if (isSingleton && spec?.name) {
      throw new Error(
        `Panel at "${relativePath}" has singletonState and cannot have its ID overridden`
      );
    }

    const panelId = this.computePanelId({
      relativePath,
      parent,
      requestedId: spec?.name,
      singletonState: isSingleton,
      isRoot,
    });

    if (this.panels.has(panelId) || this.reservedPanelIds.has(panelId)) {
      if (isSingleton && parent) {
        parent.selectedChildId = panelId;
        this.notifyPanelTreeUpdate();
        return panelId;
      }
      throw new Error(`A panel with id "${panelId}" is already running`);
    }

    this.reservedPanelIds.add(panelId);

    try {
      const panelEnv = this.buildPanelEnv(panelId, isWorker, spec?.env);

      // Create the appropriate panel type based on manifest runtime
      const panel: Panel = isWorker
        ? {
            type: "worker",
            id: panelId,
            title: manifest.title,
            path: relativePath,
            children: [],
            selectedChildId: null,
            artifacts: {
              buildState: "building",
              buildProgress: "Starting worker...",
            },
            env: panelEnv,
            sourceRepo: relativePath,
            gitDependencies: manifest.gitDependencies,
            workerOptions: {
              memoryLimitMB: spec?.type === "worker" ? spec.memoryLimitMB : undefined,
            },
          }
        : {
            type: "app",
            id: panelId,
            title: manifest.title,
            path: relativePath,
            children: [],
            selectedChildId: null,
            injectHostThemeVariables: manifest.injectHostThemeVariables !== false,
            artifacts: {
              buildState: "building",
              buildProgress: "Starting build...",
            },
            env: panelEnv,
            sourceRepo: relativePath,
            gitDependencies: manifest.gitDependencies,
          };

      if (isRoot) {
        this.rootPanels = [panel];
        this.panels = new Map([[panel.id, panel]]);
      } else if (parent) {
        parent.children.push(panel);
        parent.selectedChildId = panel.id;
        this.panels.set(panel.id, panel);
      } else {
        this.panels.set(panel.id, panel);
      }

      this.notifyPanelTreeUpdate();

      if (panel.type === "worker") {
        void this.buildWorkerAsync(panel, spec?.type === "worker" ? spec : undefined);
      } else if (panel.type === "app") {
        void this.buildPanelAsync(panel, spec?.type === "app" ? spec : undefined);
      }

      return panel.id;
    } finally {
      this.reservedPanelIds.delete(panelId);
    }
  }

  /**
   * Create a child panel, worker, or browser from a spec.
   * Main process handles git checkout and build asynchronously for app/worker types.
   * Returns child ID immediately; build happens in background.
   */
  async createChild(parentId: string, spec: SharedPanel.ChildSpec): Promise<string> {
    const parent = this.panels.get(parentId);
    if (!parent) {
      throw new Error(`Parent panel not found: ${parentId}`);
    }

    // Handle browser panels separately (no manifest/build needed)
    if (spec.type === "browser") {
      return this.createBrowserChild(parentId, spec);
    }

    const { relativePath, absolutePath } = this.normalizePanelPath(spec.source);

    // Read manifest to check singleton state and get title
    let manifest: PanelManifest;
    try {
      manifest = this.builder.loadManifest(absolutePath);
    } catch (error) {
      throw new Error(
        `Failed to load manifest for ${spec.source}: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    return this.createPanelFromManifest({
      manifest,
      relativePath,
      parent,
      spec,
    });
  }

  /**
   * Create a browser child panel that loads an external URL.
   * Browser panels don't require manifest or build - they load external content directly.
   */
  private async createBrowserChild(
    parentId: string,
    spec: SharedPanel.BrowserChildSpec
  ): Promise<string> {
    const parent = this.panels.get(parentId);
    if (!parent) {
      throw new Error(`Parent panel not found: ${parentId}`);
    }

    // Validate URL protocol
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(spec.source);
    } catch {
      throw new Error(`Invalid URL format: "${spec.source}"`);
    }

    if (!["http:", "https:"].includes(parsedUrl.protocol)) {
      throw new Error(
        `Invalid URL protocol "${parsedUrl.protocol}". Only http: and https: are allowed.`
      );
    }

    // Generate a random name if not provided
    const browserName = spec.name ?? `browser-${this.generatePanelNonce()}`;

    const panelId = this.computePanelId({
      relativePath: `browser/${browserName}`,
      parent,
      requestedId: browserName,
      singletonState: false,
      isRoot: false,
    });

    if (this.panels.has(panelId) || this.reservedPanelIds.has(panelId)) {
      throw new Error(`A panel with id "${panelId}" is already running`);
    }

    const panel: SharedPanel.BrowserPanel = {
      type: "browser",
      id: panelId,
      title: spec.title ?? parsedUrl.hostname,
      url: spec.source,
      children: [],
      selectedChildId: null,
      artifacts: {
        buildState: "ready",
      },
      env: spec.env,
      browserState: {
        pageTitle: spec.title ?? parsedUrl.hostname,
        isLoading: true,
        canGoBack: false,
        canGoForward: false,
      },
      injectHostThemeVariables: false,
    };

    parent.children.push(panel);
    parent.selectedChildId = panel.id;
    this.panels.set(panel.id, panel);

    // Create WebContentsView for the browser
    this.createViewForPanel(panel.id, spec.source, "browser");

    this.notifyPanelTreeUpdate();

    return panel.id;
  }

  /**
   * Update browser panel state (URL, loading, navigation capabilities).
   * Called when the renderer forwards webview events.
   */
  updateBrowserState(
    browserId: string,
    state: {
      url?: string;
      pageTitle?: string;
      isLoading?: boolean;
      canGoBack?: boolean;
      canGoForward?: boolean;
    }
  ): void {
    const panel = this.panels.get(browserId);
    if (!panel || panel.type !== "browser") {
      console.warn(`[PanelManager] Browser panel not found: ${browserId}`);
      return;
    }

    // Update URL if provided
    if (state.url !== undefined) {
      panel.url = state.url;
    }

    // Update browserState fields
    if (state.pageTitle !== undefined) {
      panel.browserState.pageTitle = state.pageTitle;
      panel.title = state.pageTitle; // Also update the panel title
    }
    if (state.isLoading !== undefined) {
      panel.browserState.isLoading = state.isLoading;
    }
    if (state.canGoBack !== undefined) {
      panel.browserState.canGoBack = state.canGoBack;
    }
    if (state.canGoForward !== undefined) {
      panel.browserState.canGoForward = state.canGoForward;
    }

    this.notifyPanelTreeUpdate();
  }

  /**
   * Build a worker asynchronously and update its state.
   * Workers are built via PanelBuilder and then sent to the utility process.
   */
  private async buildWorkerAsync(
    worker: SharedPanel.WorkerPanel,
    spec?: SharedPanel.WorkerChildSpec
  ): Promise<void> {
    const workerManager = getWorkerManager();

    try {
      // Create the worker entry in WorkerManager (sets up scoped FS)
      const workerInfo = await workerManager.createWorker(
        this.findParentPanel(worker.id)?.id ?? "",
        worker.path,
        {
          env: spec?.env,
          memoryLimitMB: spec?.memoryLimitMB,
          branch: spec?.branch,
          commit: spec?.commit,
          tag: spec?.tag,
        },
        worker.id // Pass the tree node ID so WorkerManager uses it
      );

      if (workerInfo.error) {
        throw new Error(workerInfo.error);
      }

      // Build the worker bundle using PanelBuilder
      const version =
        spec?.branch || spec?.commit || spec?.tag
          ? {
              branch: spec.branch,
              commit: spec.commit,
              tag: spec.tag,
            }
          : undefined;

      const buildResult = await this.builder.buildWorker(
        this.panelsRoot,
        worker.path,
        version,
        (progress) => {
          worker.artifacts = {
            ...worker.artifacts,
            buildState: progress.state,
            buildProgress: progress.message,
            buildLog: progress.log,
          };
          this.notifyPanelTreeUpdate();
        }
      );

      if (!buildResult.success || !buildResult.bundle) {
        throw new Error(buildResult.error ?? "Worker build failed");
      }

      // Send the bundle to the utility process
      await workerManager.sendWorkerBundle(worker.id, buildResult.bundle);

      // Mark as ready
      worker.artifacts = {
        buildState: "ready",
        buildProgress: "Worker ready",
        buildLog: buildResult.buildLog,
      };
      this.notifyPanelTreeUpdate();
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      worker.artifacts = {
        error: errorMsg,
        buildState: "error",
        buildProgress: errorMsg,
      };
      this.notifyPanelTreeUpdate();
    }
  }

  /**
   * Build a panel asynchronously and update its state.
   * Works for both root and child panels (all use protocol serving now).
   */
  private async buildPanelAsync(
    panel: SharedPanel.AppPanel,
    spec?: SharedPanel.AppChildSpec
  ): Promise<void> {
    try {
      const version =
        spec?.branch || spec?.commit || spec?.tag
          ? {
              branch: spec.branch,
              commit: spec.commit,
              tag: spec.tag,
            }
          : undefined;

      const result = await this.builder.buildPanel(
        this.panelsRoot,
        panel.path,
        version,
        (progress) => {
          // Update panel state with progress
          panel.artifacts = {
            ...panel.artifacts,
            buildState: progress.state,
            buildProgress: progress.message,
            buildLog: progress.log,
          };
          this.notifyPanelTreeUpdate();
        },
        { sourcemap: spec?.sourcemap !== false }
      );

      if (result.success && result.bundle && result.html) {
        // Store panel content for protocol serving
        const htmlUrl = storeProtocolPanel(panel.id, {
          bundle: result.bundle,
          html: result.html,
          title: result.manifest?.title ?? panel.title,
          css: result.css,
          injectHostThemeVariables: result.manifest?.injectHostThemeVariables !== false,
          sourceRepo: panel.path,
          gitDependencies: result.manifest?.gitDependencies,
        });

        // Update panel with successful build
        panel.artifacts = {
          htmlPath: htmlUrl,
          buildState: "ready",
          buildProgress: "Build complete",
          buildLog: result.buildLog,
        };

        // Create WebContentsView for this panel
        const srcUrl = new URL(htmlUrl);
        srcUrl.searchParams.set("panelId", panel.id);
        this.createViewForPanel(panel.id, srcUrl.toString(), "panel");
      } else {
        // Build failed
        panel.artifacts = {
          error: result.error ?? "Build failed",
          buildState: "error",
          buildProgress: result.error ?? "Build failed",
          buildLog: result.buildLog,
        };
      }

      this.notifyPanelTreeUpdate();
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      panel.artifacts = {
        error: errorMsg,
        buildState: "error",
        buildProgress: errorMsg,
      };
      this.notifyPanelTreeUpdate();
    }
  }

  async removeChild(parentId: string, childId: string): Promise<void> {
    const parent = this.panels.get(parentId);
    if (!parent) {
      throw new Error(`Parent panel not found: ${parentId}`);
    }

    const childIndex = parent.children.findIndex((c) => c.id === childId);
    if (childIndex === -1) {
      throw new Error(`Child panel not found: ${childId}`);
    }

    // Remove child
    parent.children.splice(childIndex, 1);

    // Update selected child
    if (parent.selectedChildId === childId) {
      const firstChild = parent.children[0];
      parent.selectedChildId = firstChild ? firstChild.id : null;
    }

    // Remove from panels map (and all descendants)
    this.removePanelRecursive(childId);

    this.sendPanelEvent(parent.id, { type: "child-removed", childId });

    // Notify renderer
    this.notifyPanelTreeUpdate();
  }

  async setTitle(panelId: string, title: string): Promise<void> {
    const panel = this.panels.get(panelId);
    if (!panel) {
      throw new Error(`Panel not found: ${panelId}`);
    }

    panel.title = title;

    // Notify renderer
    this.notifyPanelTreeUpdate();
  }

  /**
   * Add a console log entry to a worker panel.
   * Keeps only the last 100 log entries to avoid memory bloat.
   */
  addWorkerConsoleLog(workerId: string, level: string, message: string): void {
    const panel = this.panels.get(workerId);
    if (!panel || panel.type !== "worker") {
      return; // Silently ignore if not a worker
    }

    if (!panel.consoleLogs) {
      panel.consoleLogs = [];
    }

    panel.consoleLogs.push({
      timestamp: Date.now(),
      level,
      message,
    });

    // Keep only the last 100 entries
    if (panel.consoleLogs.length > 100) {
      panel.consoleLogs = panel.consoleLogs.slice(-100);
    }

    // Notify renderer about the update
    this.notifyPanelTreeUpdate();
  }

  async closePanel(panelId: string): Promise<void> {
    // Find parent
    const parent = this.findParentPanel(panelId);
    if (parent) {
      const childIndex = parent.children.findIndex((c) => c.id === panelId);
      if (childIndex !== -1) {
        parent.children.splice(childIndex, 1);

        // Update selected child
        if (parent.selectedChildId === panelId) {
          const firstChild = parent.children[0];
          parent.selectedChildId = firstChild ? firstChild.id : null;
        }

        this.sendPanelEvent(parent.id, { type: "child-removed", childId: panelId });
      }
    }

    // Remove from panels map
    this.removePanelRecursive(panelId);

    // Notify renderer
    this.notifyPanelTreeUpdate();
  }

  getEnv(panelId: string): Record<string, string> {
    const panel = this.panels.get(panelId);
    if (!panel) {
      throw new Error(`Panel not found: ${panelId}`);
    }
    return panel.env ?? {};
  }

  getInfo(panelId: string): SharedPanel.PanelInfo {
    const panel = this.panels.get(panelId);
    if (!panel) {
      throw new Error(`Panel not found: ${panelId}`);
    }
    return {
      panelId: panel.id,
      partition: panel.id,
    };
  }

  /**
   * Get git configuration for a panel.
   * Used by panels to clone/pull their source and dependencies via @natstack/git.
   */
  getGitConfig(panelId: string): {
    serverUrl: string;
    token: string;
    sourceRepo: string;
    gitDependencies: Record<string, SharedPanel.GitDependencySpec>;
  } {
    const panel = this.panels.get(panelId);
    if (!panel) {
      throw new Error(`Panel not found: ${panelId}`);
    }

    // Browser panels don't have git configuration
    if (panel.type === "browser") {
      throw new Error("Git configuration is not available for browser panels");
    }

    const sourceRepo = panel.sourceRepo ?? panel.path;
    if (!sourceRepo) {
      throw new Error("Git configuration is not available for this panel");
    }
    return {
      serverUrl: this.gitServer.getBaseUrl(),
      token: this.gitServer.getTokenForPanel(panelId),
      sourceRepo,
      gitDependencies: panel.gitDependencies ?? {},
    };
  }

  getSerializablePanelTree(): Panel[] {
    return this.rootPanels.map((panel) => this.serializePanel(panel));
  }

  /**
   * Find which panel a webContents sender belongs to.
   * Uses ViewManager's reverse lookup from webContents ID to view ID.
   * Returns the panel ID if found, null otherwise.
   */
  findPanelIdBySenderId(senderId: number): string | null {
    if (!this.viewManager) {
      return null;
    }
    return this.viewManager.findViewIdByWebContentsId(senderId);
  }

  setCurrentTheme(theme: "light" | "dark"): void {
    this.currentTheme = theme;
  }

  sendPanelEvent(panelId: string, payload: PanelEventPayload): void {
    // Use ViewManager to get webContents for the panel
    if (!this.viewManager) {
      return;
    }

    const contents = this.viewManager.getWebContents(panelId);
    if (contents && !contents.isDestroyed()) {
      contents.send("panel:event", { panelId, ...payload });
    }
  }

  broadcastTheme(theme: "light" | "dark"): void {
    // Broadcast to all panels that have views (app panels with views, not workers)
    for (const panelId of this.panels.keys()) {
      if (this.viewManager?.hasView(panelId)) {
        this.sendPanelEvent(panelId, { type: "theme", theme });
      }
    }
  }

  // Private methods

  private removePanelRecursive(panelId: string): void {
    const panel = this.panels.get(panelId);
    if (!panel) return;

    // Remove all children first
    for (const child of panel.children) {
      this.removePanelRecursive(child.id);
    }

    // Cleanup based on panel type
    switch (panel.type) {
      case "worker":
        // Terminate the worker (fire-and-forget is acceptable here since
        // terminateWorker handles cleanup and we don't need to block panel removal)
        getWorkerManager().terminateWorker(panelId);
        // Revoke CDP token for this worker (cleans up browser ownership)
        getCdpServer().revokeTokenForPanel(panelId);
        break;

      case "browser":
        // Unregister from CDP server
        getCdpServer().unregisterBrowser(panelId);
        break;

      case "app":
        // App panel cleanup
        // Revoke git token for this panel
        this.gitServer.revokeTokenForPanel(panelId);

        // Revoke CDP token for this panel (cleans up browser ownership)
        getCdpServer().revokeTokenForPanel(panelId);

        // Clean up any Claude Code conversations for this panel
        getClaudeCodeConversationManager().endPanelConversations(panelId);

        // Clean up protocol-served panel content if applicable
        if (isProtocolPanel(panelId)) {
          removeProtocolPanel(panelId);
        }
        break;
    }

    // Destroy the WebContentsView
    if (this.viewManager?.hasView(panelId)) {
      this.viewManager.destroyView(panelId);
    }

    // Remove from panels map
    this.panels.delete(panelId);
  }

  private findParentPanel(childId: string): Panel | null {
    for (const panel of this.panels.values()) {
      if (panel.children.some((c) => c.id === childId)) {
        return panel;
      }
    }
    return null;
  }

  /**
   * Find the parent panel ID for a given child panel ID.
   * Returns null if the panel is a root panel or not found.
   */
  findParentId(childId: string): string | null {
    const parent = this.findParentPanel(childId);
    return parent?.id ?? null;
  }

  /**
   * Find a browser panel by its URL.
   * Used for auto-registering browser webviews when they attach.
   * Returns null if no matching browser panel is found.
   */
  findBrowserPanelByUrl(url: string): Panel | null {
    // Normalize the URL for comparison
    const normalizedUrl = url.toLowerCase();

    for (const panel of this.panels.values()) {
      if (panel.type === "browser") {
        const browserUrl = (panel as BrowserPanel).url?.toLowerCase();
        // Match if URLs are the same or if the browser navigated (URL might have changed)
        if (browserUrl && (normalizedUrl.startsWith(browserUrl) || browserUrl.startsWith(normalizedUrl))) {
          return panel;
        }
      }
    }
    return null;
  }

  /**
   * Notify renderer of panel tree changes.
   * Debounced to batch rapid updates (e.g., worker console logs).
   */
  notifyPanelTreeUpdate(): void {
    // Mark update pending
    this.treeUpdatePending = true;

    // If timer already running, let it handle the update
    if (this.treeUpdateTimer) {
      return;
    }

    // Schedule debounced update
    this.treeUpdateTimer = setTimeout(() => {
      this.treeUpdateTimer = null;
      if (this.treeUpdatePending && this.viewManager) {
        this.treeUpdatePending = false;
        const tree = this.getSerializablePanelTree();
        const shellContents = this.viewManager.getShellWebContents();
        if (!shellContents.isDestroyed()) {
          shellContents.send("panel:tree-updated", tree);
        }
      }
    }, this.TREE_UPDATE_DEBOUNCE_MS);
  }

  private serializePanel(panel: Panel): Panel {
    const { env: _env, children, ...rest } = panel;
    return {
      ...rest,
      children: children.map((child) => this.serializePanel(child)),
    };
  }

  getRootPanels(): Panel[] {
    return this.rootPanels;
  }

  getPanel(id: string): Panel | undefined {
    return this.panels.get(id);
  }

  // Map guestInstanceId (from webContents) to panelId
  private guestInstanceMap: Map<number, string> = new Map();
  // Map panelId -> pending auth token with timestamp for TTL cleanup
  private pendingAuthTokens: Map<string, { token: string; createdAt: number }> = new Map();
  // TTL for pending auth tokens (30 seconds should be plenty for webview init)
  private readonly AUTH_TOKEN_TTL_MS = 30_000;

  getPanelIdForWebContents(contents: Electron.WebContents): string | undefined {
    return this.guestInstanceMap.get(contents.id);
  }

  /**
   * Get WebContents for a panel.
   * Used for sending IPC messages to panels.
   */
  getWebContentsForPanel(panelId: string): Electron.WebContents | undefined {
    if (!this.viewManager) {
      return undefined;
    }
    return this.viewManager.getWebContents(panelId) ?? undefined;
  }

  verifyAndRegister(panelId: string, token: string, senderId: number): void {
    // Check if this is a reload - same webContentsId already registered for this panel.
    // This is safe because:
    // 1. The senderId (webContentsId) is assigned by Electron and cannot be spoofed
    // 2. We only skip token validation if BOTH the senderId AND panelId match existing registration
    // 3. A malicious panel with a different senderId cannot re-register as another panel
    const existingPanelId = this.guestInstanceMap.get(senderId);
    if (existingPanelId === panelId) {
      // Re-registration after reload - panel is re-initializing with same webContents.
      // Re-send theme to ensure panel has current theme after reload.
      this.sendPanelEvent(panelId, { type: "theme", theme: this.currentTheme });
      return;
    }

    const pending = this.pendingAuthTokens.get(panelId);
    if (!pending || pending.token !== token) {
      throw new Error(`Invalid auth token for panel ${panelId}`);
    }

    // Check if token has expired
    if (Date.now() - pending.createdAt > this.AUTH_TOKEN_TTL_MS) {
      this.pendingAuthTokens.delete(panelId);
      throw new Error(`Auth token for panel ${panelId} has expired`);
    }

    // Token is valid and used
    this.pendingAuthTokens.delete(panelId);

    this.guestInstanceMap.set(senderId, panelId);
    this.registerPanelView(panelId, senderId);
  }

  /**
   * Clean up expired auth tokens to prevent memory leaks.
   * Called lazily when new panels are created.
   */
  private cleanupExpiredAuthTokens(): void {
    const now = Date.now();
    for (const [panelId, pending] of this.pendingAuthTokens) {
      if (now - pending.createdAt > this.AUTH_TOKEN_TTL_MS) {
        this.pendingAuthTokens.delete(panelId);
      }
    }
  }

  private registerPanelView(panelId: string, senderId: number): void {
    // ViewManager now tracks the webContents, we just need to set up cleanup for guestInstanceMap
    const contents = this.viewManager?.getWebContents(panelId);
    if (contents && !contents.isDestroyed()) {
      contents.once("destroyed", () => {
        this.guestInstanceMap.delete(senderId);
      });
    }

    this.sendPanelEvent(panelId, { type: "theme", theme: this.currentTheme });
  }

  private async initializeRootPanel(panelPath: string): Promise<void> {
    try {
      const { relativePath, absolutePath } = this.normalizePanelPath(panelPath);
      const manifest = this.builder.loadManifest(absolutePath);
      this.createPanelFromManifest({
        manifest,
        relativePath,
        parent: null,
        isRoot: true,
      });
    } catch (error) {
      console.error("Failed to initialize root panel:", error);
    }
  }
}
