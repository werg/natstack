import { type BrowserWindow, webContents } from "electron";
import * as path from "path";
import { randomBytes } from "crypto";
import { PanelBuilder } from "./panelBuilder.js";
import type { PanelEventPayload, Panel, PanelManifest } from "./panelTypes.js";
import { getActiveWorkspace } from "./paths.js";
import { PANEL_ENV_ARG_PREFIX } from "../common/panelEnv.js";
import type { GitServer } from "./gitServer.js";
import { normalizeRelativePanelPath } from "./pathUtils.js";
import * as SharedPanel from "../shared/ipc/types.js";
import { getClaudeCodeConversationManager } from "./ai/claudeCodeConversationManager.js";
import {
  storeProtocolPanel,
  removeProtocolPanel,
  isProtocolPanel,
  registerProtocolForPartition,
} from "./panelProtocol.js";
import { getWorkerManager } from "./workerManager.js";
import { getCdpServer } from "./cdpServer.js";

export class PanelManager {
  private builder: PanelBuilder;
  private mainWindow: BrowserWindow | null = null;
  private panels: Map<string, Panel> = new Map();
  private reservedPanelIds: Set<string> = new Set();
  private rootPanels: Panel[] = [];
  private panelViews: Map<string, Set<number>> = new Map();
  private currentTheme: "light" | "dark" = "light";
  private panelsRoot: string;
  private gitServer: GitServer;

  // Debounce state for panel tree updates
  private treeUpdatePending = false;
  private treeUpdateTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly TREE_UPDATE_DEBOUNCE_MS = 16; // ~1 frame at 60fps

  constructor(initialRootPanelPath: string, gitServer: GitServer) {
    this.gitServer = gitServer;
    const workspace = getActiveWorkspace();
    this.panelsRoot = workspace?.path ?? path.resolve(process.cwd());
    this.builder = new PanelBuilder();
    void this.initializeRootPanel(initialRootPanelPath);
  }

  setMainWindow(window: BrowserWindow): void {
    this.mainWindow = window;
    this.registerWebviewEnvInjection(window);
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

    const { relativePath, absolutePath } = this.normalizePanelPath(spec.path);

    // Read manifest to check singleton state and get title
    let manifest: PanelManifest;
    try {
      manifest = this.builder.loadManifest(absolutePath);
    } catch (error) {
      throw new Error(
        `Failed to load manifest for ${spec.path}: ${error instanceof Error ? error.message : String(error)}`
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
      parsedUrl = new URL(spec.url);
    } catch {
      throw new Error(`Invalid URL format: "${spec.url}"`);
    }

    if (!["http:", "https:"].includes(parsedUrl.protocol)) {
      throw new Error(
        `Invalid URL protocol "${parsedUrl.protocol}". Only http: and https: are allowed.`
      );
    }

    const panelId = this.computePanelId({
      relativePath: `browser/${spec.name}`,
      parent,
      requestedId: spec.name,
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
      url: spec.url,
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
        }
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

  getPanelViews(panelId: string): Set<number> | undefined {
    return this.panelViews.get(panelId);
  }

  /**
   * Find which panel a webContents sender belongs to.
   * Returns the panel ID if found, null otherwise.
   */
  findPanelIdBySenderId(senderId: number): string | null {
    for (const [panelId, views] of this.panelViews) {
      if (views.has(senderId)) {
        return panelId;
      }
    }
    return null;
  }

  setCurrentTheme(theme: "light" | "dark"): void {
    this.currentTheme = theme;
  }

  sendPanelEvent(panelId: string, payload: PanelEventPayload): void {
    const views = this.panelViews.get(panelId);
    if (!views) return;

    for (const senderId of views) {
      const contents = webContents.fromId(senderId);
      if (contents && !contents.isDestroyed()) {
        contents.send("panel:event", { panelId, ...payload });
      }
    }
  }

  broadcastTheme(theme: "light" | "dark"): void {
    for (const panelId of this.panelViews.keys()) {
      this.sendPanelEvent(panelId, { type: "theme", theme });
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
        // Terminate the worker
        void getWorkerManager().terminateWorker(panelId);
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

    // Remove from panels map and views
    this.panels.delete(panelId);
    this.panelViews.delete(panelId);
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
      if (this.treeUpdatePending && this.mainWindow && !this.mainWindow.isDestroyed()) {
        this.treeUpdatePending = false;
        const tree = this.getSerializablePanelTree();
        this.mainWindow.webContents.send("panel:tree-updated", tree);
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
  // Map panelId -> pending auth token
  private pendingAuthTokens: Map<string, string> = new Map();

  getPanelIdForWebContents(contents: Electron.WebContents): string | undefined {
    return this.guestInstanceMap.get(contents.id);
  }

  /**
   * Get WebContents for a panel (returns the first registered view).
   * Used for sending IPC messages to panels.
   */
  getWebContentsForPanel(panelId: string): Electron.WebContents | undefined {
    const views = this.panelViews.get(panelId);
    if (!views || views.size === 0) return undefined;

    // Get the first view's webContents
    const firstViewId = views.values().next().value;
    if (firstViewId === undefined) return undefined;

    return webContents.fromId(firstViewId) ?? undefined;
  }

  verifyAndRegister(panelId: string, token: string, senderId: number): void {
    const expectedToken = this.pendingAuthTokens.get(panelId);
    if (!expectedToken || expectedToken !== token) {
      throw new Error(`Invalid auth token for panel ${panelId}`);
    }

    // Token is valid and used
    this.pendingAuthTokens.delete(panelId);

    this.guestInstanceMap.set(senderId, panelId);
    this.registerPanelView(panelId, senderId);
  }

  private registerWebviewEnvInjection(window: BrowserWindow): void {
    window.webContents.on("will-attach-webview", (_event, webPreferences, params) => {
      const panelId = this.extractPanelIdFromSrc(params?.["src"]);
      if (!panelId) {
        return;
      }

      // Register the natstack-panel:// protocol for this partition
      // Each webview partition needs its own protocol handler registration
      const partition = webPreferences.partition as string | undefined;
      if (partition) {
        void registerProtocolForPartition(partition);
      }

      // Generate secure token
      const authToken = randomBytes(32).toString("hex");
      this.pendingAuthTokens.set(panelId, authToken);

      // Enable OPFS (Origin Private File System) support
      webPreferences.contextIsolation = true;
      webPreferences.sandbox = true;

      const args = webPreferences.additionalArguments ?? [];

      // Inject auth token
      args.push(`--natstack-auth-token=${authToken}`);

      const env = this.panels.get(panelId)?.env;
      if (env && Object.keys(env).length > 0) {
        try {
          const encodedEnv = Buffer.from(JSON.stringify(env), "utf-8").toString("base64");
          args.push(`${PANEL_ENV_ARG_PREFIX}${encodedEnv}`);
        } catch (error) {
          console.error(`Failed to encode env for panel ${panelId}`, error);
        }
      }

      webPreferences.additionalArguments = args;
    });

    // We still listen to did-attach-webview as a fallback or for cleanup,
    // but registration is now primarily driven by the panel's explicit call.
  }

  private registerPanelView(panelId: string, senderId: number): void {
    const views = this.panelViews.get(panelId) ?? new Set<number>();
    views.add(senderId);
    this.panelViews.set(panelId, views);

    const contents = webContents.fromId(senderId);
    if (contents) {
      contents.once("destroyed", () => {
        const currentViews = this.panelViews.get(panelId);
        currentViews?.delete(senderId);
        if (currentViews && currentViews.size === 0) {
          this.panelViews.delete(panelId);
        }
        this.guestInstanceMap.delete(senderId);
      });
    }

    this.sendPanelEvent(panelId, { type: "theme", theme: this.currentTheme });
  }

  private extractPanelIdFromSrc(src?: string): string | null {
    if (!src) {
      return null;
    }

    try {
      const url = new URL(src);
      return url.searchParams.get("panelId");
    } catch {
      return null;
    }
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
