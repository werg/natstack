import { ipcMain, type IpcMainInvokeEvent, type BrowserWindow, webContents } from "electron";
import { PanelBuilder } from "./panelBuilder.js";
import type { PanelEventPayload, PanelArtifacts } from "./panelTypes.js";
import { getPanelCacheDirectory } from "./paths.js";

export interface Panel {
  id: string;
  title: string;
  path: string;
  children: Panel[];
  selectedChildId: string | null;
  injectHostThemeVariables: boolean;
  artifacts: PanelArtifacts;
}

export class PanelManager {
  private builder: PanelBuilder;
  private mainWindow: BrowserWindow | null = null;
  private panels: Map<string, Panel> = new Map();
  private rootPanels: Panel[] = [];
  private panelViews: Map<string, Set<number>> = new Map();
  private currentTheme: "light" | "dark" = "light";
  constructor(initialRootPanelPath: string) {
    const cacheDir = getPanelCacheDirectory();
    console.log("Using panel cache directory:", cacheDir);
    this.builder = new PanelBuilder(cacheDir);
    this.setupIpcHandlers();
    void this.initializeRootPanel(initialRootPanelPath);
  }

  setMainWindow(window: BrowserWindow): void {
    this.mainWindow = window;
  }

  private setupIpcHandlers(): void {
    // Create a child panel
    ipcMain.handle(
      "panel:create-child",
      async (_event: IpcMainInvokeEvent, parentId: string, path: string): Promise<string> => {
        const parent = this.panels.get(parentId);
        if (!parent) {
          throw new Error(`Parent panel not found: ${parentId}`);
        }

        const manifest = this.builder.loadManifest(path);
        const artifacts = await this.buildPanelArtifacts(path);

        const newPanel: Panel = {
          id: `panel-${Date.now()}-${Math.random()}`,
          title: manifest.title,
          path,
          children: [],
          selectedChildId: null,
          injectHostThemeVariables: manifest.injectHostThemeVariables !== false,
          artifacts,
        };

        // Add to parent
        parent.children.push(newPanel);
        parent.selectedChildId = newPanel.id;
        this.panels.set(newPanel.id, newPanel);

        // Notify renderer
        this.notifyPanelTreeUpdate();

        return newPanel.id;
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
      return this.rootPanels;
    });

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
      this.mainWindow.webContents.send("panel:tree-updated", this.rootPanels);
    }
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
    try {
      const manifest = this.builder.loadManifest(panelPath);
      const artifacts = await this.buildPanelArtifacts(panelPath);

      const rootPanel: Panel = {
        id: `root-${Date.now()}`,
        title: manifest.title,
        path: panelPath,
        children: [],
        selectedChildId: null,
        injectHostThemeVariables: manifest.injectHostThemeVariables !== false,
        artifacts,
      };

      this.rootPanels = [rootPanel];
      this.panels = new Map([[rootPanel.id, rootPanel]]);
      this.notifyPanelTreeUpdate();
    } catch (error) {
      console.error("Failed to initialize root panel:", error);
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
