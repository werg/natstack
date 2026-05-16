import type { ViewManager } from "./viewManager.js";

export interface PanelWebContentsRegistry {
  isNatstackPanel(webContentsId: number): boolean;
  callerIdFor(webContentsId: number): string | null;
}

export class ViewBackedPanelWebContentsRegistry implements PanelWebContentsRegistry {
  constructor(private readonly getViewManager: () => ViewManager | null) {}

  callerIdFor(webContentsId: number): string | null {
    const viewManager = this.getViewManager();
    if (!viewManager) return null;
    const shellContents = viewManager.getShellWebContents();
    if (shellContents && !shellContents.isDestroyed() && shellContents.id === webContentsId) {
      return null;
    }
    return viewManager.findViewIdByWebContentsId(webContentsId);
  }

  isNatstackPanel(webContentsId: number): boolean {
    return this.callerIdFor(webContentsId) !== null;
  }
}
