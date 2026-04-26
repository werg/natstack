/**
 * Autofill credential dropdown overlay.
 *
 * A reusable WebContentsView positioned above the page content.
 * Page JS cannot see or interact with it.
 */

import { WebContentsView, ipcMain } from "electron";
import type { BaseWindow } from "electron";
import { createDevLogger } from "@natstack/dev-log";

const overlayLog = createDevLogger("AutofillOverlay");

export interface OverlayCallbacks {
  onSelect: (credentialId: number) => void;
  onDismiss: () => void;
}

export class AutofillOverlay {
  private view: WebContentsView | null = null;
  private window: BaseWindow | null = null;
  private callbacks: OverlayCallbacks | null = null;
  private preloadPath: string;
  private visible = false;
  /** webContents.id of the overlay view, used to attribute IPC senders. */
  private overlayWcId: number | null = null;

  constructor(preloadPath: string) {
    this.preloadPath = preloadPath;

    // Sender attribution: only accept from the overlay's own webContents.
    // Audit finding 01-HIGH-2 / #44: any panel could otherwise force a
    // credential autofill into any other loaded panel.
    ipcMain.on("natstack:autofill-overlay:select", (event, id: number) => {
      if (this.overlayWcId === null || event.sender.id !== this.overlayWcId) {
        overlayLog.warn(
          `Rejected autofill-overlay:select from non-overlay sender id=${event.sender.id} (expected ${this.overlayWcId ?? "<none>"})`,
        );
        return;
      }
      this.callbacks?.onSelect(id);
    });

    ipcMain.on("natstack:autofill-overlay:dismiss", (event) => {
      if (this.overlayWcId === null || event.sender.id !== this.overlayWcId) {
        overlayLog.warn(
          `Rejected autofill-overlay:dismiss from non-overlay sender id=${event.sender.id} (expected ${this.overlayWcId ?? "<none>"})`,
        );
        return;
      }
      this.callbacks?.onDismiss();
    });
  }

  setWindow(window: BaseWindow): void {
    this.window = window;
  }

  setCallbacks(callbacks: OverlayCallbacks): void {
    this.callbacks = callbacks;
  }

  private ensureView(): WebContentsView {
    if (this.view && !this.view.webContents.isDestroyed()) {
      return this.view;
    }

    this.view = new WebContentsView({
      webPreferences: {
        preload: this.preloadPath,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
      },
    });

    // Track the overlay's webContents id so the IPC handlers can verify
    // that select/dismiss only originate from this view.
    this.overlayWcId = this.view.webContents.id;

    this.view.setVisible(false);
    this.view.setBounds({ x: 0, y: 0, width: 0, height: 0 });

    if (this.window) {
      this.window.contentView.addChildView(this.view);
    }

    return this.view;
  }

  show(
    credentials: Array<{ id: number; username: string; origin: string }>,
    bounds: { x: number; y: number; width: number; height: number },
  ): void {
    if (!this.window) return;
    const view = this.ensureView();

    const itemsHtml = credentials
      .map(
        (c) =>
          `<div class="item" data-id="${c.id}" tabindex="0">${escapeHtml(c.username || "(no username)")}<div class="origin">${escapeHtml(c.origin)}</div></div>`,
      )
      .join("");

    const html = `<!DOCTYPE html>
<html><head><style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
         font-size: 13px; background: #fff; border: 1px solid #ccc;
         border-radius: 6px; overflow: hidden; box-shadow: 0 4px 12px rgba(0,0,0,0.15); }
  .item { padding: 8px 12px; cursor: pointer; border-bottom: 1px solid #eee; }
  .item:last-child { border-bottom: none; }
  .item:hover, .item:focus { background: #e8f0fe; outline: none; }
  .item .origin { font-size: 11px; color: #666; margin-top: 2px; }
  @media (prefers-color-scheme: dark) {
    body { background: #2d2d2d; border-color: #555; color: #eee; }
    .item:hover, .item:focus { background: #3d3d5c; }
    .item .origin { color: #aaa; }
    .item { border-bottom-color: #444; }
  }
</style></head><body>
${itemsHtml}
<script>
  document.querySelectorAll('.item').forEach(function(el) {
    el.addEventListener('click', function() {
      window.__natstack_autofill_overlay.select(Number(this.dataset.id));
    });
    el.addEventListener('keydown', function(e) {
      if (e.key === 'Enter') {
        window.__natstack_autofill_overlay.select(Number(this.dataset.id));
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        var next = this.nextElementSibling;
        if (next) next.focus();
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        var prev = this.previousElementSibling;
        if (prev) prev.focus();
      } else if (e.key === 'Escape') {
        window.__natstack_autofill_overlay.dismiss();
      }
    });
  });
  document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape') window.__natstack_autofill_overlay.dismiss();
  });
  // Focus first item for keyboard nav
  var first = document.querySelector('.item');
  if (first) first.focus();
</script>
</body></html>`;

    const itemHeight = 48;
    const dropdownHeight = Math.min(credentials.length * itemHeight + 2, 200);
    const dropdownWidth = Math.max(bounds.width, 250);

    // Clamp to window bounds
    const windowSize = this.window.getContentSize();
    const windowWidth = windowSize[0] ?? 1280;
    const windowHeight = windowSize[1] ?? 800;

    let x = bounds.x;
    let y = bounds.y + bounds.height + 2;

    // If dropdown would overflow right edge, shift left
    if (x + dropdownWidth > windowWidth) {
      x = Math.max(0, windowWidth - dropdownWidth);
    }

    // If dropdown would overflow bottom, show above the field instead
    if (y + dropdownHeight > windowHeight) {
      y = Math.max(0, bounds.y - dropdownHeight - 2);
    }

    view.setBounds({
      x,
      y,
      width: dropdownWidth,
      height: dropdownHeight,
    });

    void view.webContents.loadURL(
      `data:text/html;charset=utf-8,${encodeURIComponent(html)}`,
    );
    view.setVisible(true);
    this.visible = true;

    // Bring to top of z-order
    this.window.contentView.removeChildView(view);
    this.window.contentView.addChildView(view);
  }

  hide(): void {
    this.visible = false;
    if (this.view && !this.view.webContents.isDestroyed()) {
      this.view.setVisible(false);
      this.view.setBounds({ x: 0, y: 0, width: 0, height: 0 });
    }
  }

  isVisible(): boolean {
    return this.visible && this.view != null && !this.view.webContents.isDestroyed();
  }

  /** Re-add overlay on top after z-order changes */
  bringToFront(): void {
    if (!this.window || !this.view || this.view.webContents.isDestroyed()) return;
    if (!this.isVisible()) return;
    this.window.contentView.removeChildView(this.view);
    this.window.contentView.addChildView(this.view);
  }

  destroy(): void {
    if (this.view && !this.view.webContents.isDestroyed()) {
      if (this.window) {
        this.window.contentView.removeChildView(this.view);
      }
      this.view.webContents.close();
    }
    this.view = null;
    this.overlayWcId = null;
    ipcMain.removeAllListeners("natstack:autofill-overlay:select");
    ipcMain.removeAllListeners("natstack:autofill-overlay:dismiss");
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
