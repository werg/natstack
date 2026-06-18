import { WebContentsView, ipcMain, type BaseWindow } from "electron";
import { createDevLogger } from "@natstack/dev-log";

const log = createDevLogger("ShellOverlayView");
const OVERLAY_CSP_META = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'none'">`;

/**
 * Static overlay document. Loaded ONCE per view; row content is pushed over IPC
 * afterwards (see ShellOverlayPayload). This avoids reloading the WebContents on
 * every keystroke — which aborted in-flight loads (ERR_ABORTED), blanked the
 * list, and stole focus from the shell's address input.
 */
const SHELL_OVERLAY_HTML = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
${OVERLAY_CSP_META}
<style>
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; height: 100%; background: transparent; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
.panel { margin: 0; border: 1px solid #d7d7dc; border-radius: 6px; overflow-y: auto; overflow-x: hidden; max-height: 100%; background: #fff; color: #1f1f24; box-shadow: 0 8px 22px rgba(0,0,0,.18); }
.panel::-webkit-scrollbar { width: 10px; }
.panel::-webkit-scrollbar-track { background: transparent; }
.panel::-webkit-scrollbar-thumb { background: rgba(130,130,140,.45); border-radius: 999px; border: 3px solid transparent; background-clip: padding-box; }
.panel::-webkit-scrollbar-thumb:hover { background: rgba(130,130,140,.7); background-clip: padding-box; }
.row { width: 100%; border: 0; border-bottom: 1px solid #eeeeef; background: transparent; text-align: left; padding: 7px 10px; cursor: pointer; display: block; color: inherit; }
.row:last-child { border-bottom: 0; }
.row:hover, .row:focus, .row[data-selected="true"] { background: #edf4ff; outline: none; }
.row-inner { display: flex; gap: 8px; align-items: center; min-width: 0; }
.icon { width: 16px; flex: 0 0 16px; text-align: center; color: #6f6f77; font-size: 12px; }
.text { min-width: 0; flex: 1; }
.label { font-size: 12px; line-height: 16px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.meta { margin-top: 1px; font-size: 11px; line-height: 14px; color: #6f6f77; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.match { font-weight: 700; color: #0b57d0; }
.empty { padding: 12px; font-size: 12px; color: #6f6f77; }
@media (prefers-color-scheme: dark) {
  .panel { background: #202024; border-color: #3b3b42; color: #f0f0f3; box-shadow: 0 8px 22px rgba(0,0,0,.45); }
  .row { border-bottom-color: #303038; }
  .row:hover, .row:focus, .row[data-selected="true"] { background: #28364d; }
  .meta, .empty { color: #a5a5ad; }
  .match { color: #8ab4ff; }
}
</style>
</head>
<body>
<div class="panel" role="listbox" id="panel"></div>
</body>
</html>`;

export interface ShellOverlayBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ShellOverlayRow {
  label: string;
  meta?: string;
  labelRanges?: Array<{ start: number; end: number }>;
  metaRanges?: Array<{ start: number; end: number }>;
  icon?: string;
  selected?: boolean;
  type: string;
  payload?: unknown;
}

export interface ShellOverlayPayload {
  rows: ShellOverlayRow[];
  empty: string;
}

export interface ShellOverlayOptions {
  id: string;
  rows: ShellOverlayRow[];
  empty: string;
  bounds: ShellOverlayBounds;
  focus?: boolean;
}

export class ShellOverlayView {
  private view: WebContentsView | null = null;
  private window: BaseWindow | null = null;
  private visible = false;
  private overlayId: string | null = null;
  private overlayWcId: number | null = null;
  /** True once the current view has finished loading the static overlay document. */
  private loaded = false;
  /** True while the static document load is in flight (avoid duplicate loadURL). */
  private loading = false;
  /** Latest payload, held until the document is ready to receive it. */
  private pendingPayload: ShellOverlayPayload | null = null;

  private readonly handleOverlayEvent = (event: Electron.IpcMainEvent, payload: unknown) => {
    if (!this.isOwnSender(event.sender.id)) return;
    const message = payload as { type?: unknown; payload?: unknown };
    if (typeof message?.type !== "string" || !this.overlayId) return;
    this.onOverlayEvent({
      overlayId: this.overlayId,
      type: message.type,
      payload: message.payload,
    });
  };

  private readonly handleHide = (event: Electron.IpcMainEvent) => {
    if (!this.isOwnSender(event.sender.id)) return;
    this.hide();
  };

  constructor(
    private readonly preloadPath: string,
    private readonly onOverlayEvent: (event: ShellOverlayEvent) => void
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

  /**
   * Create and load the (hidden) overlay view ahead of first use. Creating the
   * WebContentsView and its first loadURL is what steals focus from the address
   * input the *first* time the overlay appears; doing it eagerly at startup means
   * the first real show() just reveals an already-loaded view (no focus theft).
   */
  prewarm(): void {
    if (!this.window) return;
    const view = this.ensureView();
    this.ensureLoaded(view);
  }

  show(options: ShellOverlayOptions): void {
    if (!this.window) return;
    const view = this.ensureView();
    const bounds = this.clampBounds(options.bounds);
    this.overlayId = options.id;
    this.visible = true;
    this.pendingPayload = { rows: options.rows, empty: options.empty };

    view.setBounds(bounds);
    view.setVisible(true);
    this.ensureLoaded(view);
    if (options.focus && this.loaded && !view.webContents.isDestroyed()) {
      view.webContents.focus();
    }
    // The overlay must sit above panel views; raise it once on show. Updates do
    // NOT re-stack (that would steal focus from the address input each keystroke).
    this.bringToFront();
  }

  /** Ensure the static document is loaded; flush the pending payload once ready. */
  private ensureLoaded(view: WebContentsView): void {
    if (this.loaded) {
      this.flushPayload(view);
      return;
    }
    if (this.loading) return; // in-flight load will flush on completion
    this.loading = true;
    void view.webContents
      .loadURL(this.toDataUrl(SHELL_OVERLAY_HTML))
      .then(() => {
        this.loading = false;
        if (view.webContents.isDestroyed()) return;
        this.loaded = true;
        this.flushPayload(view);
      })
      .catch((error: unknown) => {
        this.loading = false;
        log.warn(
          `Failed to load shell overlay: ${error instanceof Error ? error.message : String(error)}`
        );
      });
  }

  update(options: Partial<ShellOverlayOptions> & { id?: string }): void {
    if (!this.view || this.view.webContents.isDestroyed()) return;
    if (options.id && this.overlayId && options.id !== this.overlayId) return;
    if (options.bounds) this.view.setBounds(this.clampBounds(options.bounds));
    if (options.rows !== undefined || options.empty !== undefined) {
      this.pendingPayload = {
        rows: options.rows ?? this.pendingPayload?.rows ?? [],
        empty: options.empty ?? this.pendingPayload?.empty ?? "",
      };
      if (this.loaded) this.flushPayload(this.view);
    }
  }

  hide(id?: string): void {
    if (id && this.overlayId && id !== this.overlayId) return;
    this.visible = false;
    this.overlayId = null;
    this.pendingPayload = null;
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
    this.loaded = false;
    this.loading = false;
    this.pendingPayload = null;
  }

  /** Push the latest row payload to the (loaded) overlay document over IPC. */
  private flushPayload(view: WebContentsView): void {
    if (!this.pendingPayload || view.webContents.isDestroyed()) return;
    view.webContents.send("natstack:shell-overlay:render", this.pendingPayload);
    this.pendingPayload = null;
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
    this.loaded = false;
    this.loading = false;
    this.view.setBackgroundColor("#00000000");
    this.view.setVisible(false);
    this.view.setBounds({ x: 0, y: 0, width: 0, height: 0 });
    this.overlayWcId = this.view.webContents.id;
    this.window?.contentView.addChildView(this.view);
    return this.view;
  }

  private isOwnSender(senderId: number): boolean {
    if (this.overlayWcId === senderId) return true;
    log.warn(
      `Rejected shell overlay IPC from sender id=${senderId} expected=${this.overlayWcId ?? "<none>"}`
    );
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

export interface ShellOverlayEvent {
  overlayId: string;
  type: string;
  payload?: unknown;
}
