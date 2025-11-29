import { type BrowserWindow, webContents } from "electron";
import * as path from "path";
import { randomBytes } from "crypto";
import { PanelBuilder } from "./panelBuilder.js";
import type { PanelEventPayload, Panel, PanelArtifacts } from "./panelTypes.js";
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
  }): string {
    const { relativePath, parent, requestedId, singletonState } = params;

    // Escape slashes in path to avoid collisions (e.g., children of singletons)
    const escapedPath = relativePath.replace(/\//g, "~");

    if (singletonState) {
      return `singleton/${escapedPath}`;
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
   * Create a child panel or worker from a workspace path.
   * Main process handles git checkout and build asynchronously.
   * Returns child ID immediately; build happens in background.
   *
   * The runtime type (panel vs worker) is determined by the manifest's `runtime` field.
   * Workers run in isolated-vm with auto-generated filesystem scope paths.
   * Singleton children get the same ID/scope path across restarts.
   */
  async createChild(
    parentId: string,
    childPath: string,
    options?: SharedPanel.CreateChildOptions
  ): Promise<string> {
    const parent = this.panels.get(parentId);
    if (!parent) {
      throw new Error(`Parent panel not found: ${parentId}`);
    }

    const { relativePath, absolutePath } = this.normalizePanelPath(childPath);

    // Read manifest to check singleton state and get title
    let manifest;
    try {
      manifest = this.builder.loadManifest(absolutePath);
    } catch (error) {
      throw new Error(
        `Failed to load manifest for ${childPath}: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    const isSingleton = manifest.singletonState === true;
    const isWorker = manifest.runtime === "worker";

    if (isSingleton && options?.panelId) {
      throw new Error(
        `Panel at "${relativePath}" has singletonState and cannot have its ID overridden`
      );
    }

    // Compute child ID
    const childId = this.computePanelId({
      relativePath,
      parent,
      requestedId: options?.panelId,
      singletonState: isSingleton,
    });

    // Check if child already exists (for singletons)
    if (this.panels.has(childId) || this.reservedPanelIds.has(childId)) {
      if (isSingleton) {
        // For singletons, just select the existing child
        parent.selectedChildId = childId;
        this.notifyPanelTreeUpdate();
        return childId;
      }
      throw new Error(`A child with id "${childId}" is already running`);
    }

    this.reservedPanelIds.add(childId);

    try {
      // Create child node immediately with 'building' state
      const newChild: Panel = {
        id: childId,
        title: manifest.title,
        path: relativePath,
        children: [],
        selectedChildId: null,
        injectHostThemeVariables: !isWorker && manifest.injectHostThemeVariables !== false,
        artifacts: {
          buildState: "building",
          buildProgress: isWorker ? "Starting worker..." : "Starting build...",
        },
        env: options?.env,
        sourceRepo: relativePath,
        gitDependencies: manifest.gitDependencies,
        type: isWorker ? "worker" : undefined,
        workerOptions: isWorker
          ? {
              memoryLimitMB: options?.memoryLimitMB,
            }
          : undefined,
      };

      // For panels, also set up git token
      if (!isWorker) {
        const gitToken = this.gitServer.getTokenForPanel(childId);
        newChild.env = {
          ...newChild.env,
          __GIT_SERVER_URL: this.gitServer.getBaseUrl(),
          __GIT_TOKEN: gitToken,
        };
      }

      parent.children.push(newChild);
      parent.selectedChildId = newChild.id;
      this.panels.set(newChild.id, newChild);

      // Notify UI of new child (will show placeholder)
      this.notifyPanelTreeUpdate();

      // Start async build/creation
      if (isWorker) {
        void this.buildWorkerAsync(newChild, options);
      } else {
        void this.buildPanelAsync(newChild, options);
      }

      return newChild.id;
    } finally {
      this.reservedPanelIds.delete(childId);
    }
  }

  /**
   * Build a worker asynchronously and update its state.
   * Workers are built via PanelBuilder and then sent to the utility process.
   */
  private async buildWorkerAsync(
    worker: Panel,
    options?: SharedPanel.CreateChildOptions
  ): Promise<void> {
    const workerManager = getWorkerManager();

    try {
      // Create the worker entry in WorkerManager (sets up scoped FS)
      const workerInfo = await workerManager.createWorker(
        this.findParentPanel(worker.id)?.id ?? "",
        worker.path,
        {
          env: options?.env,
          memoryLimitMB: options?.memoryLimitMB,
          branch: options?.branch,
          commit: options?.commit,
          tag: options?.tag,
        },
        worker.id // Pass the tree node ID so WorkerManager uses it
      );

      if (workerInfo.error) {
        throw new Error(workerInfo.error);
      }

      // Build the worker bundle using PanelBuilder
      const version =
        options?.branch || options?.commit || options?.tag
          ? {
              branch: options.branch,
              commit: options.commit,
              tag: options.tag,
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
    panel: Panel,
    options?: SharedPanel.CreateChildOptions
  ): Promise<void> {
    try {
      const version =
        options?.branch || options?.commit || options?.tag
          ? {
              branch: options.branch,
              commit: options.commit,
              tag: options.tag,
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

    // Check if this is a worker or a panel
    if (panel.type === "worker") {
      // Terminate the worker
      void getWorkerManager().terminateWorker(panelId);
    } else {
      // Panel cleanup
      // Revoke git token for this panel
      this.gitServer.revokeTokenForPanel(panelId);

      // Clean up any Claude Code conversations for this panel
      getClaudeCodeConversationManager().endPanelConversations(panelId);

      // Clean up protocol-served panel content if applicable
      if (isProtocolPanel(panelId)) {
        removeProtocolPanel(panelId);
      }
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

  notifyPanelTreeUpdate(): void {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      const tree = this.getSerializablePanelTree();
      this.mainWindow.webContents.send("panel:tree-updated", tree);
    }
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
    let panelId: string | undefined;
    try {
      const { relativePath, absolutePath } = this.normalizePanelPath(panelPath);
      const manifest = this.builder.loadManifest(absolutePath);
      const isSingleton = manifest.singletonState === true;
      panelId = this.computePanelId({
        relativePath,
        singletonState: isSingleton,
        parent: null,
      });

      if (this.panels.has(panelId) || this.reservedPanelIds.has(panelId)) {
        throw new Error(`Root panel id/partition already in use: ${panelId}`);
      }

      this.reservedPanelIds.add(panelId);

      // Inject git server credentials into root panel env
      const gitToken = this.gitServer.getTokenForPanel(panelId);
      const panelEnv: Record<string, string> = {
        __GIT_SERVER_URL: this.gitServer.getBaseUrl(),
        __GIT_TOKEN: gitToken,
      };

      // Create root panel with initial building state
      const rootPanel: Panel = {
        id: panelId,
        title: manifest.title,
        path: relativePath,
        children: [],
        selectedChildId: null,
        injectHostThemeVariables: manifest.injectHostThemeVariables !== false,
        artifacts: {
          buildState: "building",
          buildProgress: "Initializing...",
        },
        env: panelEnv,
        gitDependencies: manifest.gitDependencies,
      };

      this.rootPanels = [rootPanel];
      this.panels = new Map([[rootPanel.id, rootPanel]]);
      this.notifyPanelTreeUpdate();

      // Build asynchronously (same as child panels)
      void this.buildPanelAsync(rootPanel);
    } catch (error) {
      console.error("Failed to initialize root panel:", error);
    } finally {
      if (panelId) {
        this.reservedPanelIds.delete(panelId);
      }
    }
  }
}
