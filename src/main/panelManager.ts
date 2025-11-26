import { type BrowserWindow, webContents } from "electron";
import * as path from "path";
import { randomBytes } from "crypto";
import { PanelBuilder } from "./panelBuilder.js";
import type { PanelEventPayload, Panel, PanelArtifacts } from "./panelTypes.js";
import { getPanelCacheDirectory, getActiveWorkspace } from "./paths.js";
import { PANEL_ENV_ARG_PREFIX } from "../common/panelEnv.js";
import type { GitServer } from "./gitServer.js";
import { normalizeRelativePanelPath } from "./pathUtils.js";
import * as SharedPanel from "../shared/ipc/types.js";
import { getClaudeCodeConversationManager } from "./ai/claudeCodeConversationManager.js";

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
    const cacheDir = getPanelCacheDirectory();
    // console.log("Using panel cache directory:", cacheDir);
    this.builder = new PanelBuilder(cacheDir);
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

  async createChild(
    parentId: string,
    panelPath: string,
    env?: Record<string, string>,
    requestedPanelId?: string
  ): Promise<string> {
    const parent = this.panels.get(parentId);
    if (!parent) {
      throw new Error(`Parent panel not found: ${parentId}`);
    }

    const { relativePath, absolutePath } = this.normalizePanelPath(panelPath);
    const manifest = this.builder.loadManifest(absolutePath);
    const isSingleton = manifest.singletonState === true;

    if (isSingleton && requestedPanelId) {
      throw new Error(
        `Panel at "${relativePath}" has singletonState and cannot have its ID overridden`
      );
    }

    const panelId = this.computePanelId({
      relativePath,
      parent,
      requestedId: requestedPanelId,
      singletonState: isSingleton,
    });

    if (this.panels.has(panelId) || this.reservedPanelIds.has(panelId)) {
      throw new Error(`A panel with id/partition "${panelId}" is already running`);
    }

    this.reservedPanelIds.add(panelId);
    try {
      const artifacts = await this.buildPanelArtifacts(absolutePath);

      // Inject git server credentials into panel env
      const gitToken = this.gitServer.getTokenForPanel(panelId);
      const panelEnv: Record<string, string> = {
        ...env,
        __GIT_SERVER_URL: this.gitServer.getBaseUrl(),
        __GIT_TOKEN: gitToken,
      };

      const newPanel: Panel = {
        id: panelId,
        title: manifest.title,
        path: relativePath,
        children: [],
        selectedChildId: null,
        injectHostThemeVariables: manifest.injectHostThemeVariables !== false,
        artifacts,
        env: panelEnv,
      };

      // Add to parent
      parent.children.push(newPanel);
      parent.selectedChildId = newPanel.id;
      this.panels.set(newPanel.id, newPanel);

      // Notify renderer
      this.notifyPanelTreeUpdate();

      return newPanel.id;
    } finally {
      this.reservedPanelIds.delete(panelId);
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

    // Revoke git token for this panel
    this.gitServer.revokeTokenForPanel(panelId);

    // Clean up any Claude Code conversations for this panel
    getClaudeCodeConversationManager().endPanelConversations(panelId);

    // Remove this panel
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
      this.mainWindow.webContents.send("panel:tree-updated", this.getSerializablePanelTree());
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

      const artifacts = await this.buildPanelArtifacts(absolutePath);

      // Inject git server credentials into root panel env
      const gitToken = this.gitServer.getTokenForPanel(panelId);
      const panelEnv: Record<string, string> = {
        __GIT_SERVER_URL: this.gitServer.getBaseUrl(),
        __GIT_TOKEN: gitToken,
      };

      const rootPanel: Panel = {
        id: panelId,
        title: manifest.title,
        path: relativePath,
        children: [],
        selectedChildId: null,
        injectHostThemeVariables: manifest.injectHostThemeVariables !== false,
        artifacts,
        env: panelEnv,
      };

      this.rootPanels = [rootPanel];
      this.panels = new Map([[rootPanel.id, rootPanel]]);
      this.notifyPanelTreeUpdate();
    } catch (error) {
      console.error("Failed to initialize root panel:", error);
    } finally {
      if (panelId) {
        this.reservedPanelIds.delete(panelId);
      }
    }
  }

  private async buildPanelArtifacts(panelPath: string): Promise<PanelArtifacts> {
    try {
      const buildResult = await this.builder.buildPanel(panelPath);
      if (buildResult.success && buildResult.htmlPath) {
        return {
          htmlPath: buildResult.htmlPath,
          bundlePath: buildResult.bundlePath,
        };
      }

      return {
        error: buildResult.error || "Failed to build panel",
      };
    } catch (error) {
      return {
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
