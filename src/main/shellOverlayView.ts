import { WebContentsView, ipcMain, type BaseWindow } from "electron";
import { createDevLogger } from "@natstack/dev-log";

const log = createDevLogger("ShellOverlayView");

export interface ShellOverlayBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ShellOverlayOptions {
  id: string;
  html: string;
  bounds: ShellOverlayBounds;
  focus?: boolean;
}

export interface ShellOverlayEvent {
  overlayId: string;
  type: string;
  payload?: unknown;
}

export class ShellOverlayView {
  private view: WebContentsView | null = null;
  private window: BaseWindow | null = null;
  private visible = false;
  private overlayId: string | null = null;
  private overlayWcId: number | null = null;

  private readonly handleOverlayEvent = (event: Electron.IpcMainEvent, payload: unknown) => {
    if (!this.isOwnSender(event.sender.id)) return;
    const message = payload as { type?: unknown; payload?: unknown };
    if (typeof message?.type !== "string" || !this.overlayId) return;
    this.onEvent({ overlayId: this.overlayId, type: message.type, payload: message.payload });
  };

  private readonly handleHide = (event: Electron.IpcMainEvent) => {
    if (!this.isOwnSender(event.sender.id)) return;
    this.hide();
  };

  constructor(
    private readonly preloadPath: string,
    private readonly onEvent: (event: ShellOverlayEvent) => void,
  ) {
    ipcMain.on("natstack:shell-overlay:event", this.handleOverlayEvent);
    ipcMain.on("natstack:shell-overlay:hide", this.handleHide);
  }

  setWindow(window: BaseWindow): void {
    this.window = window;
    if (this.view && !this.view.webContents.isDestroyed()) {
      this.window.contentView.addChildView(this.view);
    }
  }

  show(options: ShellOverlayOptions): void {
    if (!this.window) return;
    const view = this.ensureView();
    const bounds = this.clampBounds(options.bounds);
    this.overlayId = options.id;
    this.visible = true;

    view.setBounds(bounds);
    view.setVisible(true);
    void view.webContents.loadURL(this.toDataUrl(options.html)).then(() => {
      if (options.focus && !view.webContents.isDestroyed()) {
        view.webContents.focus();
      }
    }).catch((error: unknown) => {
      log.warn(`Failed to load shell overlay ${options.id}: ${error instanceof Error ? error.message : String(error)}`);
    });
    this.bringToFront();
  }

  update(options: Partial<ShellOverlayOptions> & { id?: string }): void {
    if (!this.view || this.view.webContents.isDestroyed()) return;
    if (options.id && this.overlayId && options.id !== this.overlayId) return;
    if (options.bounds) this.view.setBounds(this.clampBounds(options.bounds));
    if (options.html) {
      void this.view.webContents.loadURL(this.toDataUrl(options.html)).catch((error: unknown) => {
        log.warn(`Failed to update shell overlay ${options.id ?? this.overlayId ?? "<unknown>"}: ${error instanceof Error ? error.message : String(error)}`);
      });
    }
    if (this.visible) this.bringToFront();
  }

  hide(id?: string): void {
    if (id && this.overlayId && id !== this.overlayId) return;
    this.visible = false;
    this.overlayId = null;
    if (!this.view || this.view.webContents.isDestroyed()) return;
    this.view.setVisible(false);
    this.view.setBounds({ x: 0, y: 0, width: 0, height: 0 });
  }

  isVisible(): boolean {
    return this.visible && this.view != null && !this.view.webContents.isDestroyed();
  }

  bringToFront(): void {
    if (!this.window || !this.view || this.view.webContents.isDestroyed() || !this.visible) return;
    this.window.contentView.removeChildView(this.view);
    this.window.contentView.addChildView(this.view);
  }

  destroy(): void {
    ipcMain.removeListener("natstack:shell-overlay:event", this.handleOverlayEvent);
    ipcMain.removeListener("natstack:shell-overlay:hide", this.handleHide);
    if (this.view && !this.view.webContents.isDestroyed()) {
      if (this.window) this.window.contentView.removeChildView(this.view);
      this.view.webContents.close();
    }
    this.view = null;
    this.overlayWcId = null;
    this.overlayId = null;
    this.visible = false;
  }

  private ensureView(): WebContentsView {
    if (this.view && !this.view.webContents.isDestroyed()) return this.view;

    this.view = new WebContentsView({
      webPreferences: {
        preload: this.preloadPath,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
      },
    });
    this.view.setBackgroundColor("#00000000");
    this.view.setVisible(false);
    this.view.setBounds({ x: 0, y: 0, width: 0, height: 0 });
    this.overlayWcId = this.view.webContents.id;
    this.window?.contentView.addChildView(this.view);
    return this.view;
  }

  private isOwnSender(senderId: number): boolean {
    if (this.overlayWcId === senderId) return true;
    log.warn(`Rejected shell overlay IPC from sender id=${senderId} expected=${this.overlayWcId ?? "<none>"}`);
    return false;
  }

  private clampBounds(bounds: ShellOverlayBounds): ShellOverlayBounds {
    const [windowWidth = 0, windowHeight = 0] = this.window?.getContentSize() ?? [0, 0];
    const width = Math.max(1, Math.min(Math.round(bounds.width), Math.max(1, windowWidth)));
    const height = Math.max(1, Math.min(Math.round(bounds.height), Math.max(1, windowHeight)));
    const x = Math.max(0, Math.min(Math.round(bounds.x), Math.max(0, windowWidth - width)));
    const y = Math.max(0, Math.min(Math.round(bounds.y), Math.max(0, windowHeight - height)));
    return { x, y, width, height };
  }

  private toDataUrl(html: string): string {
    return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
  }
}
