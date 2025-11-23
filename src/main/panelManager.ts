import { ipcMain, type IpcMainInvokeEvent, type BrowserWindow, webContents } from "electron";
import * as path from "path";
import { randomBytes } from "crypto";
import { PanelBuilder } from "./panelBuilder.js";
import type { PanelEventPayload, Panel, PanelArtifacts } from "./panelTypes.js";
import { getPanelCacheDirectory } from "./paths.js";
import { PANEL_ENV_ARG_PREFIX } from "../common/panelEnv.js";
import type { GitServer } from "./gitServer.js";
import { normalizeRelativePanelPath } from "./pathUtils.js";

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
    this.panelsRoot = path.resolve(process.cwd());
    const cacheDir = getPanelCacheDirectory();
    console.log("Using panel cache directory:", cacheDir);
    this.builder = new PanelBuilder(cacheDir);
    this.setupIpcHandlers();
    // TODO: Perhaps a special way to handle errors / switch roots
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

  private setupIpcHandlers(): void {
    // Create a child panel
    ipcMain.handle(
      "panel:create-child",
      async (
        _event: IpcMainInvokeEvent,
        parentId: string,
        panelPath: string,
        env?: Record<string, string>,
        requestedPanelId?: string
      ): Promise<string> => {
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
    );

    // Remove a child panel
    ipcMain.handle(
      "panel:remove-child",
      async (_event: IpcMainInvokeEvent, parentId: string, childId: string): Promise<void> => {
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
          parent.selectedChildId = parent.children.length > 0 ? parent.children[0]!.id : null;
        }

        // Remove from panels map (and all descendants)
        this.removePanelRecursive(childId);

        this.sendPanelEvent(parent.id, { type: "child-removed", childId });

        // Notify renderer
        this.notifyPanelTreeUpdate();
      }
    );

    // Set panel title
    ipcMain.handle(
      "panel:set-title",
      async (_event: IpcMainInvokeEvent, panelId: string, title: string): Promise<void> => {
        const panel = this.panels.get(panelId);
        if (!panel) {
          throw new Error(`Panel not found: ${panelId}`);
        }

        panel.title = title;

        // Notify renderer
        this.notifyPanelTreeUpdate();
      }
    );

    // Close panel (remove from parent)
    ipcMain.handle(
      "panel:close",
      async (_event: IpcMainInvokeEvent, panelId: string): Promise<void> => {
        // Find parent
        const parent = this.findParentPanel(panelId);
        if (parent) {
          const childIndex = parent.children.findIndex((c) => c.id === panelId);
          if (childIndex !== -1) {
            parent.children.splice(childIndex, 1);

            // Update selected child
            if (parent.selectedChildId === panelId) {
              parent.selectedChildId = parent.children.length > 0 ? parent.children[0]!.id : null;
            }

            this.sendPanelEvent(parent.id, { type: "child-removed", childId: panelId });
          }
        }

        // Remove from panels map
        this.removePanelRecursive(panelId);

        // Notify renderer
        this.notifyPanelTreeUpdate();
      }
    );

    ipcMain.handle(
      "panel:register-view",
      async (event: IpcMainInvokeEvent, panelId: string): Promise<void> => {
        this.registerPanelView(panelId, event.sender.id);
      }
    );

    ipcMain.handle(
      "panel:notify-focus",
      async (_event: IpcMainInvokeEvent, panelId: string): Promise<void> => {
        this.sendPanelEvent(panelId, { type: "focus" });
      }
    );

    ipcMain.handle("panel:get-tree", async (): Promise<Panel[]> => {
      return this.getSerializablePanelTree();
    });

    ipcMain.handle(
      "panel:get-env",
      async (_event: IpcMainInvokeEvent, panelId: string): Promise<Record<string, string>> => {
        const panel = this.panels.get(panelId);
        if (!panel) {
          throw new Error(`Panel not found: ${panelId}`);
        }
        return panel.env ?? {};
      }
    );

    ipcMain.handle(
      "panel:get-info",
      async (
        _event: IpcMainInvokeEvent,
        panelId: string
      ): Promise<{ panelId: string; partition: string }> => {
        const panel = this.panels.get(panelId);
        if (!panel) {
          throw new Error(`Panel not found: ${panelId}`);
        }
        return {
          panelId: panel.id,
          partition: panel.id,
        };
      }
    );

    ipcMain.handle(
      "panel:update-theme",
      async (_event: IpcMainInvokeEvent, theme: "light" | "dark"): Promise<void> => {
        this.currentTheme = theme;
        this.broadcastTheme(theme);
      }
    );

    ipcMain.handle(
      "panel:open-devtools",
      async (_event: IpcMainInvokeEvent, panelId: string): Promise<void> => {
        const views = this.panelViews.get(panelId);
        if (!views || views.size === 0) {
          throw new Error(`No active webviews for panel ${panelId}`);
        }

        for (const contentsId of views) {
          const contents = webContents.fromId(contentsId);
          if (contents && !contents.isDestroyed()) {
            contents.openDevTools({ mode: "detach" });
          }
        }
      }
    );
  }

  private removePanelRecursive(panelId: string): void {
    const panel = this.panels.get(panelId);
    if (!panel) return;

    // Remove all children first
    for (const child of panel.children) {
      this.removePanelRecursive(child.id);
    }

    // Revoke git token for this panel
    this.gitServer.revokeTokenForPanel(panelId);

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

  private notifyPanelTreeUpdate(): void {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send("panel:tree-updated", this.getSerializablePanelTree());
    }
  }

  private getSerializablePanelTree(): Panel[] {
    return this.rootPanels.map((panel) => this.serializePanel(panel));
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
      });
    }

    this.sendPanelEvent(panelId, { type: "theme", theme: this.currentTheme });
  }

  private registerWebviewEnvInjection(window: BrowserWindow): void {
    window.webContents.on("will-attach-webview", (_event, webPreferences, params) => {
      const panelId = this.extractPanelIdFromSrc(params?.["src"]);
      if (!panelId) {
        return;
      }

      // Enable OPFS (Origin Private File System) support
      // These settings ensure the File System Access API works properly
      webPreferences.contextIsolation = true;
      webPreferences.sandbox = true;

      const env = this.panels.get(panelId)?.env;
      if (!env || Object.keys(env).length === 0) {
        return;
      }

      try {
        const encodedEnv = Buffer.from(JSON.stringify(env), "utf-8").toString("base64");
        const argument = `${PANEL_ENV_ARG_PREFIX}${encodedEnv}`;
        const existingArgs = webPreferences.additionalArguments ?? [];
        const filteredArgs = existingArgs.filter((arg) => !arg.startsWith(PANEL_ENV_ARG_PREFIX));
        webPreferences.additionalArguments = [...filteredArgs, argument];
      } catch (error) {
        console.error(`Failed to encode env for panel ${panelId}`, error);
      }
    });
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

  private sendPanelEvent(panelId: string, payload: PanelEventPayload): void {
    const views = this.panelViews.get(panelId);
    if (!views) return;

    for (const senderId of views) {
      const contents = webContents.fromId(senderId);
      if (contents && !contents.isDestroyed()) {
        contents.send("panel:event", { panelId, ...payload });
      }
    }
  }

  private broadcastTheme(theme: "light" | "dark"): void {
    for (const panelId of this.panelViews.keys()) {
      this.sendPanelEvent(panelId, { type: "theme", theme });
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
